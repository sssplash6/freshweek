"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";
import { getWeekBounds } from "@/lib/weeks";
import { goalPercent } from "@/lib/progress";
import { currentMeetingSlot } from "@/lib/meetings";
import { currentSubmissionCycle } from "@/lib/lateness";
import { submissionOffsetHours } from "@/lib/submissionClock";
import { dayDeadline } from "@/lib/dailyReportTypes";
import {
  formatMoney,
  MAX_PENALTY,
  MEETING_LATE_PENALTY,
  meetingPenaltyAmount,
  type AttendanceStatus,
} from "@/lib/penalties";
import { allocateSettlement } from "@/lib/settlement";
import { requireCanManage } from "@/lib/manage";
import { formatYmd, toYmd } from "@/lib/dates";
import { notify } from "@/lib/notifications";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Permanently delete a user and everything cascaded from them (weeks, goals,
 * subtasks, shares, sessions). Admin-only; you can't delete your own account.
 */
export async function deleteUser(userId: string) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  if (session!.user.id === userId) {
    throw new Error("You can't delete your own account.");
  }
  await prisma.user.delete({ where: { id: userId } });
  revalidatePath("/admin");
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a week was submitted days before it supposedly began — proof it was
 * never that week at all. It's the launch offset: first weeks were seeded one
 * week ahead (LAUNCH_START_NEXT_WEEK), and every close since chained off those
 * wrong dates, so the person's whole run of weeks is labelled a week late.
 * The two days of slack keep the legitimate Sunday-before submission — always
 * within a day of the Monday start — from reading as misdated.
 */
function wasMislabelled(week: {
  startDate: Date;
  submittedAt: Date | null;
}): boolean {
  return (
    week.submittedAt != null &&
    week.submittedAt.getTime() < week.startDate.getTime() - 2 * 24 * 3_600_000
  );
}

/**
 * Put a user who's running ahead of the team's cycle back on the current
 * calendar week. Three shapes, none of which lose work:
 *
 *  - Nothing occupies the current week: re-date their week onto it. Goals and
 *    subtasks ride along, since they belong to the same week row.
 *  - The current week is taken by a week that was submitted before it began —
 *    the launch offset. Their whole chain of weeks is a week late, so slide the
 *    run back: the live week takes the current slot and each week it displaces
 *    moves back one, until a slot is free. Only date labels change.
 *  - The current week is taken by a correctly-dated week they closed early:
 *    re-dating would leave two weeks with identical dates and the review picking
 *    the wrong one, so undo the close instead — reopen that week and fold the
 *    ahead week into it.
 *
 * Goal deadlines are never rewritten: they're the user's own calendar dates, and
 * guessing at them is the one thing here that couldn't be undone.
 *
 * Admin-only.
 */
