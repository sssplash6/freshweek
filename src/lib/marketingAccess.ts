// Server-only: who may see and act on the marketing content plan. Membership
// in the "Marketing" department is the access — there is no marketing flag on
// the user, because a department seat is already exactly that fact and /departments
// already manages it. Admins (the email allowlist) get in alongside, the same
// way they reach every page.
//
// Inside the plan, the department's LEAD and the admins are its managers: they
// may edit or withdraw any teammate's task, so work set by someone who has
// since left the department never gets stuck with nobody able to touch it.

import { auth } from "@/auth";
import { ActionError } from "@/lib/actionResult";
import { isAdmin } from "@/lib/admin";
import { MARKETING_DEPARTMENT } from "@/lib/marketing";
import { prisma } from "@/lib/prisma";

const marketingDept = {
  name: { equals: MARKETING_DEPARTMENT, mode: "insensitive" },
} as const;

/** This person's seat in the Marketing department, if they hold one. */
async function marketingSeat(userId: string) {
  return prisma.departmentMembership.findFirst({
    where: { userId, department: marketingDept },
    select: { role: true },
  });
}

/** Whether this person holds a seat in the Marketing department. */
export async function isMarketingMember(userId: string): Promise<boolean> {
  return (await marketingSeat(userId)) != null;
}

/** Whether this signed-in user may use the marketing content plan. */
export async function isMarketingUser(user: {
  id: string;
  email?: string | null;
}): Promise<boolean> {
  return isAdmin(user.email) || isMarketingMember(user.id);
}

/**
 * The access this user holds on the plan: `null` for none, otherwise whether
 * they're a member at all and whether they manage it (lead or admin).
 */
export async function marketingAccess(user: {
  id: string;
  email?: string | null;
}): Promise<{ member: boolean; manager: boolean } | null> {
  const seat = await marketingSeat(user.id);
  const admin = isAdmin(user.email);
  if (!seat && !admin) return null;
  return { member: seat != null, manager: admin || seat?.role === "LEAD" };
}

/**
 * The gate every marketing action runs first: a live session whose user is a
 * marketing member (or an admin). Throws an ActionError so the refusal reads
 * on the client (actions return ActionResult — see lib/actionResult.ts); the
 * page runs its own redirect-based gate (the codebase's page-gate convention).
 */
export async function requireMarketing() {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) throw new ActionError("Sign in again to keep going.");
  const access = await marketingAccess(user);
  if (!access) {
    throw new ActionError("The content plan is for the marketing department.");
  }
  return { ...user, id: user.id, manager: access.manager };
}

/**
 * Everyone who may be handed marketing work — the department's roster, for
 * the assignee pickers and for team-wide notifications. Ids and names only.
 */
export async function marketingMembers() {
  const dept = await prisma.department.findFirst({
    where: marketingDept,
    select: {
      memberships: {
        orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }],
        select: {
          user: { select: { id: true, name: true, email: true, avatar: true } },
        },
      },
    },
  });
  return (dept?.memberships ?? []).map((m) => m.user);
}
