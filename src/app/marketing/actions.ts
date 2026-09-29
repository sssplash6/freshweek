"use server";

import { revalidatePath } from "next/cache";
import {
  ActionError,
  actionResult,
  type ActionResult,
} from "@/lib/actionResult";
import { formatDateTimeTz, parseYmd } from "@/lib/dates";
import {
  isHttpUrl,
  isPostPlatform,
  MAX_LINK,
  MAX_LOCATION,
  MAX_POST_CAPTION,
  MAX_POST_TITLE,
  MAX_SHOOT_NOTE,
  MAX_SHOOT_TITLE,
  MAX_TASK_NOTE,
  MAX_TASK_TITLE,
  POST_PLATFORMS,
  tashkentStampToDate,
} from "@/lib/marketing";
import { marketingMembers, requireMarketing } from "@/lib/marketingAccess";
import { notify } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";

// Every action here returns an ActionResult: the refusals (empty title, a
// shoot that's already reported, someone else's task) are things the person
// can fix, and production strips the message off anything thrown. See
// lib/actionResult.ts.

function revalidateMarketing() {
  revalidatePath("/marketing");
  revalidatePath("/dashboard");
}

function cleanText(value: string, max: number, label: string): string {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  if (!v) throw new ActionError(`${label} can't be empty.`);
  if (v.length > max) {
    throw new ActionError(`Keep the ${label.toLowerCase()} under ${max} characters.`);
  }
  return v;
}

function cleanOptional(
  value: string | null | undefined,
  max: number,
  label: string,
): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (v.length > max) {
    throw new ActionError(`Keep the ${label.toLowerCase()} under ${max} characters.`);
  }
  return v;
}

function cleanLink(value: string | null | undefined, label: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (v.length > MAX_LINK) throw new ActionError(`The ${label} is too long.`);
  if (!isHttpUrl(v)) {
    throw new ActionError(`The ${label} needs to be a full link starting with https://`);
  }
  return v;
}

/** An entered Tashkent date+time → an instant, or a friendly refusal. */
function cleanWhen(ymd: string, hm: string, label: string): Date {
  const when = tashkentStampToDate(ymd ?? "", hm ?? "");
  if (!when) throw new ActionError(`${label} needs a real date and time.`);
  return when;
}

function cleanDue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const due = parseYmd(value);
  if (!due) throw new ActionError("The due date isn't a real day.");
  return due;
}

function cleanPlatforms(values: string[] | null | undefined): string[] {
  const list = Array.isArray(values) ? values : [];
  if (!list.every(isPostPlatform)) {
    throw new ActionError("One of those channels isn't on the list.");
  }
  // Stored in the picker's order (and deduped) so every row reads the same way.
  return POST_PLATFORMS.filter((p) => list.includes(p));
}

/**
 * An assignee must be a current member of the marketing department — except
 * the person the row is already assigned to, who may have left since: saving
 * an unrelated edit (a new time, a typo) mustn't be blocked on reassigning.
 */
async function cleanAssignee(
  userId: string | null | undefined,
  keep: string | null = null,
): Promise<string | null> {
  if (!userId) return null;
  if (userId === keep) return userId;
  const members = await marketingMembers();
  if (!members.some((m) => m.id === userId)) {
    throw new ActionError("That person isn't in the marketing department.");
  }
  return userId;
}

async function requireAssignee(userId: string, keep: string | null = null) {
  const id = await cleanAssignee(userId, keep);
  if (!id) throw new ActionError("Pick who the task goes to.");
  return id;
}

/** Everyone the change is worth a line to — minus whoever made it. */
function othersThan(actorId: string, ...ids: (string | null | undefined)[]) {
  return [...new Set(ids.filter((x): x is string => !!x && x !== actorId))];
}

const who = (actor: { name?: string | null }) => actor.name ?? "A teammate";

// ----- Shoots -----

type ShootInput = {
  title: string;
  date: string;
  time: string;
  location: string;
  assigneeId: string | null;
  note?: string | null;
};

export async function planShoot(input: ShootInput): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const title = cleanText(input.title, MAX_SHOOT_TITLE, "Title");
    const location = cleanText(input.location, MAX_LOCATION, "Location");
    const shootAt = cleanWhen(input.date, input.time, "The shoot");
    const assigneeId = await cleanAssignee(input.assigneeId);
    const note = cleanOptional(input.note, MAX_SHOOT_NOTE, "Notes");

    await prisma.$transaction(async (tx) => {
      await tx.contentShoot.create({
        data: { title, shootAt, location, assigneeId, note, createdById: actor.id },
      });
      const to = othersThan(actor.id, assigneeId);
      if (to.length > 0) {
        await notify(
          tx,
          to,
          "MARKETING",
          `${who(actor)} put you on a shoot: “${title}” — ${formatDateTimeTz(shootAt)} at ${location}.`,
        );
      }
    });
    revalidateMarketing();
  });
}

