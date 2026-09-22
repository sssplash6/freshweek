"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isFinance, isPayrollAdmin } from "@/lib/payroll";
import { isPayrollOpenFor } from "@/lib/payrollTypes";

export type SheetResult = { ok: true } | { ok: false; error: string };

const fail = (error: string): SheetResult => ({ ok: false, error });

/**
 * Recording a payout figure is a FINANCE act, narrower than the payroll-admin
 * stage: these numbers say what actually left which account, and finance is
 * who moves the money. Global admins pass too, as they do everywhere.
 * Deliberately not the reviewer alone — deciding a request and writing
 * its settled amount are different jobs.
 */
async function requireSheetEditor() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (!isFinance(session.user.email) && !isPayrollAdmin(session.user.email)) {
    throw new Error("Not authorized");
  }
  return session;
}

/**
 * Guard rail mirroring MAX_PAYROLL_AMOUNT, but per-unit: UZS figures run to
 * millions where USD runs to thousands, so one shared ceiling would either
 * reject a real som amount or wave through an absurd dollar one.
 */
const MAX_UZS = 100_000_000_000; // 100bn som
const MAX_CENTS = 100_000_000; // $1,000,000.00

/**
 * Parse one figure. Three outcomes, and the difference between the first two
 * matters more than it looks:
 *   • `undefined` (key absent)  → SKIP, leave the stored value alone
 *   • null or ""                → CLEAR back to "not recorded"
 *   • digits                    → the integer, in the column's stored unit
 *
 * An omitted key used to mean "write null", so a caller updating one column
 * would silently wipe the two beside it. The client always sends all three, so
 * nothing was losing data — but that made the API's safety a property of one
 * caller's discipline rather than of the API, which is the kind of thing that
 * holds until someone adds a second caller.
 *
 * Clearing stays possible on purpose: "not recorded" is a real state, and
 * finance must be able to get back to it after a mistyped number — a
 * 0-means-empty shortcut would leave a confident zero in a register instead.
 */
const SKIP = Symbol("skip");

function parseFigure(
  raw: unknown,
  max: number,
  label: string,
): number | null | typeof SKIP | { error: string } {
  if (raw === undefined) return SKIP;
  if (raw === null) return null;
  const text = String(raw).trim().replace(/[\s,]/g, "");
  if (text === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > max) {
    return { error: `${label} isn't a valid amount.` };
  }
  return n;
}

/** Narrow a parsed figure, or hand back the refusal to return to the caller. */
function readFigure(
  parsed: ReturnType<typeof parseFigure>,
): { error: string } | { set: false } | { set: true; value: number | null } {
  if (parsed === SKIP) return { set: false };
  if (parsed !== null && typeof parsed === "object") return parsed;
  return { set: true, value: parsed };
}

/**
 * Write the payout figures for one request. Every field is optional and
 * independently clearable; the submission itself is untouched, so this never
 * moves a request through the status machine and can't collide with an
 * approval happening at the same time.
 */
export async function setSheetFigures(
  submissionId: string,
  figures: {
    amountUzs?: string | null;
    amountSgdCents?: string | null;
    wiseFeeCents?: string | null;
  },
): Promise<SheetResult> {
  const session = await requireSheetEditor();
  if (!isPayrollOpenFor(session.user?.email)) {
    return fail("Payroll is closed right now.");
  }

  const uzs = readFigure(parseFigure(figures.amountUzs, MAX_UZS, "The UZS amount"));
  if ("error" in uzs) return fail(uzs.error);
  const sgd = readFigure(
    parseFigure(figures.amountSgdCents, MAX_CENTS, "The SGD amount"),
  );
  if ("error" in sgd) return fail(sgd.error);
  const fee = readFigure(
    parseFigure(figures.wiseFeeCents, MAX_CENTS, "The Wise fee"),
  );
  if ("error" in fee) return fail(fee.error);

  // Only the columns the caller actually spoke about.
  const data: {
    amountUzs?: number | null;
    amountSgdCents?: number | null;
    wiseFeeCents?: number | null;
  } = {};
  if (uzs.set) data.amountUzs = uzs.value;
  if (sgd.set) data.amountSgdCents = sgd.value;
  if (fee.set) data.wiseFeeCents = fee.value;
  if (Object.keys(data).length === 0) return { ok: true }; // nothing asked for

  const exists = await prisma.payrollSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true },
  });
  if (!exists) return fail("That request is gone.");

  await prisma.payrollSubmission.update({ where: { id: submissionId }, data });

  revalidatePath("/payroll/sheet");
  revalidatePath("/payroll/finance");
  return { ok: true };
}
