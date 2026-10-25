// Proactive late-submission fining. Instead of only fining people when they
// eventually submit late (which let no-shows escape entirely), this reconciles
// the current weekly cycle and fines anyone who missed the deadline:
//   • after Sunday 17:00 (Tashkent) — $20 for goals not yet submitted
//   • after the Monday meeting     — escalate an unpaid $20 to $40
// It's idempotent (at most one late-submission fine per person per cycle) so it
// can safely run on any page load or a cron ping. People who submitted on time
// are never fined; people who submitted late keep the $20 they earned.
//
// The Sunday deadline is read on the person's own clock where they keep one
// (lib/submissionClock.ts): "17:00 on Sunday" means 17:00 where they live, so the
// sweep runs once per clock over non-overlapping sets of people. The Monday
// meeting escalation does NOT move — it's one meeting at one instant for
// everyone (10:00 Tashkent, and 11:00 for weeks before lib/meetings.ts's
// MEETING_10AM_FROM_MONDAY).
//
// The deadline only governs department leads (role LEAD — the ops director is
// one), and only through a normal department: leading a mini one (Alumni
// Council, Department.mini) owes nothing. Members may set and submit goals
// like anyone else, but nothing is owed, so they're never fined; any
// late-submission fine a member is still carrying (from before roles existed)
// is released on the next sweep. Accounts on the submission-exempt list (see
// lib/submissionExempt.ts) are skipped the same way regardless of role.

import { prisma } from "@/lib/prisma";
import { toYmd } from "@/lib/dates";
import { meetingHourForMonday } from "@/lib/meetings";
import { notify } from "@/lib/notifications";
import {
  formatMoney,
  LATE_SUBMISSION_PENALTY,
  MISSED_SUBMISSION_PENALTY,
} from "@/lib/penalties";
import {
  currentSubmissionCycle,
  SUBMISSION_DEADLINE_EPOCH,
  TRIP_SHIFTED_DEADLINE_FROM,
  TRIP_SHIFTED_DEADLINE_TO,
  submissionHourForMonday,
  weekSubmissionDeadline,
} from "@/lib/lateness";
import {
  offClockEmails,
  submissionClockGroups,
  submissionOffsetHours,
  type SubmissionClock,
} from "@/lib/submissionClock";
import {
  isSubmissionExempt,
  submissionExemptEmails,
} from "@/lib/submissionExempt";

// Cites the hour the cycle was judged at (12:00 before SUBMISSION_5PM_FROM_MONDAY).
function lateNote(deadlineHour: number): string {
  return `Goals not submitted by the Sunday ${deadlineHour}:00 deadline`;
}
/**
 * The steeper note names the meeting hour it was judged against, rather than
 * a fixed 11:00, because the meeting moved to 10:00 from 2026-09-14 (see
 * MEETING_10AM_FROM_MONDAY) and a fine has to be able to say what it was
 * actually measured by. Notes already written are untouched — every one of
 * them cites the hour that applied when it was issued, which is why nothing
 * here matches rows by their text (userId + type + createdAt does).
 */
function missedNote(meetingHour: number): string {
  return `Goals not submitted by the Monday ${meetingHour}:00 meeting`;
}
// The 2026-08-16 trip week runs on a midnight deadline; a fine issued for
// missing it shouldn't cite noon.
const LATE_NOTE_TRIP =
  "Goals not submitted by the Sunday midnight deadline (trip week)";

/**
 * Reconcile late-submission fines for the current cycle. Pass a `userId` to
 * reconcile just that person (used on their own dashboard load); omit it to
 * sweep the whole team (used on admin load / cron).
 */
export async function reconcileSubmissionFines(opts?: {
  userId?: string;
}): Promise<void> {
  const now = new Date();

  // Clear anything an exempt account or a member is still carrying first —
  // this runs on every phase, so adding an exemption (or demoting someone to
  // member) takes effect on the next page load rather than waiting for a
  // deadline to come round.
  await releaseUnexpectedSubmissionFines(opts?.userId);

  // Undo what the noon sweep wrote before the 2026-08-16 deadline moved to
  // midnight (see TRIP_SHIFTED_DEADLINE_* in lib/lateness.ts).
  await releaseTripShiftedFines(now, opts?.userId);

  // One pass per clock. Each pass has its own deadline instant, so its own
  // cycle and phase, over the people who read Sunday noon on it.
  for (const clock of submissionClockGroups()) {
    await reconcileClock(now, clock, opts?.userId);
  }
}

