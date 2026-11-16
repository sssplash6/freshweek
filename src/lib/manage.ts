// Server-only: who may act ON whom. Assigning tasks, fining, and awarding
// bonuses used to be admin-only; department leads now hold the same three
// powers over the people under them. "Under" means holding a MEMBER seat in a
// department the actor holds a LEAD seat in — a fellow lead of the same
// department is a peer, not a report.
//
// A lead may also act on THEMSELVES, but only for the two money powers (fine,
// bonus) — see `allowSelf`. Assigning is excluded: a lead adding their own
// task doesn't need this gate at all, they set their own goals from the
// dashboard, and keeping self out of the assign scope also keeps the
// dashboard's "assign to everyone" fan-out from silently including the sender.

import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";

type Actor = { id: string; email?: string | null };

export type ManageOptions = {
  /**
   * Let the actor target themselves. Only ever true for fining and awarding a
   * bonus, and only honoured for a lead of a NORMAL department: a mini
   * department's head is self-appointed by whoever joined first
   * (lib/miniDepartments.ts), so honouring it there would turn one click on
   * /profile into the power to pay yourself a bonus — bonuses snapshot into
   * payroll as real money.
   */
  allowSelf?: boolean;
};

/**
 * The user ids this actor may manage: "all" for admins, else the members
 * under the departments they lead (possibly empty), plus the actor themselves
 * when `allowSelf` applies.
 */
export async function manageableUserIds(
  actor: Actor,
  opts: ManageOptions = {},
): Promise<"all" | Set<string>> {
  if (isAdmin(actor.email)) return "all";

  const led = await prisma.departmentMembership.findMany({
    where: { userId: actor.id, role: "LEAD" },
    select: { departmentId: true, department: { select: { mini: true } } },
  });
  if (led.length === 0) return new Set();

  const members = await prisma.departmentMembership.findMany({
    where: {
      departmentId: { in: led.map((l) => l.departmentId) },
      role: "MEMBER",
      userId: { not: actor.id },
    },
    select: { userId: true },
  });
  const scope = new Set(members.map((m) => m.userId));

  // Self, for the money powers only, and only off the back of a real
  // department's lead seat.
  if (opts.allowSelf && led.some((l) => !l.department.mini)) {
    scope.add(actor.id);
  }
  return scope;
}

/**
 * Throw unless the signed-in actor may manage every one of `targetUserIds`.
 * Admins always pass; a lead passes for their own members, and for themselves
 * when the caller opts into `allowSelf`.
 */
export async function requireCanManage(
  session: { user?: { id?: string; email?: string | null } } | null,
  targetUserIds: string[],
  opts: ManageOptions = {},
): Promise<void> {
  const actorId = session?.user?.id;
  if (!actorId) throw new Error("Not authenticated");
  const scope = await manageableUserIds(
    { id: actorId, email: session!.user!.email },
    opts,
  );
  if (scope === "all") return;
  if (!targetUserIds.every((id) => scope.has(id))) {
    throw new Error("Not authorized");
  }
}

/**
 * Whether the actor may delete this person's whole account, the step past
 * removing a seat. It is irreversible and org-wide, so a lead's reach is
 * narrower than for the powers above: every seat the target holds must be a
 * MEMBER seat in a department the actor leads, so a peer lead, someone who
 * also sits in another lead's team, or an admin never vanishes from under
 * anyone. `ledIds` is the actor's NORMAL led departments (ledDepartmentIds in
 * lib/payrollParts.ts): a mini head is self-appointed, so that seat confers
 * nothing here. Admins pass for anyone but themselves, as on /admin.
 */
export function canDeleteAccount(
  actor: Actor,
  ledIds: ReadonlySet<string>,
  target: {
    id: string;
    email: string | null;
    seats: { departmentId: string; role: string }[];
  },
): boolean {
  if (target.id === actor.id) return false;
  if (isAdmin(actor.email)) return true;
  return (
    !isAdmin(target.email) &&
    target.seats.length > 0 &&
    target.seats.every(
      (s) => s.role === "MEMBER" && ledIds.has(s.departmentId),
    )
  );
}
