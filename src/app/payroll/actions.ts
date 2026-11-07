"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isApprovedUser } from "@/lib/approval";
import { formatMoney } from "@/lib/penalties";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";
import {
  applyTransition,
  appUrl,
  ensureCurrentPeriod,
  expireLapsedSubmissions,
  filingWindowStateFor,
  formatTashkent,
  inFlightSubmission,
  financeEmails,
  pullLedgerSnapshot,
  reviewerUsers,
} from "@/lib/payroll";
import { approvingLeadsFor } from "@/lib/payrollApproval";
import {
  anyPartPaid,
  filesSplit,
  partAmount,
  payDepartmentsFor,
  splitLine,
  type PayDepartment,
} from "@/lib/payrollParts";
import { renderPayrollInvoice } from "@/lib/payrollPdf";
import { regenerateInvoicePdf } from "@/lib/payrollInvoice";
import {
  computeNet,
  MAX_PAYROLL_AMOUNT,
  MAX_PAYROLL_AMOUNT_CENTS,
  MAX_PAYROLL_EXPENSES,
  parseAmountCents,
  MAX_RECEIPT_BYTES,
  RECEIPT_MIME_TYPES,
  payrollMonthName,
  payrollPeriodLabel,
  isOfferedPayrollMethod,
  paymentFieldsFor,
  validatePaymentDetails,
  isPayrollOpenFor,
  PAYROLL_STATUS_LABEL,
  type PaymentDetails,
  type PayrollMethod,
} from "@/lib/payrollTypes";
import type { Prisma } from "@/generated/prisma/client";

export type SubmitPayrollResult = { ok: true } | { ok: false; error: string };

// Expected failures (validation, closed windows) come back as { ok: false }
// with a specific message — production masks thrown action errors, and the
// form needs to say WHY. Throws are reserved for auth and genuine bugs.
const fail = (error: string): SubmitPayrollResult => ({ ok: false, error });

type ParsedExpense = {
  /** Set when this line survives from the declined submission — its stored
   * receipt is kept unless a new file replaces it. */
  existingId: string | null;
  label: string;
  amountCents: number;
  receipt: {
    filename: string;
    mimeType: string;
    size: number;
    // Prisma's Bytes input is pinned to a plain ArrayBuffer view.
    bytes: Uint8Array<ArrayBuffer>;
  } | null;
};

/**
 * File (or, after a decline, refile) the signed-in user's pay request for the
 * current period. Reads the form multipart body: baseSalary, paymentMethod +
 * its details, an `expenses` JSON array, and one optional `receipt_<i>` file
 * per expense. Snapshots the ledger, computes the net, renders the invoice
 * PDF, moves the request onto the desk that has to act on it next — the
 * filer's department lead, or finance when they have no lead — and tells that
 * desk.
 *
 * Filing and editing are only allowed inside the period's filing window;
 * refiling after a decline runs on the decline's own clock instead. See the
 * "Which filing path is open?" section below.
 */
