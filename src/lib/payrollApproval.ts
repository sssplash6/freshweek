// Server-only: who approves whose pay request, and who has no one to answer
// to. The identity half of the lead stage — lib/payroll.ts owns the status
// machine that uses it, and app/payroll/team/actions.ts owns the verbs.
//
// The rule, in one sentence: a filer's request is approved by the LEAD of a
// normal department where the filer holds a MEMBER seat — and a lead approves
// their own.
//
// Three consequences worth stating, because each of them is a decision:
//
//   • A lead approves their own request. It lands on their own desk (WITH_LEAD)
//     like anyone's and waits for them to pass it on. That is approval ONLY:
//     `approvableFilerIds` (the payment scope) still excludes them, so nobody
//     pays their own request — finance does.
//   • Mini departments (Alumni Council) are excluded. A mini department runs
//     itself and its head carries none of the lead expectations — no meeting
//     seat, no submission deadline, no fines (lib/miniDepartments.ts) — so it
//     does not acquire a payroll desk either.
//   • Several leads on one department are ONE desk, not a queue of them: any
//     of them may approve, and the audit row records which did. Likewise
//     someone who is a member of two departments needs one approval, from
//     either lead — the gate exists so a request is seen by someone who knows
//     the work, and either of them does.
//
// A filer nobody covers by that rule — a member of a department with no lead,
// say — files straight to finance. That is the honest outcome rather than a
// wedge: there is no one to wait for, and holding their pay for an approver who
// does not exist would be a bug, not a control.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

/** One desk that may approve a given filer's request. */
export type ApprovingLead = {
  id: string;
  name: string | null;
  email: string | null;
  /** The department(s) of theirs the filer sits in — why they're the approver. */
  departments: string[];
};

/**
 * The leads who may approve `userId`'s pay request, newest-filed first being
 * irrelevant here — the order is by name so a UI can name them stably.
 * Empty means nobody: file straight to finance.
 */
export async function approvingLeadsFor(
  db: Db,
  userId: string,
): Promise<ApprovingLead[]> {
  const seats = await db.departmentMembership.findMany({
    where: { userId, department: { mini: false } },
    select: { departmentId: true, role: true, department: { select: { name: true } } },
  });
  const memberDepts = seats.filter((s) => s.role === "MEMBER");
  const ownLed = seats.filter((s) => s.role === "LEAD");
  if (seats.length === 0) return [];

  const leadSeats = memberDepts.length
    ? await db.departmentMembership.findMany({
        where: {
          departmentId: { in: memberDepts.map((s) => s.departmentId) },
          role: "LEAD",
          // A filer can't hold both seats in one department (one seat per
          // person per department), so this never matches the filer — the
          // self-approval of a lead is added explicitly below instead.
          userId: { not: userId },
        },
        select: {
          userId: true,
          user: { select: { name: true, email: true } },
          department: { select: { name: true } },
        },
      })
    : [];

  // A lead is their own approver for the departments they lead.
  if (ownLed.length) {
    const me = await db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    for (const seat of ownLed) {
      leadSeats.push({
        userId,
        user: { name: me?.name ?? null, email: me?.email ?? null },
        department: { name: seat.department.name },
      });
    }
  }

  // One row per lead, carrying every department of theirs the filer sits in.
  const byLead = new Map<string, ApprovingLead>();
  for (const seat of leadSeats) {
    const found = byLead.get(seat.userId);
    if (found) {
      found.departments.push(seat.department.name);
      continue;
    }
    byLead.set(seat.userId, {
      id: seat.userId,
      name: seat.user.name,
      email: seat.user.email,
      departments: [seat.department.name],
    });
  }
  return [...byLead.values()].sort((a, b) =>
    (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""),
  );
}

/**
 * Whose requests `leadId` may approve — the mirror of the above, for the team
 * page and its guards. A set, empty for anyone who leads nothing.
 */
export async function approvableFilerIds(
  db: Db,
  leadId: string,
): Promise<Set<string>> {
  const led = await db.departmentMembership.findMany({
    where: { userId: leadId, role: "LEAD", department: { mini: false } },
    select: { departmentId: true },
  });
  if (led.length === 0) return new Set();

  const members = await db.departmentMembership.findMany({
    where: {
      departmentId: { in: led.map((l) => l.departmentId) },
      role: "MEMBER",
      userId: { not: leadId },
    },
    select: { userId: true },
  });
  return new Set(members.map((m) => m.userId));
}

/**
 * Whose requests `leadId` may APPROVE: `approvableFilerIds` plus themselves
 * when they lead a normal department. Not the payment scope — that stays
 * `approvableFilerIds`, so a lead can approve their own request but not pay it.
 */
export async function approvalScopeFor(
  db: Db,
  leadId: string,
): Promise<Set<string>> {
  const scope = await approvableFilerIds(db, leadId);
  const leads = await db.departmentMembership.count({
    where: { userId: leadId, role: "LEAD", department: { mini: false } },
  });
  if (leads > 0) scope.add(leadId);
  return scope;
}

/** Whether `leadId` is one of the desks that may approve `filerId`. */
export async function canApprovePayroll(
  db: Db,
  leadId: string,
  filerId: string,
): Promise<boolean> {
  return (await approvalScopeFor(db, leadId)).has(filerId);
}