export async function moveUserWeekToCurrent(userId: string) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  const weeks = await prisma.week.findMany({
    where: { userId },
    orderBy: { startDate: "desc" },
    select: {
      id: true,
      startDate: true,
      isCurrent: true,
      submittedAt: true,
      goals: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          title: true,
          completedAt: true,
          manualPercent: true,
          subtasks: { select: { isDone: true } },
        },
      },
    },
  });
  const live = weeks.find((w) => w.isCurrent);
  if (!live) throw new Error("That user has no current week.");

  const { start, end } = getWeekBounds(new Date());
  if (toYmd(live.startDate) === toYmd(start)) return; // already on this week

  const closed = weeks.find(
    (w) => !w.isCurrent && toYmd(w.startDate) === toYmd(start),
  );
  if (!closed) {
    await prisma.week.update({
      where: { id: live.id },
      data: { startDate: start, endDate: end },
    });
  } else if (wasMislabelled(closed)) {
    // Slide the whole chain back a week. Each pass parks a week on the slot it
    // should hold, then picks up whoever was sitting there to place one week
    // earlier; it ends at the oldest week, whose own slot is free. Every week is
    // touched at most once, so this always terminates.
    const moves: { id: string; start: Date; end: Date }[] = [];
    const moved = new Set<string>();
    let mover: (typeof weeks)[number] | undefined = live;
    let slot = { start, end };
    while (mover) {
      moved.add(mover.id);
      moves.push({ id: mover.id, start: slot.start, end: slot.end });
      const displaced: (typeof weeks)[number] | undefined = weeks.find(
        (w) => !moved.has(w.id) && toYmd(w.startDate) === toYmd(slot.start),
      );
      if (!displaced) break;
      mover = displaced;
      slot = {
        start: new Date(slot.start.getTime() - WEEK_MS),
        end: new Date(slot.end.getTime() - WEEK_MS),
      };
    }
    await prisma.$transaction(
      moves.map((m) =>
        prisma.week.update({
          where: { id: m.id },
          data: { startDate: m.start, endDate: m.end },
        }),
      ),
    );
  } else {
    // Goals carried into the ahead week are copies of ones still sitting on the
    // week being reopened. Move over only what's new or further along, so real
    // work survives and the carried copies don't come back doubled; the rest go
    // with the ahead week (goals and subtasks cascade).
    const percentByTitle = new Map(
      closed.goals.map((g) => [g.title, goalPercent(g)]),
    );
    const moving = live.goals.filter((g) => {
      const existing = percentByTitle.get(g.title);
      return existing === undefined || goalPercent(g) > existing;
    });
    await prisma.$transaction(async (tx) => {
      let position = closed.goals.length;
      for (const g of moving) {
        await tx.goal.update({
          where: { id: g.id },
          data: { weekId: closed.id, position: ++position },
        });
      }
      // Fines raised against the ahead week would otherwise be orphaned
      // (Penalty.week is SetNull) — hang them on the week that remains.
      await tx.penalty.updateMany({
        where: { weekId: live.id },
        data: { weekId: closed.id },
      });
      await tx.week.delete({ where: { id: live.id } });
      await tx.week.update({
        where: { id: closed.id },
        data: { isCurrent: true },
      });
    });
  }
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}

/**
 * Issue a manual fine to a user (type OTHER) — for anything other than a missed
 * meeting (those flow from attendance). Links to the user's current week so it
 * surfaces there. Admins may fine anyone; a department lead may fine the
 * members under the departments they lead (see lib/manage.ts).
 */
export async function addManualPenalty(
  userId: string,
  amount: number,
  note: string,
) {
  const session = await auth();
  // allowSelf: a lead may fine themselves from their own department panel.
  await requireCanManage(session, [userId], { allowSelf: true });
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PENALTY) {
    throw new Error("Enter a valid fine amount.");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  const week = await prisma.week.findFirst({
    where: { userId, isCurrent: true },
    select: { id: true },
  });

  const cleanNote = note.trim().slice(0, 500) || null;
  await prisma.penalty.create({
    data: {
      userId,
      type: "OTHER",
      amount: value,
      note: cleanNote,
      weekId: week?.id ?? null,
      issuedById: session!.user.id,
    },
  });
  await notify(
    prisma,
    userId,
    "FINE",
    `You were fined ${formatMoney(value)}${cleanNote ? ` — ${cleanNote}` : ""}.`,
  );
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}