export async function submitPayroll(
  formData: FormData,
): Promise<SubmitPayrollResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  // The page renders the coming-soon screen when payroll is off or this
  // account isn't in the restricted rollout, but the action stays
  // POST-reachable — refuse here too.
  if (!isPayrollOpenFor(session.user.email)) {
    return fail("Payroll is closed right now.");
  }
  if (!(await isApprovedUser(session.user))) throw new Error("Not authorized");
  const userId = session.user.id;

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { select: { id: true }, take: 1 },
    },
  });
  if (!me) throw new Error("Not authenticated");
  if (me.memberships.length === 0) {
    return fail("Finish onboarding (join a department) before filing payroll.");
  }

  // ----- Parse & validate the form -----

  // Someone in two or more departments is paid by each of them, so they file
  // a salary per department and the request is split into parts that each
  // department approves and pays on its own (lib/payrollParts.ts). Which
  // departments those are is read HERE, from the seats, never from the form —
  // the form only says how much each one pays.
  const payDepartments = await payDepartmentsFor(prisma, userId);
  const split = filesSplit(payDepartments);
  let parts: ParsedPart[] = [];
  let baseSalary: number;
  if (split) {
    const parsed = parseParts(formData, payDepartments);
    if (typeof parsed === "string") return fail(parsed);
    parts = parsed;
    baseSalary = parts.reduce((sum, p) => sum + p.salary, 0);
    if (baseSalary > MAX_PAYROLL_AMOUNT) {
      return fail("Enter a valid base salary (whole dollars).");
    }
  } else {
    baseSalary = Math.round(Number(formData.get("baseSalary")));
    if (!Number.isFinite(baseSalary) || baseSalary < 0 || baseSalary > MAX_PAYROLL_AMOUNT) {
      return fail("Enter a valid base salary (whole dollars).");
    }
  }

  const rawMethod = formData.get("paymentMethod");
  // Offered, not merely valid: the retired sources are still legal values in
  // the column so old rows can keep theirs, and a POST naming one would
  // otherwise file a request against a source nobody pays from any more.
  if (!isOfferedPayrollMethod(rawMethod)) {
    return fail("Pick a preferred payment method.");
  }
  const method: PayrollMethod = rawMethod;
  // Payout instructions, read straight off the field list for the chosen
  // method — so only what that method actually asks for is ever stored, and a
  // switch of method can't leave a stale card number behind on the row.
  const details: PaymentDetails = {};
  for (const field of paymentFieldsFor(method)) {
    const value = String(formData.get(`detail_${field.key}`) ?? "")
      .trim()
      .slice(0, field.maxLength);
    if (value) details[field.key] = value;
  }
  const detailsError = validatePaymentDetails(method, details);
  if (detailsError) return fail(detailsError);

  let expenseMeta: { id?: unknown; label: unknown; amount: unknown }[];
  try {
    expenseMeta = JSON.parse(String(formData.get("expenses") ?? "[]"));
    if (!Array.isArray(expenseMeta)) throw new Error();
  } catch {
    return fail("Couldn't read the expense lines — reload and try again.");
  }
  if (expenseMeta.length > MAX_PAYROLL_EXPENSES) {
    return fail(`At most ${MAX_PAYROLL_EXPENSES} expense lines.`);
  }
  const expenses: ParsedExpense[] = [];
  for (const [i, raw] of expenseMeta.entries()) {
    const label = String(raw.label ?? "").trim().slice(0, 120);
    // Cents, straight from what was typed — a $1.95 receipt files as $1.95.
    // Only the net is rounded (computeNet), and only once.
    const amountCents = parseAmountCents(String(raw.amount ?? ""));
    if (!label) return fail(`Expense ${i + 1} needs a label.`);
    if (amountCents == null || amountCents > MAX_PAYROLL_AMOUNT_CENTS) {
      return fail(`Expense “${label}” needs a valid amount.`);
    }
    const file = formData.get(`receipt_${i}`);
    let receipt: ParsedExpense["receipt"] = null;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_RECEIPT_BYTES) {
        return fail(`Receipt for “${label}” is over 4MB — attach a smaller file.`);
      }
      if (!RECEIPT_MIME_TYPES.includes(file.type)) {
        return fail(`Receipt for “${label}” must be an image or a PDF.`);
      }
      receipt = {
        filename: (file.name || "receipt").slice(0, 200),
        mimeType: file.type,
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      };
    }
    expenses.push({
      existingId: typeof raw.id === "string" ? raw.id : null,
      label,
      amountCents,
      receipt,
    });
  }
  const expensesTotalCents = expenses.reduce((s, e) => s + e.amountCents, 0);
  if (expensesTotalCents > MAX_PAYROLL_AMOUNT_CENTS) {
    return fail("Expenses total is too large.");
  }

  // ----- Which filing path is open? -----

  const now = new Date();
  await expireLapsedSubmissions(now);
  const period = await ensureCurrentPeriod(prisma, now);
  const label = payrollPeriodLabel(period.year, period.month);

  const existing = await prisma.payrollSubmission.findUnique({
    where: { userId_periodId: { userId, periodId: period.id } },
    select: {
      id: true,
      status: true,
      resubmitDeadline: true,
      parts: { select: { paidAt: true } },
    },
  });

  // The filing window (last three days of the month plus the 1st of the next
  // one — see periodBoundsFor). The page hides the form outside it, but the
  // action stays POST-reachable and a page left open across the boundary would
  // still submit, so this is where the window is actually enforced.
  const filingWindow = filingWindowStateFor(session.user.email, period, now);

  // "edit" is the filer changing a request that is still sitting in the queue.
  // Inside the window it is bounded by the review as well as the clock: the
  // moment an admin declines or approves, it shuts early — a decline has its
  // own timed resubmit path, and an approval can't be silently altered
  // underneath the person who gave it.
  let mode: "create" | "resubmit" | "edit";
  if (!existing) {
    if (filingWindow === "BEFORE") {
      return fail(
        `Filing for ${label} opens ${formatTashkent(period.filingOpensAt)} — the request pulls in the whole month, so it can't be filed before the month is nearly over.`,
      );
    }
    if (filingWindow === "CLOSED") {
      return fail(
        `Filing for ${label} closed ${formatTashkent(period.filingClosesAt)} — no penalty, you'll simply file in next month's cycle.`,
      );
    }
    const blocking = await inFlightSubmission(prisma, userId);
    if (blocking) {
      return fail(
        `Your ${payrollMonthName(blocking.period.month)} request is still in review — filing for ${label} unlocks once it's processed.`,
      );
    }
    mode = "create";
  } else if (existing.status === "DECLINED") {
    // Deliberately NOT window-gated: a decline carries its own deadline, and
    // that deadline is allowed to run one day past the cutoff (the grace day
    // in resubmitWindowFor). Refusing here would strand anyone declined late
    // on the window's last day.
    //
    // No deadline on the row means the period had no cutoff to set one from —
    // it was declined while the month was held open — so the window IS the
    // bound, and this refile stops being possible when the month closes. (The
    // same reading settles legacy rows from before the column existed: their
    // month closed long ago, so they are refused exactly as they were.)
    const lapsed = existing.resubmitDeadline
      ? now > existing.resubmitDeadline
      : filingWindow !== "OPEN";
    if (lapsed) {
      return fail("The resubmit window has closed — this filing rolls into next month's cycle.");
    }
    mode = "resubmit";
  } else if (
    existing.status === "SUBMITTED" ||
    existing.status === "WITH_LEAD"
  ) {
    // An edit rewrites the whole request, so it is a filing and lives under the
    // same window. Either way the request stands as filed; whichever desk
    // holds it — their lead or finance — sends it back if it needs changing,
    // which opens the resubmit path above. (BEFORE is reachable for requests
    // filed under the old whole-month rule, so it gets its own wording rather
    // than being told the window "closed".)
    //
    // Editing works the same on either desk, and lands back on the lead's
    // either way — see `landsOn` below.
    if (filingWindow === "CLOSED") {
      return fail(
        `Filing for ${label} closed ${formatTashkent(period.filingClosesAt)} — your request stays in review exactly as filed. If something needs changing, ask your department lead (or finance) to send it back.`,
      );
    }
    if (filingWindow === "BEFORE") {
      return fail(
        `Filing for ${label} isn't open until ${formatTashkent(period.filingOpensAt)} — your request stays in review exactly as filed until then.`,
      );
    }
    // One department has already paid its part. Rewriting the request now
    // would change money that has left the building, so it stands as filed.
    if (anyPartPaid(existing.parts)) {
      return fail(
        `Part of your ${label} request is already paid, so it can't be changed now. If something is wrong, tell finance.`,
      );
    }
    mode = "edit";
  } else {
    return fail(
      `Your ${label} request is ${PAYROLL_STATUS_LABEL[existing.status].toLowerCase()} — it can't be changed now.`,
    );
  }

  // ----- Which desk does it land on? -----

  /**
   * A filing goes to the filer's department lead, and only reaches finance
   * once that lead passes it (see lib/payrollApproval.ts for who that is, and
   * the PayrollStatus lifecycle for why the gate exists).
   *
   * Every path lands here, including an edit to a request the lead has
   * ALREADY approved: that edit rewrites the very numbers they stamped, so it
   * goes back to them rather than carrying a stamp for money they never saw.
   * The filer is told this in the form's result, because silently un-approving
   * their request would look like the edit failed.
   *
   * A filer with nobody to approve them lands on SUBMITTED exactly as before,
   * and the audit note says why, so a trail with no approval step in it isn't
   * read later as a gate that was skipped.
   */
  const leads = await approvingLeadsFor(prisma, userId);
  // A split request waits on the lead of each department it has a part in.
  // A department with no lead has nobody to wait on, so its part starts out
  // approved — the whole-request rule below, one department at a time.
  const approverIdsOf = new Map(payDepartments.map((d) => [d.id, d.approverIds]));
  const unapproved = parts.filter(
    (p) => (approverIdsOf.get(p.departmentId) ?? []).length > 0,
  );
  const landsOn: "WITH_LEAD" | "SUBMITTED" = split
    ? unapproved.length > 0
      ? "WITH_LEAD"
      : "SUBMITTED"
    : leads.length > 0
      ? "WITH_LEAD"
      : "SUBMITTED";
  const leaderless = parts.filter((p) => !unapproved.includes(p));
  const skipNote = split
    ? landsOn === "SUBMITTED"
      ? "No department lead to approve any part of this — filed straight to finance."
      : leaderless.length > 0
        ? `No lead in ${leaderless.map((p) => p.departmentName).join(" or ")} — that part needs no approval.`
        : null
    : landsOn === "SUBMITTED"
      ? "No department lead to approve this — filed straight to finance."
      : null;
  // Who is waiting on whom, for the hand-off below: each lead hears about the
  // part (or parts) that are theirs to approve, not the whole request.
  const partsByApprover = new Map<string, ParsedPart[]>();
  for (const p of unapproved) {
    for (const id of approverIdsOf.get(p.departmentId) ?? []) {
      partsByApprover.set(id, [...(partsByApprover.get(id) ?? []), p]);
    }
  }
  const approverUsers = split
    ? await prisma.user.findMany({
        where: { id: { in: [...partsByApprover.keys()] } },
        select: { id: true, email: true },
      })
    : [];

  // ----- Write it all atomically -----

  let netTotal = 0;
  try {
    await prisma.$transaction(async (tx) => {
      // Serialize this person's filings before reading anything. Every check
      // above ran outside the transaction, so two requests for DIFFERENT
      // periods could both pass the in-flight guard and then snapshot the same
      // unpaid fines and unpaid bonuses — paying the bonuses twice and
      // deducting the fines twice. The (userId, periodId) unique key doesn't
      // help: it only stops two filings for the SAME period. A per-user
      // advisory lock does, and needs no schema change — Postgres holds it for
      // the life of the transaction and drops it on commit or rollback.
      // Projected through a subquery because pg_advisory_xact_lock returns
      // `void`, and Prisma's raw-query decoder can't deserialize a void column
      // — it throws before the lock is ever of any use. The outer SELECT hands
      // it an int instead.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${PAYROLL_LOCK_NAMESPACE}::int4, hashtext(${userId}))) AS _lock`;

      // Re-assert what decided `mode`, now that nothing else can be filing for
      // this person. Whoever held the lock first may have just used it up.
      if (mode === "create") {
        const blocking = await inFlightSubmission(tx, userId);
        if (blocking) {
          throw new SubmitError(
            `Your ${payrollMonthName(blocking.period.month)} request is still in review — filing for ${label} unlocks once it's processed.`,
          );
        }
      } else {
        // An edit must still be sitting on the desk it was read from and a
        // refile must still be declined; either way a reviewer may have acted
        // since the check above.
        const expected = mode === "edit" ? existing!.status : "DECLINED";
        const still = await tx.payrollSubmission.findUnique({
          where: { id: existing!.id },
          select: { status: true },
        });
        if (still?.status !== expected) {
          throw new SubmitError(
            "That request has already moved on — reload to see where it is.",
          );
        }
      }

      const snapshot = await pullLedgerSnapshot(tx, userId);
      netTotal = computeNet({
        baseSalary,
        bonusesTotal: snapshot.bonusesTotal,
        finesTotal: snapshot.finesTotal,
        expensesTotalCents,
      });
      if (netTotal < 0) {
        throw new SubmitError(
          `Your outstanding fines (${formatMoney(snapshot.finesTotal)}) exceed the rest of this request — the total can't go below zero.`,
        );
      }
      // The fines come off ONE department's payment, so that part has to be
      // big enough to take them, not just the request as a whole.
      const carrying = parts.find((p) => p.carriesLedger);
      if (carrying && partAmount(carrying, parts, netTotal) < 0) {
        throw new SubmitError(
          `Your outstanding fines (${formatMoney(snapshot.finesTotal)}) are more than your ${carrying.departmentName} part — put bonuses, fines and expenses on a department with a bigger share.`,
        );
      }

      const money = {
        baseSalary,
        bonusesTotal: snapshot.bonusesTotal,
        finesTotal: snapshot.finesTotal,
        expensesTotalCents,
        netTotal,
        paymentMethod: method,
        paymentDetails: details as Prisma.InputJsonValue,
      };

      let submissionId: string;
      if (mode === "create") {
        const created = await tx.payrollSubmission.create({
          data: { userId, periodId: period.id, status: "DRAFT", ...money },
          select: { id: true },
        });
        submissionId = created.id;
        await applyTransition(tx, {
          submissionId,
          from: "DRAFT",
          to: landsOn,
          actorId: userId,
          note: skipNote,
          data: { submittedAt: now, lastSubmittedAt: now },
        });
      } else {
        submissionId = existing!.id;
        // A resubmission or an edit replaces the ledger snapshot wholesale and
        // regenerates the PDF below. Expenses are reconciled, not wiped: a
        // kept line updates in place so its stored receipt survives — the
        // person shouldn't re-upload a photo because the base salary was
        // wrong (a new file on a kept line replaces the old receipt).
        await tx.payrollBonusLine.deleteMany({ where: { submissionId } });
        await tx.payrollFineLine.deleteMany({ where: { submissionId } });
        await tx.payrollSubmission.update({
          where: { id: submissionId },
          data: money,
        });
        await applyTransition(tx, {
          submissionId,
          // An edit on the lead's desk is WITH_LEAD → WITH_LEAD: the status
          // doesn't move, but the event still lands so the desk can see the
          // request changed under it. `submittedAt` is untouched on every
          // path, so lateness is still judged by the original filing.
          from: mode === "edit" ? existing!.status : "DECLINED",
          to: landsOn,
          actorId: userId,
          note: skipNote,
          data: { lastSubmittedAt: now },
        });
      }

      // The department parts, rebuilt from scratch on every filing: an edit or
      // a refile changes the numbers each lead would be vouching for, so no
      // approval carries over (the same reason the whole request goes back to
      // WITH_LEAD). Paid parts can't reach here — an edit is refused above and
      // a request with a paid part can't be declined.
      await tx.payrollPart.deleteMany({ where: { submissionId } });
      if (parts.length > 0) {
        await tx.payrollPart.createMany({
          data: parts.map((p, i) => ({
            submissionId,
            departmentId: p.departmentId,
            departmentName: p.departmentName,
            salary: p.salary,
            carriesLedger: p.carriesLedger,
            position: i + 1,
            ...(unapproved.includes(p) ? {} : { approvedAt: now }),
          })),
        });
      }

      if (snapshot.bonusLines.length > 0) {
        await tx.payrollBonusLine.createMany({
          data: snapshot.bonusLines.map((l) => ({ ...l, submissionId })),
        });
      }
      if (snapshot.fineLines.length > 0) {
        await tx.payrollFineLine.createMany({
          data: snapshot.fineLines.map((l) => ({ ...l, submissionId })),
        });
      }

      // Reconcile expense rows. `existingId` claims are honored only for rows
      // that really belong to THIS submission — a forged id can't touch
      // someone else's data.
      const oldRows = await tx.payrollExpense.findMany({
        where: { submissionId },
        select: { id: true },
      });
      const oldIds = new Set(oldRows.map((r) => r.id));
      const keptIds = new Set(
        expenses
          .map((e) => e.existingId)
          .filter((id): id is string => id !== null && oldIds.has(id)),
      );
      const dropIds = oldRows.filter((r) => !keptIds.has(r.id)).map((r) => r.id);
      if (dropIds.length > 0) {
        await tx.payrollExpense.deleteMany({ where: { id: { in: dropIds } } });
      }
      for (const [i, e] of expenses.entries()) {
        const kept = e.existingId !== null && keptIds.has(e.existingId);
        let expenseId: string;
        if (kept) {
          expenseId = e.existingId!;
          await tx.payrollExpense.update({
            where: { id: expenseId },
            data: { label: e.label, amountCents: e.amountCents, position: i + 1 },
          });
        } else {
          const row = await tx.payrollExpense.create({
            data: {
              submissionId,
              label: e.label,
              amountCents: e.amountCents,
              position: i + 1,
            },
            select: { id: true },
          });
          expenseId = row.id;
        }
        if (e.receipt) {
          await tx.payrollReceipt.deleteMany({ where: { expenseId } });
          await tx.payrollReceipt.create({
            data: { expenseId, ...e.receipt },
          });
        }
      }

      // Invoice number: this person's Nth request ever, stable across
      // regenerations (createdAt order, not status).
      const created = await tx.payrollSubmission.findUniqueOrThrow({
        where: { id: submissionId },
        select: { createdAt: true },
      });
      const invoiceNo =
        (await tx.payrollSubmission.count({
          where: { userId, createdAt: { lt: created.createdAt } },
        })) + 1;

      const pdfBytes = await renderPayrollInvoice({
        invoiceNo,
        employeeName: me.name ?? me.email ?? "—",
        dateLabel: now.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "Asia/Tashkent",
        }),
        periodLabel: label,
        baseSalary,
        bonusLines: snapshot.bonusLines,
        fineLines: snapshot.fineLines,
        expenses: expenses.map((e) => ({
          label: e.label,
          amountCents: e.amountCents,
        })),
        netTotal,
        paymentMethod: method,
        paymentDetails: details,
        parts: parts.map((p) => ({
          departmentName: p.departmentName,
          salary: p.salary,
          amount: partAmount(p, parts, netTotal),
          carriesLedger: p.carriesLedger,
        })),
      });
      await tx.payrollPdf.upsert({
        where: { submissionId },
        update: { bytes: pdfBytes },
        create: { submissionId, bytes: pdfBytes },
      });

      // Told to the desk it actually landed on — nobody is paged about a
      // request that isn't theirs to act on yet. Finance hears about it when
      // the lead passes it (approveAsLead in ./team/actions.ts).
      if (split && landsOn === "WITH_LEAD") {
        // Each lead is told what is theirs: the part of THEIR department, and
        // that the rest is another lead's.
        for (const [leadId, theirs] of partsByApprover) {
          if (leadId === userId) continue;
          await notify(
            tx,
            leadId,
            "PAYROLL",
            `${me.name ?? me.email}: ${label} pay request ${NOTICE[mode].verb} — ${splitOf(theirs, parts, netTotal)} is your department's part. Needs your approval before it can be paid.`,
          );
        }
      } else {
        const audience =
          landsOn === "WITH_LEAD"
            ? leads.map((l) => l.id)
            : (await reviewerUsers(tx, financeEmails())).map((r) => r.id);
        await notify(
          tx,
          audience.filter((id) => id !== userId),
          "PAYROLL",
          landsOn === "WITH_LEAD"
            ? `${me.name ?? me.email}: ${label} pay request ${NOTICE[mode].verb} — ${formatMoney(netTotal)} net. Needs your approval before finance can pay it.`
            : `${me.name ?? me.email}: ${label} pay request ${NOTICE[mode].verb} — ${formatMoney(netTotal)} net${
                split ? ` (${splitOf(parts, parts, netTotal)})` : ""
              }.`,
        );
      }
    });
  } catch (e) {
    if (e instanceof SubmitError) return fail(e.message);
    // Two tabs racing the same filing hit the (userId, periodId) unique key.
    if (typeof e === "object" && e !== null && "code" in e && e.code === "P2002") {
      return fail(`You've already filed for ${label} — reload to see it.`);
    }
    throw e;
  }

  // Mail is a side channel — after the transaction, never inside it.
  //
  // It goes to the desk the request landed on, with the invoice attached,
  // because THIS mail is the hand-off: whoever reads it is whoever has to act
  // next, and they work from the invoice rather than from app state. When the
  // lead is that desk, finance's copy is sent a stage later — by their
  // approval (./team/actions.ts) — so finance's inbox holds only requests it
  // can actually pay.
  const who = me.name ?? me.email ?? "Someone";
  const pdf = await prisma.payrollPdf.findFirst({
    where: { submission: { userId, periodId: period.id } },
    select: { bytes: true },
  });
  const attachments = pdf
    ? [{ filename: `${who} — ${label}.pdf`, bytes: pdf.bytes }]
    : undefined;
  if (split && landsOn === "WITH_LEAD") {
    // One email per lead, about their own department's part.
    await Promise.all(
      approverUsers
        .filter((u) => u.id !== userId && u.email)
        .map((u) => {
          const theirs = splitOf(partsByApprover.get(u.id) ?? [], parts, netTotal);
          return sendEmail({
            to: u.email!,
            subject: `Payroll: ${who} ${NOTICE[mode].subject(label)} — ${theirs} to approve`,
            text:
              `${who} ${NOTICE[mode].sentence(label)} — ${formatMoney(netTotal)} in all, split by department: ` +
              `${splitOf(parts, parts, netTotal)}.\n\n` +
              `${theirs} is your department's part, so that part waits on you; the rest is for the other department's lead. ` +
              `The invoice is attached.\n\nApprove your part, or send the request back with a note: ${appUrl()}/payroll/team\n\n— FreshWeek`,
            attachments,
          });
        }),
    );
  } else {
    const recipients =
      landsOn === "WITH_LEAD"
        ? leads.map((l) => l.email).filter((to): to is string => !!to)
        : financeEmails();
    await Promise.all(
      recipients
        .filter((to) => to.toLowerCase() !== (me.email ?? "").toLowerCase())
        .map((to) =>
          sendEmail({
            to,
            subject:
              landsOn === "WITH_LEAD"
                ? `Payroll: ${who} ${NOTICE[mode].subject(label)} — ${formatMoney(netTotal)} to approve`
                : `Payroll: ${who} ${NOTICE[mode].subject(label)} — ${formatMoney(netTotal)} to pay`,
            text:
              landsOn === "WITH_LEAD"
                ? `${who} ${NOTICE[mode].sentence(label)} — ${formatMoney(netTotal)} net.\n\n` +
                  `You lead their department, so it waits on you: finance can't pay it until you approve it. ` +
                  `The invoice is attached.\n\nApprove it, or send it back with a note: ${appUrl()}/payroll/team\n\n— FreshWeek`
                : `${who} ${NOTICE[mode].sentence(label)} — ${formatMoney(netTotal)} net${
                    split ? `, split by department: ${splitOf(parts, parts, netTotal)}` : ""
                  }.\n\n` +
                  `The invoice is attached. Pay it, or decline it back with a note: ${appUrl()}/payroll/panel\n\n— FreshWeek`,
            attachments,
          }),
        ),
    );
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/panel");
  revalidatePath("/payroll/team");
  revalidatePath("/department");
  return { ok: true };
}

