// A week must be submitted — the previous week closed and the new week started
// with its goals — by Sunday 17:00 Tashkent time (12:00 for weeks before
// SUBMISSION_5PM_FROM_MONDAY) (Asia/Tashkent is UTC+5 with no
// DST). A submission after that deadline is "late". Deadlines are derived from
// the week's Monday start; production runs in UTC, which these helpers assume.
//
// The submission helpers take an `offsetHours` for people who read that hour on
// another clock (lib/submissionClock.ts) and default to the company's. The
// MEETING helpers take no such argument on purpose: the Monday sync is one
// event at one instant for the whole team, so it is the company clock, always.

import { toYmd } from "@/lib/dates";
import { meetingHourForMonday } from "@/lib/meetings";

export const COMPANY_UTC_OFFSET_HOURS = 5; // Asia/Tashkent, no DST

/**
 * When the Sunday-12:00 deadline started being enforced — the first governed
 * cycle is the one due 2026-07-19 12:00 Tashkent (= 07:00 UTC). Nothing before
 * this was ever fined, so nothing before it is judged late either: the fine
 * sweep skips those cycles (lib/submissionFines.ts) and so do the reporting
 * stats (lib/performance.ts).
 */
export const SUBMISSION_DEADLINE_EPOCH = new Date("2026-07-19T07:00:00.000Z");

/** Whether the Sunday-12:00 rule was in force for the week starting here. */
export function submissionDeadlineApplies(weekStart: Date): boolean {
  return (
    weekSubmissionDeadline(weekStart).getTime() >=
    SUBMISSION_DEADLINE_EPOCH.getTime()
  );
}

const SUBMISSION_HOUR = 17; // Sunday 17:00 Tashkent
const SUBMISSION_HOUR_BEFORE_MOVE = 12; // …and 12:00 before the move below

/**
 * The first Monday whose week is due Sunday 17:00 instead of noon, as a plain
 * calendar day. Effective-dated for the same reason as MEETING_10AM_FROM_MONDAY:
 * the deadline is a judgement instant and a key. The fine sweep's idempotency
 * window (createdAt >= deadline) and FineWaiver.cycleDeadline both hang off it,
 * so moving a past cycle's deadline would re-issue its fines and orphan its
 * waivers. The move was made early on Sunday 2026-10-11, before that noon had
 * passed, so the cycle due that day is the first to get 17:00.
 */
export const SUBMISSION_5PM_FROM_MONDAY = "2026-10-12";

/** The Sunday deadline hour for the week whose Monday is `mondayYmd`. */
export function submissionHourForMonday(mondayYmd: string): number {
  return mondayYmd >= SUBMISSION_5PM_FROM_MONDAY
    ? SUBMISSION_HOUR
    : SUBMISSION_HOUR_BEFORE_MOVE;
}

/**
 * One-off: the team was on a trip the week due 2026-08-16, so that single
 * cycle's deadline moved from Sunday 12:00 to Sunday midnight (Tashkent).
 * Every deadline-derived surface — fines, Late flags, cycle phase, stats —
 * shifts with it, since they all go through weekSubmissionDeadline. Inert for
 * every other week; safe to delete once the cycle is history (the fines the
 * noon sweep had already issued are unwound by releaseTripShiftedFines in
 * lib/submissionFines.ts).
 */
export const TRIP_SHIFTED_DEADLINE_FROM = new Date("2026-08-16T07:00:00.000Z"); // Sun 12:00 UZT
export const TRIP_SHIFTED_DEADLINE_TO = new Date("2026-08-16T19:00:00.000Z"); // Sun 24:00 UZT

/**
 * The submission deadline for a week: Sunday 17:00 (12:00 before the move)
 * immediately before the week's Monday start, as a UTC instant. The hour is
 * read on the company clock unless the person keeps their own (`offsetHours`,
 * from lib/submissionClock).
 */
export function weekSubmissionDeadline(
  weekStart: Date,
  offsetHours: number = COMPANY_UTC_OFFSET_HOURS,
): Date {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() - 1); // step back to the Sunday before Monday
  // 17:00 UZT = 12:00 UTC (12:00 UZT = 07:00 UTC before the move)
  d.setUTCHours(submissionHourForMonday(toYmd(weekStart)) - offsetHours, 0, 0, 0);
  // The trip week's one-off slip from noon to midnight was a team decision
  // about that Sunday, so it applies on whatever clock the person reads noon
  // on: the same 12-hour move, off their own noon.
  const companyNoon = d.getTime() + (offsetHours - COMPANY_UTC_OFFSET_HOURS) * 3_600_000;
  if (companyNoon === TRIP_SHIFTED_DEADLINE_FROM.getTime()) {
    return new Date(
      d.getTime() +
        (TRIP_SHIFTED_DEADLINE_TO.getTime() - TRIP_SHIFTED_DEADLINE_FROM.getTime()),
    );
  }
  return d;
}

/**
 * The earliest moment the week beginning `weekStart` may be opened: 12:00
 * Tashkent on the Friday before its goals are due (48 hours before Sunday
 * noon; it stayed put when the deadline moved to 17:00). The window runs from
 * then through the Monday the week begins — submitting after the Sunday
 * deadline is "late" and after the Monday
 * meeting "missed" (see submissionTiming), but never blocked.
 *
 * Opening a week sooner means closing the current one before it's over, which
 * strands the person a week ahead of the team's cycle: their dashboard runs on
 * next week's goals while everyone else is still mid-week, and the admin review
 * shows the week they already closed instead of live work. Catching up is never
 * blocked by this — a week whose Friday noon has passed is always openable.
 */