export async function updateShoot(
  shootId: string,
  input: ShootInput,
): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const shoot = await prisma.contentShoot.findUnique({
      where: { id: shootId },
      select: {
        title: true,
        shootAt: true,
        location: true,
        assigneeId: true,
        reportedAt: true,
      },
    });
    if (!shoot) throw new ActionError("That shoot was removed — refresh the page.");
    if (shoot.reportedAt) {
      throw new ActionError("This shoot is already reported — only its links can change.");
    }

    const title = cleanText(input.title, MAX_SHOOT_TITLE, "Title");
    const location = cleanText(input.location, MAX_LOCATION, "Location");
    const shootAt = cleanWhen(input.date, input.time, "The shoot");
    const assigneeId = await cleanAssignee(input.assigneeId, shoot.assigneeId);
    const note = cleanOptional(input.note, MAX_SHOOT_NOTE, "Notes");

    const moved = shootAt.getTime() !== shoot.shootAt.getTime();
    const relocated = location !== shoot.location;
    const reassigned = assigneeId !== shoot.assigneeId;
    const when = `${formatDateTimeTz(shootAt)} at ${location}`;

    await prisma.$transaction(async (tx) => {
      await tx.contentShoot.update({
        where: { id: shootId },
        data: {
          title,
          shootAt,
          location,
          assigneeId,
          note,
          // A new time or a new creator is a new reminder: the old claim was
          // for a slot (or a person) that no longer applies.
          ...(moved || reassigned ? { reminderSentAt: null } : {}),
        },
      });
      if (reassigned) {
        const newcomer = othersThan(actor.id, assigneeId);
        if (newcomer.length > 0) {
          await notify(tx, newcomer, "MARKETING", `${who(actor)} put you on a shoot: “${title}” — ${when}.`);
        }
        const leaver = othersThan(actor.id, shoot.assigneeId);
        if (leaver.length > 0) {
          await notify(tx, leaver, "MARKETING", `${who(actor)} took you off the shoot “${shoot.title}”.`);
        }
      } else if (moved || relocated) {
        const to = othersThan(actor.id, assigneeId);
        if (to.length > 0) {
          await notify(tx, to, "MARKETING", `${who(actor)} changed the shoot “${title}” — now ${when}.`);
        }
      }
    });
    revalidateMarketing();
  });
}

/** Call a shoot off. A reported one is a record — it stays. */
export async function deleteShoot(shootId: string): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const shoot = await prisma.contentShoot.findUnique({
      where: { id: shootId },
      select: { title: true, assigneeId: true, reportedAt: true },
    });
    if (!shoot) return;
    if (shoot.reportedAt) {
      throw new ActionError("A reported shoot is the record — it can't be called off.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.contentShoot.delete({ where: { id: shootId } });
      const to = othersThan(actor.id, shoot.assigneeId);
      if (to.length > 0) {
        await notify(tx, to, "MARKETING", `${who(actor)} called off the shoot “${shoot.title}”.`);
      }
    });
    revalidateMarketing();
  });
}

/**
 * The videographer's report: Drive links for the finished cut and the raw
 * materials. Filing needs at least one — a "reported" shoot with nothing in
 * it would be a report of nothing — and the other can follow later. The first
 * filing stamps who and when; later link edits keep that stamp.
 */
export async function fileShootReport(
  shootId: string,
  input: { finishedUrl?: string | null; rawUrl?: string | null },
): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const shoot = await prisma.contentShoot.findUnique({
      where: { id: shootId },
      select: {
        title: true,
        shootAt: true,
        assigneeId: true,
        createdById: true,
        reportedAt: true,
        finishedUrl: true,
        rawUrl: true,
      },
    });
    if (!shoot) throw new ActionError("That shoot was removed — refresh the page.");
    if (!shoot.reportedAt && shoot.shootAt.getTime() > Date.now()) {
      throw new ActionError(
        "This shoot hasn't happened yet. If it already did, change its time first.",
      );
    }

    const finishedUrl = cleanLink(input.finishedUrl, "finished content link");
    const rawUrl = cleanLink(input.rawUrl, "raw materials link");
    if (!finishedUrl && !rawUrl) {
      throw new ActionError("Add at least one Drive link to file the report.");
    }

    const firstFiling = !shoot.reportedAt;
    const added = [
      !shoot.finishedUrl && finishedUrl ? "the finished content" : null,
      !shoot.rawUrl && rawUrl ? "the raw materials" : null,
    ].filter(Boolean);

    await prisma.$transaction(async (tx) => {
      await tx.contentShoot.update({
        where: { id: shootId },
        data: {
          finishedUrl,
          rawUrl,
          ...(firstFiling ? { reportedAt: new Date(), reportedById: actor.id } : {}),
        },
      });
      const to = othersThan(actor.id, shoot.createdById, shoot.assigneeId);
      if (to.length === 0) return;
      if (firstFiling) {
        await notify(tx, to, "MARKETING", `${who(actor)} filed the report for “${shoot.title}”.`);
      } else if (added.length > 0) {
        await notify(
          tx,
          to,
          "MARKETING",
          `${who(actor)} added ${added.join(" and ")} for “${shoot.title}”.`,
        );
      }
    });
    revalidateMarketing();
  });
}

