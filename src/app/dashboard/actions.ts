"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isApprovedUser } from "@/lib/approval";
import {
  ActionError,
  actionResult,
  type ActionResult,
} from "@/lib/actionResult";
import { getOrCreateCurrentWeek, nextWeekBounds } from "@/lib/weeks";
import { getOrCreateCurrentMonth, nextMonthBounds } from "@/lib/months";
import { submissionTiming, weekOpensAt } from "@/lib/lateness";
import { submissionOffsetHours } from "@/lib/submissionClock";
import {
  clampPercent,
  goalPercent,
  isGoalComplete,
  needsCompletionReason,
} from "@/lib/progress";
import { isPriority, type Priority } from "@/lib/priority";
import {
  MAX_DAY_TASKS,
  MAX_DAY_TASK_TITLE,
  type DayTaskView,
} from "@/lib/dayTasks";
import {
  MAX_COMPLETION_REASON,
  MAX_GOAL_TITLE,
  requireText,
} from "@/lib/goals";
import { notify } from "@/lib/notifications";
import { formatYmd, parseYmd, toYmd } from "@/lib/dates";

async function requireUserId(): Promise<string> {
  return (await requireUser()).id;
}

/**
 * The signed-in user with the email attached — needed wherever a rule is read
 * on the person's own clock rather than the company's (lib/submissionClock.ts).
 */
async function requireUser(): Promise<{ id: string; email: string | null }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Not authenticated");
  }
  return { id: session.user.id, email: session.user.email ?? null };
}

// A goal belongs to either a week or a month; both count as the user's.
function goalOwnedWhere(userId: string) {
  return { OR: [{ week: { userId } }, { month: { userId } }] };
}

/**
 * The person on the receiving end of a delegation. Existing isn't enough: a
 * pending sign-up can't reach the dashboard, so anything delegated to them
 * lands in a period nobody will ever see, and approval is the same gate every
 * signed-in page enforces — reuse it rather than restate it.
 */
async function requireShareRecipient(toUserId: string) {
  const recipient = await prisma.user.findUnique({
    where: { id: toUserId },
    select: { id: true, name: true, email: true },
  });
  if (!recipient) throw new ActionError("That teammate no longer exists.");
  if (!(await isApprovedUser(recipient))) {
    throw new ActionError("That person hasn't been approved yet.");
  }
  return recipient;
}

/**
 * Refuse to write into a period its owner has already submitted. The sender
 * can't see the recipient's lock, so this is the only place it can be caught —
 * without it a delegation silently edits a period that is closed for its owner.
 */
function assertRecipientPeriodOpen(period: { goalsLocked: boolean }) {
  if (period.goalsLocked) {
    throw new ActionError(
      "They've already submitted this period — it can't take anything new.",
    );
  }
}

/** Confirm a goal belongs to the signed-in user; returns it or throws. */
async function assertGoalOwned(goalId: string, userId: string) {
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, ...goalOwnedWhere(userId) },
  });
  if (!goal) throw new Error("Goal not found");
  return goal;
}

/**
 * Like `assertGoalOwned`, but also rejects edits while the goal's week or month
 * is submitted. Used for actions that change a goal's *definition* (title,
 * priority, deadline, subtasks) — progress actions (toggling, completing) stay
 * allowed when locked. Exception: goals in the user's most recent archived
 * week stay editable (that week is the one the dashboard lets them revisit).
 */
async function assertGoalEditable(goalId: string, userId: string) {
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, ...goalOwnedWhere(userId) },
    include: {
      week: { select: { id: true, goalsLocked: true, isCurrent: true } },
      month: { select: { goalsLocked: true, isCurrent: true } },
    },
  });
  if (!goal) throw new Error("Goal not found");
  if (goal.month?.goalsLocked) {
    throw new Error("Goals are locked. Click Edit to make changes.");
  }
  if (
    goal.week?.goalsLocked &&
    !(await isLatestArchivedWeek(userId, goal.week))
  ) {
    throw new Error("Goals are locked. Click Edit to make changes.");
  }
  return goal;
}

/**
 * Whether the given week is the user's most recent archived (non-current) one —
 * the single past week the dashboard offers for editing, submitted or not.
 */
async function isLatestArchivedWeek(
  userId: string,
  week: { id: string; isCurrent: boolean },
): Promise<boolean> {
  if (week.isCurrent) return false;
  const latest = await prisma.week.findFirst({
    where: { userId, isCurrent: false },
    orderBy: { startDate: "desc" },
    select: { id: true },
  });
  return latest?.id === week.id;
}

/** Confirm a subtask belongs to the signed-in user; returns it or throws. */
async function assertSubtaskOwned(subtaskId: string, userId: string) {
  const subtask = await prisma.subtask.findFirst({
    where: { id: subtaskId, goal: goalOwnedWhere(userId) },
  });
  if (!subtask) throw new Error("Subtask not found");
  return subtask;
}

/** Like `assertSubtaskOwned`, but rejects edits while the period is submitted —
 * except in the user's most recent archived week (see assertGoalEditable). */
