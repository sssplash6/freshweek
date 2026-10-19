import Link from "next/link";
import { PenIcon, ChevronIcon } from "./icons";

/**
 * The reporter's way into /daily-reports from the dashboard (which hides the
 * site nav): one quiet row stating where today stands — unsent and due,
 * already sent, or a free weekend.
 */
export function DailyReportPrompt({
  sentTimeLabel,
  optionalDay,
  yesterdayOpen,
}: {
  sentTimeLabel: string | null;
  optionalDay: boolean;
  // Midnight–5 AM Tashkent with yesterday's report unsent: the urgent day is
  // yesterday, whatever today's own state says.
  yesterdayOpen: boolean;
}) {
  return (
    <Link
      href="/daily-reports"
      className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 transition hover:bg-canvas"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"
        aria-hidden="true"
      >
        <PenIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">
          Daily report
        </span>
        <span className="block text-xs">
          {yesterdayOpen ? (
            <span className="font-medium text-chart-warn">
              Yesterday not sent — due by 5 AM
            </span>
          ) : sentTimeLabel ? (
            <>
              <span className="font-medium text-chart-good">
                {`Sent ${sentTimeLabel}`}
              </span>
              <span className="text-muted-fg"> · edit anytime</span>
            </>
          ) : optionalDay ? (
            <span className="text-muted-fg">Weekend — optional</span>
          ) : (
            <span className="text-muted-fg">Not sent yet — due by 5 AM</span>
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