/** Remove a penalty (e.g. issued by mistake). Admin-only. */
export async function deletePenalty(penaltyId: string) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  const penalty = await prisma.penalty.findUnique({
    where: { id: penaltyId },
    select: {
      id: true,
      userId: true,
      // The waiver below is keyed by a deadline instant, and that instant is
      // read on the fined person's own clock (lib/submissionClock.ts).
      user: { select: { email: true } },
      type: true,
      amount: true,
      paidAmount: true,
      meetingId: true,
      reportDay: true,
      createdAt: true,
    },
  });
  if (!penalty) return; // already gone — nothing to undo
  // Money has already moved against this one. Deleting it would erase a payment
  // that really happened, so the admin has to undo the payment first — an
  // explicit decision, taken on the settled side of the ledger.
  if (penalty.paidAmount > 0) {
    throw new Error(
      "This fine has been part-paid — undo the payment on /penalties first.",
    );
  }

  // Late-submission and meeting fines aren't stored decisions, they're derived:
  // one from whether the week was reported on time, the other from the
  // attendance history. Deleting the row on its own achieved nothing — the next
  // reconcile re-derived it and raised the fine again, so the button looked
  // broken. Record the waiver alongside the delete and both reconcilers leave it
  // alone from then on.
  const waiver =
    penalty.type === "LATE_SUBMISSION"
      ? {
          // The cycle this fine belongs to: the Sunday-12:00 deadline that had
          // most recently passed when it was raised — the same key the sweep
          // groups a cycle's fines by, read on the same clock it swept them on,
          // or the waiver lands on a deadline the sweep never looks up and the
          // fine comes straight back.
          cycleDeadline: currentSubmissionCycle(
            penalty.createdAt,
            submissionOffsetHours(penalty.user.email),
          ).submissionDeadline,
          meetingId: null,
        }
      : penalty.type === "LATE_DAILY_REPORT" && penalty.reportDay
        ? {
            // Daily fines key their waiver by the day's 5 AM deadline instant.
            // It can never collide with a weekly key (Sunday noon Tashkent),
            // so both sweeps share the FineWaiver table safely.
            cycleDeadline: dayDeadline(penalty.reportDay),
            meetingId: null,
          }
        : (penalty.type === "MEETING_SKIPPED" ||
              penalty.type === "MEETING_LATE") &&
            penalty.meetingId
          ? { cycleDeadline: null, meetingId: penalty.meetingId }
          : null;

  await prisma.$transaction(async (tx) => {
    await tx.penalty.delete({ where: { id: penalty.id } });
    if (waiver) {
      await tx.fineWaiver.upsert({
        where: waiver.meetingId
          ? {
              userId_meetingId: {
                userId: penalty.userId,
                meetingId: waiver.meetingId,
              },
            }
          : {
              userId_cycleDeadline: {
                userId: penalty.userId,
                cycleDeadline: waiver.cycleDeadline!,
              },
            },
        create: {
          userId: penalty.userId,
          cycleDeadline: waiver.cycleDeadline,
          meetingId: waiver.meetingId,
          waivedById: session!.user.id,
        },
        update: {},
      });
    }
    await notify(
      tx,
      penalty.userId,
      "FINE",
      `Your ${formatMoney(penalty.amount)} fine was cancelled.`,
    );
  });

  revalidatePath("/penalties");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}

/** Sum of what a user still owes — every fine's unpaid remainder. */
async function outstandingFinesTotal(
  db: Prisma.TransactionClient | typeof prisma,
  userId: string,
): Promise<number> {
  const agg = await db.penalty.aggregate({
    where: { userId, paidAt: null },
    _sum: { amount: true, paidAmount: true },
  });
  return (agg._sum.amount ?? 0) - (agg._sum.paidAmount ?? 0);
}

/** What a settlement did, handed back so the UI can report it. */
export type SettlementResult = {
  /** How much was actually placed (never more than was owed). */
  applied: number;
  /** Fines this payment closed out. */
  cleared: number;
  /** What the person still owes afterwards. */
  outstanding: number;
};

/**
 * Record money against a person's fines. The heart of settling: `amount` is
 * whatever was cut from their salary, and it's applied to their open fines
 * **oldest first** (see lib/settlement — the same function the settle dialog
 * previews with, so the admin's preview and the result can't drift apart). A
 * fine that the payment covers in full is closed out and archived; the one it
 * runs out on is left part-paid and stays in the active ledger owing the rest.
 *
 * Scope it to a single fine with `penaltyId`. Paying more than is owed places
 * what it can and ignores the rest rather than overpaying. Every fine touched
 * gets a FinePayment row, all sharing one `batchId`, so the settlement reads
 * back as one receipt and can be undone as one.
 */
