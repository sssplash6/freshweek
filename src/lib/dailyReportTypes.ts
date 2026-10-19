// Client-safe daily-report vocabulary: day math, status derivation, and the
// display meta each status carries. No env or Prisma imports — who reports and
// where reports go lives in lib/dailyReports.ts (server-only). Same split as
// notificationTypes.ts vs notifications.ts.
//
// A report belongs to a Tashkent calendar day, stored at UTC midnight (the
// goal-deadline date-only convention). It is due by 5 AM the NEXT Tashkent
// morning (moved from midnight on 2026-08-19, when fines arrived: $5 past
// 5 AM, $10 if still not in by 3 PM — see lib/dailyReportFines.ts). Monday to
// Friday are expected; weekend reports are welcome but never owed. Reports were
// optional for everyone from 2026-10-14 and came back on 2026-10-19 for a new
// roster (lib/dailyReports.ts), so no day before that counts.

import { fromYmd, toYmd, COMPANY_TIME_ZONE } from "@/lib/dates";

const TASHKENT_UTC_OFFSET_HOURS = 5; // no DST (see lib/lateness.ts)

/** Hard cap on a report's length; the composer counts down near it. */
export const MAX_DAILY_REPORT = 5000;

/** Nothing before this day is owed — the feature shipped here. */
export const DAILY_REPORTS_EPOCH = fromYmd("2026-08-17");

/**
 * No day before this one is owed or fined: the current roster started here.
 * Earlier days belong to the previous roster, which no surface shows any more.
 */
export const DAILY_REPORTS_REQUIRED_FROM = fromYmd("2026-10-19");

/** Today's Tashkent calendar day as "YYYY-MM-DD". */
export function tashkentTodayYmd(now: Date = new Date()): string {
  return toYmd(new Date(now.getTime() + TASHKENT_UTC_OFFSET_HOURS * 3_600_000));
}

/**
 * When the report for `day` is due: 5 AM the next Tashkent morning, as a UTC
 * instant (= day's UTC-midnight key + 29h − 5h offset).
 */
export function dayDeadline(day: Date): Date {
  return new Date(
    day.getTime() + (24 + 5 - TASHKENT_UTC_OFFSET_HOURS) * 3_600_000,
  );
}

/**
 * When a missed report's fine escalates from $5 to $10: 3 PM on the same
 * Tashkent day the 5 AM deadline fell on (= day key + 39h − 5h offset).
 */
export function dayEscalationDeadline(day: Date): Date {
  return new Date(
    day.getTime() + (24 + 15 - TASHKENT_UTC_OFFSET_HOURS) * 3_600_000,
  );
}

/** Whether a report is owed for this day at all (Monday to Friday, from the required-from day). */
// ponytail: one start day for the whole roster. A reporter added later shows
// "Not sent" for weekdays before they joined; pass dailyReporterSinceYmd in here
// if that starts to matter.
export function isRequiredDay(day: Date): boolean {
  const wd = day.getUTCDay();
  return (
    wd >= 1 && wd <= 5 && day.getTime() >= DAILY_REPORTS_REQUIRED_FROM.getTime()
  );
}

// sent     — submitted by 5 AM the next morning
// late     — submitted, but after 5 AM
// pending  — nothing sent yet, deadline still ahead (today, or yesterday
//            before its 5 AM cutoff)
// upcoming — a future day (nothing owed yet)
// missed   — a required weekday whose deadline passed with no report
// skipped: a day that isn't owed (weekend, or before 2026-10-19) with no report
export type DailyReportStatus =
  | "sent"
  | "late"
  | "pending"
  | "upcoming"
  | "missed"
  | "skipped";

export function reportStatus(
  day: Date,
  submittedAt: Date | null,
  now: Date = new Date(),
): DailyReportStatus {
  if (submittedAt) {
    return !isRequiredDay(day) ||
      submittedAt.getTime() <= dayDeadline(day).getTime()
      ? "sent"
      : "late";
  }
  if (now.getTime() < dayDeadline(day).getTime()) {
    // The deadline lives in the NEXT morning, so early hours can hold two open
    // days at once: yesterday (until 5 AM) and today. Both read as pending.
    return toYmd(day) <= tashkentTodayYmd(now) ? "pending" : "upcoming";
  }
  return isRequiredDay(day) ? "missed" : "skipped";
}

/**
 * Display meta per status. Dots use the chart status triad (good/warn/bad,
 * mute for "doesn't count") — state colors, deliberately not the brand or
 * accent hues. `pending` renders as a hollow slot: the day is still open.
 */
export const DAILY_REPORT_STATUS: Record<
  DailyReportStatus,
  { label: string; dot: string }
> = {
  sent: { label: "Sent", dot: "bg-chart-good" },
  late: { label: "Sent late", dot: "bg-chart-warn" },
  pending: { label: "Due by 5 AM", dot: "border-[1.5px] border-muted-fg" },
  upcoming: { label: "Upcoming", dot: "bg-line" },
  missed: { label: "Not sent", dot: "bg-chart-bad" },
  skipped: { label: "No report", dot: "bg-chart-mute" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-08-17" → "Mon, 17 Aug" (year appended when it isn't the current one). */
export function dayLabel(ymd: string, currentYear?: number): string {
  const d = fromYmd(ymd);
  const [y, m, dd] = ymd.split("-").map(Number);
  const base = `${WEEKDAYS[d.getUTCDay()]}, ${dd} ${MONTHS[m - 1]}`;
  return currentYear != null && y !== currentYear ? `${base} ${y}` : base;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** A Date (or ISO string) → "09:32 AM" on the company clock (Tashkent). */
export function formatTimeTz(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: COMPANY_TIME_ZONE,
  });
}
