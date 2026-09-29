import Link from "next/link";
import { CalendarIcon, ChevronIcon } from "./icons";

/**
 * A marketing member's way into /marketing from the dashboard (which hides
 * the site nav) — the DailyReportPrompt pattern: one quiet row that says what
 * on the content plan is waiting on this person, most urgent first.
 */
export function MarketingPrompt({
  awaitingReports,
  overdueTasks,
  openTasks,
  nextShootLabel,
}: {
  /** Shoots this person filmed whose Drive links aren't filed yet. */
  awaitingReports: number;
  overdueTasks: number;
  openTasks: number;
  /** "“Open day reel” — tomorrow, 10:00 AM" for their next shoot, if any. */
  nextShootLabel: string | null;
}) {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const urgent = [
    awaitingReports > 0 && plural(awaitingReports, "shoot needs its Drive links", "shoots need their Drive links"),
    overdueTasks > 0 && plural(overdueTasks, "task overdue", "tasks overdue"),
  ].filter(Boolean) as string[];
  const calm = [
    nextShootLabel && `Your next shoot: ${nextShootLabel}`,
    openTasks > 0 && plural(openTasks, "open task", "open tasks"),
  ].filter(Boolean) as string[];

  return (
    <Link
      href="/marketing"
      className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 transition hover:bg-canvas"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"
        aria-hidden="true"
      >
        <CalendarIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">Content plan</span>
        <span className="block truncate text-xs">
          {urgent.length > 0 ? (
            <span className="font-medium text-chart-warn">{urgent.join(" · ")}</span>
          ) : calm.length > 0 ? (
            <span className="text-muted-fg">{calm.join(" · ")}</span>
          ) : (
            <span className="text-muted-fg">Shoots, posts and team tasks</span>
          )}
        </span>
      </span>
      <ChevronIcon
        className="h-4 w-4 shrink-0 text-muted-fg transition group-hover:text-ink"
        aria-hidden="true"
      />
    </Link>
  );
}