async function recordSettlement(
  amount: number,
  adminId: string,
  target: { userId: string } | { penaltyId: string },
): Promise<SettlementResult> {
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PENALTY) {
    throw new Error("Enter a valid amount to settle.");
  }

  return prisma.$transaction(async (tx) => {
    // Scoping by penalty still needs the owner: the notification and the
    // remaining-total below are per person, not per fine.
    let userId: string;
    if ("userId" in target) {
      userId = target.userId;
    } else {
      const owner = await tx.penalty.findUnique({
        where: { id: target.penaltyId },
        select: { userId: true },
      });
      if (!owner) throw new Error("Fine not found");
      userId = owner.userId;
    }

    const open = await tx.penalty.findMany({
      where: {
        userId,
        paidAt: null,
        ...("penaltyId" in target ? { id: target.penaltyId } : {}),
      },
      // Oldest debt first. `id` breaks ties so two fines raised in the same
      // instant (the reconcile sweep does that) always settle in a stable order.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, amount: true, paidAmount: true },
    });

    const plan = allocateSettlement(open, value);
    if (plan.applied === 0) {
      return { applied: 0, cleared: 0, outstanding: await outstandingFinesTotal(tx, userId) };
    }

    const batchId = randomUUID();
    const now = new Date();
    for (const [i, a] of plan.allocations.entries()) {
      if (a.pay === 0) continue;
      const fine = open[i];
      // Match on the balance this plan was built from, so two admins settling
      // the same person at once can't both spend the same headroom and push a
      // fine past its amount — the second one finds nothing to update and the
      // whole settlement rolls back rather than half-landing.
      const updated = await tx.penalty.updateMany({
        where: { id: fine.id, paidAt: null, paidAmount: fine.paidAmount },
        data: {
          paidAmount: fine.paidAmount + a.pay,
          // Only a fine paid off in full leaves the active ledger.
          ...(a.clears ? { paidAt: now, settledById: adminId } : {}),
        },
      });
      if (updated.count === 0) {
        throw new Error(
          "These fines changed while you were settling — reload and try again.",
        );
      }
      await tx.finePayment.create({
        data: {
          penaltyId: a.id,
          amount: a.pay,
          batchId,
          recordedById: adminId,
        },
      });
    }

    const outstanding = await outstandingFinesTotal(tx, userId);
    await notify(
      tx,
      userId,
      "FINE",
      `${formatMoney(plan.applied)} was deducted from your salary and put toward your fines. ` +
        (outstanding > 0
          ? `${formatMoney(outstanding)} still outstanding.`
          : `You're all settled — nothing outstanding.`),
    );

    return { applied: plan.applied, cleared: plan.cleared, outstanding };
  });
}

/** Every view that shows fine balances, refreshed after money moves. */
function revalidateFines() {
  revalidatePath("/penalties");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}

/**
 * Settle a custom amount against everything a person owes — the payroll case
 * where part of their fines came out of this month's salary. Applied oldest
 * fine first. Admin-only.
 */
export async function settleAmount(
  userId: string,
  amount: number,
): Promise<SettlementResult> {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  const result = await recordSettlement(amount, session!.user.id, { userId });
  revalidateFines();
  return result;
}

/**
 * Settle a custom amount against one specific fine — for when a person is
 * paying a single fine down rather than their balance as a whole. Admin-only.
 */
export async function settleFineAmount(
  penaltyId: string,
  amount: number,
): Promise<SettlementResult> {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  const result = await recordSettlement(amount, session!.user.id, { penaltyId });
  revalidateFines();
  return result;
}

/**
 * Undo one settlement — the receipt written by a single settle action, across
 * however many fines it touched. Each fine gets its balance back and reopens if
 * the payment had closed it. For a mistyped amount this is the fix: undo the
 * receipt and record the right one. Silent (no notification). Admin-only.
 *
 * PAYROLL batches are refused. That deduction is one half of a PROCESSED pay
 * request: the money was already netted off an invoice the person was paid
 * against. Handing the fines back here would leave them owing what their
 * invoice says they settled, with the submission still marked processed — two
 * records of the same money disagreeing. Reversing it properly means reversing
 * the submission, which is payroll's job, not this receipt's.
 */
