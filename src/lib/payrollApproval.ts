// Server-only: who approves whose pay request, and who has no one to answer
// to. The identity half of the lead stage — lib/payroll.ts owns the status
// machine that uses it, and app/payroll/team/actions.ts owns the verbs.
//
// The rule, in one sentence: a filer's request is approved by the LEAD of a
// normal department where the filer holds a MEMBER seat.
//
// Three consequences worth stating, because each of them is a decision:
//
//   • A lead never approves their own request. They hold a LEAD seat, not a
//     MEMBER one, so they are not in anyone's scope by this rule — and a desk
//     that stamps its own claims is not a desk. Theirs goes straight to
//     finance.
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
// A filer nobody covers by that rule files straight to finance. That is the
// honest outcome rather than a wedge: there is no one to wait for, and holding
// their pay for an approver who does not exist would be a bug, not a control.

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
    where: { userId, role: "MEMBER", department: { mini: false } },
    select: { departmentId: true },
  });
  if (seats.length === 0) return [];

  const leadSeats = await db.departmentMembership.findMany({
    where: {
      departmentId: { in: seats.map((s) => s.departmentId) },
      role: "LEAD",
      // Belt and braces: the filer can't hold a LEAD seat in a department they
      // hold a MEMBER seat in (one seat per person per department), so this
      // can't match — but the rule "nobody approves themselves" is stated
      // here rather than left to a uniqueness constraint elsewhere.
      userId: { not: userId },
    },
    select: {
      userId: true,
      user: { select: { name: true, email: true } },
      department: { select: { name: true } },
    },
  });

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

/** Whether `leadId` is one of the desks that may approve `filerId`. */
export async function canApprovePayroll(
  db: Db,
  leadId: string,
  filerId: string,
): Promise<boolean> {
  return (await approvableFilerIds(db, leadId)).has(filerId);
}