async function assertSubtaskEditable(subtaskId: string, userId: string) {
  const subtask = await prisma.subtask.findFirst({
    where: { id: subtaskId, goal: goalOwnedWhere(userId) },
    include: {
      goal: {
        select: {
          week: { select: { id: true, goalsLocked: true, isCurrent: true } },
          month: { select: { goalsLocked: true } },
        },
      },
    },
  });
  if (!subtask) throw new Error("Subtask not found");
  if (subtask.goal.month?.goalsLocked) {
    throw new Error("Goals are locked. Click Edit to make changes.");
  }
  if (
    subtask.goal.week?.goalsLocked &&
    !(await isLatestArchivedWeek(userId, subtask.goal.week))
  ) {
    throw new Error("Goals are locked. Click Edit to make changes.");
  }
  return subtask;
}

/**
 * Parse a required "YYYY-MM-DDTHH:MM" wall-clock deadline stamp into a Date,
 * stored verbatim as UTC so it reads back exactly as typed. Throws if missing
 * or malformed — deadlines are required when setting a goal.
 */
function parseRequiredDeadline(stamp: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(stamp)) {
    throw new Error("A deadline is required.");
  }
  const deadline = new Date(`${stamp}:00.000Z`);
  if (Number.isNaN(deadline.getTime())) throw new Error("Invalid deadline");
  return deadline;
}

/** A sender's display name, for the notifications sent to share recipients. */
async function displayNameOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  return u?.name ?? u?.email ?? "A teammate";
}

/**
 * After the sender edits a goal they've delegated, mirror the change onto every
 * recipient's linked copy and notify them. No-op (one indexed lookup) when the
 * goal isn't shared, so normal goal edits stay cheap. The recipient's own
 * progress (subtasks, completion) is untouched — only the definition changes.
 */
async function syncGoalShares(
  goalId: string,
  senderId: string,
  update: { title?: string; deadline?: Date | null },
  message: (sender: string) => string,
) {
  const shares = await prisma.goalShare.findMany({
    where: { originalGoalId: goalId },
    select: { copyGoalId: true, toUserId: true },
  });
  if (shares.length === 0) return;
  const sender = await displayNameOf(senderId);
  await prisma.$transaction(async (tx) => {
    await tx.goal.updateMany({
      where: { id: { in: shares.map((s) => s.copyGoalId) } },
      data: update,
    });
    await notify(
      tx,
      shares.map((s) => s.toUserId),
      "TASK_ASSIGNED",
      message(sender),
    );
  });
}

/** The subtask counterpart of `syncGoalShares` — mirrors a renamed delegated
 * subtask onto every recipient's copy and notifies them. */
async function syncSubtaskShares(
  subtaskId: string,
  senderId: string,
  title: string,
) {
  const shares = await prisma.subtaskShare.findMany({
    where: { originalSubtaskId: subtaskId },
    select: { copySubtaskId: true, toUserId: true },
  });
  if (shares.length === 0) return;
  const sender = await displayNameOf(senderId);
  await prisma.$transaction(async (tx) => {
    await tx.subtask.updateMany({
      where: { id: { in: shares.map((s) => s.copySubtaskId) } },
      data: { title },
    });
    await notify(
      tx,
      shares.map((s) => s.toUserId),
      "TASK_ASSIGNED",
      `${sender} renamed a subtask they shared with you to “${title}”.`,
    );
  });
}

/** Which period a goal-list action targets: the current week or current month. */
export type GoalScope = "week" | "month";

/**
 * Add a goal to the current week or month. Priority and deadline are required
 * parts of setting a goal (enforced here as well as in the UI).
 */
export async function addGoal(input: {
  title: string;
  priority: Priority;
  deadline: string;
  scope?: GoalScope;
}): Promise<ActionResult> {
  return actionResult(async () => {
    const userId = await requireUserId();
    const title = requireText(input.title, MAX_GOAL_TITLE, "That goal title");
    if (!title) throw new ActionError("A goal needs a title.");
    if (!isPriority(input.priority)) {
      throw new ActionError("A priority is required.");
    }
    const deadline = parseRequiredDeadline(input.deadline);

    const period =
      input.scope === "month"
        ? await getOrCreateCurrentMonth(userId)
        : await getOrCreateCurrentWeek(userId);
    if (period.goalsLocked) {
      throw new ActionError("Goals are locked. Click Edit to make changes.");
    }
    const position = period.goals.length + 1;
    await prisma.goal.create({
      data: {
        ...(input.scope === "month"
          ? { monthId: period.id }
          : { weekId: period.id }),
        title,
        position,
        priority: input.priority,
        deadline,
      },
    });
    revalidatePath("/dashboard");
  });
}

/**
 * Confirm ("submit") the current week's goals — locks them for editing. The
 * submission time is fixed to the *first* submit on this week: it's recorded
 * only when not already set, so re-submitting after an edit keeps the original.
 */
export async function submitWeek() {
  const userId = await requireUserId();
  const week = await getOrCreateCurrentWeek(userId);
  if (week.goals.length === 0) {
    throw new Error("Add at least one goal before submitting.");
  }
  await prisma.week.update({
    where: { id: week.id },
    data: {
      goalsLocked: true,
      // Only stamp the first time — never overwrite an existing submission time.
      ...(week.submittedAt ? {} : { submittedAt: new Date() }),
    },
  });
  revalidatePath("/dashboard");
}

