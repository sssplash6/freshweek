"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/penalties";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";
import {
  applyTransition,
  appUrl,
  expireLapsedSubmissions,
  financeEmails,
  formatTashkent,
  processSubmission,
  requireFinance,
  resubmitWindowFor,
  reviewerUsers,
} from "@/lib/payroll";
import {
  payrollPeriodLabel,
  isPayrollOpenFor,
  type PayrollStatus,
} from "@/lib/payrollTypes";

export type FinanceActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): FinanceActionResult => ({ ok: false, error });

/**
 * What finance may PAY, and what finance may DECLINE. They are deliberately
 * different sets, and the difference IS the lead gate.
 *
 * SUBMITTED is a request the lead has passed on (or one whose filer has no
 * lead — lib/payrollApproval.ts). APPROVED_BY_ADMIN is the legacy half: rows
 * the removed admin stage had already approved when it went away. Both are the
 * same job, unpaid money on the reviewer's desk, and both are payable.
 *
 * WITH_LEAD is not payable by anyone, ever: that is the whole point of the
 * gate, and there is no override — a request nobody's lead has looked at
 * cannot be paid, however senior the person asking.
 *
 * It IS declinable, and that asymmetry is load-bearing. A request stuck on an
 * absent lead's desk blocks its filer from ever filing again (WITH_LEAD is in
 * IN_FLIGHT_STATUSES), so something has to be able to move it. Sending it back
 * to the filer is not paying it and not approving it — it returns the request
 * to the one person who can always act on it — so finance keeps that exit
 * while the gate itself stays absolute.
 */
const PAYABLE: PayrollStatus[] = ["SUBMITTED", "APPROVED_BY_ADMIN"];
const DECLINABLE: PayrollStatus[] = [
  "WITH_LEAD",
  "SUBMITTED",
  "APPROVED_BY_ADMIN",
];

/** The views a panel action changes, refreshed together. */
function revalidatePanels() {
  revalidatePath("/payroll");
  // The three reviewer URLs collapsed into one panel; the old paths are
  // 307s now and have nothing of their own to refresh.
  revalidatePath("/payroll/panel");
  revalidatePath("/penalties"); // the fine deduction lands there as a receipt
}

async function loadForReview(submissionId: string) {
  return prisma.payrollSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      status: true,
      netTotal: true,
      graceDayUsed: true,
      user: { select: { id: true, name: true, email: true } },
      period: {
        select: { id: true, year: true, month: true, filingClosesAt: true },
      },
    },
  });
}

/** In-app notice to the other reviewers, so a queue isn't worked twice. */
async function tellOtherReviewers(
  db: Parameters<typeof notify>[0],
  message: string,
  exceptIds: (string | null)[],
) {
  const others = await reviewerUsers(db, financeEmails());
  await notify(
    db,
    others.map((r) => r.id).filter((id) => !exceptIds.includes(id)),
    "PAYROLL",
    message,
  );
}

/**
 * Decline a pay request back to its owner. The note is the whole point — it's
 * what the employee fixes — so it's required.
 *
 * Declining takes nothing off the filer's clock: the resubmit deadline is the
 * period's filing cutoff, exactly the deadline they already had. Only a
 * decline on the window's last day moves it, one day past the cutoff, and that
 * spends the once-per-period grace day — ORed in below because the flag
 * records that the period ever ran past its cutoff, not that this particular
 * decline did. resubmitWindowFor returns the same deadline for every later
 * decline, so a re-decline can't extend the window or cut it short.
 *
 * This is also the recovery path when a payment is refused for snapshot drift
 * (see processSubmission): the numbers are stale, and only the filer can refile
 * them fresh. It replaces finance's old send-back, which returned a request to
 * an admin stage that no longer exists.
 */