/** The `where` fragment selecting exactly the people on one clock. */
function onClock(clock: SubmissionClock) {
  if (clock.emails) {
    return { email: { in: clock.emails, mode: "insensitive" as const } };
  }
  // The company clock is everyone NOT listed on another one. Written as an OR
  // against null rather than `notIn` alone because an account with no email
  // (nothing has ever excluded those) would fail a plain SQL NOT IN.
  const off = offClockEmails();
  if (off.length === 0) return {};
  return {
    OR: [
      { email: null },
      { email: { notIn: off, mode: "insensitive" as const } },
    ],
  };
}

/** Reconcile one clock's cycle for the people who keep it. */
async function reconcileClock(
  now: Date,
  clock: SubmissionClock,
  userId?: string,
): Promise<void> {
  const cycle = currentSubmissionCycle(now, clock.offsetHours);

  // Nothing due yet, or a cycle from before the deadline was enforced. The
  // epoch is a team-wide date read on the company clock, so a personal deadline
  // a few hours either side of it can't pull a cycle in or push one out.
  if (cycle.phase === "before") return;
  if (
    weekSubmissionDeadline(cycle.weekStart).getTime() <
    SUBMISSION_DEADLINE_EPOCH.getTime()
  ) {
    return;
  }

  const { submissionDeadline, meetingDeadline, phase } = cycle;
  // The hour this cycle's meeting is actually held at, for the wording of
  // everything below. Same source the deadline itself comes from, so a fine
  // can never cite an hour it wasn't measured against.
  const meetingHour = meetingHourForMonday(toYmd(cycle.weekStart));
  const deadlineHour = submissionHourForMonday(toYmd(cycle.weekStart));

  const users = await prisma.user.findMany({
    where: {
      // Only department leads — anyone holding a LEAD membership in a normal
      // (non-mini) department — are expected to submit, and only ones who were
      // around before the deadline (new joiners get a pass this cycle).
      memberships: {
        some: { role: "LEAD", department: { mini: false } },
      },
      createdAt: { lt: submissionDeadline },
      ...onClock(clock),
      ...(userId ? { id: userId } : {}),
    },
    select: {
      id: true,
      email: true,
      // Every week for this cycle (starting on/after its Monday). Usually one,
      // but a redeploy race in getOrCreateCurrentWeek/startNewWeek can leave a
      // stray duplicate — so we look at all of them, not just one. Keyed off
      // the Monday, not the deadline: a clock west of UTC puts Sunday 17:00
      // after Monday 00:00 UTC, where weeks start.
      weeks: {
        where: { startDate: { gte: cycle.weekStart } },
        select: { id: true, submittedAt: true },
      },
      // This cycle's late-submission fine, if one has been issued already.
      penalties: {
        where: {
          type: "LATE_SUBMISSION",
          createdAt: { gte: submissionDeadline },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, amount: true, paidAt: true, paidAmount: true },
      },
    },
  });

  // Cycles an admin has already forgiven for someone (they removed the fine on
  // the admin page). Without this the sweep would re-derive the fine from the
  // unsubmitted week on the very next page load and undo the decision.
  const waived = new Set(
    (
      await prisma.fineWaiver.findMany({
        where: {
          cycleDeadline: submissionDeadline,
          ...(userId ? { userId } : {}),
        },
        select: { userId: true },
      })
    ).map((w) => w.userId),
  );

  for (const u of users) {
    // The clock filter above is an optimisation; this is the guarantee. Judging
    // each person by the offset they actually keep means nobody can fall into
    // two passes (and be priced on two different deadlines) if the stored email
    // differs in case from the listed one.
    if (submissionOffsetHours(u.email) !== clock.offsetHours) continue;

    // Accounts not expected to report weekly (e.g. alumni) are never fined for
    // it — releaseUnexpectedSubmissionFines above has already cleaned up after
    // them.
    if (isSubmissionExempt(u.email)) continue;
    if (waived.has(u.id)) continue;

    // Count as submitted if ANY current-cycle week is, and tier by the earliest
    // submission — so a stray unsubmitted duplicate can't wrongly flag someone
    // who actually reported on time.
    const submits = u.weeks
      .map((w) => w.submittedAt)
      .filter((d): d is Date => d != null)
      .sort((a, b) => a.getTime() - b.getTime());
    const earliestSubmit = submits[0] ?? null;

    const amount = dueAmount(
      earliestSubmit,
      phase,
      submissionDeadline,
      meetingDeadline,
    );
    const existing = u.penalties[0];

    if (amount === 0) {
      // Submitted on time. If a fine exists and nothing has been paid against
      // it, it was created in error (the duplicate-week bug) — remove it and
      // let the person know. Once money has moved, an admin has to unwind it
      // deliberately on /penalties; deleting it here would erase the payment.
      if (existing && existing.paidAt == null && existing.paidAmount === 0) {
        await prisma.$transaction(async (tx) => {
          await tx.penalty.delete({ where: { id: existing.id } });
          await notify(
            tx,
            u.id,
            "FINE",
            `Your ${formatMoney(existing.amount)} late-submission fine was removed — your goals were submitted on time.`,
          );
        });
      }
      continue;
    }

    // Prefer linking the fine to the submitted week, else any current-cycle one.
    const weekId =
      u.weeks.find((w) => w.submittedAt != null)?.id ??
      u.weeks[0]?.id ??
      null;
    const missed = amount >= MISSED_SUBMISSION_PENALTY;
    const shiftedWeek =
      submissionDeadline.getTime() === TRIP_SHIFTED_DEADLINE_TO.getTime();
    const note = missed
      ? missedNote(meetingHour)
      : shiftedWeek
        ? LATE_NOTE_TRIP
        : lateNote(deadlineHour);

    if (!existing) {
      await prisma.$transaction(async (tx) => {
        // Re-check inside the transaction to narrow the double-create window if
        // two reconciles race (e.g. the admin sweep and the person's own load).
        const already = await tx.penalty.findFirst({
          where: {
            userId: u.id,
            type: "LATE_SUBMISSION",
            createdAt: { gte: submissionDeadline },
          },
          select: { id: true },
        });
        if (already) return;
        await tx.penalty.create({
          data: { userId: u.id, type: "LATE_SUBMISSION", amount, note, weekId },
        });
        await notify(
          tx,
          u.id,
          "FINE",
          missed
            ? `You were fined ${formatMoney(amount)} for not submitting your goals by the Monday ${meetingHour}:00 meeting.`
            : `You were fined ${formatMoney(amount)} for not submitting your goals by the Sunday ${shiftedWeek ? "midnight" : `${deadlineHour}:00`} deadline.`,
        );
      });
    } else if (existing.paidAt == null && existing.amount < amount) {
      // Escalate an unpaid $20 to $40 at the Monday meeting. A fine that's
      // already been settled is left alone rather than silently re-priced. A
      // part-paid one does escalate — the amount only ever goes up, so what's
      // been paid still stands and the person simply owes the difference.
      // `existing` was read before this transaction opened. Re-assert it in
      // the where clause so a submission that landed, or a settlement
      // recorded, in the gap wins over a price computed from stale state —
      // and stay quiet if it did.
      await prisma.$transaction(async (tx) => {
        const updated = await tx.penalty.updateMany({
          where: { id: existing.id, paidAt: null, amount: existing.amount },
          data: { amount, note, ...(weekId ? { weekId } : {}) },
        });
        if (updated.count === 0) return;
        await notify(
          tx,
          u.id,
          "FINE",
          `Your late-submission fine was raised to ${formatMoney(amount)} — goals still not submitted at the Monday ${meetingHour}:00 meeting.`,
        );
      });
    } else if (
      existing.paidAt == null &&
      existing.amount > amount &&
      existing.paidAmount <= amount
    ) {
      // Re-price DOWN too: a $40 "missed the meeting" fine issued while the
      // person looked like a no-show drops back to $20 once their submission
      // turns out to have landed before the meeting (the sweep runs between
      // page loads, so it can escalate before it has seen a submit). What's
      // been paid stays paid — shrink only while paid ≤ the new amount;
      // anything odder is admin territory on /penalties. Conditional for the
      // same reason as the escalation above.
      await prisma.$transaction(async (tx) => {
        const updated = await tx.penalty.updateMany({
          where: {
            id: existing.id,
            paidAt: null,
            amount: existing.amount,
            paidAmount: { lte: amount },
          },
          data: { amount, note, ...(weekId ? { weekId } : {}) },
        });
        if (updated.count === 0) return;
        await notify(
          tx,
          u.id,
          "FINE",
          `Your late-submission fine was reduced to ${formatMoney(amount)} — your goals were in before the Monday ${meetingHour}:00 meeting.`,
        );
      });
    }
  }
}

