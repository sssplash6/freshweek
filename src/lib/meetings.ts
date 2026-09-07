// The team meets every Monday at 10:00 company time (Asia/Tashkent, UTC+5, no
// DST). These helpers resolve that weekly slot to a UTC instant so it's stored
// and compared unambiguously, regardless of the server's timezone.
//
// It used to be 11:00, and both hours still live here on purpose — see
// MEETING_10AM_FROM_MONDAY.

import { toYmd } from "@/lib/dates";

const TASHKENT_OFFSET_MIN = 5 * 60;

const MEETING_HOUR = 10; // 10:00 Tashkent
const MEETING_HOUR_BEFORE_MOVE = 11; // …and 11:00 before the move below

/**
 * The Monday the sync moved from 11:00 to 10:00, as a plain calendar day.
 *
 * The hour is effective-dated rather than simply changed, because the old hour
 * is not just history — it is a judgement instant and a database key:
 *
 *   • Goals still unsubmitted at the meeting are fined at the steeper tier
 *     (lib/submissionFines.ts, via weekMeetingDeadline). Reading a past week
 *     against 10:00 would re-tier fines already issued — and in some cases
 *     already paid — against the 11:00 those weeks were actually judged at.
 *     Someone who submitted at 10:30 on a past Monday was late; they must not
 *     become a no-show because the meeting later moved.
 *   • Attendance keys off the slot. A Meeting row stores the instant it was
 *     held at and `scheduledAt` is unique, so a week whose row already exists
 *     at 11:00 has to keep resolving to that row. Otherwise marking someone
 *     creates a SECOND meeting for the same Monday, splitting that week's
 *     attendance — and the escalating skip fines derived from it — across two
 *     rows nobody can see are the same meeting.
 *
 * 2026-09-14 is the first Monday the new time can apply to: the move was made
 * on Monday 2026-09-07, after that morning's 11:00 sync had already been held.
 */
export const MEETING_10AM_FROM_MONDAY = "2026-09-14";

/**
 * The meeting hour (Tashkent) for the week whose Monday is `mondayYmd`
 * ("YYYY-MM-DD"). ISO dates compare correctly as strings, which is the whole
 * reason the cutover is stored as one.
 */
export function meetingHourForMonday(mondayYmd: string): number {
  return mondayYmd >= MEETING_10AM_FROM_MONDAY
    ? MEETING_HOUR
    : MEETING_HOUR_BEFORE_MOVE;
}

/**
 * The meeting for the week containing `date` — Monday 10:00 Asia/Tashkent
 * (11:00 for weeks before the move) — as a UTC instant. Computed in Tashkent
 * wall-clock terms, then shifted back to UTC.
 */
export function meetingSlotFor(date = new Date()): Date {
  // Shift so UTC getters read the Tashkent wall clock.
  const tash = new Date(date.getTime() + TASHKENT_OFFSET_MIN * 60_000);
  const day = tash.getUTCDay(); // 0 = Sun
  const sinceMonday = (day + 6) % 7;
  // The week's Monday as a plain Tashkent calendar day. Date.UTC normalizes a
  // day-of-month that steps back past the 1st into the previous month.
  const monday = new Date(
    Date.UTC(
      tash.getUTCFullYear(),
      tash.getUTCMonth(),
      tash.getUTCDate() - sinceMonday,
    ),
  );
  // Monday's meeting hour in Tashkent wall-clock terms…
  const wall = monday.getTime() + meetingHourForMonday(toYmd(monday)) * 3_600_000;
  // …then shift back to the real UTC instant.
  return new Date(wall - TASHKENT_OFFSET_MIN * 60_000);
}

/** The current week's meeting slot as a UTC instant. */
export function currentMeetingSlot(): Date {
  return meetingSlotFor(new Date());
}