// ----- Posting calendar -----

type PostInput = {
  title: string;
  date: string;
  time: string;
  platforms: string[];
  caption?: string | null;
  shootId?: string | null;
};

async function cleanPost(input: PostInput) {
  const title = cleanText(input.title, MAX_POST_TITLE, "Title");
  const publishAt = cleanWhen(input.date, input.time, "The post");
  const platforms = cleanPlatforms(input.platforms);
  const caption = cleanOptional(input.caption, MAX_POST_CAPTION, "Caption");
  const shootId = input.shootId || null;
  if (shootId) {
    const shoot = await prisma.contentShoot.findUnique({
      where: { id: shootId },
      select: { id: true },
    });
    if (!shoot) throw new ActionError("That shoot was removed — pick another or none.");
  }
  return { title, publishAt, platforms, caption, shootId };
}

export async function schedulePost(input: PostInput): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const data = await cleanPost(input);
    await prisma.contentPost.create({ data: { ...data, createdById: actor.id } });
    revalidateMarketing();
  });
}

export async function updatePost(
  postId: string,
  input: PostInput,
): Promise<ActionResult> {
  return actionResult(async () => {
    await requireMarketing();
    const post = await prisma.contentPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new ActionError("That post was removed — refresh the page.");
    const data = await cleanPost(input);
    await prisma.contentPost.update({ where: { id: postId }, data });
    revalidateMarketing();
  });
}

export async function deletePost(postId: string): Promise<ActionResult> {
  return actionResult(async () => {
    await requireMarketing();
    await prisma.contentPost.deleteMany({ where: { id: postId } });
    revalidateMarketing();
  });
}

/**
 * Mark a post as published, optionally with the live link — or, on a post
 * that's already out, just change the link (the publish stamp stays).
 */
export async function markPostPublished(
  postId: string,
  input: { postUrl?: string | null },
): Promise<ActionResult> {
  return actionResult(async () => {
    await requireMarketing();
    const post = await prisma.contentPost.findUnique({
      where: { id: postId },
      select: { publishedAt: true },
    });
    if (!post) throw new ActionError("That post was removed — refresh the page.");
    const postUrl = cleanLink(input.postUrl, "post link");
    await prisma.contentPost.update({
      where: { id: postId },
      data: { postUrl, publishedAt: post.publishedAt ?? new Date() },
    });
    revalidateMarketing();
  });
}

/** Undo a publish mark — back onto the calendar. The live link goes with it. */
export async function unpublishPost(postId: string): Promise<ActionResult> {
  return actionResult(async () => {
    await requireMarketing();
    await prisma.contentPost.updateMany({
      where: { id: postId },
      data: { publishedAt: null, postUrl: null },
    });
    revalidateMarketing();
  });
}

// ----- Team tasks -----

type TaskInput = {
  title: string;
  note?: string | null;
  dueOn?: string | null;
  assigneeId: string;
};

type TaskPair = { createdById: string | null; assigneeId: string };

/** Setter and assignee move a task; the department's managers may too. */
function requireInPair(task: TaskPair, actor: { id: string; manager: boolean }) {
  if (actor.manager) return;
  if (task.assigneeId !== actor.id && task.createdById !== actor.id) {
    throw new ActionError("Only the person who set this task, or whoever has it, can change it.");
  }
}

/** Editing and withdrawing belong to whoever set it (or a manager). */
function requireSetter(task: TaskPair, actor: { id: string; manager: boolean }) {
  if (actor.manager) return;
  if (task.createdById !== actor.id) {
    throw new ActionError("Only the person who set this task can change it.");
  }
}

export async function delegateTask(input: TaskInput): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const title = cleanText(input.title, MAX_TASK_TITLE, "Title");
    const note = cleanOptional(input.note, MAX_TASK_NOTE, "Note");
    const dueOn = cleanDue(input.dueOn);
    const assigneeId = await requireAssignee(input.assigneeId);

    await prisma.$transaction(async (tx) => {
      await tx.marketingTask.create({
        data: { title, note, dueOn, assigneeId, createdById: actor.id },
      });
      const to = othersThan(actor.id, assigneeId);
      if (to.length > 0) {
        await notify(tx, to, "MARKETING", `${who(actor)} handed you a task: “${title}”.`);
      }
    });
    revalidateMarketing();
  });
}