/**
 * How each filing path is announced to the desk it landed on. An edit has to read
 * differently from a fresh filing: the request is already sitting in their
 * queue, and what changed is the very thing they were about to pay.
 */
const NOTICE = {
  create: {
    verb: "filed",
    subject: (label: string) => `filed for ${label}`,
    sentence: (label: string) => `filed a ${label} pay request`,
  },
  resubmit: {
    verb: "resubmitted",
    subject: (label: string) => `resubmitted for ${label}`,
    sentence: (label: string) => `resubmitted their ${label} pay request`,
  },
  edit: {
    verb: "edited",
    subject: (label: string) => `edited their ${label} request`,
    sentence: (label: string) =>
      `edited their ${label} pay request before it was paid`,
  },
} as const;

/** An expected, user-facing refusal thrown from inside the transaction. */
class SubmitError extends Error {}

/** One department's share, as filed. */
type ParsedPart = {
  departmentId: string;
  departmentName: string;
  salary: number;
  carriesLedger: boolean;
};

/**
 * Read a split filing's parts: a `parts` JSON array of
 * `{ departmentId, salary }`, one per department the filer sits in, and
 * `ledgerDepartmentId`, the department the bonuses, fines and expenses go with.
 *
 * The departments are checked against the filer's seats as they are NOW, and
 * every one of them must be answered: a form opened before a seat was added or
 * removed is refused rather than filed against a split nobody chose. A
 * department paying $0 this month is dropped — there is nothing for its lead
 * to approve or pay — unless it carries the ledger, which can be all a part is
 * (an expenses-only month).
 *
 * Returns the parts in department order, or the message to show.
 */