export async function declineSubmission(
  submissionId: string,
  note: string,
): Promise<FinanceActionResult> {
  const session = await auth();
  if (!isPayrollOpenFor(session?.user?.email)) {
    return fail("Payroll is closed right now.");
  }
  const actorId = await requireFinance(session);

  const cleanNote = note.trim().slice(0, 1000);
  if (!cleanNote) return fail("A note is required — say what needs fixing.");

  const sub = await loadForReview(submissionId);
  if (!sub) return fail("Request not found.");
  if (!DECLINABLE.includes(sub.status)) {
    return fail("Only a request still in review can be declined — reload.");
  }

  const now = new Date();
  const window = resubmitWindowFor(now, sub.period);
  const label = payrollPeriodLabel(sub.period.year, sub.period.month);
  // A held-open month hands back no deadline (resubmitWindowFor), so the two
  // messages below say what actually bounds the refile — the month closing —
  // rather than naming a date nobody has set yet.
  const byWhen = window.deadline
    ? `by ${formatTashkent(window.deadline)}`
    : `whenever you like — ${label} is being held open, so there's no deadline until it closes`;

  await prisma.$transaction(async (tx) => {
    await applyTransition(tx, {
      submissionId: sub.id,
      from: sub.status,
      to: "DECLINED",
      actorId,
      note: cleanNote,
      data: {
        resubmitDeadline: window.deadline,
        graceDayUsed: sub.graceDayUsed || window.usesGraceDay,
      },
    });
    await notify(
      tx,
      sub.user.id,
      "PAYROLL",
      `Your ${label} pay request was declined — “${cleanNote}”. Resubmit ${byWhen}.`,
    );
    // In-app only for the other reviewers — no email (the employee gets both).
    await tellOtherReviewers(
      tx,
      `${sub.user.name ?? sub.user.email}'s ${label} request was declined — “${cleanNote}”.`,
      [actorId, sub.user.id],
    );
  });

  if (sub.user.email) {
    await sendEmail({
      to: sub.user.email,
      subject: `Payroll: your ${label} request was declined`,
      text:
        `Your ${label} pay request was declined:\n\n“${cleanNote}”\n\n` +
        `Fix it and resubmit ${byWhen}${window.deadline ? " — after that the filing rolls into next month's cycle" : ""}.\n\n` +
        `Your form is reopened with everything prefilled: ${appUrl()}/payroll\n\n— FreshWeek`,
    });
  }

  revalidatePanels();
  return { ok: true };
}

/**
 * One payment, from a desk that has already been established as the
 * reviewer's: re-verify the snapshot against the live ledger, write the fine
 * deduction back as one PAYROLL FinePayment batch, stamp the bonuses consumed
 * and move the request to PROCESSED (lib/payroll.ts processSubmission), then
 * tell the filer and the other reviewers.
 *
 * It does no session work and no revalidation, because it is shared by the
 * single row's button and the batch below, and those differ in exactly that:
 * a batch checks the role once and refreshes the page once, at the end. The
 * caller MUST have gone through `requireFinance` and the closed-payroll gate
 * before calling this — `actorId` is the proof it did.
 *
 * Every failure here is per-request and returns rather than throws: in a batch
 * one stale snapshot must not take the other payments down with it. Each
 * payment is its own transaction for the same reason — money that has moved
 * for one person is never rolled back because the next person's numbers had
 * drifted.
 */
type PayOutcome =
  | { ok: true; name: string }
  | { ok: false; name: string; error: string };

async function payOne(
  submissionId: string,
  actorId: string,
): Promise<PayOutcome> {
  const sub = await loadForReview(submissionId);
  if (!sub) {
    return { ok: false, name: "That request", error: "Request not found." };
  }
  const who = sub.user.name ?? sub.user.email ?? "Someone";
  if (!PAYABLE.includes(sub.status)) {
    return {
      ok: false,
      name: who,
      // Name the gate rather than saying "reload": a WITH_LEAD row is not a
      // stale screen, it is a request whose lead hasn't passed it yet, and
      // "reload" would send the reviewer looking for a problem on their end.
      error:
        sub.status === "WITH_LEAD"
          ? "Their department lead hasn't approved this yet — it can't be paid until they do. Send it back if it's stuck."
          : "Only a request awaiting payment can be confirmed — reload.",
    };
  }

  try {
    const result = await processSubmission({ submissionId, actorId });
    if (!result.ok) {
      return {
        ok: false,
        name: who,
        error: `The ledger moved after filing — ${result.reasons.join(" ")} Decline it so they refile with a fresh snapshot.`,
      };
    }
  } catch (e) {
    if (e instanceof Error) return { ok: false, name: who, error: e.message };
    throw e;
  }

  const label = payrollPeriodLabel(sub.period.year, sub.period.month);

  await notify(
    prisma,
    sub.user.id,
    "PAYROLL",
    `Your ${label} pay request was processed — ${formatMoney(sub.netTotal)} paid out. Fine deductions were recorded on your ledger.`,
  );
  await tellOtherReviewers(
    prisma,
    `${who}'s ${label} pay request was processed — ${formatMoney(sub.netTotal)} paid.`,
    [actorId, sub.user.id],
  );

  if (sub.user.email) {
    const pdf = await prisma.payrollPdf.findUnique({
      where: { submissionId: sub.id },
      select: { bytes: true },
    });
    await sendEmail({
      to: sub.user.email,
      subject: `Payroll: your ${label} request was paid — ${formatMoney(sub.netTotal)}`,
      text:
        `Your ${label} pay request was processed: ${formatMoney(sub.netTotal)} paid out. ` +
        `Any fine deductions were recorded on your ledger.\n\nThe final invoice is attached.\n\n— FreshWeek`,
      attachments: pdf
        ? [{ filename: `${who} — ${label}.pdf`, bytes: pdf.bytes }]
        : undefined,
    });
  }

  return { ok: true, name: who };
}

