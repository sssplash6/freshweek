import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Dashboard" };
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isProfileComplete } from "@/lib/profile";
import { assertApproved } from "@/lib/approval";
import { isAdmin } from "@/lib/admin";
import { manageableUserIds } from "@/lib/manage";
import { ensureAvatar } from "@/lib/assignAvatar";
import {
  getArchivedWeeks,
  getOrCreateCurrentWeek,
  getWeekBounds,
  nextWeekBounds,
  weekInclude,
} from "@/lib/weeks";
import {
  getArchivedMonths,
  getOrCreateCurrentMonth,
  monthLabel,
  nextMonthBounds,
} from "@/lib/months";
import {
  goalPercent,
  isGoalComplete,
  needsCompletionReason,
  weekPercent,
} from "@/lib/progress";
import {
  formatDateTimeTz,
  formatYmd,
  fromYmd,
  toStamp,
  toYmd,
} from "@/lib/dates";
import { weekOpensAt } from "@/lib/lateness";
import { submissionOffsetHours } from "@/lib/submissionClock";
import { submitsAtBottom } from "@/lib/submitPlacement";
import { reconcileSubmissionFines } from "@/lib/submissionFines";
import {
  reconcileDailyReportFines,
  reconcileDailyReportReminders,
} from "@/lib/dailyReportFines";
import {
  reconcilePayrollReminders,
  submissionNeedingPaymentDetails,
} from "@/lib/payroll";
import { PaymentDetailsPrompt } from "@/app/payroll/_components/PaymentDetailsPrompt";
import {
  dailyReporterEmails,
  dailyReporterFirstName,
  isDailyReporter,
  isDailyReportRecipient,
} from "@/lib/dailyReports";
import {
  dayDeadline,
  formatTimeTz,
  isRequiredDay,
  tashkentTodayYmd,
} from "@/lib/dailyReportTypes";
import { resolveAvatar } from "@/lib/avatar";
import { celebratesOn } from "@/lib/birthdays";
import type { Priority } from "@/lib/priority";
import type { DayTaskCount } from "@/lib/dayTasks";
import { GoalCard } from "./_components/GoalCard";
import { AddGoalCard } from "./_components/AddGoalCard";
import { ProfileMenu } from "./_components/ProfileMenu";
import { WeekProgress } from "./_components/WeekProgress";
import { StartNewWeekButton } from "./_components/StartNewWeekButton";
import { StartNewMonthButton } from "./_components/StartNewMonthButton";
import { FeedbackButton } from "./_components/FeedbackButton";
import {
  WeekArchive,
  type ArchivedAssignedTask,
} from "./_components/WeekArchive";
import { WeekCalendar } from "./_components/WeekCalendar";
import { WeekSubmit } from "./_components/WeekSubmit";
import { PenaltyNotice } from "./_components/PenaltyNotice";
import { NotificationsBell } from "./_components/NotificationsBell";
import { SignupRequestsButton } from "./_components/SignupRequestsButton";
import { SubmitReminder } from "./_components/SubmitReminder";
import { BonusNotice } from "./_components/BonusNotice";
import { AssignedTasks } from "./_components/AssignedTasks";
import { AssignGoalButton } from "./_components/AssignGoalButton";
import { DailyReportPrompt } from "./_components/DailyReportPrompt";
import { BirthdayPrompt } from "./_components/BirthdayPrompt";
import { BirthdayBoard } from "./_components/BirthdayBoard";
import {
  TodaysReports,
  type TodaysReportRow,
} from "./_components/TodaysReports";
import { AssignedByMe } from "./_components/AssignedByMe";
import { PeriodToggle } from "./_components/PeriodToggle";
import { PENALTY_LABEL } from "@/lib/penalties";

// Render by the UTC calendar date the bounds were stored at, so the week label
// doesn't drift by the viewer's timezone.
function formatRange(start: Date, end: Date): string {
  return `${formatYmd(toYmd(start))} – ${formatYmd(toYmd(end))}`;
}

function displayName(u: { name: string | null; email: string | null }): string {
  return u.name ?? u.email ?? "Someone";
}