function parseParts(
  formData: FormData,
  departments: PayDepartment[],
): ParsedPart[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("parts") ?? "[]"));
  } catch {
    return "Couldn't read your salaries — reload and try again.";
  }
  if (!Array.isArray(raw)) {
    return "Couldn't read your salaries — reload and try again.";
  }
  const stale = "Your departments changed since this page opened — reload it and fill in each salary again.";
  const salaryOf = new Map<string, number>();
  for (const entry of raw as { departmentId?: unknown; salary?: unknown }[]) {
    const dept = departments.find((d) => d.id === entry?.departmentId);
    if (!dept || salaryOf.has(dept.id)) return stale;
    const text = String(entry.salary ?? "").trim();
    if (!/^\d+$/.test(text) || Number(text) > MAX_PAYROLL_AMOUNT) {
      return `Enter your salary from ${dept.name} in whole dollars — 0 if they pay you nothing this month.`;
    }
    salaryOf.set(dept.id, Number(text));
  }
  if (salaryOf.size !== departments.length) return stale;

  const ledgerId = String(formData.get("ledgerDepartmentId") ?? "");
  if (!departments.some((d) => d.id === ledgerId)) {
    return "Pick which department your bonuses, fines and expenses go with.";
  }
  return departments
    .map((d) => ({
      departmentId: d.id,
      departmentName: d.name,
      salary: salaryOf.get(d.id)!,
      carriesLedger: d.id === ledgerId,
    }))
    .filter((p) => p.salary > 0 || p.carriesLedger);
}

