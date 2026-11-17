import { prisma } from "@/lib/prisma";
import { goalPercent, isGoalComplete } from "@/lib/progress";

/**
 * Monday 00:00 UTC and the following Sunday 23:59:59.999 UTC for the week
 * containing `date`.
 *
 * UTC deliberately, not the server's local time. Everything downstream already
 * assumes a Monday-00:00-UTC start — weekSubmissionDeadline steps back a UTC
 * day and sets 07:00 UTC to land on Sunday 12:00 Tashkent (see lib/lateness.ts,
 * which says so in its header). Built from local getters this only held while
 * the deployment happened to run in UTC; set TZ to anything else and every
 * week boundary, submission deadline and fine slid with it.
 */
export function getWeekBounds(date = new Date()): { start: Date; end: Date } {
  const start = new Date(date);
  const day = start.getUTCDay(); // 0 = Sunday
  const diffToMonday = (day + 6) % 7; // days since Monday
  start.setUTCDate(start.getUTCDate() - diffToMonday);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Bounds of the week immediately following the one that ends at `prevEnd`.
 * Used when starting a new week so consecutive weeks get distinct, sequential
 * date ranges instead of all reusing the current calendar week.
 */
export function nextWeekBounds(prevEnd: Date): { start: Date; end: Date } {
  const next = new Date(prevEnd);
  next.setUTCDate(next.getUTCDate() + 1); // step into the following week
  return getWeekBounds(next);
}

// Loads a week with its goals, subtasks, and delegation info. Inlined at both
// call sites so Prisma infers the full relation payload type.
// Exported for the dashboard's editable-archive query (same payload shape).
export const weekInclude = {
  goals: {
    orderBy: { position: "asc" },
    include: {
      sharesOut: {
        include: { toUser: { select: { name: true, email: true } } },
      },
      shareIn: {
        include: { fromUser: { select: { name: true, email: true } } },
      },
      subtasks: {
        orderBy: { position: "asc" },
        include: {
          sharesOut: {
            include: { toUser: { select: { name: true, email: true } } },
          },
          shareIn: {
            include: { fromUser: { select: { name: true, email: true } } },
          },
        },
      },
    },
  },
} as const;

// Launch exception: seed each user's first auto-created week as the *upcoming*
// week rather than the current (nearly-over) calendar week, so people who sign
// up at launch land on a fresh full week. Set back to false (or delete) once the
// launch week has started.
//
// Turned off now that the launch week has started: new users were landing on
// next week's dates and entering goals there thinking it was the current week.
const LAUNCH_START_NEXT_WEEK = false;

/**
 * Return the user's current week, loaded with goals and subtasks (ordered).
 * Creates an empty week for the current calendar week if none is marked current
 * (or the upcoming week while LAUNCH_START_NEXT_WEEK is on).
 */
export async function getOrCreateCurrentWeek(userId: string) {
  // Normally one current week, but a concurrency race (e.g. simultaneous loads
  // during a redeploy) can leave duplicates. Pick the most meaningful one — the
  // submitted week, else the one with the most goals, else the oldest — so the
  // dashboard never lands on a stray empty duplicate.
  const current = await prisma.week.findMany({
    where: { userId, isCurrent: true },
    include: weekInclude,
  });

  if (current.length > 0) {
    const [keep, ...extra] = current.sort(
      (a, b) =>
        Number(b.submittedAt != null) - Number(a.submittedAt != null) ||
        b.goals.length - a.goals.length ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    // Retire the losers rather than sorting past them every load. Left current
    // they stay live for every OTHER query that filters on isCurrent, so the
    // dashboard and the admin roster can disagree about which week someone is
    // in. Demoted they become ordinary archived weeks — nothing is deleted,
    // and the goals on them stay reachable in the archive.
    if (extra.length > 0) {
      await prisma.week.updateMany({
        where: { id: { in: extra.map((w) => w.id) } },
        data: { isCurrent: false },
      });
    }
    return keep;
  }

  const { start, end } = LAUNCH_START_NEXT_WEEK
    ? nextWeekBounds(getWeekBounds().end)
    : getWeekBounds();
  return prisma.week.create({
    data: { userId, startDate: start, endDate: end, isCurrent: true },
    include: weekInclude,
  });
}

/**
 * Past weeks (already closed out), newest first, with goals and subtasks loaded
 * lean — just what the archive sidebar needs to show completion rates.
 */
export async function getArchivedWeeks(userId: string) {
  return prisma.week.findMany({
    where: { userId, isCurrent: false },
    orderBy: { startDate: "desc" },
    include: {
      goals: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          title: true,
          incompleteReason: true,
          completedAt: true,
          manualPercent: true,
          subtasks: {
            orderBy: { position: "asc" },
            select: { id: true, title: true, isDone: true },
          },
        },
      },
    },
  });
}

/**
 * Whether closing a week hands this goal on to the next week instead of
 * archiving it: something delegated in (a whole goal, or a goal made to hold a
 * delegated subtask) after the next week had already opened. A Saturday
 * delegation is meant for the coming week, but if the recipient hadn't rolled
 * over yet it lands in the old one; asking them for a reflection on work they
 * got a day before the close, then copying it forward without its "From X"
 * link, was the wrong answer. Finished ones archive as usual.
 */
export function movesToNextWeek(
  goal: {
    createdAt: Date;
    completedAt: Date | null;
    manualPercent: number | null;
    shareIn: unknown;
    subtasks: { isDone: boolean; shareIn: unknown }[];
  },
  nextWeekOpensAt: Date,
): boolean {
  const delegatedIn =
    goal.shareIn != null || goal.subtasks.some((s) => s.shareIn != null);
  return (
    delegatedIn &&
    goal.createdAt.getTime() >= nextWeekOpensAt.getTime() &&
    !isGoalComplete(goal) &&
    goalPercent(goal) < 100
  );
}

export type CurrentWeek = Awaited<ReturnType<typeof getOrCreateCurrentWeek>>;
export type WeekGoal = CurrentWeek["goals"][number];
export type GoalSubtask = WeekGoal["subtasks"][number];