/** A Date → "YYYY-MM-DD" using its local calendar day (matches week bounds). */
function toLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  // Non-company sign-ups wait in /pending until a lead or admin lets them in.
  await assertApproved(session!.user);

  // Which period the dashboard shows: weekly goals (default) or monthly ones.
  const view = (await searchParams).view === "month" ? "month" : "week";
  const isMonth = view === "month";

  // Require a completed profile before showing the dashboard.
  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      workPhone: true,
      telegramUsername: true,
      // departmentId + mini: the header's join-request button counts only
      // sign-ups at a door this viewer can actually open, and a mini
      // department's lead seat opens none (lib/signupAlerts.ts).
      memberships: {
        select: {
          role: true,
          departmentId: true,
          department: { select: { mini: true } },
        },
      },
      birthday: true,
      avatar: true,
    },
  });
  if (!profile || !isProfileComplete(profile)) redirect("/onboarding");
  // Leads at least one department — the only people the weekly deadline nags.
  const viewerIsLead = profile.memberships.some((m) => m.role === "LEAD");

  /**
   * Who is waiting at this viewer's door, for the header button.
   *
   * A lead sees sign-ups who named one of the departments they lead — their
   * own doorstep, and the same scope their alert used. An admin sees the whole
   * queue, unnamed requests included: tech@ is on every sign-up alert exactly
   * so the unowned ones have an owner. Everyone else queries nothing and
   * renders nothing.
   */
  const viewerIsAdmin = isAdmin(session!.user.email);
  const myDoorIds = profile.memberships
    .filter((m) => m.role === "LEAD" && !m.department.mini)
    .map((m) => m.departmentId);
  const atMyDoor =
    viewerIsAdmin || myDoorIds.length > 0
      ? await prisma.user.findMany({
          where: {
            approvedAt: null,
            ...(viewerIsAdmin
              ? {}
              : { requestedDepartmentId: { in: myDoorIds } }),
          },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            email: true,
            requestedDepartment: { select: { name: true } },
          },
        })
      : [];
  // Named, because a button that says "1" tells you nothing about whether to
  // stop what you're doing.
  const doorSummary =
    atMyDoor.length === 1
      ? `${atMyDoor[0].name ?? atMyDoor[0].email ?? "Someone"} is waiting to join ${
          atMyDoor[0].requestedDepartment?.name ?? "the team"
        }`
      : `${atMyDoor.length} people are waiting to join${
          viewerIsAdmin ? "" : " your departments"
        }`;

  // Enforce the weekly submission deadline for this person: if they've missed
  // Sunday 12:00 (or the Monday meeting escalation) without submitting, this
  // issues/updates their fine so it shows on this very load. Idempotent and
  // best-effort — never block the dashboard on it.
  await reconcileSubmissionFines({ userId }).catch(() => {});

  // Fire the monthly payroll filing reminder when its 09:00 slot has passed —
  // the same lazy no-cron pattern; claims once per period, so this is a cheap
  // read on every load after that. Best-effort like the sweep above.
  await reconcilePayrollReminders().catch(() => {});

  // Same treatment for daily reports: fine this person's missed 5 AM
  // deadlines, and fire the 21:00 "not sent yet" nudge for the whole roster
  // once its slot has passed (claimed once per day).
  await reconcileDailyReportFines({ userId }).catch(() => {});
  await reconcileDailyReportReminders().catch(() => {});

  // Backfill a unique avatar for users created before avatars existed.
  const avatar =
    profile.avatar ?? (await ensureAvatar(userId, session!.user.email));

  // The updates zone shows everything from the last 48 hours.
  const updatesSince = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const now = new Date();

  // Daily-report surfaces: reporters get their own way in (a status row under
  // the period toggle — the dashboard hides the site nav), admins get today's
  // reports at a glance in the sidebar.
  const reportDayYmd = tashkentTodayYmd(now);
  const reportDay = fromYmd(reportDayYmd);
  const dailyReporter = isDailyReporter(session!.user.email);
  const ownTodayReport = dailyReporter
    ? await prisma.dailyReport.findUnique({
        where: { userId_day: { userId, day: reportDay } },
        select: { submittedAt: true },
      })
    : null;
  // Between midnight and 5 AM Tashkent, yesterday's report is still open —
  // the prompt nags about that day, not today's barely-started one.
  const reportYesterday = new Date(reportDay.getTime() - 86_400_000);
  const yesterdayReportOpen =
    dailyReporter &&
    isRequiredDay(reportYesterday) &&
    now.getTime() < dayDeadline(reportYesterday).getTime() &&
    !(await prisma.dailyReport.findUnique({
      where: { userId_day: { userId, day: reportYesterday } },
      select: { id: true },
    }));
  const reportRecipient = isDailyReportRecipient(session!.user.email);
  let todaysReportRows: TodaysReportRow[] = [];
  if (reportRecipient) {
    const reporterOrder = dailyReporterEmails();
    const reporters = await prisma.user.findMany({
      where: { email: { in: reporterOrder, mode: "insensitive" } },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        dailyReports: {
          where: { day: reportDay },
          select: { content: true, submittedAt: true },
        },
      },
    });
    const rank = (e: string | null) =>
      reporterOrder.indexOf((e ?? "").toLowerCase());
    todaysReportRows = [...reporters]
      .sort((a, b) => rank(a.email) - rank(b.email))
      .map((r) => {
        const report = r.dailyReports[0] ?? null;
        const av = resolveAvatar(r.avatar, r.email ?? r.name);
        return {
          id: r.id,
          name: dailyReporterFirstName(r.email, r.name),
          emoji: av.emoji,
          bg: av.bg,
          timeLabel: report ? formatTimeTz(report.submittedAt) : null,
          late:
            report != null &&
            report.submittedAt.getTime() > dayDeadline(reportDay).getTime(),
          optionalDay: !isRequiredDay(reportDay),
          content: report?.content ?? null,
        };
      });
  }

  // Window of day-task markers to load for the calendar. It renders one month
  // back to thirteen forward (see WeekCalendar); this is deliberately wider so
  // the edges stay marked even when the viewer's timezone puts them on a
  // different calendar day than the server.
  const markerStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1),
  );
  const markerEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 15, 1),
  );

  const [
    period,
    members,
    archivedPeriods,
    editableArchivedWeek,
    penalties,
    bonuses,
    assignedTasks,
    assignedByMe,
    recentNotifications,
    olderUnreadNotifications,
    unreadCount,
    dayTaskRows,
  ] = await Promise.all([
      isMonth ? getOrCreateCurrentMonth(userId) : getOrCreateCurrentWeek(userId),
      prisma.user.findMany({
        where: { id: { not: userId } },
        select: { id: true, name: true, email: true },
        orderBy: [{ name: "asc" }, { email: "asc" }],
      }),
      isMonth ? getArchivedMonths(userId) : getArchivedWeeks(userId),
      // The most recent archived week, loaded with full goal/subtask/share
      // detail — it's the one past week the archive lets the user edit.
      isMonth
        ? Promise.resolve(null)
        : prisma.week.findFirst({
            where: { userId, isCurrent: false },
            orderBy: { startDate: "desc" },
            include: weekInclude,
          }),
      prisma.penalty.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          amount: true,
          paidAmount: true,
          note: true,
          createdAt: true,
          paidAt: true,
          meeting: { select: { scheduledAt: true } },
        },
      }),
      prisma.bonus.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, amount: true, note: true, createdAt: true },
      }),
      prisma.assignedTask.findMany({
        where: { userId },
        orderBy: [{ completedAt: "asc" }, { createdAt: "desc" }],
        select: {
          id: true,
          title: true,
          note: true,
          scope: true,
          deadline: true,
          completedAt: true,
        },
      }),
      // Goals this user has assigned to others — shown beneath their fines.
      prisma.assignedTask.findMany({
        where: { assignedById: userId },
        orderBy: [{ completedAt: "asc" }, { createdAt: "desc" }],
        select: {
          id: true,
          title: true,
          note: true,
          scope: true,
          deadline: true,
          completedAt: true,
          user: { select: { name: true, email: true, avatar: true } },
        },
      }),
      prisma.notification.findMany({
        where: { userId, createdAt: { gte: updatesSince } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true,
          type: true,
          message: true,
          createdAt: true,
          readAt: true,
        },
      }),
      // Unread notifications older than the 48-hour window — the badge counts
      // them, so the dropdown must surface them too (below the recent list).
      prisma.notification.findMany({
        where: { userId, readAt: null, createdAt: { lt: updatesSince } },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          type: true,
          message: true,
          createdAt: true,
          readAt: true,
        },
      }),
      // Unread notifications of any age — the bell badge counts these, so an
      // unread fine older than 48 hours doesn't silently drop off the badge.
      prisma.notification.count({ where: { userId, readAt: null } }),
      // Just enough of each day task to mark its day in the calendar; the full
      // list for one day is fetched when that day is opened.
      prisma.dayTask.findMany({
        where: { userId, date: { gte: markerStart, lt: markerEnd } },
        select: { date: true, isDone: true },
      }),
    ]);

  // The user's own fines. Only what's *still owed* drives the money block —
  // a fine drops out once it's fully settled (cut from salary), and one that's
  // been part-paid counts for the remainder only, so the figure is always what
  // they'd actually pay today. Everything settled to date, whole fines and part
  // payments alike, is summed separately as a quiet "paid" note. This week's
  // outstanding fines are broken out front-and-centre, on both views.
  // A fine's "date" is the meeting it relates to (for skips) or when it was
  // recorded (late submissions / manual fines).
  const activePenalties = penalties.filter((p) => p.paidAt == null);
  const outstandingTotal = activePenalties.reduce(
    (s, p) => s + (p.amount - p.paidAmount),
    0,
  );
  const paidTotal = penalties.reduce((s, p) => s + p.paidAmount, 0);
  // "This week" for the fines breakdown: the viewed period's own bounds on the
  // week view; the current calendar week on the month view (fines aren't
  // month-scoped, so the week split must stay literal there).
  const weekWindow = isMonth
    ? getWeekBounds(now)
    : { start: period.startDate, end: period.endDate };
  const weekStartMs = weekWindow.start.getTime();
  const weekEndMs = weekWindow.end.getTime();
  const penaltyDate = (p: (typeof penalties)[number]) =>
    p.meeting?.scheduledAt ?? p.createdAt;
  const toRow = (p: (typeof penalties)[number]) => ({
    id: p.id,
    label: PENALTY_LABEL[p.type],
    // What's left on it, with the original amount alongside so a part payment
    // is visible rather than looking like the fine was quietly reduced.
    amount: p.amount - p.paidAmount,
    fullAmount: p.amount,
    paidAmount: p.paidAmount,
    note: p.note,
    dateLabel: formatDateTimeTz(penaltyDate(p)),
  });
  const inThisWeek = (p: (typeof penalties)[number]) => {
    const d = penaltyDate(p).getTime();
    return d >= weekStartMs && d <= weekEndMs;
  };
  const weekPenalties = activePenalties.filter(inThisWeek).map(toRow);
  // Earlier outstanding fines are itemised too (not just summed) so the reason
  // for every unpaid fine stays visible, not only this week's.
  const earlierPenalties = activePenalties
    .filter((p) => !inThisWeek(p))
    .map(toRow);
  const weekPenaltyTotal = weekPenalties.reduce((s, p) => s + p.amount, 0);

  // The user's own bonuses — tracked separately from fines (no netting), shown
  // alongside them so the person sees both. Not period-scoped.
  const bonusTotal = bonuses.reduce((s, b) => s + b.amount, 0);
  const bonusRows = bonuses.map((b) => ({
    id: b.id,
    amount: b.amount,
    note: b.note,
    dateLabel: formatDateTimeTz(b.createdAt),
  }));

  // Notifications from the last 48 hours, for the header bell.
  const updates = recentNotifications.map((n) => ({
    id: n.id,
    type: n.type,
    message: n.message,
    dateLabel: formatDateTimeTz(n.createdAt),
    unread: n.readAt == null,
  }));

  // Older unread ones — everything the badge counts is listed somewhere.
  const olderUnread = olderUnreadNotifications.map((n) => ({
    id: n.id,
    type: n.type,
    message: n.message,
    dateLabel: formatDateTimeTz(n.createdAt),
    unread: true,
  }));

  // Admin-assigned tasks — shown as a standalone list, not part of week %.
  // Weekly-scoped ones surface on the week view, monthly ones on the month view.
  const scopedAssigned = assignedTasks.filter(
    (t) => (t.scope === "MONTHLY") === isMonth,
  );

  // A finished assigned task belongs to the period its deadline falls in (or,
  // with no deadline, the period it was ticked off in). Once that period is
  // archived the task is filed there instead of sitting in the Inbox for ever.
  // Compared as calendar days, so a UTC-midnight deadline can't fall outside a
  // period whose bounds were stored in a different timezone. Unfinished tasks are
  // never filed, however old — outstanding work has to stay in front of people.
  const assignedArchive = new Map<string, ArchivedAssignedTask[]>();
  const filedAssignedIds = new Set<string>();
  for (const p of archivedPeriods) {
    const from = toYmd(p.startDate);
    const to = toYmd(p.endDate);
    const filed = scopedAssigned.filter((t) => {
      if (t.completedAt == null) return false;
      const day = toYmd(t.deadline ?? t.completedAt);
      return day >= from && day <= to;
    });
    if (filed.length === 0) continue;
    for (const t of filed) filedAssignedIds.add(t.id);
    assignedArchive.set(
      p.id,
      filed.map((t) => ({
        id: t.id,
        title: t.title,
        deadlineLabel: t.deadline ? formatYmd(toYmd(t.deadline)) : null,
      })),
    );
  }

  const assignedTaskViews = scopedAssigned
    .filter((t) => !filedAssignedIds.has(t.id))
    .map((t) => ({
      id: t.id,
      title: t.title,
      note: t.note,
      deadlineLabel: t.deadline ? formatYmd(toYmd(t.deadline)) : null,
      done: t.completedAt != null,
    }));

  // Goals this user handed to others (both scopes), pending first.
  const assignedByMeViews = assignedByMe.map((t) => {
    const av = resolveAvatar(t.user.avatar, t.user.email ?? t.user.name);
    return {
      id: t.id,
      title: t.title,
      recipient: displayName(t.user),
      emoji: av.emoji,
      bg: av.bg,
      scope: t.scope,
      deadlineLabel: t.deadline ? formatYmd(toYmd(t.deadline)) : null,
      deadline: t.deadline ? toYmd(t.deadline) : null,
      note: t.note,
      done: t.completedAt != null,
    };
  });

  const overall = weekPercent(period.goals);
  const locked = period.goalsLocked;
  const submittedAtLabel = period.submittedAt
    ? formatDateTimeTz(period.submittedAt)
    : null;

  // Every goal below 100% at close needs a reflection reason — including ones
  // marked complete at a partial rate, not just unfinished ones.
  const incompleteGoals = period.goals
    .filter((g) => needsCompletionReason(g))
    .map((g) => ({ id: g.id, title: g.title, percent: goalPercent(g) }));

  // Candidates to carry into the new week — every current goal, with unfinished
  // ones pre-checked in the Start-new-week dialog.
  const carryGoals = period.goals.map((g) => {
    const percent = goalPercent(g);
    return { id: g.id, title: g.title, percent, done: percent === 100 };
  });

  // A pay request filed before the card/bank fields existed has nothing
  // finance can pay from, and nothing tells the filer. The dashboard is where
  // everyone lands, so the ask happens here as well as on /payroll.
  const needsPayoutDetails = await submissionNeedingPaymentDetails(userId);

  // Whose birthday falls on the company's calendar day. The whole team is a
  // dozen-odd rows and Prisma has no date-part filter (month/day matching
  // would mean raw SQL), so the day is matched here — see lib/birthdays.ts for
  // the rule, leap day included. Same population as /team: approved, named.
  const birthdayRows = await prisma.user.findMany({
    where: {
      name: { not: null },
      approvedAt: { not: null },
      birthday: { not: null },
    },
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
      telegramUsername: true,
      birthday: true,
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });
  const birthdaysToday = birthdayRows
    .filter((u) => u.birthday && celebratesOn(toYmd(u.birthday), reportDayYmd))
    .map((u) => {
      const av = resolveAvatar(u.avatar, u.email ?? u.name);
      return {
        id: u.id,
        name: u.name ?? u.email ?? "A teammate",
        emoji: av.emoji,
        bg: av.bg,
        telegram: u.telegramUsername,
        isYou: u.id === userId,
      };
    });

  const todayYmd = toYmd(now);
  const nowStamp = toStamp(now);

  // Default date range for the next week (editable in the Start-new-week
  // dialog); the next month is fixed — always the following calendar month.
  const nextWeek = nextWeekBounds(period.endDate);
  const defaultWeekStart = toLocalYmd(nextWeek.start);
  const defaultWeekEnd = toLocalYmd(nextWeek.end);
  const nextMonthName = monthLabel(nextMonthBounds(period.endDate).start);

  // The next week can't be opened before Friday noon of the week before it, so
  // the close button waits until then instead of letting someone close mid-week
  // and spend the rest of the cycle a week ahead of the team (see weekOpensAt;
  // the same rule is enforced in startNewWeek). Anyone catching up on an
  // overdue week is already past their Friday, so this never blocks them.
  const canStartNextWeek =
    now.getTime() >=
    weekOpensAt(nextWeek.start, submissionOffsetHours(session!.user.email)).getTime();
  // The Friday the window opens: three days before the new week's Monday.
  const opensOnLabel = formatYmd(
    toLocalYmd(new Date(nextWeek.start.getTime() - 3 * 86_400_000)),
  );

  // Open goals due on each day, keyed by "YYYY-MM-DD", as a list of their
  // priorities (null = no flag) so the calendar can color each dot.
  const deadlineDots: Record<string, (Priority | null)[]> = {};
  for (const g of period.goals) {
    if (g.deadline && !isGoalComplete(g)) {
      const key = toYmd(g.deadline);
      (deadlineDots[key] ??= []).push(g.priority ?? null);
    }
  }

  // How many day tasks each day holds, and how many are still open — the
  // calendar tints a day by this. Separate from the deadline dots above:
  // those are goals, these are the day's own focus list.
  const dayTaskCounts: Record<string, DayTaskCount> = {};
  for (const t of dayTaskRows) {
    const key = toYmd(t.date);
    const entry = (dayTaskCounts[key] ??= { total: 0, open: 0 });
    entry.total++;
    if (!t.isDone) entry.open++;
  }

  // Flatten to a serializable shape for the client components. Shared by the
  // current period and the editable archived week (same include payload).
  const toGoalView = (goal: (typeof period.goals)[number]) => ({
    id: goal.id,
    title: goal.title,
    completed: isGoalComplete(goal),
    deadline: goal.deadline ? toStamp(goal.deadline) : null,
    priority: goal.priority ?? null,
    manualPercent: goal.manualPercent,
    sharedTo: goal.sharesOut.map((sh) => displayName(sh.toUser)),
    receivedFrom: goal.shareIn ? displayName(goal.shareIn.fromUser) : null,
    subtasks: goal.subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      isDone: s.isDone,
      sharedTo: s.sharesOut.map((sh) => displayName(sh.toUser)),
      receivedFrom: s.shareIn ? displayName(s.shareIn.fromUser) : null,
    })),
  });
  const goals = period.goals.map(toGoalView);

  // The editable archived week's goals, in position order (no completed-first
  // re-sort — reordering while editing would be jarring).
  const editableArchiveGoals =
    editableArchivedWeek?.goals.map(toGoalView) ?? null;

  // Completed goals sink to the bottom automatically. Array.sort is stable, so
  // position order is preserved within the open and completed groups. This is
  // display-only — the stored `position` is untouched, so reopening a goal
  // returns it to its original spot.
  goals.sort((a, b) => Number(a.completed) - Number(b.completed));

  // Goals delegated to this user by a teammate move into the Inbox section
  // instead of the main list — but they're still real goals in the period, so
  // they keep counting toward the week/month percent.
  const inboxGoals = goals.filter((g) => g.receivedFrom);
  const ownGoals = goals.filter((g) => !g.receivedFrom);

  // Sharing a single subtask auto-creates (or reuses) a same-titled goal on
  // the recipient's list (see shareSubtask), which otherwise blends in with
  // goals they wrote themselves. Anything carrying a teammate's subtask gets
  // its own "Shared goals" section below the main list; goals that are wholly
  // the user's stay up top.
  const hasSharedIn = (g: (typeof goals)[number]) =>
    g.subtasks.some((s) => s.receivedFrom);
  const sharedGoals = ownGoals.filter(hasSharedIn);
  const myGoals = ownGoals.filter((g) => !hasSharedIn(g));

  const team = members.map((m) => ({ id: m.id, name: displayName(m) }));

  // Who the viewer may assign goals to: everyone for admins, the members under
  // their departments for leads, nobody otherwise (the FAB hides itself).
  const manageScope = await manageableUserIds({
    id: userId,
    email: session!.user.email,
  });
  const assignablePeople =
    manageScope === "all" ? team : team.filter((m) => manageScope.has(m.id));

  const archive = archivedPeriods.map((p) => ({
    id: p.id,
    label: isMonth ? monthLabel(p.startDate) : formatRange(p.startDate, p.endDate),
    percent: weekPercent(p.goals),
    goals: p.goals.map((g) => ({
      id: g.id,
      title: g.title,
      percent: goalPercent(g),
      completed: isGoalComplete(g),
      incompleteReason: g.incompleteReason,
      subtasks: g.subtasks.map((s) => ({
        id: s.id,
        title: s.title,
        isDone: s.isDone,
      })),
    })),
    // Assigned tasks finished in this period, filed here rather than the Inbox.
    assignedTasks: assignedArchive.get(p.id) ?? [],
  }));

  // The user's own money block — fines and bonuses, shown on both views (a
  // fine isn't week-scoped, so it can't vanish on the month view). Lives in
  // the left sidebar on desktop; on smaller screens (no sidebar) it renders at
  // the top of the main column instead.
  const moneyNotices =
    outstandingTotal > 0 || bonusTotal > 0 ? (
      <>
        {outstandingTotal > 0 && (
          <PenaltyNotice
            weekPenalties={weekPenalties}
            earlierPenalties={earlierPenalties}
            weekTotal={weekPenaltyTotal}
            outstandingTotal={outstandingTotal}
            paidTotal={paidTotal}
          />
        )}
        {bonusTotal > 0 && <BonusNotice bonuses={bonusRows} total={bonusTotal} />}
      </>
    ) : null;

  // The submit control sits above the goal list for everyone except the
  // accounts in lib/submitPlacement.ts, who read down their goals first and
  // hit Submit at the end. Built once here so both spots stay in sync.
  const submitAtBottom = submitsAtBottom(session!.user.email);
  const weekSubmit = (
    <WeekSubmit
      scope={view}
      locked={locked}
      submittedAtLabel={submittedAtLabel}
      goalCount={goals.length}
      placement={submitAtBottom ? "bottom" : "top"}
    />
  );

  return (
    <>
      {/* Entry alert: nags until this period's goals are submitted once.
          Submissions are only expected from department leads — members can
          still submit, they're just never nagged about it. */}
      {period.submittedAt == null && viewerIsLead && (
        <SubmitReminder scope={view} />
      )}

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-8">
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="sticky top-8">
          {todaysReportRows.length > 0 && (
            <div className="mb-6">
              <TodaysReports rows={todaysReportRows} />
            </div>
          )}
          {moneyNotices && (
            <div className="mb-6 flex flex-col gap-3">{moneyNotices}</div>
          )}
          <WeekArchive
            weeks={archive}
            periodNoun={view}
            editableWeek={
              editableArchivedWeek && editableArchiveGoals
                ? { id: editableArchivedWeek.id, goals: editableArchiveGoals }
                : null
            }
            team={team}
            todayYmd={todayYmd}
            nowStamp={nowStamp}
          />
        </div>
      </aside>

      <main className="flex w-full min-w-0 max-w-3xl flex-1 flex-col">
        <header className="mb-6 flex items-start justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-widest text-brand">
            freshman.academy
          </div>
          <h1 className="mt-1 text-xl font-bold text-ink sm:text-2xl">
            {isMonth
              ? monthLabel(period.startDate)
              : formatRange(period.startDate, period.endDate)}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-4">
          <WeekProgress percent={overall} label={isMonth ? "Month" : "Week"} />
          <div className="flex items-center gap-2">
            <SignupRequestsButton
              count={atMyDoor.length}
              summary={doorSummary}
              href={viewerIsAdmin ? "/admin" : "/department"}
            />
            <NotificationsBell
              updates={updates}
              olderUnread={olderUnread}
              unreadCount={unreadCount}
            />
            <ProfileMenu
              name={session!.user.name}
              email={session!.user.email}
              avatar={avatar}
              isAdmin={isAdmin(session!.user.email)}
              isLead={viewerIsLead}
            />
          </div>
        </div>
      </header>

      {needsPayoutDetails && (
        <PaymentDetailsPrompt
          pending={{
            submissionId: needsPayoutDetails.id,
            method: needsPayoutDetails.method,
            details: needsPayoutDetails.details,
            periodLabel: needsPayoutDetails.periodLabel,
          }}
        />
      )}

      {/* The one ask that used to be a locked door: a missing birthday sent
          people to /onboarding instead of the dashboard, so the accounts that
          predate the field could never be told what was wanted. They're let
          in now and nagged here. */}
      {profile.birthday == null && <BirthdayPrompt maxYmd={todayYmd} />}

      <PeriodToggle view={view} showDaily={dailyReporter || reportRecipient} />

      {dailyReporter && (
        <div className="mb-5">
          <DailyReportPrompt
            sentTimeLabel={
              ownTodayReport ? formatTimeTz(ownTodayReport.submittedAt) : null
            }
            optionalDay={!isRequiredDay(reportDay)}
            yesterdayOpen={yesterdayReportOpen}
          />
        </div>
      )}

      {todaysReportRows.length > 0 && (
        <div className="mb-5 lg:hidden">
          <TodaysReports rows={todaysReportRows} />
        </div>
      )}

      {moneyNotices && (
        <div
          className={`mb-5 grid items-start gap-3 lg:hidden ${
            outstandingTotal > 0 && bonusTotal > 0 ? "sm:grid-cols-2" : ""
          }`}
        >
          {moneyNotices}
        </div>
      )}

      {/* xl:hidden, not lg — the card lives in the right sidebar now, which
          only exists from xl up; between lg and xl it must stay inline. */}
      {assignedByMeViews.length > 0 && (
        <div className="mb-5 xl:hidden">
          <AssignedByMe items={assignedByMeViews} />
        </div>
      )}

      {assignedTaskViews.length > 0 && (
        <section className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">
              Assigned by leadership
            </h2>
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-fg">
              {assignedTaskViews.length}
            </span>
          </div>
          <AssignedTasks tasks={assignedTaskViews} />
        </section>
      )}

      {inboxGoals.length > 0 && (
        <section className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">
              Assigned by colleagues
            </h2>
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-fg">
              {inboxGoals.length}
            </span>
          </div>
          <div className="flex flex-col gap-4">
            {inboxGoals.map((goal, i) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                index={i + 1}
                team={team}
                todayYmd={todayYmd}
                nowStamp={nowStamp}
                locked={locked}
              />
            ))}
          </div>
        </section>
      )}

      {!submitAtBottom && weekSubmit}

      <section className="flex flex-col gap-4">
        {myGoals.map((goal, i) => (
          <GoalCard
            key={goal.id}
            goal={goal}
            index={i + 1}
            team={team}
            todayYmd={todayYmd}
            nowStamp={nowStamp}
            locked={locked}
          />
        ))}

        {!locked && (
          <AddGoalCard
            nextIndex={myGoals.length + 1}
            todayYmd={todayYmd}
            scope={view}
          />
        )}

        {myGoals.length === 0 && (
          <p className="px-1 text-sm text-muted-fg">
            Add your goals for the {view}, then break each one into subtasks.
          </p>
        )}
      </section>

      {submitAtBottom && weekSubmit}

      {sharedGoals.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Shared goals</h2>
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-fg">
              {sharedGoals.length}
            </span>
            <span className="text-xs text-muted-fg">
              with subtasks from your team
            </span>
          </div>
          <div className="flex flex-col gap-4">
            {sharedGoals.map((goal, i) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                index={i + 1}
                team={team}
                todayYmd={todayYmd}
                nowStamp={nowStamp}
                locked={locked}
              />
            ))}
          </div>
        </section>
      )}

      {/* Both sidebars are hidden on narrow screens (archive below lg, calendar
          below xl); surface their content inline so nothing is lost on mobile. */}
      <div className="mt-8 lg:hidden">
        <WeekArchive
          weeks={archive}
          periodNoun={view}
          editableWeek={
            editableArchivedWeek && editableArchiveGoals
              ? { id: editableArchivedWeek.id, goals: editableArchiveGoals }
              : null
          }
          team={team}
          todayYmd={todayYmd}
          nowStamp={nowStamp}
        />
      </div>
      <div className="mt-8 xl:hidden">
        {/* A birthday takes the calendar's slot for the day — see
            BirthdayBoard. */}
        {birthdaysToday.length > 0 ? (
          <BirthdayBoard people={birthdaysToday} />
        ) : (
          <WeekCalendar deadlines={deadlineDots} dayTasks={dayTaskCounts} />
        )}
      </div>

        <footer className="mt-10 border-t border-line pt-6">
          {isMonth ? (
            <StartNewMonthButton
              incompleteGoals={incompleteGoals}
              nextMonthLabel={nextMonthName}
              todayYmd={todayYmd}
            />
          ) : (
            <StartNewWeekButton
              incompleteGoals={incompleteGoals}
              carryGoals={carryGoals}
              defaultStart={defaultWeekStart}
              defaultEnd={defaultWeekEnd}
              canStart={canStartNextWeek}
              opensOnLabel={opensOnLabel}
            />
          )}
        </footer>
      </main>

      <aside className="hidden w-64 shrink-0 xl:block">
        <div className="sticky top-8">
          {assignedByMeViews.length > 0 && (
            <div className="mb-6">
              <AssignedByMe items={assignedByMeViews} />
            </div>
          )}
          {birthdaysToday.length > 0 ? (
            <BirthdayBoard people={birthdaysToday} />
          ) : (
            <WeekCalendar deadlines={deadlineDots} dayTasks={dayTaskCounts} />
          )}
        </div>
      </aside>

      {/* Admins can assign to anyone; a department lead to the members under
          them (the action re-checks the same scope server-side). */}
      {assignablePeople.length > 0 && (
        <AssignGoalButton people={assignablePeople} />
      )}
      <FeedbackButton />
      </div>
    </>
  );
}
