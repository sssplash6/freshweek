import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { fromYmd, toYmd } from "@/lib/dates";
import {
  DAILY_REPORT_STATUS,
  dayDeadline,
  dayLabel,
  formatTimeTz,
  reportStatus,
  tashkentTodayYmd,
  isRequiredDay,
} from "@/lib/dailyReportTypes";
import { BackLink } from "@/app/_components/BackLink";
import { ReportEditor } from "./ReportEditor";
import { ReporterHistory, type HistoryRow } from "./ReporterHistory";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 14;

/**
 * The reporter's side of daily reports: today's composer front and center,
 * this week's rhythm beside it, and the recent record below — every day
 * editable and resendable, including writing a missed one late.
 */
export async function ReporterView({
  userId,
  showReviewLink = false,
}: {
  userId: string;
  // For reporter-admins: a way over to the team calendar they'd otherwise
  // lose to the composer-first routing.
  showReviewLink?: boolean;
}) {
  const now = new Date();
  const todayYmd = tashkentTodayYmd(now);
  const today = fromYmd(todayYmd);

  const reports = await prisma.dailyReport.findMany({
    where: {
      userId,
      day: { gte: new Date(today.getTime() - HISTORY_DAYS * DAY_MS) },
    },
    select: { day: true, content: true, submittedAt: true, lastSentAt: true },
  });
  const byYmd = new Map(reports.map((r) => [toYmd(r.day), r]));

  // Today's composer state.
  const todays = byYmd.get(todayYmd) ?? null;
  const todayStatus = reportStatus(today, todays?.submittedAt ?? null, now);
  const updated =
    todays != null &&
    todays.lastSentAt.getTime() - todays.submittedAt.getTime() > 60_000;

  // The 5 AM grace window: between midnight and 5 AM Tashkent, yesterday's
  // report is still unsent-but-on-time — and it's the one the late-night
  // writer actually came to send, so it gets its own composer up top rather
  // than hiding until it turns "missed" at 5 AM.
  const yesterdayYmd = toYmd(new Date(today.getTime() - DAY_MS));
  const yesterday = fromYmd(yesterdayYmd);
  const yesterdayOpen =
    !byYmd.has(yesterdayYmd) &&
    isRequiredDay(yesterday) &&
    now.getTime() < dayDeadline(yesterday).getTime();

  // This week, Monday first, as compact status dots.
  const monday = new Date(
    today.getTime() - (((today.getUTCDay() + 6) % 7) * DAY_MS),
  );
  const week = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday.getTime() + i * DAY_MS);
    const ymd = toYmd(day);
    const status = reportStatus(day, byYmd.get(ymd)?.submittedAt ?? null, now);
    return {
      ymd,
      letter: "MTWTFSS"[i],
      isToday: ymd === todayYmd,
      dot: DAILY_REPORT_STATUS[status].dot,
    };
  });

  // The recent record: every sent day, plus the holes that count (missed
  // weekdays) and any still-open day (an unsent weekend yesterday before its
  // 5 AM cutoff — a required yesterday gets the composer card instead).
  // Quiet weekends stay out of the list.
  const history: HistoryRow[] = [];
  for (let i = 1; i <= HISTORY_DAYS; i++) {
    const day = new Date(today.getTime() - i * DAY_MS);
    const ymd = toYmd(day);
    if (ymd === yesterdayYmd && yesterdayOpen) continue;
    const report = byYmd.get(ymd) ?? null;
    const status = reportStatus(day, report?.submittedAt ?? null, now);
    if (!report && status !== "missed" && status !== "pending") continue;
    history.push({
      ymd,
      label: dayLabel(ymd),
      dotClass: DAILY_REPORT_STATUS[status].dot,
      statusLabel: DAILY_REPORT_STATUS[status].label,
      missed: status === "missed",
      timeLabel: report ? formatTimeTz(report.submittedAt) : null,
      content: report?.content ?? "",
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Daily reports</h1>
          <p className="mt-1 text-sm text-muted-fg">
            A few lines on your day, Monday to Friday — due by 5 AM the next
            morning ($5 fine after that, $10 past 3 PM). Goes straight to
            Valera.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showReviewLink && (
            <Link
              href="/daily-reports?view=review"
              className="inline-flex items-center whitespace-nowrap rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-brand shadow-sm transition hover:bg-canvas"
            >
              Team view
            </Link>
          )}
          <BackLink href="/dashboard" label="Dashboard" />
        </div>
      </header>

      {yesterdayOpen && (
        <section className="mb-4 rounded-xl border border-chart-warn/50 bg-surface p-4 sm:p-5">
          <div className="mb-4 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-chart-warn">
              Yesterday — still open
            </p>
            <h2 className="mt-1 text-lg font-bold text-ink">
              {dayLabel(yesterdayYmd)}
            </h2>
            <p className="mt-0.5 text-sm text-muted-fg">
              Not sent yet — you have until 5 AM before the $5 fine lands.
            </p>
          </div>
          <ReportEditor
            dayYmd={yesterdayYmd}
            initialContent=""
            sendLabel="Send report"
            big
          />
        </section>
      )}

      <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-fg">
              Today
            </p>
            <h2 className="mt-1 text-lg font-bold text-ink">
              {dayLabel(todayYmd)}
            </h2>
            <p className="mt-0.5 text-sm">
              {todays ? (
                <>
                  <span className="font-medium text-chart-good">
                    {`Sent ${formatTimeTz(todays.submittedAt)}`}
                  </span>
                  {todayStatus === "late" && (
                    <span className="text-chart-warn"> · after 5 AM</span>
                  )}
                  {updated && (
                    <span className="text-muted-fg">
                      {` · updated ${formatTimeTz(todays.lastSentAt)}`}
                    </span>
                  )}
                </>
              ) : isRequiredDay(today) ? (
                <span className="text-muted-fg">Due by 5 AM tomorrow.</span>
              ) : (
                <span className="text-muted-fg">
                  Weekend — optional, but welcome.
                </span>
              )}
            </p>
          </div>
          <div
            className="flex shrink-0 items-center gap-2 pt-1"
            aria-label="This week"
          >
            {week.map((d) => (
              <div key={d.ymd} className="flex flex-col items-center gap-1.5">
                <span
                  className={`text-[10px] font-semibold uppercase ${
                    d.isToday ? "text-ink" : "text-muted-fg"
                  }`}
                >
                  {d.letter}
                </span>
                <span
                  className={`h-2 w-2 rounded-full ${d.dot}`}
                  aria-hidden="true"
                />
              </div>
            ))}
          </div>
        </div>

        <ReportEditor
          dayYmd={todayYmd}
          initialContent={todays?.content ?? ""}
          sendLabel={todays ? "Send update" : "Send report"}
          big
        />
      </section>

      {history.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 px-1 text-sm font-semibold text-ink">Earlier</h2>
          <ReporterHistory rows={history} />
        </section>
      )}
    </div>
  );
}