/**
 * Drop any untouched late-submission fine held by someone the deadline doesn't
 * govern: an exempt account, or a member (only department leads owe weekly
 * submissions — a member's fine either predates the roles or predates their
 * demotion). Leading only mini departments counts as a member here, so moving
 * someone to one releases their fine on the next load. Fines with money
 * against them are left alone (it already moved; an admin can reopen one on
 * /penalties if it was wrong). Pass a `userId` to limit this to one person,
 * matching the sweep above.
 */
async function releaseUnexpectedSubmissionFines(userId?: string): Promise<void> {
  const unexpected = await prisma.user.findMany({
    where: {
      OR: [
        { email: { in: submissionExemptEmails(), mode: "insensitive" } },
        // Leads no department the deadline governs — a member everywhere they
        // belong, or a lead of mini departments only.
        {
          memberships: {
            none: { role: "LEAD", department: { mini: false } },
          },
        },
      ],
      ...(userId ? { id: userId } : {}),
    },
    select: {
      id: true,
      email: true,
      penalties: {
        where: { type: "LATE_SUBMISSION", paidAt: null, paidAmount: 0 },
        select: { id: true, amount: true },
      },
    },
  });

  for (const u of unexpected) {
    if (u.penalties.length === 0) continue;
    const total = u.penalties.reduce((sum, p) => sum + p.amount, 0);
    const label =
      u.penalties.length > 1
        ? `late-submission fines totalling ${formatMoney(total)}`
        : `${formatMoney(total)} late-submission fine`;
    const reason = isSubmissionExempt(u.email)
      ? "this account isn't fined for late weekly submissions"
      : "only department leads are expected to submit weekly goals";
    await prisma.$transaction(async (tx) => {
      await tx.penalty.deleteMany({
        where: { id: { in: u.penalties.map((p) => p.id) } },
      });
      await notify(tx, u.id, "FINE", `Your ${label} was removed — ${reason}.`);
    });
  }
}