export async function undoSettlement(batchId: string) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  await prisma.$transaction(async (tx) => {
    const payments = await tx.finePayment.findMany({
      where: { batchId },
      select: {
        amount: true,
        source: true,
        penalty: { select: { id: true, amount: true, paidAmount: true } },
      },
    });
    if (payments.length === 0) return;

    // One settle action writes one batch with one source, but check every row:
    // a single payroll payment is enough to make the whole receipt unsafe.
    if (payments.some((p) => p.source === "PAYROLL")) {
      throw new Error(
        "This deduction came from a processed pay request — it can't be undone here.",
      );
    }

    // A batch normally hits each fine once, but sum per fine anyway so an undo
    // can never leave a stray part-payment behind.
    const backOut = new Map<string, { total: number; amount: number; paidAmount: number }>();
    for (const p of payments) {
      const entry = backOut.get(p.penalty.id) ?? {
        total: 0,
        amount: p.penalty.amount,
        paidAmount: p.penalty.paidAmount,
      };
      entry.total += p.amount;
      backOut.set(p.penalty.id, entry);
    }

    for (const [id, e] of backOut) {
      const paidAmount = Math.max(0, e.paidAmount - e.total);
      await tx.penalty.update({
        where: { id },
        data: {
          paidAmount,
          // Anything short of the full amount is outstanding again.
          ...(paidAmount < e.amount ? { paidAt: null, settledById: null } : {}),
        },
      });
    }
    await tx.finePayment.deleteMany({ where: { batchId } });
  });
  revalidateFines();
}

/**
 * Award a bonus to a user — the positive counterpart of a manual fine, tracked
 * separately (no netting). Amount is a whole number in the app currency.
 * Admins may award anyone; a department lead, the members under them.
 */
export async function addBonus(userId: string, amount: number, note: string) {
  const session = await auth();
  // allowSelf: a lead may award themselves from their own department panel.
  // Deliberate — it's money, and it lands in the same ledgers and payroll
  // snapshot as any other bonus, so it's visible on /admin and /penalties.
  await requireCanManage(session, [userId], { allowSelf: true });
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PENALTY) {
    throw new Error("Enter a valid bonus amount.");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  const cleanNote = note.trim().slice(0, 500) || null;
  await prisma.bonus.create({
    data: {
      userId,
      amount: value,
      note: cleanNote,
      issuedById: session!.user.id,
    },
  });
  await notify(
    prisma,
    userId,
    "BONUS",
    `You received a ${formatMoney(value)} bonus${cleanNote ? ` — ${cleanNote}` : ""}.`,
  );
  revalidateBonusViews();
}

/**
 * Everywhere a bonus shows up. /payroll is on the list because the filing form
 * previews the un-paid-out bonuses it will claim, so its totals move whenever
 * one is awarded, corrected or removed.
 */
function revalidateBonusViews() {
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
  revalidatePath("/payroll");
}

/**
 * A bonus nobody can change any more, and why — the one guard the corrections
 * below share. A PROCESSED pay request paid this bonus out, so the invoice is
 * a record of money that really moved; editing or deleting it would rewrite
 * that. (The part-paid fine rule, mirrored.)
 *
 * A bonus snapshotted onto a request still AWAITING payment is deliberately
 * NOT locked. Processing re-checks every snapshotted line against the live
 * ledger and refuses with "changed amount after filing" / "was deleted after
 * filing" rather than paying a stale figure, so the correction surfaces as a
 * decline-and-refile instead of a wrong payment.
 */
const PAID_OUT_BONUS =
  "This bonus was already paid out through payroll — it can't be changed.";

/**
 * Correct a bonus that was awarded wrong: its amount, its note, or both.
 *
 * Same scope as awarding one (lib/manage.ts): admins anyone, a lead the people
 * under them, and themselves. Whoever may create the money may fix a typo in
 * it — sending someone to an admin over a mistyped digit was the old answer.
 *
 * The recipient is deliberately not editable. Moving a bonus to someone else
 * isn't a correction, it's a different award: delete this one and give that.
 */
