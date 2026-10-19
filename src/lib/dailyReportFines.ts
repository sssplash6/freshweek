// Proactive daily-report fining plus the evening nudge — the same lazy no-cron
// pattern as the weekly sweep (lib/submissionFines.ts) and the payroll
// reminder: everything runs on page loads and is idempotent.
//
// The rules (set 2026-08-19): a weekday's report is due by 5 AM Tashkent the
// next morning. Missing that costs $5; if the report still isn't in by 3 PM
// that same day, the fine becomes $10. Submitting between 5 AM and 3 PM keeps
// it at $5. Weekends are never owed, nothing before 2026-10-19 is ever fined
// (reports were optional 14 to 18 Oct; the roster changed when they came
// back), and at 21:00 Tashkent anyone who hasn't sent that day's report gets a
// reminder (in-app + email) — once per day, claimed by whichever page load
// gets there first.
//
// Taking someone off the roster leaves their fines alone: their days simply
// stop being swept. Cancel anything owed from after they left by hand (see
// scripts/cancel-daily-report-fines.ts).
//
// Idempotency is stronger here than the weekly sweep's createdAt-window trick:
// each fine carries the day it's for (Penalty.reportDay) under a database
// unique, so racing reconciles can't double-fine.

import { prisma } from "@/lib/prisma";
import { notify } from "@/lib/notifications";
import { sendEmails } from "@/lib/email";
import {
  formatMoney,
  LATE_DAILY_REPORT_PENALTY,
  MISSED_DAILY_REPORT_PENALTY,
} from "@/lib/penalties";
import {
  dailyReporterEmails,
  dailyReporterFirstName,
  dailyReporterSinceYmd,
} from "@/lib/dailyReports";
import {
  DAILY_REPORTS_REQUIRED_FROM,
  DAILY_REPORTS_EPOCH,
  dayDeadline,
  dayEscalationDeadline,
  dayLabel,
  isRequiredDay,
  tashkentTodayYmd,
} from "@/lib/dailyReportTypes";
import { fromYmd, toYmd } from "@/lib/dates";

// How many days back the sweep re-checks. Page loads run it many times a day,
// so anything older is already settled history; keeping the window tight also
// bounds the damage if a reporter is ever added without a
// DAILY_REPORTER_SINCE entry.
const FINE_LOOKBACK_DAYS = 7;

/**
 * Reconcile daily-report fines. Pass a `userId` to reconcile just that person
 * (their own dashboard load); omit it to sweep every reporter (admin and
 * /daily-reports loads). `now` is injectable for tests only.
 */