export function weekOpensAt(
  weekStart: Date,
  offsetHours: number = COMPANY_UTC_OFFSET_HOURS,
): Date {
  const sinceNoon = submissionHourForMonday(toYmd(weekStart)) - 12;
  return new Date(
    weekSubmissionDeadline(weekStart, offsetHours).getTime() -
      (48 + sinceNoon) * 3_600_000,
  );
}

/**
 * The Monday meeting for the week beginning `weekStart`, as a UTC instant.
 * Goals still unsubmitted at this moment are flagged "not submitted" at the
 * meeting, so submitting after it is the steeper offence.
 *
 * The hour comes from lib/meetings.ts rather than sitting here as a literal,
 * so the slot attendance is marked against and the instant fines are judged
 * by can never drift apart — and so the 11:00 → 10:00 move applies from its
 * own Monday forward instead of re-tiering weeks already decided (see
 * MEETING_10AM_FROM_MONDAY for what that would have cost).
 *
 * No per-person clock here, deliberately: everyone joins the same call at the
 * same moment, so "you weren't in it" is one instant for the whole team.
 */
export function weekMeetingDeadline(weekStart: Date): Date {
  const d = new Date(weekStart);
  const hour = meetingHourForMonday(toYmd(weekStart));
  d.setUTCHours(hour - COMPANY_UTC_OFFSET_HOURS, 0, 0, 0); // 10:00 UZT = 05:00 UTC
  return d;
}

/**
 * Whether a week submitted at `submittedAt`, for a week beginning `weekStart`,
 * missed the Sunday-midday deadline.
 */
export function isLateSubmission(
  submittedAt: Date,
  weekStart: Date,
  offsetHours?: number,
): boolean {
  return (
    submittedAt.getTime() > weekSubmissionDeadline(weekStart, offsetHours).getTime()
  );
}

// How late a submission was, which sets the fine tier:
//   on-time — by the Sunday deadline (no fine)
//   late    — after the Sunday deadline but by the Monday meeting
//   missed  — after the Monday meeting (was flagged "not submitted" there)
export type SubmissionTiming = "on-time" | "late" | "missed";

export function submissionTiming(
  submittedAt: Date,
  weekStart: Date,
  offsetHours?: number,
): SubmissionTiming {
  const t = submittedAt.getTime();
  if (t > weekMeetingDeadline(weekStart).getTime()) return "missed";
  if (t > weekSubmissionDeadline(weekStart, offsetHours).getTime()) return "late";
  return "on-time";
}

/**
 * Whether `at` falls on a Sunday in Asia/Tashkent (UTC+5) — the day the weekly
 * close-and-restart is due, and the only day the review page flags who's
 * reported vs not.
 */
export function isTashkentSunday(at: Date): boolean {
  const shifted = new Date(at.getTime() + COMPANY_UTC_OFFSET_HOURS * 3_600_000);
  return shifted.getUTCDay() === 0;
}

// The weekly submission cycle in focus right now. The cut between one cycle and
// the next is the Sunday deadline: from then on, "the week" people must
// have goals in for is the one starting the coming Monday. Used both to
// proactively fine missed submissions and to split the admin view into the
// previous vs current week.
export type SubmissionPhase = "before" | "late" | "missed";
export type SubmissionCycle = {
  // The target week's Monday, at UTC midnight (matches how week.startDate is
  // stored in production). Compare weeks against `submissionDeadline`, not this,
  // to stay robust to dev/prod timezone differences in stored week bounds.
  weekStart: Date;
  submissionDeadline: Date; // Sunday 17:00 Tashkent, as a UTC instant
  meetingDeadline: Date; // the Monday meeting (lib/meetings.ts), as a UTC instant
  // before  — the deadline hasn't passed yet (nothing due)
  // late    — past the Sunday deadline, not yet the Monday meeting ($20 tier)
  // missed  — past the Monday meeting ($40 tier)
  phase: SubmissionPhase;
};

/**
 * The submission cycle governing `now`: the week whose Sunday-12:00 deadline
 * most recently passed, plus which fine tier applies. Before the current
 * week's Sunday deadline it stays on that week (phase "before"); once the
 * deadline passes it advances to the coming Monday's week.
 */
export function currentSubmissionCycle(
  now = new Date(),
  offsetHours: number = COMPANY_UTC_OFFSET_HOURS,
): SubmissionCycle {
  // Which Monday's week we're in is a shared calendar fact — the team runs one
  // week at a time — so it's read on the company clock for everyone. Only the
  // deadline that cuts one cycle from the next moves with `offsetHours`.
  const tash = new Date(now.getTime() + COMPANY_UTC_OFFSET_HOURS * 3_600_000);
  const y = tash.getUTCFullYear();
  const mo = tash.getUTCMonth();
  const d = tash.getUTCDate();
  const sinceMonday = (tash.getUTCDay() + 6) % 7; // days since Monday
  const thisMonday = new Date(Date.UTC(y, mo, d - sinceMonday));
  const nextMonday = new Date(Date.UTC(y, mo, d - sinceMonday + 7));

  // We move into the coming Monday's cycle once its Sunday deadline (this
  // Sunday) has passed; until then we're still in the current week's cycle.
  const weekStart =
    now.getTime() >= weekSubmissionDeadline(nextMonday, offsetHours).getTime()
      ? nextMonday
      : thisMonday;

  const submissionDeadline = weekSubmissionDeadline(weekStart, offsetHours);
  const meetingDeadline = weekMeetingDeadline(weekStart);
  const t = now.getTime();
  const phase: SubmissionPhase =
    t < submissionDeadline.getTime()
      ? "before"
      : t < meetingDeadline.getTime()
        ? "late"
        : "missed";

  return { weekStart, submissionDeadline, meetingDeadline, phase };
}