/** Re-open the current week's goals for editing. Keeps the first-submit time. */
export async function reopenWeek() {
  const userId = await requireUserId();
  const week = await getOrCreateCurrentWeek(userId);
  await prisma.week.update({
    where: { id: week.id },
    data: { goalsLocked: false },
  });
  revalidatePath("/dashboard");
}

/**
 * Confirm ("submit") the current month's goals — locks them for editing. There
 * is no deadline for this (unlike weeks, no lateness or penalty); the recorded
 * time is fixed to the first submit, same as weeks.
 */
export async function submitMonth() {
  const userId = await requireUserId();
  const month = await getOrCreateCurrentMonth(userId);
  if (month.goals.length === 0) {
    throw new Error("Add at least one goal before submitting.");
  }
  await prisma.month.update({
    where: { id: month.id },
    data: {
      goalsLocked: true,
      ...(month.submittedAt ? {} : { submittedAt: new Date() }),
    },
  });
  revalidatePath("/dashboard");
}

/** Re-open the current month's goals for editing. Keeps the first-submit time. */
export async function reopenMonth() {
  const userId = await requireUserId();
  const month = await getOrCreateCurrentMonth(userId);
  await prisma.month.update({
    where: { id: month.id },
    data: { goalsLocked: false },
  });
  revalidatePath("/dashboard");
}

export async function renameGoal(goalId: string, title: string) {
  const userId = await requireUserId();
  const trimmed = requireText(title, MAX_GOAL_TITLE, "That goal title");
  if (!trimmed) return;
  await assertGoalEditable(goalId, userId);
  await prisma.goal.update({ where: { id: goalId }, data: { title: trimmed } });
  await syncGoalShares(
    goalId,
    userId,
    { title: trimmed },
    (sender) => `${sender} renamed a goal they shared with you to “${trimmed}”.`,
  );
  revalidatePath("/dashboard");
}

/**
 * Mark a goal complete (or reopen it). Completion is always a deliberate act —
 * finishing every subtask does not complete the goal on its own.
 */
export async function setGoalCompleted(
  goalId: string,
  completed: boolean,
  // The completion rate captured when marking done (0–100, defaults to 100).
  // Stored as the goal's manualPercent so a goal can be "done at 70%" and stay
  // editable. Ignored when un-completing (the existing percent is kept).
  rate?: number,
) {
  const userId = await requireUserId();
  await assertGoalOwned(goalId, userId);
  await prisma.goal.update({
    where: { id: goalId },
    data: completed
      ? {
          completedAt: new Date(),
          manualPercent: clampPercent(rate ?? 100),
        }
      : { completedAt: null },
  });
  revalidatePath("/dashboard");
}

/**
 * Mark one of the signed-in user's admin-assigned tasks done / not done. Only
 * the assignee can toggle their own task.
 */
export async function setAssignedTaskDone(taskId: string, done: boolean) {
  const userId = await requireUserId();
  const task = await prisma.assignedTask.findUnique({
    where: { id: taskId },
    select: { userId: true },
  });
  if (!task || task.userId !== userId) {
    throw new Error("Task not found");
  }
  await prisma.assignedTask.update({
    where: { id: taskId },
    data: { completedAt: done ? new Date() : null },
  });
  revalidatePath("/dashboard");
  revalidatePath("/admin");
}

/**
 * Set a goal's progress percent by hand (or clear the override with null so the
 * subtask-derived value takes back over). Progress, not definition — allowed
 * while the week is locked, like toggling subtasks.
 */
export async function setGoalPercent(goalId: string, percent: number | null) {
  const userId = await requireUserId();
  await assertGoalOwned(goalId, userId);
  const manualPercent =
    percent == null || Number.isNaN(percent) ? null : clampPercent(percent);
  await prisma.goal.update({ where: { id: goalId }, data: { manualPercent } });
  revalidatePath("/dashboard");
}

/**
 * Set or clear a goal's deadline. Accepts a "YYYY-MM-DDTHH:MM" wall-clock stamp
 * (stored verbatim as UTC so the time shows back exactly as typed) or null.
 */
export async function setGoalDeadline(goalId: string, stamp: string | null) {
  const userId = await requireUserId();
  await assertGoalEditable(goalId, userId);

  let deadline: Date | null = null;
  if (stamp) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(stamp)) {
      throw new Error("Invalid deadline");
    }
    deadline = new Date(`${stamp}:00.000Z`);
    if (Number.isNaN(deadline.getTime())) throw new Error("Invalid deadline");
  }

  await prisma.goal.update({ where: { id: goalId }, data: { deadline } });
  await syncGoalShares(goalId, userId, { deadline }, (sender) =>
    deadline
      ? `${sender} set the deadline on a goal they shared with you to ${formatYmd(toYmd(deadline))}.`
      : `${sender} cleared the deadline on a goal they shared with you.`,
  );
  revalidatePath("/dashboard");
}