export async function editBonus(
  bonusId: string,
  amount: number,
  note: string,
) {
  const session = await auth();
  const bonus = await prisma.bonus.findUnique({
    where: { id: bonusId },
    select: {
      userId: true,
      amount: true,
      note: true,
      payrollSubmissionId: true,
    },
  });
  if (!bonus) throw new Error("That bonus is gone.");
  // Authorization is read off the bonus's OWNER rather than off whoever is
  // asking: a lead may only touch money belonging to someone under them.
  await requireCanManage(session, [bonus.userId], { allowSelf: true });
  if (bonus.payrollSubmissionId) throw new Error(PAID_OUT_BONUS);

  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PENALTY) {
    throw new Error("Enter a valid bonus amount.");
  }
  const cleanNote = note.trim().slice(0, 500) || null;
  // Nothing actually moved — don't write an audit-less update or, worse, tell
  // the recipient their bonus "changed" when it didn't.
  if (value === bonus.amount && cleanNote === bonus.note) return;

  await prisma.bonus.update({
    where: { id: bonusId },
    data: { amount: value, note: cleanNote },
  });

  // Told in the same terms they were told the first time. Money quietly
  // rewritten under someone is how a ledger stops being trusted.
  const message =
    value !== bonus.amount
      ? `Your ${formatMoney(bonus.amount)} bonus was changed to ${formatMoney(value)}${
          cleanNote ? ` — ${cleanNote}` : ""
        }.`
      : cleanNote
        ? `The note on your ${formatMoney(value)} bonus is now: ${cleanNote}`
        : `The note on your ${formatMoney(value)} bonus was removed.`;
  await notify(prisma, bonus.userId, "BONUS", message);
  revalidateBonusViews();
}

/**
 * Remove a bonus (awarded by mistake, or superseded). Same scope as awarding
 * one — see editBonus for why that is, and PAID_OUT_BONUS for the one bonus
 * this refuses to touch.
 */
export async function deleteBonus(bonusId: string) {
  const session = await auth();
  const bonus = await prisma.bonus.findUnique({
    where: { id: bonusId },
    select: { userId: true, amount: true, payrollSubmissionId: true },
  });
  if (!bonus) return; // already gone — nothing to undo
  await requireCanManage(session, [bonus.userId], { allowSelf: true });
  if (bonus.payrollSubmissionId) throw new Error(PAID_OUT_BONUS);

  await prisma.bonus.delete({ where: { id: bonusId } });
  await notify(
    prisma,
    bonus.userId,
    "BONUS",
    `Your ${formatMoney(bonus.amount)} bonus was removed.`,
  );
  revalidateBonusViews();
}

/**
 * Mark a person's attendance for this week's Monday meeting (creating the
 * meeting row on first mark). Recomputes that person's escalating skip fines so
 * amounts and the consecutive-skip streak always stay correct. Admin-only.
 */
export async function setAttendance(userId: string, status: AttendanceStatus) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  if (
    status !== "ATTENDED" &&
    status !== "LATE" &&
    status !== "SKIPPED" &&
    status !== "EXCUSED"
  ) {
    throw new Error("Invalid status");
  }
  const issuedById = session!.user.id;
  const slot = currentMeetingSlot();

  await prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.upsert({
      where: { scheduledAt: slot },
      update: {},
      create: { scheduledAt: slot },
    });
    await tx.attendance.upsert({
      where: { meetingId_userId: { meetingId: meeting.id, userId } },
      update: { status },
      create: { meetingId: meeting.id, userId, status },
    });
    await recomputeMeetingPenalties(tx, userId, issuedById);
  });

  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}

/**
 * Reconcile a user's meeting-attendance fines from their attendance history.
 * Walks meetings oldest-first tracking the consecutive-skip streak — SKIPPED
 * escalates the streak fine; LATE is a flat fine that counts as present (resets
 * the streak); ATTENDED/EXCUSED reset it with no fine. Ensures exactly one
 * correctly-typed, correctly-priced fine per fined meeting (updating in place to
 * preserve timestamps) and removes fines for meetings that no longer warrant one.
 */
