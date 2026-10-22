// Client-safe marketing vocabulary: the content-plan constants, the Tashkent
// date-time helpers, and the derived-state display meta the /marketing page
// and its forms share. No env or Prisma imports — who may see the page lives
// in lib/marketingAccess.ts (server-only). Same split as notificationTypes.ts
// vs notifications.ts.

import { parseYmd, toYmd, toHm } from "@/lib/dates";
import { dayLabel } from "@/lib/dailyReportTypes";

/** The department whose members run the content plan (matched insensitively). */
export const MARKETING_DEPARTMENT = "Marketing";

// Field caps — long enough that nobody hits them in honest use, short enough
// that a paste of a whole doc can't land in a list row.
export const MAX_SHOOT_TITLE = 120;
export const MAX_LOCATION = 120;
export const MAX_POST_TITLE = 200;
// Instagram's own caption cap — the longest any channel here accepts.
export const MAX_POST_CAPTION = 2200;
export const MAX_TASK_TITLE = 200;
export const MAX_TASK_NOTE = 1000;
export const MAX_LINK = 2000;

// Tashkent is UTC+5 with no DST, so wall-clock ↔ instant is a fixed offset
// (same arithmetic as dayDeadline in lib/dailyReportTypes.ts). Shoot and post
// times are stored as real instants — the Meeting.scheduledAt convention —
// and rendered back through formatDateTimeTz on the way out.
const TASHKENT_UTC_OFFSET_MS = 5 * 3_600_000;

/**
 * "YYYY-MM-DD" + "HH:MM" as the Tashkent wall clock → the real UTC instant.
 * Returns null on anything that isn't a real calendar day or a real clock
 * time — the caller turns that into a form error rather than a thrown one.
 */
export function tashkentStampToDate(ymd: string, hm: string): Date | null {
  const day = parseYmd(ymd);
  if (!day || !/^\d{2}:\d{2}$/.test(hm)) return null;
  const [h, m] = hm.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  return new Date(day.getTime() + (h * 60 + m) * 60_000 - TASHKENT_UTC_OFFSET_MS);
}

/** An instant → its Tashkent "YYYY-MM-DD", for prefilling a date input. */
export function tashkentYmd(date: Date): string {
  return toYmd(new Date(date.getTime() + TASHKENT_UTC_OFFSET_MS));
}

/** An instant → its Tashkent "HH:MM", for prefilling a time input. */
export function tashkentHm(date: Date): string {
  return toHm(new Date(date.getTime() + TASHKENT_UTC_OFFSET_MS));
}

/** "YYYY-MM-DD" shifted by whole days (calendar math on the UTC-midnight key). */
export function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  return toYmd(new Date(d.getTime() + days * 86_400_000));
}

/**
 * A calendar day as the list headers read it: "Today", "Tomorrow",
 * "Yesterday", otherwise "Wed, 1 Oct" (year added outside the current one).
 */
export function relativeDayLabel(ymd: string, todayYmd: string): string {
  if (ymd === todayYmd) return "Today";
  if (ymd === addDaysYmd(todayYmd, 1)) return "Tomorrow";
  if (ymd === addDaysYmd(todayYmd, -1)) return "Yesterday";
  return dayLabel(ymd, Number(todayYmd.slice(0, 4)));
}

// upcoming         — shootAt still ahead, no report filed
// awaiting-report  — the shoot happened and the Drive links aren't in yet
// reported         — reportedAt set (at least one link filed)
export type ShootState = "upcoming" | "awaiting-report" | "reported";

export function shootState(
  shoot: { shootAt: Date; reportedAt: Date | null },
  now: Date = new Date(),
): ShootState {
  if (shoot.reportedAt) return "reported";
  return shoot.shootAt.getTime() > now.getTime()
    ? "upcoming"
    : "awaiting-report";
}

/**
 * Display meta per state. Dots use the chart status triad (good/warn/mute) —
 * state colors, deliberately not the brand or accent hues, matching
 * DAILY_REPORT_STATUS in lib/dailyReportTypes.ts. `text` is the readable
 * step for the state word itself.
 */
export const SHOOT_STATE: Record<
  ShootState,
  { label: string; dot: string; text: string }
> = {
  upcoming: { label: "Upcoming", dot: "bg-chart-mute", text: "text-muted-fg" },
  "awaiting-report": {
    label: "Awaiting report",
    dot: "bg-chart-warn",
    text: "text-chart-warn",
  },
  reported: { label: "Reported", dot: "bg-chart-good", text: "text-chart-good" },
};

// scheduled — publishAt still ahead, not marked out
// overdue   — publishAt has passed and nobody has marked it out
// out       — publishedAt set
export type PostState = "scheduled" | "overdue" | "out";

export function postState(
  post: { publishAt: Date; publishedAt: Date | null },
  now: Date = new Date(),
): PostState {
  if (post.publishedAt) return "out";
  return post.publishAt.getTime() > now.getTime() ? "scheduled" : "overdue";
}

export const POST_STATE: Record<
  PostState,
  { label: string; dot: string; text: string }
> = {
  scheduled: { label: "Scheduled", dot: "bg-chart-mute", text: "text-muted-fg" },
  overdue: { label: "Overdue", dot: "bg-chart-bad", text: "text-chart-bad" },
  out: { label: "Published", dot: "bg-chart-good", text: "text-chart-good" },
};

/**
 * The channels a post can go out on. Stored as these keys in
 * ContentPost.platforms; the order here is the order the picker shows.
 */
export const POST_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "telegram",
  "facebook",
  "linkedin",
  "website",
  "other",
] as const;
export type PostPlatform = (typeof POST_PLATFORMS)[number];

export const POST_PLATFORM_LABEL: Record<PostPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  telegram: "Telegram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  website: "Website",
  other: "Other",
};

export function isPostPlatform(v: string): v is PostPlatform {
  return (POST_PLATFORMS as readonly string[]).includes(v);
}

/**
 * The academy programs a shoot, post or task can be for. Stored as-is in the
 * `program` column (null = untagged); the order here is the picker's and the
 * calendar filter's.
 */
export const PROGRAMS = ["SAT", "AP", "Global", "Imkon", "Academy", "Alumni"] as const;
export type Program = (typeof PROGRAMS)[number];

export function isProgram(v: string | null | undefined): v is Program {
  return (PROGRAMS as readonly (string | null | undefined)[]).includes(v);
}

// A task's due date against today (Tashkent). Done tasks have no urgency.
export type TaskDue = "overdue" | "today" | "later" | "none";

export function taskDue(
  dueYmd: string | null,
  done: boolean,
  todayYmd: string,
): TaskDue {
  if (!dueYmd || done) return "none";
  if (dueYmd < todayYmd) return "overdue";
  return dueYmd === todayYmd ? "today" : "later";
}

/** How far ahead of a shoot its reminder goes out (the sweep's window). */
export const SHOOT_REMINDER_WINDOW_MS = 24 * 3_600_000;

/** A stored link is only worth keeping if it's a real http(s) URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
