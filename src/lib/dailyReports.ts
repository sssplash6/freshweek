// Server-only: who writes daily reports and who reads them. A fixed set of
// accounts owes a short report every weekday, due by 5 AM Tashkent the next
// morning (day math and statuses live in lib/dailyReportTypes.ts). Every send
// — and every resend after an edit — notifies the recipient (Valera); today's
// reports sit on his dashboard and /daily-reports gives him the month at a
// glance.

// Adding someone mid-stream? Give them a DAILY_REPORTER_SINCE entry below so
// the fine sweep doesn't back-fine days from before they owed anything.
// The roster since 2026-10-19 (the earlier one was dropped when reports came
// back from their optional spell).
const BUILT_IN_REPORTERS = [
  "behruz.edu@gmail.com",
  "rustam.ganijonov@freshman.academy",
];

const BUILT_IN_RECIPIENT = "valera@freshman.academy";

/**
 * Every account that owes a daily report: the built-ins plus any from the
 * DAILY_REPORT_EMAILS env var (comma-separated), lowercased. Order is
 * meaningful — review surfaces list reporters in this order.
 */
export function dailyReporterEmails(): string[] {
  const fromEnv = (process.env.DAILY_REPORT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILT_IN_REPORTERS, ...fromEnv])];
}

/** Whether this account writes daily reports (case-insensitive). */
export function isDailyReporter(email: string | null | undefined): boolean {
  return !!email && dailyReporterEmails().includes(email.toLowerCase());
}

// The first day a reporter can be fined for. Defaults to the fines epoch (the
// day the rule started, lib/dailyReportTypes.ts) — anyone who joins the list
// later gets an entry here so the sweep's lookback can't reach days from
// before they owed reports.
const DAILY_REPORTER_SINCE: Record<string, string> = {};

/** The first Tashkent day (YMD) this reporter's fines can apply to. */
export function dailyReporterSinceYmd(
  email: string | null | undefined,
): string | null {
  return DAILY_REPORTER_SINCE[email?.toLowerCase() ?? ""] ?? null;
}

/** Who receives the reports; override with DAILY_REPORT_RECIPIENT. */
export function dailyReportRecipient(): string {
  return (
    process.env.DAILY_REPORT_RECIPIENT ?? BUILT_IN_RECIPIENT
  ).toLowerCase();
}

// What each reporter goes by. Profile names mix given-first and surname-first
// ("Shukhratov Shokhrukh" is surname-first), so the given name can't be
// derived from the name string — report surfaces show these instead.
// Env-added reporters fall back to the first word of their profile name.
const REPORTER_FIRST_NAMES: Record<string, string> = {
  "behruz.edu@gmail.com": "Behruz",
  "rustam.ganijonov@freshman.academy": "Rustam",
};

/** The name daily-report surfaces call this person by. */
export function dailyReporterFirstName(
  email: string | null | undefined,
  profileName: string | null | undefined,
): string {
  return (
    REPORTER_FIRST_NAMES[email?.toLowerCase() ?? ""] ??
    profileName?.trim().split(/\s+/)[0] ??
    email ??
    "Someone"
  );
}

/**
 * Whether this account is the reports' reader. The review calendar, the day
 * panel, and the dashboard "Today's reports" card exist for the recipient
 * alone — other admins have no window into the reports.
 */
export function isDailyReportRecipient(
  email: string | null | undefined,
): boolean {
  return !!email && email.toLowerCase() === dailyReportRecipient();
}
