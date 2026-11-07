// Server-safe helpers for pay requests split by department (PayrollPart).
//
// Someone who sits in two or more normal departments files ONE request with a
// salary per department. Each department's lead approves and pays that
// department's part; the request is paid out when every part is. Everyone else
// files exactly as before and their request has no parts at all — every
// function here that is handed an empty list of parts answers for the request
// as a whole, so callers don't branch on "split or not" more than they must.
//
// What lives here is the arithmetic and the scoping: which departments a filer
// is paid by, what each part is worth, and which parts a given lead may
// approve or pay. The state changes (approving, paying, undoing a payment) are
// in lib/payroll.ts beside the status machine they move, and the verbs that
// call them are in app/payroll/{team,finance}/actions.ts.
//
// No imports from lib/payroll.ts: that module imports this one.

import { prisma } from "@/lib/prisma";
import type { Prisma, TeamRole } from "@/generated/prisma/client";
import type { PartMoney } from "@/lib/payrollTypes";

type Db = Prisma.TransactionClient | typeof prisma;

// ----- Which departments pay a filer -----

/** One department a filer's pay can be split across. */
export type PayDepartment = {
  id: string;
  name: string;
  /**
   * Who may approve this department's part: its leads when the filer is a
   * member, or the filer themselves for a department they lead (a lead
   * approves their own request — lib/payrollApproval.ts). Empty means the
   * department has no lead, so the part has nobody to wait on.
   */
  approverIds: string[];
};

/**
 * The normal departments `userId` holds a seat in, by name. Mini departments
 * are left out for the reason they carry no payroll desk anywhere: they run
 * themselves (lib/miniDepartments.ts).
 *
 * Two or more of these is what makes a request split. The list is read at
 * filing time and frozen onto the parts, so a seat added or removed later
 * changes the next month's form, never a request already filed.
 */
export async function payDepartmentsFor(
  db: Db,
  userId: string,
): Promise<PayDepartment[]> {
  const seats = await db.departmentMembership.findMany({
    where: { userId, department: { mini: false } },
    orderBy: { department: { name: "asc" } },
    select: { role: true, department: { select: { id: true, name: true } } },
  });
  const memberOf = seats
    .filter((s) => s.role === "MEMBER")
    .map((s) => s.department.id);
  const leads = memberOf.length
    ? await db.departmentMembership.findMany({
        where: {
          departmentId: { in: memberOf },
          role: "LEAD",
          userId: { not: userId },
        },
        select: { departmentId: true, userId: true },
      })
    : [];
  return seats.map((s) => ({
    id: s.department.id,
    name: s.department.name,
    approverIds:
      s.role === "LEAD"
        ? [userId]
        : leads
            .filter((l) => l.departmentId === s.department.id)
            .map((l) => l.userId),
  }));
}

/** Whether a filer with these departments files a split request. */
export function filesSplit(departments: readonly unknown[]): boolean {
  return departments.length >= 2;
}

// ----- What each part is worth -----
//
// The arithmetic is client-safe, so it lives in lib/payrollTypes.ts (the
// finance edit dialog previews part amounts as figures are typed) and is
// re-exported here for the server code that reaches for it by this name.

export { partAmount, splitLine, type PartMoney } from "@/lib/payrollTypes";

// ----- Who may act on which part -----

/** A filer's seat, as the pages already load it. */
export type SeatRef = { role: TeamRole; departmentId: string };

/**
 * The departments whose part of `filerId`'s request `actorId` may APPROVE,
 * given the departments the actor leads and the filer's seats. The rule
 * lib/payrollApproval.ts states for a whole request, narrowed to one
 * department at a time:
 *
 *   • a lead approves the part of a department they lead, when the filer is a
 *     MEMBER there — not when the filer co-leads it, which is the filer's own
 *     desk;
 *   • a lead approves their own parts, for the departments they lead.
 *
 * Pure, so a page that has already loaded its rows can scope every one of
 * them without a query per row.
 */
export function approvableDepartments(
  actorId: string,
  actorLeads: ReadonlySet<string>,
  filerId: string,
  filerSeats: readonly SeatRef[],
): Set<string> {
  if (actorId === filerId) {
    return new Set(
      filerSeats
        .filter((s) => s.role === "LEAD" && actorLeads.has(s.departmentId))
        .map((s) => s.departmentId),
    );
  }
  return new Set(
    filerSeats
      .filter((s) => s.role === "MEMBER" && actorLeads.has(s.departmentId))
      .map((s) => s.departmentId),
  );
}

/**
 * The departments whose part `actorId` may PAY: the approval scope minus the
 * self case. Nobody pays their own request (requirePayer in lib/payroll.ts), so
 * a lead's own parts are finance's to settle.
 */
export function payableDepartments(
  actorId: string,
  actorLeads: ReadonlySet<string>,
  filerId: string,
  filerSeats: readonly SeatRef[],
): Set<string> {
  if (actorId === filerId) return new Set();
  return approvableDepartments(actorId, actorLeads, filerId, filerSeats);
}

/** The normal departments `userId` leads, as a set of ids. */
export async function ledDepartmentIds(
  db: Db,
  userId: string,
): Promise<Set<string>> {
  const rows = await db.departmentMembership.findMany({
    where: { userId, role: "LEAD", department: { mini: false } },
    select: { departmentId: true },
  });
  return new Set(rows.map((r) => r.departmentId));
}

/** `userId`'s seats in normal departments, in the shape the scopes take. */
export async function seatsOf(db: Db, userId: string): Promise<SeatRef[]> {
  return db.departmentMembership.findMany({
    where: { userId, department: { mini: false } },
    select: { role: true, departmentId: true },
  });
}

// ----- Reading a split request -----

/** A part as every surface reads it. */
export type PartRow = PartMoney & {
  id: string;
  departmentId: string | null;
  departmentName: string;
  approvedAt: Date | null;
  paidAt: Date | null;
};

/** How far through payment a split request is. */
export function paidProgress(parts: readonly { paidAt: Date | null }[]): {
  paid: number;
  total: number;
} {
  return {
    paid: parts.filter((p) => p.paidAt !== null).length,
    total: parts.length,
  };
}

/** Whether any money has moved on this request — which freezes it. */
export function anyPartPaid(parts: readonly { paidAt: Date | null }[]): boolean {
  return parts.some((p) => p.paidAt !== null);
}

/**
 * Take a row lock on one submission for the rest of the transaction.
 *
 * Every part-level move reads the other parts to decide whether the request as
 * a whole moves on — the last approval sends it to finance, the last payment
 * pays it out. Two leads acting at once would each see the other's part still
 * open and neither would move it. Serializing on the submission row makes the
 * second one read the first one's write.
 */
export async function lockSubmission(
  tx: Prisma.TransactionClient,
  submissionId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM "PayrollSubmission" WHERE "id" = ${submissionId} FOR UPDATE`;
}
