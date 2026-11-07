"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/penalties";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";
import {
  applyTransition,
  approveParts,
  appUrl,
  expireLapsedSubmissions,
  financeEmails,
  formatTashkent,
  resubmitWindowFor,
  reviewerUsers,
  type PartLine,
} from "@/lib/payroll";
import {
  approvingLeadsFor,
  canApprovePayroll,
} from "@/lib/payrollApproval";
import {
  anyPartPaid,
  approvableDepartments,
  ledDepartmentIds,
  seatsOf,
  splitLine,
} from "@/lib/payrollParts";
import { payrollPeriodLabel, isPayrollOpenFor } from "@/lib/payrollTypes";

export type LeadActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): LeadActionResult => ({ ok: false, error });

/** The views a lead's decision changes, refreshed together. */
function revalidateAll() {
  revalidatePath("/payroll"); // the filer's own page
  revalidatePath("/payroll/team"); // this page
  revalidatePath("/payroll/panel"); // finance's queue gains (or loses) a row
  revalidatePath("/department"); // the lead's "waiting on you" count
}

/**
 * Load a request for a lead's decision, and prove the lead may make it.
 *
 * Two failures, one message: a request that isn't on this lead's desk and one
 * that doesn't exist are answered identically, because the id comes off a
 * page and a distinct "not yours" would confirm that some other department's
 * request exists and what its id is.
 */
async function loadForApproval(actorId: string, submissionId: string) {
  const sub = await prisma.payrollSubmission.findUnique({
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
      parts: { select: { paidAt: true } },
    },
  });
  if (!sub) return null;
  if (!(await canApprovePayroll(prisma, actorId, sub.user.id))) return null;
  return sub;
}

/**
 * Pass a team member's request on to finance.
 *
 * This is the gate opening, and it is the only thing that opens it: finance
 * cannot pay a WITH_LEAD request at all (PAYABLE in ../finance/actions.ts), so
 * until a lead does this, nothing is payable. Which is also why the hand-off
 * mail with the invoice is sent from here rather than at filing — finance's
 * inbox should hold requests it can act on, not ones still waiting on someone
 * else.
 *
 * A lead approves the request AS FILED. There is no partial approval and no
 * editing of someone else's claim: if a line is wrong, send it back and let
 * the person who filed it fix it, which keeps the request theirs.
 */
export async function approveAsLead(
  submissionId: string,
): Promise<LeadActionResult> {
  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) throw new Error("Not authenticated");
  if (!isPayrollOpenFor(session?.user?.email)) {
    return fail("Payroll is closed right now.");
  }
  await expireLapsedSubmissions();

  const sub = await loadForApproval(actorId, submissionId);
  if (!sub) return fail("That request isn't waiting on you.");
  if (sub.status !== "WITH_LEAD") {
    return fail(
      "That request has already moved on — reload to see where it is.",
    );
  }

  const label = payrollPeriodLabel(sub.period.year, sub.period.month);
  const who = sub.user.name ?? sub.user.email ?? "Someone";
  const me = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true },
  });
  const meName = me?.name ?? me?.email ?? "Their lead";

  if (sub.parts.length > 0) {
    return approveSplit(sub, actorId, { label, who, meName });
  }

  await prisma.$transaction(async (tx) => {
    await applyTransition(tx, {
      submissionId: sub.id,
      from: "WITH_LEAD",
      to: "SUBMITTED",
      actorId,
    });
    const reviewers = await reviewerUsers(tx, financeEmails());
    const reviewerIds = reviewers.map((r) => r.id).filter((id) => id !== actorId);
    await notify(
      tx,
      reviewerIds,
      "PAYROLL",
      `${who}: ${label} pay request approved by ${meName} — ${formatMoney(sub.netTotal)} net, ready to pay.`,
    );
    // The filer hears it from their own lead, not just from a status change.
    await notify(
      tx,
      sub.user.id === actorId ? [] : sub.user.id,
      "PAYROLL",
      `${meName} approved your ${label} pay request — it's with finance now.`,
    );
    // Co-leads of the same department share this desk; tell them it's done so
    // two people don't work the same row. Anyone who just got the finance
    // line is skipped — a reviewer who also leads a department would
    // otherwise read the same approval twice, once per hat.
    const coLeads = await approvingLeadsFor(tx, sub.user.id);
    await notify(
      tx,
      coLeads
        .map((l) => l.id)
        .filter((id) => id !== actorId && !reviewerIds.includes(id)),
      "PAYROLL",
      `${meName} approved ${who}'s ${label} pay request.`,
    );
  });

  // The hand-off: whoever pays works from the invoice, so it rides along.
  const pdf = await prisma.payrollPdf.findUnique({
    where: { submissionId: sub.id },
    select: { bytes: true },
  });
  await Promise.all(
    financeEmails().map((to) =>
      sendEmail({
        to,
        subject: `Payroll: ${who}'s ${label} request approved by their lead — ${formatMoney(sub.netTotal)} to pay`,
        text:
          `${meName} approved ${who}'s ${label} pay request — ${formatMoney(sub.netTotal)} net.\n\n` +
          `The invoice is attached. Pay it, or decline it back with a note: ${appUrl()}/payroll/panel\n\n— FreshWeek`,
        attachments: pdf
          ? [{ filename: `${who} — ${label}.pdf`, bytes: pdf.bytes }]
          : undefined,
      }),
    ),
  );

  revalidateAll();
  return { ok: true };
}