async function recomputeMeetingPenalties(
  tx: Prisma.TransactionClient,
  userId: string,
  issuedById: string,
) {
  const attendances = await tx.attendance.findMany({
    where: { userId },
    include: { meeting: { select: { id: true, scheduledAt: true } } },
    orderBy: { meeting: { scheduledAt: "asc" } },
  });

  const existing = await tx.penalty.findMany({
    where: { userId, type: { in: ["MEETING_SKIPPED", "MEETING_LATE"] } },
  });
  const byMeeting = new Map(existing.map((p) => [p.meetingId, p]));

  // Meetings whose fine an admin cancelled for this person. The skip itself is
  // left in the history and still counts toward the consecutive-skip streak
  // below — what was forgiven is the money, not the fact.
  const waivedMeetings = new Set(
    (
      await tx.fineWaiver.findMany({
        where: { userId, meetingId: { not: null } },
        select: { meetingId: true },
      })
    ).map((w) => w.meetingId),
  );

  let streak = 0;
  for (const a of attendances) {
    let desired: { type: "MEETING_SKIPPED" | "MEETING_LATE"; amount: number } | null =
      null;
    if (a.status === "SKIPPED") {
      streak += 1;
      desired = { type: "MEETING_SKIPPED", amount: meetingPenaltyAmount(streak) };
    } else if (a.status === "LATE") {
      streak = 0;
      desired = { type: "MEETING_LATE", amount: MEETING_LATE_PENALTY };
    } else {
      streak = 0;
    }

    // A waived meeting is priced as if it warranted nothing: any fine still on
    // it stays in `byMeeting` and is swept up as stale below, and none is
    // raised again. The streak arithmetic above has already run.
    if (waivedMeetings.has(a.meetingId)) desired = null;

    if (!desired) continue;

    const current = byMeeting.get(a.meetingId);
    if (current) {
      // Fines with money against them are frozen history — never re-price or
      // re-type one, or we'd silently change what the person already paid.
      // That covers part-paid fines too: re-pricing one below what's been paid
      // would leave it owing a negative amount.
      if (
        current.paidAmount === 0 &&
        (current.amount !== desired.amount || current.type !== desired.type)
      ) {
        await tx.penalty.update({
          where: { id: current.id },
          data: { amount: desired.amount, type: desired.type },
        });
      }
      byMeeting.delete(a.meetingId);
    } else {
      await tx.penalty.create({
        data: {
          userId,
          type: desired.type,
          amount: desired.amount,
          meetingId: a.meetingId,
          issuedById,
        },
      });
      // Only a newly created fine notifies — silent amount corrections from
      // re-marking older meetings would just be noise.
      await notify(
        tx,
        userId,
        "FINE",
        desired.type === "MEETING_SKIPPED"
          ? `You were fined ${formatMoney(desired.amount)} for skipping the ${formatYmd(toYmd(a.meeting.scheduledAt))} meeting.`
          : `You were fined ${formatMoney(desired.amount)} for being late to the ${formatYmd(toYmd(a.meeting.scheduledAt))} meeting.`,
      );
    }
  }

  // Any leftover fines with nothing paid against them point at meetings that no
  // longer warrant one — remove them. Anything part-paid or settled is left
  // alone (deleting one would erase a payment that actually happened).
  const stale = [...byMeeting.values()]
    .filter((p) => p.paidAmount === 0)
    .map((p) => p.id);
  if (stale.length > 0) {
    await tx.penalty.deleteMany({ where: { id: { in: stale } } });
  }
}

/**
 * Create a goal and assign it to one or more people. Lives outside the weekly
 * goal flow (see the AssignedTask model) — a standalone task each assignee
 * tracks. Admins may assign to anyone; a department lead to the members under
 * the departments they lead. `scope` picks which dashboard view (week/month)
 * surfaces it. Deadline is an optional YYYY-MM-DD (stored at UTC midnight,
 * treated as date-only like goal deadlines).
 *
 * Each assignee gets their own row, so completing, editing, or deleting one
 * person's copy leaves everybody else's alone. The batch is written in a single
 * transaction: it lands for everyone or for nobody, so a failure partway can't
 * assign half the team a goal the rest never hear about.
 */
