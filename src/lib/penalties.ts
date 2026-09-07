// Client-safe penalty constants & helpers. Mirrors the Prisma `PenaltyType` and
// `AttendanceStatus` enums so client components don't need the generated client.

// ----- Configuration (change these in one place) -----

/** Currency for all fines. `formatMoney` renders USD as "$40"; adjust both if changed. */
export const PENALTY_CURRENCY = "USD";

/** Meeting fines escalate per consecutive skip: 1st = base, then +step each. */
export const MEETING_PENALTY_BASE = 40; // first skip
export const MEETING_PENALTY_STEP = 20; // added for every further skip in a row

/** Flat fine for showing up late to a meeting (counts as present, no escalation). */
export const MEETING_LATE_PENALTY = 20;

/** Fine auto-applied when a week's goals are submitted after the Sunday 12:00
 * deadline but before the Monday meeting. */
export const LATE_SUBMISSION_PENALTY = 20;

/** Steeper fine when goals are still unsubmitted at the Monday meeting —
 * i.e. the person was flagged "not submitted" there and submitted even later. */
export const MISSED_SUBMISSION_PENALTY = 40;

/** Fine when a daily report misses its 5 AM (next-morning, Tashkent) deadline. */
export const LATE_DAILY_REPORT_PENALTY = 5;

/** Escalated fine when the report still isn't in by 3 PM that same day. */
export const MISSED_DAILY_REPORT_PENALTY = 10;

/** Pre-filled amount for a manual (admin-issued) fine. */
export const DEFAULT_MANUAL_PENALTY = 20;

/** Guard rail so a typo can't create an absurd fine. */
export const MAX_PENALTY = 100_000_000;

/** The fine for the Nth consecutive skipped meeting (n ≥ 1): 40, 60, 80, … */
export function meetingPenaltyAmount(consecutive: number): number {
  return MEETING_PENALTY_BASE + MEETING_PENALTY_STEP * (consecutive - 1);
}

// ----- Types & labels -----

export type PenaltyType =
  | "MEETING_SKIPPED"
  | "MEETING_LATE"
  | "LATE_SUBMISSION"
  | "LATE_DAILY_REPORT"
  | "OTHER";

export const PENALTY_LABEL: Record<PenaltyType, string> = {
  MEETING_SKIPPED: "Skipped meeting",
  MEETING_LATE: "Late to meeting",
  LATE_SUBMISSION: "Late submission",
  LATE_DAILY_REPORT: "Late daily report",
  OTHER: "Fine",
};

export type AttendanceStatus = "ATTENDED" | "LATE" | "SKIPPED" | "EXCUSED";

export const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = {
  ATTENDED: "Attended",
  LATE: "Late",
  SKIPPED: "Skipped",
  EXCUSED: "Excused",
};

/** A whole-number amount → "$40". */
export function formatMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}