/**
 * Confirm the payment: the snapshot is re-verified against the live ledger,
 * the fine deduction is written back as one PAYROLL FinePayment batch, the
 * bonuses are stamped consumed, and the request goes PROCESSED (see
 * lib/payroll.ts processSubmission). If the ledger moved after filing, this
 * refuses with the exact reasons instead of paying wrong amounts — decline it
 * so the person refiles with a fresh snapshot.
 */
export async function confirmPayment(
  submissionId: string,
): Promise<FinanceActionResult> {
  const session = await auth();
  if (!isPayrollOpenFor(session?.user?.email)) {
    return fail("Payroll is closed right now.");
  }
  const actorId = await requireFinance(session);
  await expireLapsedSubmissions();

  const outcome = await payOne(submissionId, actorId);
  if (!outcome.ok) return fail(outcome.error);

  revalidatePanels();
  return { ok: true };
}

/**
 * The most payments one call will make. A month of payroll is a couple of
 * dozen requests, so this is far above any real batch and only there to bound
 * what a hand-made POST can ask the server to do in one request — each payment
 * is a transaction plus an email.
 */
const MAX_BATCH = 100;

export type BatchPaymentResult =
  | { ok: false; error: string }
  | {
      ok: true;
      paid: number;
      /** Per request, why it did not go through — named, so the bar can say who. */
      failed: { id: string; name: string; error: string }[];
    };

/**
 * Confirm several payments in one go — the reviewer ticks a run of rows (say,
 * everything paid from one source) and settles them together.
 *
 * PARTIAL SUCCESS IS THE NORMAL OUTCOME, not an error case. Each request is
 * paid in its own transaction, so a stale snapshot or a row someone else just
 * decided fails alone and the rest still settle; the result names every
 * failure so the panel can show which people still need a decision. There is
 * no all-or-nothing mode on purpose — refusing a whole batch because one
 * person's fines moved would mean un-paying people the ledger was happy with.
 *
 * The ids come from the client, so they are treated as a list of references
 * and nothing more: the role is checked once here, and `payOne` re-reads every
 * request's own status before it moves any money.
 */
export async function confirmPayments(
  submissionIds: string[],
): Promise<BatchPaymentResult> {
  const session = await auth();
  if (!isPayrollOpenFor(session?.user?.email)) {
    return { ok: false, error: "Payroll is closed right now." };
  }
  const actorId = await requireFinance(session);

  const ids = [
    ...new Set(
      (Array.isArray(submissionIds) ? submissionIds : []).filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
  if (ids.length === 0) return { ok: false, error: "Nothing selected." };
  if (ids.length > MAX_BATCH) {
    return { ok: false, error: `Too many at once — pay at most ${MAX_BATCH}.` };
  }

  await expireLapsedSubmissions();

  // One at a time: each payment writes a FinePayment batch against the same
  // ledger the next one is about to re-check, and each sends an email.
  let paid = 0;
  const failed: { id: string; name: string; error: string }[] = [];
  for (const id of ids) {
    const outcome = await payOne(id, actorId);
    if (outcome.ok) paid += 1;
    else failed.push({ id, name: outcome.name, error: outcome.error });
  }

  if (paid > 0) revalidatePanels();
  return { ok: true, paid, failed };
}