export async function reconcileDailyReportFines(opts?: {
  userId?: string;
  now?: Date;
}): Promise<void> {
  const now = opts?.now ?? new Date();

  const days = finableDays(now);
  if (days.length === 0) return;

  const users = await prisma.user.findMany({
    where: {
      email: { in: dailyReporterEmails(), mode: "insensitive" },
      ...(opts?.userId ? { id: opts.userId } : {}),
    },
    select: {
      id: true,
      email: true,
      dailyReports: {
        where: { day: { in: days } },
        select: { day: true, submittedAt: true },
      },
      penalties: {
        where: { type: "LATE_DAILY_REPORT", reportDay: { in: days } },
        select: {
          id: true,
          amount: true,
          paidAt: true,
          paidAmount: true,
          reportDay: true,
        },
      },
      // Days an admin has already forgiven (they deleted the fine on
      // /penalties — deletePenalty keys the waiver by the day's deadline).
      fineWaivers: {
        where: { cycleDeadline: { in: days.map(dayDeadline) } },
        select: { cycleDeadline: true },
      },
    },
  });

  for (const u of users) {
    const sinceYmd = dailyReporterSinceYmd(u.email);
    const reportByDay = new Map(
      u.dailyReports.map((r) => [r.day.getTime(), r.submittedAt]),
    );
    const fineByDay = new Map(
      u.penalties.map((p) => [p.reportDay!.getTime(), p]),
    );
    const waived = new Set(
      u.fineWaivers.map((w) => w.cycleDeadline?.getTime()),
    );

    for (const day of days) {
      const ymd = toYmd(day);
      // A reporter added mid-stream owes nothing from before they joined.
      if (sinceYmd && ymd < sinceYmd) continue;
      if (waived.has(dayDeadline(day).getTime())) continue;

      const submittedAt = reportByDay.get(day.getTime()) ?? null;
      const amount = dueDailyAmount(submittedAt, day, now);
      const existing = fineByDay.get(day.getTime());
      const label = dayLabel(ymd);

      if (amount === 0) {
        // Sent on time — an untouched fine here was created in error (e.g. a
        // sweep raced the submit). Same rule as the weekly sweep: once money
        // has moved, unwinding is an admin decision on /penalties.
        if (existing && existing.paidAt == null && existing.paidAmount === 0) {
          await prisma.$transaction(async (tx) => {
            const del = await tx.penalty.deleteMany({
              where: { id: existing.id, paidAt: null, paidAmount: 0 },
            });
            if (del.count === 0) return;
            await notify(
              tx,
              u.id,
              "FINE",
              `Your ${formatMoney(existing.amount)} daily-report fine for ${label} was removed — your report was sent on time.`,
            );
          });
        }
        continue;
      }

      const missed = amount >= MISSED_DAILY_REPORT_PENALTY;
      const note = missed
        ? `Daily report for ${label} still not sent by 3 PM`
        : `Daily report for ${label} not sent by the 5 AM deadline`;

      if (!existing) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.penalty.create({
              data: {
                userId: u.id,
                type: "LATE_DAILY_REPORT",
                amount,
                note,
                reportDay: day,
              },
            });
            await notify(
              tx,
              u.id,
              "FINE",
              missed
                ? `You were fined ${formatMoney(amount)} — your daily report for ${label} still wasn't sent by 3 PM.`
                : `You were fined ${formatMoney(amount)} — your daily report for ${label} wasn't sent by the 5 AM deadline.`,
            );
          });
        } catch (e) {
          // The (userId, type, reportDay) unique fired — a racing reconcile
          // created it first, which is exactly the outcome we wanted.
          if ((e as { code?: string })?.code !== "P2002") throw e;
        }
      } else if (existing.paidAt == null && existing.amount < amount) {
        // Escalate an unpaid $5 to $10 at 3 PM. What's been paid stands; the
        // person owes the difference (mirrors the weekly $20 → $40 rule).
        //
        // The read that produced `existing` happened before this transaction.
        // Re-assert it in the where clause so a report that landed, or a
        // settlement recorded, in the gap wins over a price computed from
        // state that has since moved — and say nothing if it did.
        await prisma.$transaction(async (tx) => {
          const updated = await tx.penalty.updateMany({
            where: { id: existing.id, paidAt: null, amount: existing.amount },
            data: { amount, note },
          });
          if (updated.count === 0) return;
          await notify(
            tx,
            u.id,
            "FINE",
            `Your daily-report fine for ${label} was raised to ${formatMoney(amount)} — still not sent by 3 PM.`,
          );
        });
      } else if (
        existing.paidAt == null &&
        existing.amount > amount &&
        existing.paidAmount <= amount
      ) {
        // Re-price DOWN too: the sweep can escalate before it has seen a
        // submit that actually landed before 3 PM. Shrink only while what's
        // paid still fits; anything odder is admin territory on /penalties.
        // Conditional for the same reason as the escalation above.
        await prisma.$transaction(async (tx) => {
          const updated = await tx.penalty.updateMany({
            where: {
              id: existing.id,
              paidAt: null,
              amount: existing.amount,
              paidAmount: { lte: amount },
            },
            data: { amount, note },
          });
          if (updated.count === 0) return;
          await notify(
            tx,
            u.id,
            "FINE",
            `Your daily-report fine for ${label} was reduced to ${formatMoney(amount)} — your report was in before 3 PM.`,
          );
        });
      }
    }
  }
}

/**
 * Days the sweep looks at: required weekdays inside the lookback window whose
 * 5 AM deadline has already passed.
 */
function finableDays(now: Date): Date[] {
  const today = fromYmd(tashkentTodayYmd(now));
  const days: Date[] = [];
  for (let i = 0; i <= FINE_LOOKBACK_DAYS; i++) {
    const day = new Date(today.getTime() - i * 86_400_000);
    if (day.getTime() < DAILY_REPORTS_REQUIRED_FROM.getTime()) break;
    if (!isRequiredDay(day)) continue;
    if (dayDeadline(day).getTime() > now.getTime()) continue;
    days.push(day);
  }
  return days;
}

/**
 * What a person owes for one day: $0 sent by 5 AM, $5 in by 3 PM (or not yet
 * in while it's still before 3 PM), $10 past 3 PM. A late submit's tier is
 * judged by when it landed, so it never re-prices afterwards.
 */