export async function updateTask(
  taskId: string,
  input: TaskInput,
): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const task = await prisma.marketingTask.findUnique({
      where: { id: taskId },
      select: { title: true, createdById: true, assigneeId: true },
    });
    if (!task) throw new ActionError("That task was removed — refresh the page.");
    requireSetter(task, actor);

    const title = cleanText(input.title, MAX_TASK_TITLE, "Title");
    const note = cleanOptional(input.note, MAX_TASK_NOTE, "Note");
    const dueOn = cleanDue(input.dueOn);
    const assigneeId = await requireAssignee(input.assigneeId, task.assigneeId);
    const reassigned = assigneeId !== task.assigneeId;

    await prisma.$transaction(async (tx) => {
      await tx.marketingTask.update({
        where: { id: taskId },
        data: { title, note, dueOn, assigneeId },
      });
      const to = othersThan(actor.id, assigneeId);
      if (to.length > 0) {
        await notify(
          tx,
          to,
          "MARKETING",
          reassigned
            ? `${who(actor)} handed you a task: “${title}”.`
            : `${who(actor)} changed the task “${title}”.`,
        );
      }
      const leaver = reassigned ? othersThan(actor.id, task.assigneeId) : [];
      if (leaver.length > 0) {
        await notify(tx, leaver, "MARKETING", `${who(actor)} moved “${task.title}” to someone else.`);
      }
    });
    revalidateMarketing();
  });
}

/** Take a delegated task back. Only who set it (or a manager) may. */
export async function deleteTask(taskId: string): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const task = await prisma.marketingTask.findUnique({
      where: { id: taskId },
      select: { title: true, createdById: true, assigneeId: true },
    });
    if (!task) return;
    requireSetter(task, actor);
    await prisma.$transaction(async (tx) => {
      await tx.marketingTask.delete({ where: { id: taskId } });
      const to = othersThan(actor.id, task.assigneeId);
      if (to.length > 0) {
        await notify(tx, to, "MARKETING", `${who(actor)} took back the task “${task.title}”.`);
      }
    });
    revalidateMarketing();
  });
}

/**
 * Update the honest percent. Reaching 100 completes the task; moving off 100
 * reopens it. Only those two transitions ping the other side — every notch
 * of the slider would bury the bell.
 */
export async function setTaskProgress(
  taskId: string,
  percent: number,
): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const task = await prisma.marketingTask.findUnique({
      where: { id: taskId },
      select: { title: true, createdById: true, assigneeId: true, completedAt: true, percent: true },
    });
    if (!task) throw new ActionError("That task was removed — refresh the page.");
    requireInPair(task, actor);
    const value = Math.round(Number(percent));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new ActionError("Progress is a number from 0 to 100.");
    }
    if (value === task.percent) return;

    const completed = value === 100;
    const wasDone = task.completedAt != null;
    await prisma.$transaction(async (tx) => {
      await tx.marketingTask.update({
        where: { id: taskId },
        data: {
          percent: value,
          completedAt: completed ? (task.completedAt ?? new Date()) : null,
        },
      });
      const to = othersThan(actor.id, task.createdById, task.assigneeId);
      if (to.length > 0 && completed !== wasDone) {
        await notify(
          tx,
          to,
          "MARKETING",
          completed
            ? `${who(actor)} finished “${task.title}”.`
            : `${who(actor)} reopened “${task.title}”.`,
        );
      }
    });
    revalidateMarketing();
  });
}

/**
 * Mark done / reopen. Percent follows the done state so the row stays honest:
 * done is 100%, and a reopened task drops just shy of it (90%) — a reopened
 * task at 100% would claim to be finished while saying it isn't.
 */
export async function setTaskDone(
  taskId: string,
  done: boolean,
): Promise<ActionResult> {
  return actionResult(async () => {
    const actor = await requireMarketing();
    const task = await prisma.marketingTask.findUnique({
      where: { id: taskId },
      select: { title: true, createdById: true, assigneeId: true, completedAt: true, percent: true },
    });
    if (!task) throw new ActionError("That task was removed — refresh the page.");
    requireInPair(task, actor);
    if ((task.completedAt != null) === done) return;

    await prisma.$transaction(async (tx) => {
      await tx.marketingTask.update({
        where: { id: taskId },
        data: done
          ? { completedAt: new Date(), percent: 100 }
          : { completedAt: null, percent: Math.min(task.percent, 90) },
      });
      const to = othersThan(actor.id, task.createdById, task.assigneeId);
      if (to.length > 0) {
        await notify(
          tx,
          to,
          "MARKETING",
          done
            ? `${who(actor)} finished “${task.title}”.`
            : `${who(actor)} reopened “${task.title}”.`,
        );
      }
    });
    revalidateMarketing();
  });
}