/**
 * One-off follow-through for the trip-shifted 2026-08-16 deadline (see
 * TRIP_SHIFTED_DEADLINE_* in lib/lateness.ts): by the time the deadline moved
 * from Sunday noon to midnight, the noon sweep had already fined people and
 * flagged weeks "late". This unwinds everything the noon deadline wrote:
 *   • drops untouched fines from the noon sweep (money already settled against
 *     one freezes it, same rule as everywhere else — /penalties can unwind it),
 *   • clears the Late flag on weeks submitted between noon and midnight,
 *   • re-keys waivers an admin granted against the noon deadline so the
 *     forgiveness still counts for this cycle after it re-keys to midnight.
 * Idempotent — after the first pass nothing matches — and inert once the trip
 * cycle is a week old, at which point this function can simply be deleted.
 */
async function releaseTripShiftedFines(
  now: Date,
  userId?: string,
): Promise<void> {
  const from = TRIP_SHIFTED_DEADLINE_FROM;
  const to = TRIP_SHIFTED_DEADLINE_TO;
  if (now.getTime() >= to.getTime() + 7 * 86_400_000) return;
  const scope = userId ? { userId } : {};

  try {
    const fines = await prisma.penalty.findMany({
      where: {
        type: "LATE_SUBMISSION",
        createdAt: { gte: from, lt: to },
        paidAt: null,
        paidAmount: 0,
        ...scope,
      },
      select: { id: true, userId: true, amount: true },
    });
    for (const f of fines) {
      await prisma.$transaction(async (tx) => {
        // Re-check the untouched guard inside the delete itself, in case a
        // payment landed (or a racing reconcile already deleted it) since the
        // read above.
        const del = await tx.penalty.deleteMany({
          where: { id: f.id, paidAt: null, paidAmount: 0 },
        });
        if (del.count === 0) return;
        await notify(
          tx,
          f.userId,
          "FINE",
          `Your ${formatMoney(f.amount)} late-submission fine was removed — this week's deadline moved from Sunday noon to midnight for the team trip.`,
        );
      });
    }

    // Weeks submitted between noon and midnight were stamped late on the way
    // in; under the midnight deadline they're on time. Only this cycle's weeks
    // qualify — a week from an older cycle submitted today really is late.
    await prisma.week.updateMany({
      where: {
        submittedLate: true,
        submittedAt: { gte: from, lt: to },
        startDate: { gte: from },
        ...scope,
      },
      data: { submittedLate: false },
    });

    await prisma.fineWaiver.updateMany({
      where: { cycleDeadline: from, ...scope },
      data: { cycleDeadline: to },
    });
  } catch (e) {
    // A one-off cleanup must never take a page load down with it.
    console.error("releaseTripShiftedFines failed", e);
  }
}

/** The fine a person owes for the cycle, given when (if ever) they submitted. */
function dueAmount(
  submittedAt: Date | null,
  phase: "before" | "late" | "missed",
  submissionDeadline: Date,
  meetingDeadline: Date,
): number {
  if (submittedAt) {
    if (submittedAt.getTime() <= submissionDeadline.getTime()) return 0; // on time
    if (submittedAt.getTime() <= meetingDeadline.getTime()) {
      return LATE_SUBMISSION_PENALTY; // late, but before the meeting
    }
    return MISSED_SUBMISSION_PENALTY; // submitted after the meeting
  }
  // Never submitted — tier by how far past the deadline we are now.
  return phase === "missed" ? MISSED_SUBMISSION_PENALTY : LATE_SUBMISSION_PENALTY;
}
