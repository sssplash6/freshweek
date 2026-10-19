/**
 * Cancel the daily-report fines raised after reports went optional.
 *
 * Why: 37d8406 made daily reports optional from 2026-10-14 and removed the
 * fine sweep, but prod wasn't redeployed, so the old sweep kept fining the old
 * roster. This cancels every LATE_DAILY_REPORT fine for a day from 2026-10-14
 * on, except the ones the current roster really owes (lib/dailyReports.ts,
 * required days per lib/dailyReportTypes.ts: weekdays from 2026-10-19).
 *
 * Each cancel does what the admin "delete fine" button does (deletePenalty in
 * app/admin/actions.ts): deletes the fine, records a FineWaiver on the day's
 * 5 AM deadline so a sweep still running the old code can't raise it again,
 * and tells the person. A fine with money against it is only listed: undo the
 * payment on /penalties, then re-run. A fine already on a payroll filing is
 * flagged, since that filing won't process ("deleted after filing") until it's
 * filed again.
 *
 * The current roster is read from this process's env, so pass the same
 * DAILY_REPORT_EMAILS as prod if prod sets one.
 *
 * Usage (dry run: prints what it WOULD cancel, changes nothing):
 *   DATABASE_URL="<prod-url>" npx tsx scripts/cancel-daily-report-fines.ts
 *
 * Apply for real (safe to re-run; a second pass only finds new fines):
 *   DATABASE_URL="<prod-url>" npx tsx scripts/cancel-daily-report-fines.ts --apply
 */
import { prisma } from "@/lib/prisma";
import { notify } from "@/lib/notifications";
import { formatMoney } from "@/lib/penalties";
import { isDailyReporter } from "@/lib/dailyReports";
import { dayDeadline, dayLabel, isRequiredDay } from "@/lib/dailyReportTypes";
import { fromYmd, toYmd } from "@/lib/dates";

const OPTIONAL_FROM = fromYmd("2026-10-14");

async function main() {
  const apply = process.argv.includes("--apply");

  const fines = await prisma.penalty.findMany({
    where: { type: "LATE_DAILY_REPORT", reportDay: { gte: OPTIONAL_FROM } },
    orderBy: [{ reportDay: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      userId: true,
      amount: true,
      paidAmount: true,
      paidAt: true,
      reportDay: true,
      user: { select: { email: true } },
      payrollLines: { select: { submission: { select: { status: true } } } },
    },
  });

  let cancelled = 0;
  let total = 0;
  for (const f of fines) {
    const day = f.reportDay!;
    const label = `${f.user.email}  ${toYmd(day)}  ${formatMoney(f.amount)}`;

    if (isDailyReporter(f.user.email) && isRequiredDay(day)) {
      console.log(`${label}  kept (owed by the current roster)`);
      continue;
    }
    if (f.paidAmount > 0 || f.paidAt) {
      console.log(
        `${label}  SKIPPED: ${formatMoney(f.paidAmount)} already paid, undo it on /penalties and re-run`,
      );
      continue;
    }

    const filings = f.payrollLines.map((l) => l.submission.status);
    const filed = filings.length
      ? `  (on a ${filings.join(", ")} payroll filing: it must be filed again)`
      : "";

    if (!apply) {
      console.log(`${label}  would cancel${filed}`);
      cancelled++;
      total += f.amount;
      continue;
    }

    const done = await prisma.$transaction(async (tx) => {
      // Re-check unpaid at write time: a settlement may have landed since the read.
      const del = await tx.penalty.deleteMany({
        where: { id: f.id, paidAmount: 0, paidAt: null },
      });
      if (del.count === 0) return false;
      await tx.fineWaiver.upsert({
        where: {
          userId_cycleDeadline: {
            userId: f.userId,
            cycleDeadline: dayDeadline(day),
          },
        },
        create: { userId: f.userId, cycleDeadline: dayDeadline(day) },
        update: {},
      });
      await notify(
        tx,
        f.userId,
        "FINE",
        `Your ${formatMoney(f.amount)} daily-report fine for ${dayLabel(toYmd(day))} was cancelled.`,
      );
      return true;
    });
    console.log(`${label}  ${done ? "cancelled" : "SKIPPED: paid or gone since the read"}${filed}`);
    if (done) {
      cancelled++;
      total += f.amount;
    }
  }

  console.log(
    `\n${apply ? "Cancelled" : "Would cancel"} ${cancelled} fine${cancelled === 1 ? "" : "s"}, ${formatMoney(total)} in total.` +
      (apply ? "" : " Re-run with --apply to write."),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
