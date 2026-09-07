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
import { regenerateInvoicePdf } from "@/lib/payrollInvoice";
import {
  computeNet,
  formatCents,
  MAX_PAYROLL_AMOUNT,
  MAX_PAYROLL_AMOUNT_CENTS,
  MAX_PAYROLL_EXPENSES,
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

/**
 * One line's new amount, as the reviewer typed it. `null` drops the line.
 */
export type FinanceLineEdit = { id: string; amount: number | null };

export type FinanceExpenseEdit = {
  /** An existing line to keep (its receipt survives), or null for a new one. */
  id: string | null;
  label: string;
  amountCents: number;
};

export type FinanceEdit = {
  /** Required. Goes in the audit trail and in what the filer is told. */
  reason: string;
  baseSalary: number;
  expenses: FinanceExpenseEdit[];
  bonusLines: FinanceLineEdit[];
  fineLines: FinanceLineEdit[];
};

/**
 * Revise a filed request's figures before paying it.
 *
 * The alternative was declining it back for a $5 receipt typo, which costs the
 * filer a refile and everyone a round trip. So the reviewer can correct it in
 * place — every line, not just the ones the filer typed — with a required
 * reason, the filer told what changed, and the whole diff in the audit trail.
 * It stays on this desk: an edit here does not send the request back to the
 * lead, because finance is the last word on it and a second wait would be
 * paid for by the person owed the money.
 *
 * Two lines are bound to LEDGER ROWS, and this is where that binding is kept
 * honest — payment settles real fines and consumes real bonuses from these
 * lines (processSubmission), so a snapshot that drifts from its source either
 * refuses to pay or pays the wrong thing:
 *
 *   • A FINE line may be lowered to anything down to zero, and needs no ledger
 *     write: payment already settles exactly the line amount against that
 *     penalty, so a smaller line simply deducts less this month and leaves the
 *     rest outstanding, to roll into the next snapshot like any unpaid fine.
 *     It may NOT exceed what the fine still owes — that would settle money
 *     that isn't owed, and processSubmission refuses it outright.
 *   • A BONUS line is different: payment stamps the whole source bonus as paid
 *     out regardless of the line, so paying $100 of a $300 bonus would consume
 *     all $300 and lose $200 with no record. processSubmission already refuses
 *     a line whose amount has drifted from its bonus, which leaves exactly one
 *     coherent reading of "pay less than the bonus says": the bonus was worth
 *     less. So lowering the line revises the bonus itself to match, and the
 *     recipient is told, on the same path an admin's correction takes
 *     (editBonus). Dropping the line instead leaves the bonus untouched and
 *     unconsumed — it returns to the ledger and snapshots into next month.
 */
export async function editSubmissionAsFinance(
  submissionId: string,
  edit: FinanceEdit,
): Promise<FinanceActionResult> {
  const session = await auth();
  if (!isPayrollOpenFor(session?.user?.email)) {
    return fail("Payroll is closed right now.");
  }
  const actorId = await requireFinance(session);

  const reason = edit.reason.trim().slice(0, 1000);
  if (!reason) {
    return fail("Say what you changed and why — the filer is told.");
  }

  const sub = await prisma.payrollSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      status: true,
      baseSalary: true,
      bonusesTotal: true,
      finesTotal: true,
      expensesTotalCents: true,
      netTotal: true,
      user: { select: { id: true, name: true, email: true } },
      period: { select: { year: true, month: true } },
      bonusLines: {
        select: {
          id: true,
          amount: true,
          note: true,
          bonusId: true,
          bonus: { select: { id: true, amount: true, payrollSubmissionId: true } },
        },
      },
      fineLines: {
        select: {
          id: true,
          amount: true,
          type: true,
          penaltyId: true,
          penalty: { select: { id: true, amount: true, paidAmount: true, paidAt: true } },
        },
      },
      expenses: { select: { id: true, label: true, amountCents: true } },
    },
  });
  if (!sub) return fail("Request not found.");
  // Only money still on this desk. A paid request is a record of a payment
  // that happened, and one waiting on its lead isn't finance's to rewrite.
  if (!PAYABLE.includes(sub.status)) {
    return fail(
      sub.status === "WITH_LEAD"
        ? "That request is still with its department lead — send it back if it needs changing."
        : "Only a request awaiting payment can be edited — reload.",
    );
  }

  // ----- Validate every line before writing anything -----

  const baseSalary = Math.round(Number(edit.baseSalary));
  if (!Number.isFinite(baseSalary) || baseSalary < 0 || baseSalary > MAX_PAYROLL_AMOUNT) {
    return fail("Enter a valid base salary (whole dollars).");
  }

  if (edit.expenses.length > MAX_PAYROLL_EXPENSES) {
    return fail(`At most ${MAX_PAYROLL_EXPENSES} expense lines.`);
  }
  const ownExpenseIds = new Set(sub.expenses.map((e) => e.id));
  const expenses: (FinanceExpenseEdit & { keptId: string | null })[] = [];
  for (const [i, raw] of edit.expenses.entries()) {
    const label = String(raw.label ?? "").trim().slice(0, 120);
    const amountCents = Math.round(Number(raw.amountCents));
    if (!label) return fail(`Expense ${i + 1} needs a label.`);
    if (!Number.isFinite(amountCents) || amountCents < 0 || amountCents > MAX_PAYROLL_AMOUNT_CENTS) {
      return fail(`Expense “${label}” needs a valid amount.`);
    }
    // An id is honoured only for a line that really belongs to THIS request —
    // a forged one can't reach another person's expense (the submitPayroll
    // rule, same reason).
    const keptId = raw.id && ownExpenseIds.has(raw.id) ? raw.id : null;
    expenses.push({ ...raw, label, amountCents, keptId });
  }

  const bonusEdits: { lineId: string; amount: number | null; bonusId: string | null; wasAmount: number }[] = [];
  for (const e of edit.bonusLines) {
    const line = sub.bonusLines.find((l) => l.id === e.id);
    if (!line) return fail("That request changed while you were editing — reload.");
    const amount = e.amount === null ? null : Math.round(Number(e.amount));
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      return fail("Enter a valid bonus amount.");
    }
    // Raising a bonus line is not a correction to the paycheck, it is a new
    // award — and one this action cannot make honestly, because the money has
    // to exist on the ledger before a snapshot can pay it. Award it on /admin
    // (or /department) and the next snapshot carries it.
    if (amount !== null && amount > line.amount) {
      return fail(
        "A bonus line can't be raised here — award the extra on /admin and it lands on the next filing.",
      );
    }
    if (line.bonus && line.bonus.payrollSubmissionId) {
      return fail("One of these bonuses has already been paid out — reload.");
    }
    bonusEdits.push({
      lineId: line.id,
      amount: amount === 0 ? null : amount,
      bonusId: line.bonusId,
      wasAmount: line.amount,
    });
  }

  const fineEdits: { lineId: string; amount: number | null; wasAmount: number }[] = [];
  for (const e of edit.fineLines) {
    const line = sub.fineLines.find((l) => l.id === e.id);
    if (!line) return fail("That request changed while you were editing — reload.");
    const amount = e.amount === null ? null : Math.round(Number(e.amount));
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      return fail("Enter a valid fine amount.");
    }
    // Never more than the fine still owes: payment writes exactly this figure
    // against exactly that penalty, so a larger one would settle money nobody
    // owes — and processSubmission would refuse to pay the request at all.
    const outstanding = line.penalty
      ? line.penalty.amount - line.penalty.paidAmount
      : line.amount;
    if (amount !== null && amount > outstanding) {
      return fail(
        `A fine line can't exceed what the fine still owes (${formatMoney(outstanding)}).`,
      );
    }
    if (line.penalty?.paidAt) {
      return fail("One of these fines was settled outside payroll — decline the request instead.");
    }
    fineEdits.push({
      lineId: line.id,
      amount: amount === 0 ? null : amount,
      wasAmount: line.amount,
    });
  }

  // ----- The new figures -----

  const bonusesTotal = bonusEdits.reduce((sum, b) => sum + (b.amount ?? 0), 0);
  const finesTotal = fineEdits.reduce((sum, f) => sum + (f.amount ?? 0), 0);
  const expensesTotalCents = expenses.reduce((sum, e) => sum + e.amountCents, 0);
  if (expensesTotalCents > MAX_PAYROLL_AMOUNT_CENTS) {
    return fail("Expenses total is too large.");
  }
  const netTotal = computeNet({
    baseSalary,
    bonusesTotal,
    finesTotal,
    expensesTotalCents,
  });
  if (netTotal < 0) {
    return fail("The fine deductions exceed the rest of the request — the total can't go below zero.");
  }

  // What changed, in the filer's terms. Built before the write so it describes
  // the move rather than the result, and empty when nothing actually moved.
  const changes: string[] = [];
  if (baseSalary !== sub.baseSalary) {
    changes.push(`base salary ${formatMoney(sub.baseSalary)} → ${formatMoney(baseSalary)}`);
  }
  if (bonusesTotal !== sub.bonusesTotal) {
    changes.push(`compensations ${formatMoney(sub.bonusesTotal)} → ${formatMoney(bonusesTotal)}`);
  }
  if (finesTotal !== sub.finesTotal) {
    changes.push(`fine deductions ${formatMoney(sub.finesTotal)} → ${formatMoney(finesTotal)}`);
  }
  if (expensesTotalCents !== sub.expensesTotalCents) {
    changes.push(
      `expenses ${formatCents(sub.expensesTotalCents)} → ${formatCents(expensesTotalCents)}`,
    );
  }
  if (changes.length === 0) return fail("Nothing changed.");

  const label = payrollPeriodLabel(sub.period.year, sub.period.month);
  const who = sub.user.name ?? sub.user.email ?? "Someone";
  const me = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true },
  });
  const meName = me?.name ?? me?.email ?? "Finance";
  const summary = `${changes.join(", ")} (net ${formatMoney(sub.netTotal)} → ${formatMoney(netTotal)})`;

  await prisma.$transaction(async (tx) => {
    // Expenses: kept lines update in place so their receipt survives; the rest
    // are replaced. (Finance never attaches a receipt — that is the filer's
    // evidence, and a line without one says so.)
    const keptIds = new Set(
      expenses.map((e) => e.keptId).filter((id): id is string => id !== null),
    );
    const dropIds = sub.expenses.filter((e) => !keptIds.has(e.id)).map((e) => e.id);
    if (dropIds.length > 0) {
      await tx.payrollExpense.deleteMany({ where: { id: { in: dropIds } } });
    }
    for (const [i, e] of expenses.entries()) {
      if (e.keptId) {
        await tx.payrollExpense.update({
          where: { id: e.keptId },
          data: { label: e.label, amountCents: e.amountCents, position: i + 1 },
        });
      } else {
        await tx.payrollExpense.create({
          data: {
            submissionId: sub.id,
            label: e.label,
            amountCents: e.amountCents,
            position: i + 1,
          },
        });
      }
    }

    // Bonus lines, and the ledger rows they are bound to (see the doc above).
    for (const b of bonusEdits) {
      if (b.amount === null) {
        await tx.payrollBonusLine.delete({ where: { id: b.lineId } });
        continue;
      }
      if (b.amount === b.wasAmount) continue;
      await tx.payrollBonusLine.update({
        where: { id: b.lineId },
        data: { amount: b.amount },
      });
      if (b.bonusId) {
        // Kept in step, or payment refuses the request ("changed amount after
        // filing"). The recipient hears it as the bonus revision it is.
        await tx.bonus.update({
          where: { id: b.bonusId },
          data: { amount: b.amount },
        });
        await notify(
          tx,
          sub.user.id,
          "BONUS",
          `Your ${formatMoney(b.wasAmount)} bonus was changed to ${formatMoney(b.amount)} by ${meName} — “${reason}”.`,
        );
      }
    }

    // Fine lines: the snapshot only. A smaller line deducts less from this
    // paycheck and leaves the remainder owed.
    for (const f of fineEdits) {
      if (f.amount === null) {
        await tx.payrollFineLine.delete({ where: { id: f.lineId } });
      } else if (f.amount !== f.wasAmount) {
        await tx.payrollFineLine.update({
          where: { id: f.lineId },
          data: { amount: f.amount },
        });
      }
    }

    await tx.payrollSubmission.update({
      where: { id: sub.id },
      data: { baseSalary, bonusesTotal, finesTotal, expensesTotalCents, netTotal },
    });
    // The invoice is what gets paid from and emailed, so it is rebuilt from
    // the row rather than left describing the figures that were replaced.
    await regenerateInvoicePdf(tx, sub.id);

    // No status change — the event is here so the trail carries the revision.
    await applyTransition(tx, {
      submissionId: sub.id,
      from: sub.status,
      to: sub.status,
      actorId,
      note: `Revised by ${meName}: ${summary} — “${reason}”`,
    });

    await notify(
      tx,
      sub.user.id,
      "PAYROLL",
      `${meName} revised your ${label} pay request before paying it: ${summary} — “${reason}”.`,
    );
    await tellOtherReviewers(
      tx,
      `${who}'s ${label} request was revised by ${meName}: ${summary}.`,
      [actorId, sub.user.id],
    );
  });

  if (sub.user.email) {
    const pdf = await prisma.payrollPdf.findUnique({
      where: { submissionId: sub.id },
      select: { bytes: true },
    });
    await sendEmail({
      to: sub.user.email,
      subject: `Payroll: your ${label} request was revised — ${formatMoney(netTotal)} to be paid`,
      text:
        `${meName} revised your ${label} pay request before paying it:\n\n${summary}\n\n“${reason}”\n\n` +
        `The revised invoice is attached. If this isn't right, reply to ${meName} before it is paid — ` +
        `nothing has been paid out yet.\n\n${appUrl()}/payroll\n\n— FreshWeek`,
      attachments: pdf
        ? [{ filename: `${who} — ${label}.pdf`, bytes: pdf.bytes }]
        : undefined,
    });
  }

  revalidatePanels();
  return { ok: true };
}