/**
 * Send a team member's request back to them, with a note saying what to fix.
 *
 * Deliberately the same DECLINED path finance uses: the filer's form reopens
 * prefilled, the resubmit deadline is the one resubmitWindowFor already
 * computes (their period's cutoff, plus the once-per-period grace day when the
 * send-back lands on the window's last day), and the lapse sweep settles it if
 * they never come back. A second, lead-shaped decline would have been a second
 * set of clock rules to keep in step with that one.
 *
 * Finance is not told. They never saw this request — it was on the lead's desk
 * — and paging them about a round trip they play no part in is noise.
 */
export async function sendBackAsLead(
  submissionId: string,
  note: string,
): Promise<LeadActionResult> {
  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) throw new Error("Not authenticated");
  if (!isPayrollOpenFor(session?.user?.email)) {
    return fail("Payroll is closed right now.");
  }
  const cleanNote = note.trim().slice(0, 1000);
  if (!cleanNote) return fail("A note is required — say what needs fixing.");
  await expireLapsedSubmissions();

  const sub = await loadForApproval(actorId, submissionId);
  if (!sub) return fail("That request isn't waiting on you.");
  if (sub.status !== "WITH_LEAD") {
    return fail(
      "That request has already moved on — reload to see where it is.",
    );
  }
  // Finance can pay a part past its lead (FINANCE_PAYABLE). Once money has
  // moved, sending the request back would reopen numbers already paid out.
  if (anyPartPaid(sub.parts)) {
    return fail(
      "Part of this request has already been paid, so it can't be sent back — ask finance.",
    );
  }

  const label = payrollPeriodLabel(sub.period.year, sub.period.month);
  const who = sub.user.name ?? sub.user.email ?? "Someone";
  const me = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true },
  });
  const meName = me?.name ?? me?.email ?? "Their lead";

  const now = new Date();
  const window = resubmitWindowFor(now, sub.period);
  // A held-open month hands back no deadline, so say what actually bounds the
  // refile rather than naming a date nobody has set (see resubmitWindowFor).
  const byWhen = window.deadline
    ? `by ${formatTashkent(window.deadline)}`
    : `whenever you like — ${label} is being held open, so there's no deadline until it closes`;

  await prisma.$transaction(async (tx) => {
    await applyTransition(tx, {
      submissionId: sub.id,
      from: "WITH_LEAD",
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
      `${meName} sent your ${label} pay request back — “${cleanNote}”. Resubmit ${byWhen}.`,
    );
    const coLeads = await approvingLeadsFor(tx, sub.user.id);
    await notify(
      tx,
      coLeads.map((l) => l.id).filter((id) => id !== actorId),
      "PAYROLL",
      `${meName} sent ${who}'s ${label} pay request back — “${cleanNote}”.`,
    );
  });

  if (sub.user.email) {
    await sendEmail({
      to: sub.user.email,
      subject: `Payroll: your ${label} request was sent back by ${meName}`,
      text:
        `${meName}, who leads your department, sent your ${label} pay request back:\n\n“${cleanNote}”\n\n` +
        `Fix it and resubmit ${byWhen}${window.deadline ? " — after that the filing rolls into next month's cycle" : ""}. ` +
        `It comes back to them for approval, then goes to finance.\n\n` +
        `Your form is reopened with everything prefilled: ${appUrl()}/payroll\n\n— FreshWeek`,
    });
  }

  revalidateAll();
  return { ok: true };
}