function dueDailyAmount(
  submittedAt: Date | null,
  day: Date,
  now: Date,
): number {
  const at = (submittedAt ?? now).getTime();
  if (submittedAt && at <= dayDeadline(day).getTime()) return 0;
  return at <= dayEscalationDeadline(day).getTime()
    ? LATE_DAILY_REPORT_PENALTY
    : MISSED_DAILY_REPORT_PENALTY;
}

// ----- The 21:00 nudge -----

// 21:00 Tashkent as hours past the day's UTC-midnight key (21 − 5 offset).
const REMINDER_AT_UTC_HOURS = 16;

/**
 * Remind everyone who hasn't sent today's report, once the 21:00 (Tashkent)
 * slot has passed — in-app + email, once per day however many page loads race
 * it (the DailyReportReminder row is the claim). The window stays open until
 * the 5 AM deadline, so a quiet evening still gets its nudge on the first
 * load after nine.
 */
export async function reconcileDailyReportReminders(
  now = new Date(),
): Promise<void> {
  const day = reminderDay(now);
  if (!day) return;

  const claimed = await prisma.dailyReportReminder.createMany({
    data: [{ day }],
    skipDuplicates: true,
  });
  if (claimed.count === 0) return; // another load beat us to it

  const users = await prisma.user.findMany({
    where: { email: { in: dailyReporterEmails(), mode: "insensitive" } },
    select: {
      id: true,
      email: true,
      name: true,
      dailyReports: { where: { day }, select: { id: true } },
    },
  });
  const unsent = users.filter((u) => u.dailyReports.length === 0);
  if (unsent.length === 0) return; // nobody to nudge — the claim is spent

  const label = dayLabel(toYmd(day));
  const appUrl = process.env.AUTH_URL ?? "https://www.freshweek.org";

  // The reminder row above is the claim that keeps racing page loads from all
  // sending this. Kept after a failed delivery it would suppress this day's
  // only nudge — before a deadline that fines people — so it's deleted again
  // and the next load retries. A retry can re-nudge someone the first attempt
  // reached; that's much cheaper than never warning someone at all.
  try {
    await notify(
      prisma,
      unsent.map((u) => u.id),
      "REPORT",
      `Daily report for ${label} not sent yet — due by 5 AM ` +
        `(${formatMoney(LATE_DAILY_REPORT_PENALTY)} after that, ` +
        `${formatMoney(MISSED_DAILY_REPORT_PENALTY)} past 3 PM).`,
    );
    // One batch request, not a parallel burst per person: a burst trips
    // Resend's rate limit and the retry then re-emails everyone it reached.
    const sent = await sendEmails(
      unsent
        .filter((u) => u.email)
        .map((u) => ({
          to: u.email!,
          subject: `Reminder: daily report for ${label}`,
          text:
            `Hi ${dailyReporterFirstName(u.email, u.name)},\n\n` +
            `Your daily report for ${label} hasn't been sent yet. It's due ` +
            `by 5:00 AM Tashkent — after that it's a ` +
            `${formatMoney(LATE_DAILY_REPORT_PENALTY)} fine, and ` +
            `${formatMoney(MISSED_DAILY_REPORT_PENALTY)} if it's still not ` +
            `in by 3 PM.\n\n` +
            `Send it here: ${appUrl}/daily-reports\n\n— FreshWeek`,
        })),
    );
    if (!sent) {
      throw new Error("at least one daily-report reminder email did not go out");
    }
  } catch (e) {
    console.error(
      "reconcileDailyReportReminders: releasing the claim to retry",
      e,
    );
    await prisma.dailyReportReminder.deleteMany({ where: { day } });
  }
}

/** The day whose reminder window [21:00, next-day 5 AM) contains `now`. */
function reminderDay(now: Date): Date | null {
  const today = fromYmd(tashkentTodayYmd(now));
  // Early hours belong to yesterday's window (its deadline is still ahead).
  for (const day of [today, new Date(today.getTime() - 86_400_000)]) {
    const opens = day.getTime() + REMINDER_AT_UTC_HOURS * 3_600_000;
    if (now.getTime() < opens) continue;
    if (now.getTime() >= dayDeadline(day).getTime()) continue;
    if (!isRequiredDay(day)) return null; // weekends are optional — no nag
    if (day.getTime() < DAILY_REPORTS_EPOCH.getTime()) return null;
    return day;
  }
  return null;
}