export async function assignTask(
  userIds: string[],
  title: string | string[],
  deadline?: string | null,
  note?: string,
  scope: "WEEKLY" | "MONTHLY" = "WEEKLY",
) {
  const session = await auth();
  // One title or a batch — several goals can go to the same people in one
  // assignment (they share the deadline, note, and scope).
  const cleanTitles = (Array.isArray(title) ? title : [title])
    .map((t) => t.trim().slice(0, 300))
    .filter(Boolean);
  if (cleanTitles.length === 0) throw new Error("A title is required.");

  // Selecting "Everyone" and a name individually must not assign twice.
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) throw new Error("Pick at least one person.");
  await requireCanManage(session, ids);

  const found = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) throw new Error("User not found");

  let due: Date | null = null;
  if (deadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      throw new Error("Invalid deadline");
    }
    const [y, m, d] = deadline.split("-").map(Number);
    due = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(due.getTime())) throw new Error("Invalid deadline");
  }

  if (scope !== "WEEKLY" && scope !== "MONTHLY") {
    throw new Error("Invalid scope");
  }

  const cleanNote = note?.trim().slice(0, 500) || null;

  await prisma.$transaction(async (tx) => {
    await tx.assignedTask.createMany({
      data: ids.flatMap((userId) =>
        cleanTitles.map((t) => ({
          userId,
          assignedById: session!.user.id,
          title: t,
          note: cleanNote,
          scope,
          deadline: due,
        })),
      ),
    });
    // One notification per person, whatever the batch size.
    const noun = scope === "MONTHLY" ? "monthly" : "weekly";
    const dueSuffix = due ? ` — due ${formatYmd(toYmd(due))}` : "";
    await notify(
      tx,
      ids,
      "TASK_ASSIGNED",
      cleanTitles.length === 1
        ? `You were assigned a ${noun} goal: “${cleanTitles[0]}”${dueSuffix}.`
        : `You were assigned ${cleanTitles.length} ${noun} goals: ${cleanTitles
            .map((t) => `“${t}”`)
            .join(", ")}${dueSuffix}.`,
    );
  });
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}

/**
 * Edit an assigned task's definition — title, note, deadline, weekly/monthly
 * scope. Changing the scope moves it to the matching view on the assignee's
 * dashboard. The assignee is notified that their assignment changed. The
 * original assigner or an admin may edit; the assignee is never reassigned.
 */
export async function editAssignedTask(
  taskId: string,
  title: string,
  deadline?: string | null,
  note?: string,
  scope: "WEEKLY" | "MONTHLY" = "WEEKLY",
) {
  const session = await auth();
  const editorId = session?.user?.id;
  if (!editorId) throw new Error("Not authenticated");

  const task = await prisma.assignedTask.findUnique({
    where: { id: taskId },
    select: { id: true, userId: true, assignedById: true },
  });
  if (!task) throw new Error("Task not found");
  // The assigner or an admin may edit — nobody else.
  if (!isAdmin(session?.user?.email) && task.assignedById !== editorId) {
    throw new Error("Not authorized");
  }

  const cleanTitle = title.trim().slice(0, 300);
  if (!cleanTitle) throw new Error("A title is required.");

  let due: Date | null = null;
  if (deadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      throw new Error("Invalid deadline");
    }
    const [y, m, d] = deadline.split("-").map(Number);
    due = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(due.getTime())) throw new Error("Invalid deadline");
  }

  if (scope !== "WEEKLY" && scope !== "MONTHLY") {
    throw new Error("Invalid scope");
  }

  await prisma.assignedTask.update({
    where: { id: taskId },
    data: {
      title: cleanTitle,
      note: note?.trim().slice(0, 500) || null,
      scope,
      deadline: due,
    },
  });
  await notify(
    prisma,
    task.userId,
    "TASK_ASSIGNED",
    `Your assigned ${scope === "MONTHLY" ? "monthly" : "weekly"} goal was updated: “${cleanTitle}”${due ? ` — due ${formatYmd(toYmd(due))}` : ""}.`,
  );
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}

/** Remove an assigned task (e.g. created by mistake or no longer needed). Admin-only. */
export async function deleteAssignedTask(taskId: string) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  await prisma.assignedTask.delete({ where: { id: taskId } });
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/department");
}
