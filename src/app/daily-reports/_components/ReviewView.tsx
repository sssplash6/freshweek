import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { fromYmd, toYmd } from "@/lib/dates";
import {
  DAILY_REPORT_STATUS,
  DAILY_REPORTS_EPOCH,
  dayLabel,
  formatTimeTz,
  isRequiredDay,
  reportStatus,
  tashkentTodayYmd,
  type DailyReportStatus,
} from "@/lib/dailyReportTypes";
import {
  dailyReporterEmails,
  dailyReporterFirstName,
} from "@/lib/dailyReports";
import { resolveAvatar } from "@/lib/avatar";
import { BackLink } from "@/app/_components/BackLink";
import { ChevronIcon } from "@/app/dashboard/_components/icons";
import { DayReportRow } from "./DayReportRow";

const DAY_MS = 86_400_000;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type Reporter = {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
};

/**
 * The recipient's side: a month of reporting at a glance — one status dot per
 * reporter per day — and the full text of any day one click away. Days before
 * the feature existed carry no marks; a hole only counts on a weekday.
 */
export async function ReviewView({
  monthParam,
  dayParam,
}: {
  monthParam?: string;
  dayParam?: string;
}) {
  const now = new Date();
  const todayYmd = tashkentTodayYmd(now);
  const currentMonth = todayYmd.slice(0, 7);
  const epochMonth = toYmd(DAILY_REPORTS_EPOCH).slice(0, 7);

  // Clamp the viewed month between the feature's first month and the current
  // one; clamp the selected day to something real.
  let month = /^\d{4}-\d{2}$/.test(monthParam ?? "") ? monthParam! : currentMonth;
  if (month > currentMonth) month = currentMonth;
  if (month < epochMonth) month = epochMonth;
  const selectedYmd =
    /^\d{4}-\d{2}-\d{2}$/.test(dayParam ?? "") && dayParam! <= todayYmd
      ? dayParam!
      : todayYmd;

  // Reporters, in the configured order.
  const emails = dailyReporterEmails();
  const users = await prisma.user.findMany({
    where: { email: { in: emails, mode: "insensitive" } },
    select: { id: true, name: true, email: true, avatar: true },
  });
  const rank = (u: Reporter) => emails.indexOf((u.email ?? "").toLowerCase());
  const reporters = [...users].sort((a, b) => rank(a) - rank(b));

  // Every report in the viewed month, plus the selected day if it lies outside.
  const monthFirst = fromYmd(`${month}-01`);
  const monthDays = new Date(
    Date.UTC(monthFirst.getUTCFullYear(), monthFirst.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const monthLast = new Date(monthFirst.getTime() + (monthDays - 1) * DAY_MS);
  const selected = fromYmd(selectedYmd);
  const reports = await prisma.dailyReport.findMany({
    where: {
      userId: { in: reporters.map((r) => r.id) },
      OR: [
        { day: { gte: monthFirst, lte: monthLast } },
        { day: selected },
      ],
    },
    select: {
      userId: true,
      day: true,
      content: true,
      submittedAt: true,
      lastSentAt: true,
    },
  });
  const byUserDay = new Map(
    reports.map((r) => [`${r.userId}:${toYmd(r.day)}`, r]),
  );

  const statusFor = (userId: string, day: Date): DailyReportStatus =>
    reportStatus(
      day,
      byUserDay.get(`${userId}:${toYmd(day)}`)?.submittedAt ?? null,
      now,
    );

  // Calendar cells, Monday-first.
  const lead = (monthFirst.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: monthDays }, (_, i) =>
      toYmd(new Date(monthFirst.getTime() + i * DAY_MS)),
    ),
  ];

  const prevMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, 1);
  const monthLabel = `${MONTH_NAMES[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Daily reports</h1>
          <p className="mt-1 text-sm text-muted-fg">
            A few lines from each reporter every weekday, due by 5 AM the next
            morning. Pick a day to read that day&rsquo;s reports.
          </p>
        </div>
        <div className="shrink-0">
          <BackLink href="/dashboard" label="Dashboard" />
        </div>
      </header>

      <div className="gap-6 md:grid md:grid-cols-[340px_1fr] md:items-start">
        <aside className="md:sticky md:top-8">
          <div className="rounded-xl border border-line bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <MonthArrow
                to={prevMonth >= epochMonth ? `/daily-reports?m=${prevMonth}&d=${selectedYmd}` : null}
                direction="prev"
              />
              <span className="text-sm font-bold text-ink">{monthLabel}</span>
              <MonthArrow
                to={nextMonth <= currentMonth ? `/daily-reports?m=${nextMonth}&d=${selectedYmd}` : null}
                direction="next"
              />
            </div>

            <div className="grid grid-cols-7 gap-1 text-center">
              {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
                <span
                  key={d}
                  className="text-[11px] font-semibold uppercase text-muted-fg"
                >
                  {d}
                </span>
              ))}
              {cells.map((ymd, i) => {
                if (!ymd) return <span key={`pad-${i}`} />;
                const day = fromYmd(ymd);
                const inRecord =
                  ymd <= todayYmd &&
                  day.getTime() >= DAILY_REPORTS_EPOCH.getTime();
                const dots = inRecord
                  ? reporters
                      .map((r) => statusFor(r.id, day))
                      .filter((s) =>
                        ["sent", "late", "missed", "pending"].includes(s),
                      )
                  : [];
                const isSelected = ymd === selectedYmd;
                const isToday = ymd === todayYmd;
                const number = (
                  <span
                    className={`text-xs tabular-nums ${
                      isToday
                        ? "font-bold text-brand"
                        : inRecord
                          ? "font-medium text-ink"
                          : "text-muted-fg"
                    }`}
                  >
                    {Number(ymd.slice(8))}
                  </span>
                );
                // Six reporters don't fit one row in a cell — wrap into rows
                // of three inside the cell instead of spilling past its edge.
                const dotRow = (
                  <span className="flex min-h-1.5 max-w-6 flex-wrap items-center justify-center gap-[3px]">
                    {dots.map((s, j) => (
                      <span
                        key={j}
                        className={`h-1.5 w-1.5 rounded-full ${DAILY_REPORT_STATUS[s].dot}`}
                      />
                    ))}
                  </span>
                );
                if (!inRecord) {
                  return (
                    <span
                      key={ymd}
                      className="flex h-11 flex-col items-center justify-center gap-1 rounded-lg border border-transparent"
                    >
                      {number}
                      {dotRow}
                    </span>
                  );
                }
                return (
                  <Link
                    key={ymd}
                    href={`/daily-reports?m=${month}&d=${ymd}`}
                    aria-current={isSelected ? "date" : undefined}
                    className={`flex h-11 flex-col items-center justify-center gap-1 rounded-lg border transition ${
                      isSelected
                        ? "border-brand bg-brand-soft"
                        : "border-transparent hover:bg-canvas"
                    }`}
                  >
                    {number}
                    {dotRow}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-fg">
            <LegendDot className="bg-chart-good" label="Sent" />
            <LegendDot className="bg-chart-warn" label="Sent late" />
            <LegendDot className="bg-chart-bad" label="Not sent" />
            <LegendDot
              className="border-[1.5px] border-muted-fg"
              label="Still open"
            />
          </div>
        </aside>

        <section className="mt-6 md:mt-0">
          <div className="mb-2 flex items-baseline justify-between px-1">
            <h2 className="text-sm font-semibold text-ink">
              {dayLabel(selectedYmd)}
              {selectedYmd === todayYmd && (
                <span className="text-muted-fg"> · today</span>
              )}
            </h2>
            {!isRequiredDay(selected) && (
              <span className="text-xs text-muted-fg">
                Reports optional
              </span>
            )}
          </div>

          <div className="rounded-xl border border-line bg-surface">
            {reporters.map((r, i) => {
              const report = byUserDay.get(`${r.id}:${selectedYmd}`) ?? null;
              const status = statusFor(r.id, selected);
              const avatar = resolveAvatar(r.avatar, r.email ?? r.name);
              const edited =
                report != null &&
                report.lastSentAt.getTime() - report.submittedAt.getTime() >
                  60_000;
              return (
                <DayReportRow
                  key={r.id}
                  first={i === 0}
                  row={{
                    id: r.id,
                    name: dailyReporterFirstName(r.email, r.name),
                    emoji: avatar.emoji,
                    bg: avatar.bg,
                    status:
                      status === "sent" ||
                      status === "late" ||
                      status === "missed" ||
                      status === "pending"
                        ? status
                        : "none",
                    timeLabel: report ? formatTimeTz(report.submittedAt) : null,
                    editedLabel:
                      report && edited ? formatTimeTz(report.lastSentAt) : null,
                    content: report?.content ?? null,
                  }}
                />
              );
            })}
            {reporters.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-fg">
                None of the reporters have signed in yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MonthArrow({
  to,
  direction,
}: {
  to: string | null;
  direction: "prev" | "next";
}) {
  const cls = `h-4 w-4 ${direction === "prev" ? "rotate-180" : ""}`;
  if (!to) {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-lg text-line">
        <ChevronIcon className={cls} />
      </span>
    );
  }
  return (
    <Link
      href={to}
      aria-label={direction === "prev" ? "Previous month" : "Next month"}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-fg transition hover:bg-canvas hover:text-ink"
    >
      <ChevronIcon className={cls} />
    </Link>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${className}`} />
      {label}
    </span>
  );
}

/** "2026-08" ± n months → "YYYY-MM". */
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