/**
 * Approve this lead's part of a request split by department (PayrollPart).
 *
 * The lead approves only the parts of departments they lead — the other
 * department's money is its own lead's to vouch for — and the request goes on
 * to finance only when the last part is approved (approveParts in
 * lib/payroll.ts). Until then the filer is told whose approval is still
 * outstanding, so a half-approved request doesn't read as a stuck one.
 */
async function approveSplit(
  sub: NonNullable<Awaited<ReturnType<typeof loadForApproval>>>,
  actorId: string,
  ctx: { label: string; who: string; meName: string },
): Promise<LeadActionResult> {
  const { label, who, meName } = ctx;
  const [led, seats] = await Promise.all([
    ledDepartmentIds(prisma, actorId),
    seatsOf(prisma, sub.user.id),
  ]);
  const scope = approvableDepartments(actorId, led, sub.user.id, seats);
  const line = (parts: PartLine[]) =>
    splitLine(parts, parts.map((p) => p.amount), formatMoney);

  let toFinance: boolean;
  try {
    toFinance = await prisma.$transaction(async (tx) => {
      const step = await approveParts(tx, {
        submissionId: sub.id,
        actorId,
        departmentIds: scope,
      });
      const filer = sub.user.id === actorId ? [] : sub.user.id;
      let reviewerIds: string[] = [];
      if (step.toFinance) {
        reviewerIds = (await reviewerUsers(tx, financeEmails()))
          .map((r) => r.id)
          .filter((id) => id !== actorId);
        await notify(
          tx,
          reviewerIds,
          "PAYROLL",
          `${who}: ${label} pay request approved by every department — ${formatMoney(sub.netTotal)} net, ready to pay.`,
        );
        await notify(
          tx,
          filer,
          "PAYROLL",
          `${meName} approved ${line(step.acted)} — every part of your ${label} pay request is approved, and it's with finance now.`,
        );
      } else {
        await notify(
          tx,
          filer,
          "PAYROLL",
          `${meName} approved ${line(step.acted)} of your ${label} pay request — still waiting on ${line(step.remaining)}.`,
        );
      }
      // Co-leads of the same department share its desk; tell them it's done.
      const actedOn = new Set(step.acted.map((p) => p.departmentName));
      const coLeads = await approvingLeadsFor(tx, sub.user.id);
      await notify(
        tx,
        coLeads
          .filter((l) => l.departments.some((d) => actedOn.has(d)))
          .map((l) => l.id)
          .filter((id) => id !== actorId && !reviewerIds.includes(id)),
        "PAYROLL",
        `${meName} approved ${line(step.acted)} of ${who}'s ${label} pay request.`,
      );
      return step.toFinance;
    });
  } catch (e) {
    if (e instanceof Error) return fail(e.message);
    throw e;
  }

  if (toFinance) {
    const pdf = await prisma.payrollPdf.findUnique({
      where: { submissionId: sub.id },
      select: { bytes: true },
    });
    await Promise.all(
      financeEmails().map((to) =>
        sendEmail({
          to,
          subject: `Payroll: ${who}'s ${label} request approved by every department — ${formatMoney(sub.netTotal)} to pay`,
          text:
            `${who}'s ${label} pay request is split by department, and every department's lead has now approved their part — ${formatMoney(sub.netTotal)} net.\n\n` +
            `Each lead can confirm their own department's part once they've paid it; you can pay any part. ` +
            `The invoice, with the split, is attached: ${appUrl()}/payroll/panel\n\n— FreshWeek`,
          attachments: pdf
            ? [{ filename: `${who} — ${label}.pdf`, bytes: pdf.bytes }]
            : undefined,
        }),
      ),
    );
  }

  revalidateAll();
  return { ok: true };
}
