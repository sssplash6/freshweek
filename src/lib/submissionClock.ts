// Which clock a person's weekly submission deadline is read on.
//
// The rule is "goals in by 17:00 on Sunday". For almost everyone that's 17:00 in
// Tashkent, where the company runs. Someone reporting from elsewhere is judged
// on the clock they actually live by: malika@freshman.academy is at GMT+8, so
// her Sunday 17:00 lands at 09:00 UTC — three hours before the team's.
//
// SUBMISSION ONLY. The Monday meeting is one event the whole team joins
// at a single instant, so the $40 "missed the meeting" tier stays on the
// company clock wherever the person is (see weekMeetingDeadline in
// lib/lateness.ts). Everything meeting-shaped is deliberately untouched here.
//
// Add or move someone without a deploy via SUBMISSION_CLOCK_OFFSETS, a
// comma-separated list of "email=offset" in whole hours from UTC, e.g.
// "someone@freshman.academy=8, someone.else@freshman.academy=-5".

import { COMPANY_UTC_OFFSET_HOURS } from "@/lib/lateness";

const BUILT_IN_OFFSETS: Record<string, number> = {
  "malika@freshman.academy": 8,
};

/** Real UTC offsets run from -12 to +14; anything else is a typo, not a zone. */
function isRealOffset(hours: number): boolean {
  return Number.isFinite(hours) && hours >= -12 && hours <= 14;
}

function envOffsets(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of (process.env.SUBMISSION_CLOCK_OFFSETS ?? "").split(",")) {
    const [rawEmail, rawOffset] = entry.split("=");
    const email = rawEmail?.trim().toLowerCase();
    const hours = Number(rawOffset?.trim());
    // A malformed entry is skipped rather than thrown on: this is read on every
    // page load, and one bad character shouldn't take the app down.
    if (!email || !rawOffset?.trim() || !isRealOffset(hours)) continue;
    out[email] = hours;
  }
  return out;
}

/** Every account on a clock of its own: lowercased email → UTC offset hours. */
export function submissionClockOffsets(): Record<string, number> {
  return { ...BUILT_IN_OFFSETS, ...envOffsets() };
}

/** The UTC offset this person's Sunday deadline is read on (hours). */
export function submissionOffsetHours(email: string | null | undefined): number {
  if (!email) return COMPANY_UTC_OFFSET_HOURS;
  return submissionClockOffsets()[email.toLowerCase()] ?? COMPANY_UTC_OFFSET_HOURS;
}

/**
 * The distinct clocks the fine sweep has to run, company clock first. Its
 * `emails` are the accounts on that clock; `emails: null` on the company entry
 * means "everyone else", so the two never overlap and nobody is swept twice.
 */
export type SubmissionClock = { offsetHours: number; emails: string[] | null };

export function submissionClockGroups(): SubmissionClock[] {
  const offsets = submissionClockOffsets();
  const byOffset = new Map<number, string[]>();
  for (const [email, hours] of Object.entries(offsets)) {
    // Someone explicitly listed at the company offset is already covered by the
    // "everyone else" group — listing them again would sweep them twice.
    if (hours === COMPANY_UTC_OFFSET_HOURS) continue;
    byOffset.set(hours, [...(byOffset.get(hours) ?? []), email]);
  }
  return [
    { offsetHours: COMPANY_UTC_OFFSET_HOURS, emails: null },
    ...[...byOffset].map(([offsetHours, emails]) => ({ offsetHours, emails })),
  ];
}

/** Every account NOT on the company clock — the sweep's "everyone else" cut. */
export function offClockEmails(): string[] {
  return submissionClockGroups()
    .flatMap((g) => g.emails ?? [])
    .sort();
}