/** Set or clear a goal's priority flag. */
export async function setGoalPriority(goalId: string, priority: Priority | null) {
  const userId = await requireUserId();
  if (priority !== null && !isPriority(priority)) {
    throw new Error("Invalid priority");
  }
  await assertGoalEditable(goalId, userId);
  await prisma.goal.update({ where: { id: goalId }, data: { priority } });
  revalidatePath("/dashboard");
}

/** How long one person waits between messages. */
const FEEDBACK_COOLDOWN_MS = 60_000;
const MAX_FEEDBACK = 5000;

export type FeedbackResult = { ok: true } | { ok: false; error: string };

/**
 * Record a piece of product feedback (destined for tech@freshman.academy).
 * Stored in the database — there's no mail provider — with the submitter's
 * email captured so it can be followed up.
 *
 * Sign-in required. The button only exists on the dashboard, which is behind
 * both auth and approval, so nobody loses the ability to send anything — but
 * the action itself is a reachable write endpoint, and it was the one place in
 * the app where an unauthenticated caller could create rows. A per-person
 * cooldown bounds how fast a signed-in one can, too.
 */
export async function submitFeedback(message: string): Promise<FeedbackResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Sign in to send feedback." };

  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "Write something first." };
  if (trimmed.length > MAX_FEEDBACK) {
    return {
      ok: false,
      error: `Keep it under ${MAX_FEEDBACK} characters.`,
    };
  }

  const recent = await prisma.feedback.findFirst({
    where: {
      userId,
      createdAt: { gt: new Date(Date.now() - FEEDBACK_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recent) {
    return {
      ok: false,
      error: "You just sent feedback — give it a minute before the next one.",
    };
  }

  await prisma.feedback.create({
    data: {
      message: trimmed,
      userId,
      userEmail: session.user.email ?? null,
    },
  });
  return { ok: true };
}

export async function deleteGoal(goalId: string) {
  const userId = await requireUserId();
  const goal = await assertGoalEditable(goalId, userId);
  await prisma.goal.delete({ where: { id: goalId } });

  // A period with no goals can never be in a submitted state. If this was the
  // last goal, reset its week/month to a clean draft so it isn't a stale
  // "submitted" empty period (it can only become locked again by submitting
  // with at least one goal). Only applies to the current period — an archived
  // week's submission record is history and stays untouched.
  if (goal.weekId && goal.week?.isCurrent) {
    const remaining = await prisma.goal.count({ where: { weekId: goal.weekId } });
    if (remaining === 0) {
      await prisma.week.update({
        where: { id: goal.weekId },
        data: { submittedAt: null, goalsLocked: false },
      });
    }
  } else if (goal.monthId && goal.month?.isCurrent) {
    const remaining = await prisma.goal.count({ where: { monthId: goal.monthId } });
    if (remaining === 0) {
      await prisma.month.update({
        where: { id: goal.monthId },
        data: { submittedAt: null, goalsLocked: false },
      });
    }
  }
  revalidatePath("/dashboard");
}

export async function addSubtask(goalId: string, title: string) {
  const userId = await requireUserId();
  const trimmed = requireText(title, MAX_GOAL_TITLE, "That subtask title");
  if (!trimmed) return;
  await assertGoalEditable(goalId, userId);

  const count = await prisma.subtask.count({ where: { goalId } });
  await prisma.subtask.create({
    data: { goalId, title: trimmed, position: count + 1 },
  });
  revalidatePath("/dashboard");
}

/** Rename a subtask in place (so users can edit instead of delete-and-retype). */
export async function renameSubtask(subtaskId: string, title: string) {
  const userId = await requireUserId();
  const trimmed = requireText(title, MAX_GOAL_TITLE, "That subtask title");
  if (!trimmed) return;
  await assertSubtaskEditable(subtaskId, userId);
  await prisma.subtask.update({
    where: { id: subtaskId },
    data: { title: trimmed },
  });
  await syncSubtaskShares(subtaskId, userId, trimmed);
  revalidatePath("/dashboard");
}

export async function toggleSubtask(subtaskId: string, isDone: boolean) {
  const userId = await requireUserId();
  const subtask = await assertSubtaskOwned(subtaskId, userId);
  await prisma.subtask.update({ where: { id: subtaskId }, data: { isDone } });
  // Toggling a subtask hands progress back to the derived value — a stale
  // manual percent that ignores the change would read as broken.
  await prisma.goal.update({
    where: { id: subtask.goalId },
    data: { manualPercent: null },
  });
  revalidatePath("/dashboard");
}

export async function deleteSubtask(subtaskId: string) {
  const userId = await requireUserId();
  await assertSubtaskEditable(subtaskId, userId);
  await prisma.subtask.delete({ where: { id: subtaskId } });
  revalidatePath("/dashboard");
}

/**
 * Delegate a subtask to another user. The original stays on the sender's list
 * (marked "shared to X"); the recipient gets a linked copy added under the same
 * goal, in the matching period — a weekly subtask lands in the recipient's
 * current week, a monthly one in their current month (creating the goal there
 * if they don't have it yet).
 */
export async function shareSubtask(
  subtaskId: string,
  toUserId: string,
): Promise<ActionResult> {
  return actionResult(async () => {
    const fromUserId = await requireUserId();
    if (toUserId === fromUserId) return;

    // Load the original subtask (owned by sender) along with its goal title.
    const original = await prisma.subtask.findFirst({
      where: { id: subtaskId, goal: goalOwnedWhere(fromUserId) },
      include: { goal: true },
    });
    if (!original) throw new ActionError("That subtask is gone.");

    await requireShareRecipient(toUserId);

    // Don't share the same subtask to the same person twice.
    const already = await prisma.subtaskShare.findUnique({
      where: {
        originalSubtaskId_toUserId: { originalSubtaskId: subtaskId, toUserId },
      },
    });
    if (already) return;

    const isMonthly = original.goal.monthId != null;
    const recipientPeriod = isMonthly
      ? await getOrCreateCurrentMonth(toUserId)
      : await getOrCreateCurrentWeek(toUserId);
    assertRecipientPeriodOpen(recipientPeriod);

    // Find a goal with the same title in the recipient's period, or create one.
    const existingGoal = recipientPeriod.goals.find(
      (g) => g.title === original.goal.title,
    );

    // One transaction for the whole delegation. Split up, a failure between the
    // steps left the recipient holding an orphan goal with no subtask in it and
    // no share record tying it back to the sender — visible to them, invisible
    // to the person who sent it, and impossible to undo from either side.
    await prisma.$transaction(async (tx) => {
      const targetGoalId =
        existingGoal?.id ??
        (
          await tx.goal.create({
            data: {
              ...(isMonthly
                ? { monthId: recipientPeriod.id }
                : { weekId: recipientPeriod.id }),
              title: original.goal.title,
              position: recipientPeriod.goals.length + 1,
            },
          })
        ).id;

      const subtaskCount = await tx.subtask.count({
        where: { goalId: targetGoalId },
      });

      // Create the recipient's copy and record the share.
      await tx.subtask.create({
        data: {
          goalId: targetGoalId,
          title: original.title,
          position: subtaskCount + 1,
          shareIn: {
            create: {
              originalSubtaskId: subtaskId,
              fromUserId,
              toUserId,
            },
          },
        },
      });
    });

    revalidatePath("/dashboard");
  });
}

/**
 * Delegate a whole goal to another user — with or without subtasks. The
 * original stays on the sender's list (marked "shared to X"); the recipient
 * gets a linked copy of the goal (same title, priority, and deadline, plus
 * fresh unchecked copies of any subtasks) appended to their current period —
 * a weekly goal lands in the recipient's current week, a monthly one in their
 * current month. The recipient is notified.
 */
export async function shareGoal(
  goalId: string,
  toUserId: string,
): Promise<ActionResult> {
  return actionResult(async () => {
    const fromUserId = await requireUserId();
    if (toUserId === fromUserId) return;

    // Load the original goal (owned by sender) along with its subtasks.
    const original = await prisma.goal.findFirst({
      where: { id: goalId, ...goalOwnedWhere(fromUserId) },
      include: { subtasks: { orderBy: { position: "asc" } } },
    });
    if (!original) throw new ActionError("That goal is gone.");

    await requireShareRecipient(toUserId);

    // Don't share the same goal to the same person twice.
    const already = await prisma.goalShare.findUnique({
      where: { originalGoalId_toUserId: { originalGoalId: goalId, toUserId } },
    });
    if (already) return;

    const isMonthly = original.monthId != null;
    const recipientPeriod = isMonthly
      ? await getOrCreateCurrentMonth(toUserId)
      : await getOrCreateCurrentWeek(toUserId);
    assertRecipientPeriodOpen(recipientPeriod);

    const sender = await prisma.user.findUnique({
      where: { id: fromUserId },
      select: { name: true, email: true },
    });

    await prisma.$transaction(async (tx) => {
      // Create the recipient's copy — progress starts fresh (subtasks unchecked,
      // no completion or manual percent carried over) and record the share.
      await tx.goal.create({
        data: {
          ...(isMonthly
            ? { monthId: recipientPeriod.id }
            : { weekId: recipientPeriod.id }),
          title: original.title,
          position: recipientPeriod.goals.length + 1,
          priority: original.priority,
          deadline: original.deadline,
          subtasks: {
            create: original.subtasks.map((s, i) => ({
              title: s.title,
              position: i + 1,
            })),
          },
          shareIn: {
            create: { originalGoalId: goalId, fromUserId, toUserId },
          },
        },
      });
      await notify(
        tx,
        toUserId,
        "TASK_ASSIGNED",
        `${sender?.name ?? sender?.email ?? "A teammate"} delegated a goal to you: “${original.title}”.`,
      );
    });

    revalidatePath("/dashboard");
  });
}

/**
 * Archive the current week and start a fresh, empty one. Every goal that wasn't
 * marked complete must have a reflection reason — enforced here, not just in the UI.
 */
export async function startNewWeek(
  reasons: { goalId: string; reason: string }[] = [],
  range?: { start: string; end: string },
  carry: { goalId: string; deadline: string }[] = [],
) {
  const { id: userId, email } = await requireUser();
  // Sunday noon (and so the Friday the next week opens) is read on this
  // person's own clock where they keep one — the same offset the fine sweep
  // judges them by. The Monday meeting below is not: it's one shared instant.
  const offsetHours = submissionOffsetHours(email);
  const week = await getOrCreateCurrentWeek(userId);

  const reasonByGoal = new Map(
    reasons.map((r) => [
      r.goalId,
      requireText(r.reason, MAX_COMPLETION_REASON, "That reason"),
    ]),
  );

  // Goals below 100% require a reason before the week can close — including ones
  // marked complete at a partial rate, not just unfinished ones.
  const incomplete = week.goals.filter((g) => needsCompletionReason(g));
  for (const goal of incomplete) {
    if (!reasonByGoal.get(goal.id)) {
      throw new Error("A reason is required for every goal below 100%.");
    }
  }

  // Goals that reached 100% (every subtask done, or a manual 100) but were never
  // explicitly marked complete are auto-completed as the week closes, so they
  // archive as done rather than reading as unfinished.
  const autoComplete = week.goals.filter(
    (g) => !isGoalComplete(g) && goalPercent(g) === 100,
  );

  // Goals the user chose to carry into the new week, each with a fresh deadline
  // (date-only, stored at UTC midnight to match how goal deadlines are kept).
  const weekGoalById = new Map(week.goals.map((g) => [g.id, g]));
  const carryPlan: { goal: (typeof week.goals)[number]; deadline: Date }[] = [];
  for (const c of carry) {
    const goal = weekGoalById.get(c.goalId);
    if (!goal) continue; // ignore anything not in the closing week
    const deadline = parseYmd(c.deadline);
    if (!deadline) {
      throw new Error("Invalid carry-over deadline");
    }
    carryPlan.push({ goal, deadline });
  }

  // The new week's date range: either an explicit one chosen in the UI, or, by
  // default, the week immediately following the one being closed (so ranges stay
  // sequential and never collide, even when several weeks close in one calendar week).
  let start: Date;
  let end: Date;
  if (range) {
    // parseYmd catches impossible days the old regex-plus-NaN pair let through:
    // "2026-02-31" is well-formed and not NaN, it just isn't a date.
    const from = parseYmd(range.start);
    const to = parseYmd(range.end);
    if (!from || !to) {
      throw new Error("Invalid week dates");
    }
    // parseYmd hands back UTC midnight — the same instant getWeekBounds
    // produces — so the start is already right and the end is simply the last
    // millisecond of that UTC day.
    start = from;
    end = new Date(to.getTime() + 86_399_999);
    if (start > end) {
      throw new Error("Invalid week dates");
    }
  } else {
    ({ start, end } = nextWeekBounds(week.endDate));
  }

  const now = new Date();

  // A week can't be opened before Friday noon (Tashkent) of the week before it.
  // Without this, closing mid-week jumps straight onto next week's dates and the
  // person spends the rest of the cycle a week ahead of everyone else — see
  // weekOpensAt. Enforced here, not just in the UI, because the range is
  // caller-supplied. Closing late (or catching up) is always allowed.
  if (now.getTime() < weekOpensAt(start, offsetHours).getTime()) {
    throw new Error(
      "This week isn't over yet — you can close it and start the next one from Friday noon.",
    );
  }

  // How late this submission is against the new week's deadlines. "late" =
  // after Sunday 12:00; "missed" = after the Monday meeting (flagged not
  // submitted there). Both count as a late submission for the flag/fine — but
  // only for department leads: members owe no deadline, so their weeks are
  // never stamped late (and the fine sweep skips them anyway).
  const leadSeat = await prisma.departmentMembership.findFirst({
    where: { userId, role: "LEAD" },
    select: { id: true },
  });
  const timing = submissionTiming(now, start, offsetHours);
  const submittedLate = leadSeat != null && timing !== "on-time";

  await prisma.$transaction(async (tx) => {
    await Promise.all(
      incomplete.map((goal) =>
        tx.goal.update({
          where: { id: goal.id },
          data: { incompleteReason: reasonByGoal.get(goal.id) },
        }),
      ),
    );
    await Promise.all(
      autoComplete.map((goal) =>
        tx.goal.update({
          where: { id: goal.id },
          data: { completedAt: new Date() },
        }),
      ),
    );
    await tx.week.updateMany({
      where: { userId, isCurrent: true },
      data: { isCurrent: false },
    });
    const newWeek = await tx.week.create({
      // The week opens empty — goals are added afterwards on the dashboard and
      // submitted there. (submittedLate still reflects starting the week late.)
      data: {
        userId,
        startDate: start,
        endDate: end,
        isCurrent: true,
        submittedLate,
      },
    });
    // Late submissions are no longer fined here at close time. The weekly
    // deadline is enforced proactively instead (see lib/submissionFines.ts):
    // everyone who hasn't submitted by Sunday 12:00 is fined $20, escalating to
    // $40 if still unsubmitted at the Monday meeting — so no-shows are
    // caught too, not just people who eventually close late. `submittedLate`
    // above is still recorded for the admin "Late" badge.

    // Copy carried goals into the new week — title, priority, the fresh deadline,
    // and their subtasks (done-state preserved so progress continues).
    for (let i = 0; i < carryPlan.length; i++) {
      const { goal, deadline } = carryPlan[i];
      await tx.goal.create({
        data: {
          weekId: newWeek.id,
          title: goal.title,
          position: i + 1,
          priority: goal.priority,
          deadline,
          subtasks: {
            create: goal.subtasks.map((s, j) => ({
              title: s.title,
              position: j + 1,
              isDone: s.isDone,
            })),
          },
        },
      });
    }
  });
  revalidatePath("/dashboard");
}

/**
 * Close the current month and start the next calendar month. Same reflection
 * rule as weeks — every goal not marked complete needs a reason — but months
 * have no submission deadline, so nothing here is ever late or fined. The new
 * month is always the calendar month after the one being closed.
 */
export async function startNewMonth(
  reasons: { goalId: string; reason: string }[] = [],
  firstGoal?: { title: string; priority: Priority; deadline: string },
) {
  const userId = await requireUserId();
  const month = await getOrCreateCurrentMonth(userId);

  // The new month must be opened with at least one goal — with the same
  // required priority and deadline as any other goal.
  const firstGoalTitle = requireText(
    firstGoal?.title ?? "", MAX_GOAL_TITLE, "That goal title",
  );
  if (!firstGoalTitle) {
    throw new Error("Add at least one goal for the new month.");
  }
  if (!firstGoal || !isPriority(firstGoal.priority)) {
    throw new Error("A priority is required for the first goal.");
  }
  const firstGoalDeadline = parseRequiredDeadline(firstGoal.deadline);

  const reasonByGoal = new Map(
    reasons.map((r) => [
      r.goalId,
      requireText(r.reason, MAX_COMPLETION_REASON, "That reason"),
    ]),
  );

  // Goals below 100% require a reason before the month closes — including ones
  // marked complete at a partial rate, not just unfinished ones.
  const incomplete = month.goals.filter((g) => needsCompletionReason(g));
  for (const goal of incomplete) {
    if (!reasonByGoal.get(goal.id)) {
      throw new Error("A reason is required for every goal below 100%.");
    }
  }

  // Goals at 100% that were never explicitly marked complete are auto-completed
  // as the month closes, so they archive as done. Mirrors startNewWeek.
  const autoComplete = month.goals.filter(
    (g) => !isGoalComplete(g) && goalPercent(g) === 100,
  );

  const { start, end } = nextMonthBounds(month.endDate);

  await prisma.$transaction(async (tx) => {
    await Promise.all(
      incomplete.map((goal) =>
        tx.goal.update({
          where: { id: goal.id },
          data: { incompleteReason: reasonByGoal.get(goal.id) },
        }),
      ),
    );
    await Promise.all(
      autoComplete.map((goal) =>
        tx.goal.update({
          where: { id: goal.id },
          data: { completedAt: new Date() },
        }),
      ),
    );
    await tx.month.updateMany({
      where: { userId, isCurrent: true },
      data: { isCurrent: false },
    });
    const newMonth = await tx.month.create({
      // Reporting is submitting here too — the new month opens already submitted
      // (locked + timestamped), reopenable via "Edit goals". Mirrors weeks.
      data: {
        userId,
        startDate: start,
        endDate: end,
        isCurrent: true,
        goalsLocked: true,
        submittedAt: new Date(),
      },
    });
    // Seed the new month with its required first goal (priority + deadline set).
    await tx.goal.create({
      data: {
        monthId: newMonth.id,
        title: firstGoalTitle,
        position: 1,
        priority: firstGoal.priority,
        deadline: firstGoalDeadline,
      },
    });
  });
  revalidatePath("/dashboard");
}

// ----- Day tasks (the calendar's per-day focus list) -----

/** "YYYY-MM-DD" → UTC midnight, rejecting malformed and impossible days. */
function parseDay(ymd: string): Date {
  const date = parseYmd(ymd);
  if (!date) throw new Error("Invalid date");
  return date;
}

/**
 * The signed-in user's tasks for one day, in priority order. Every day-task
 * mutation returns this so the modal can re-render from the server's truth
 * rather than patching its own copy.
 */
async function dayTasksFor(userId: string, date: Date): Promise<DayTaskView[]> {
  return prisma.dayTask.findMany({
    where: { userId, date },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, isDone: true },
  });
}

/** Confirm a day-task belongs to the signed-in user; returns it or throws. */
async function assertDayTaskOwned(taskId: string, userId: string) {
  const task = await prisma.dayTask.findFirst({ where: { id: taskId, userId } });
  if (!task) throw new Error("Task not found");
  return task;
}

/** Read one day's focus list — called when the calendar opens a day. */
export async function getDayTasks(ymd: string): Promise<DayTaskView[]> {
  const userId = await requireUserId();
  return dayTasksFor(userId, parseDay(ymd));
}

/**
 * Append a focus task to a day. New tasks land at the bottom of the list, so
 * the first one added is the day's main focus until it's reordered.
 */
export async function addDayTask(
  ymd: string,
  title: string,
): Promise<DayTaskView[]> {
  const userId = await requireUserId();
  const date = parseDay(ymd);
  const trimmed = requireText(title, MAX_DAY_TASK_TITLE, "That task title");
  if (!trimmed) throw new Error("A task needs a title.");

  const count = await prisma.dayTask.count({ where: { userId, date } });
  if (count >= MAX_DAY_TASKS) {
    throw new Error(`A day holds at most ${MAX_DAY_TASKS} tasks.`);
  }

  await prisma.dayTask.create({
    data: {
      userId,
      date,
      title: trimmed.slice(0, MAX_DAY_TASK_TITLE),
      // Position past the current tail, so a gap left by a delete never collides.
      position: count + 1,
    },
  });
  revalidatePath("/dashboard");
  return dayTasksFor(userId, date);
}

/** Check a day-task off (or back on). */
export async function toggleDayTask(
  taskId: string,
  isDone: boolean,
): Promise<DayTaskView[]> {
  const userId = await requireUserId();
  const task = await assertDayTaskOwned(taskId, userId);
  await prisma.dayTask.update({ where: { id: taskId }, data: { isDone } });
  revalidatePath("/dashboard");
  return dayTasksFor(userId, task.date);
}

/** Rewrite a day-task's title. An empty title is ignored, not a delete. */
export async function renameDayTask(
  taskId: string,
  title: string,
): Promise<DayTaskView[]> {
  const userId = await requireUserId();
  const task = await assertDayTaskOwned(taskId, userId);
  const trimmed = requireText(title, MAX_DAY_TASK_TITLE, "That task title");
  if (trimmed) {
    await prisma.dayTask.update({
      where: { id: taskId },
      data: { title: trimmed },
    });
    revalidatePath("/dashboard");
  }
  return dayTasksFor(userId, task.date);
}

/** Remove a day-task. Remaining tasks close the gap, keeping positions 1..n. */
export async function deleteDayTask(taskId: string): Promise<DayTaskView[]> {
  const userId = await requireUserId();
  const task = await assertDayTaskOwned(taskId, userId);
  await prisma.$transaction(async (tx) => {
    await tx.dayTask.delete({ where: { id: taskId } });
    const rest = await tx.dayTask.findMany({
      where: { userId, date: task.date },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    await Promise.all(
      rest.map((t, i) =>
        tx.dayTask.update({ where: { id: t.id }, data: { position: i + 1 } }),
      ),
    );
  });
  revalidatePath("/dashboard");
  return dayTasksFor(userId, task.date);
}

/**
 * Move a task one slot up or down its day — this is how the day's priority
 * order is set (position 1 is the main focus). Positions are rewritten to
 * 1..n on every move, so they never drift.
 */
export async function moveDayTask(
  taskId: string,
  direction: "up" | "down",
): Promise<DayTaskView[]> {
  const userId = await requireUserId();
  const task = await assertDayTaskOwned(taskId, userId);

  await prisma.$transaction(async (tx) => {
    const ordered = await tx.dayTask.findMany({
      where: { userId, date: task.date },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const from = ordered.findIndex((t) => t.id === taskId);
    const to = direction === "up" ? from - 1 : from + 1;
    // Already at the end it's being moved toward — nothing to do.
    if (from === -1 || to < 0 || to >= ordered.length) return;

    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    await Promise.all(
      ordered.map((t, i) =>
        tx.dayTask.update({ where: { id: t.id }, data: { position: i + 1 } }),
      ),
    );
  });
  revalidatePath("/dashboard");
  return dayTasksFor(userId, task.date);
}

/**
 * Set the signed-in user's birthday from the dashboard nag.
 *
 * A birthday no longer gates the app (see lib/profile.ts), so anyone who
 * arrived without one is inside and asked here rather than shut out at
 * /onboarding. Only ever writes the caller's own row, and only when it's still
 * empty: the nag is not an edit surface, and a birthday that's already set
 * belongs to /profile, where the owner can see what they're changing.
 */
export async function saveBirthday(ymd: string): Promise<ActionResult> {
  return actionResult(async () => {
    const userId = await requireUserId();

    const birthday = parseYmd(ymd.trim());
    if (!birthday) throw new ActionError("That isn't a real date.");
    // Both ends of the range catch the same slip: a mistyped year. A date
    // input hands over a whole date, so nothing else about it can be wrong.
    if (birthday.getTime() > Date.now()) {
      throw new ActionError("That's in the future — check the year.");
    }
    if (birthday.getUTCFullYear() < 1900) {
      throw new ActionError("That's too long ago — check the year.");
    }

    const { count } = await prisma.user.updateMany({
      where: { id: userId, birthday: null },
      data: { birthday },
    });
    // Already set — another tab got there first. Nothing to do, and nothing
    // the person needs to hear about: their birthday is in, which is all the
    // prompt wanted.
    if (count === 0) return;

    revalidatePath("/dashboard");
    revalidatePath("/profile");
    revalidatePath("/team");
  });
}