/** "Research $400 · Global Admissions $600" for some of a request's parts. */
function splitOf(
  some: ParsedPart[],
  all: ParsedPart[],
  netTotal: number,
): string {
  return splitLine(
    some,
    some.map((p) => partAmount(p, all, netTotal)),
    formatMoney,
  );
}

/**
 * Namespace for the per-user payroll advisory lock, so it can't collide with
 * any other advisory lock the app might take later. Arbitrary but fixed.
 */
const PAYROLL_LOCK_NAMESPACE = 8_140_233;


/**
 * Fill in the payout details on a request that was filed without them.
 *
 * The card and bank fields didn't exist when some requests were filed, so those
 * rows sit in the queue with nothing finance can pay from. This is the way back
 * in — details only, no money, no status change, and no new filing — so it
 * works whatever the review has or hasn't done, right up until the request is
 * paid or expired.
 *
 * The stored invoice PDF is re-rendered from the row, because that file is what
 * gets emailed and it would otherwise still say "arranged directly with
 * finance". Reviewers are told, since they are the ones who were stuck.
 */
export async function savePaymentDetails(
  submissionId: string,
  entries: Record<string, string>,
): Promise<SubmitPayrollResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Not authenticated");

  const submission = await prisma.payrollSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      userId: true,
      status: true,
      paymentMethod: true,
      period: { select: { year: true, month: true } },
    },
  });
  // Not yours is indistinguishable from not there — this is a prompt anyone
  // can be shown, so it says nothing about whose request an id belongs to.
  if (!submission || submission.userId !== userId) {
    return fail("That request is no longer available.");
  }
  if (submission.status === "PROCESSED" || submission.status === "EXPIRED") {
    return fail(
      submission.status === "PROCESSED"
        ? "That request has already been paid — send anything new to finance directly."
        : "That request expired. File again in the next window.",
    );
  }

  // Read only the fields this method asks for, exactly as the filing form does.
  const details: PaymentDetails = {};
  for (const field of paymentFieldsFor(submission.paymentMethod)) {
    const value = String(entries[field.key] ?? "").trim().slice(0, field.maxLength);
    if (value) details[field.key] = value;
  }
  const detailsError = validatePaymentDetails(submission.paymentMethod, details);
  if (detailsError) return fail(detailsError);

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.payrollSubmission.update({
      where: { id: submission.id },
      data: { paymentDetails: details as Prisma.InputJsonValue },
    });
    await regenerateInvoicePdf(tx, submission.id);

    const reviewers = await reviewerUsers(tx, financeEmails());
    await notify(
      tx,
      reviewers.map((r) => r.id),
      "PAYROLL",
      `${me?.name ?? me?.email ?? "Someone"} added their payment details for ${payrollPeriodLabel(
        submission.period.year,
        submission.period.month,
      )}.`,
    );
  });

  revalidatePath("/payroll");
  revalidatePath("/payroll/panel");
  revalidatePath("/dashboard");
  return { ok: true };
}
