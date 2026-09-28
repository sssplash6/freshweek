"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";
import { isApprovedUser } from "@/lib/approval";
import { notify } from "@/lib/notifications";

/**
 * Only department leads and admins review sign-ups. Returns the reviewer's
 * session; throws for anyone else.
 *
 * A MINI department's lead seat does not count. Approving a sign-up is an
 * org-wide power (it lets any Google account onto the platform), while a mini
 * department's head is self-appointed — whoever joined it first, with no admin
 * in the loop (see lib/miniDepartments.ts). Letting that seat confer this
 * would turn one click on /profile into the right to admit strangers.
 */
async function requireReviewer() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (isAdmin(session.user.email)) return session;
  const leadSeat = await prisma.departmentMembership.findFirst({
    where: {
      userId: session.user.id,
      role: "LEAD",
      department: { mini: false },
    },
    select: { id: true },
  });
  if (!leadSeat) throw new Error("Not authorized");
  return session;
}

function revalidateSignupViews() {
  revalidatePath("/department");
  revalidatePath("/admin");
  revalidatePath("/departments");
  revalidatePath("/pending");
}

/**
 * Let a pending sign-up onto the platform. They're notified and land on
 * onboarding (pick a department, fill the profile) on their next load.
 * Lead-or-admin only.
 */
export async function approveSignup(userId: string) {
  const session = await requireReviewer();

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, approvedAt: true },
  });
  if (!target) throw new Error("That account is gone.");
  if (target.approvedAt != null) return; // someone beat this reviewer to it

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { approvedAt: new Date(), approvedById: session.user.id },
    });
    await notify(
      tx,
      userId,
      "OTHER",
      "Your account was approved — welcome aboard! Head to the dashboard and finish your profile.",
    );
  });
  revalidateSignupViews();
}

/**
 * Turn a pending sign-up away — deletes the account. Deliberately refuses to
 * touch anyone already approved (removing a real teammate stays an admin-only
 * act on /admin). If the same person signs in again a fresh request appears.
 *
 * ADMIN ONLY, unlike approval. A pending account has no department yet —
 * memberships are created during onboarding, which is itself behind the
 * approval gate — so there is no department for a lead's authority to be
 * scoped against, and every lead would otherwise be able to delete every
 * sign-up in the queue. Approval stays a lead power because it is additive and
 * an admin can reverse it; deletion can't be taken back.
 */
export async function rejectSignup(userId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (!isAdmin(session.user.email)) {
    throw new Error("Only an admin can remove a sign-up.");
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, approvedAt: true },
  });
  if (!target) return; // already gone
  if (target.approvedAt != null) {
    throw new Error("This account is already approved — only an admin can remove it.");
  }

  await prisma.user.delete({ where: { id: userId } });
  revalidateSignupViews();
}

/** Every view that shows department membership, refreshed after a seat moves. */
function revalidateMembershipViews() {
  revalidatePath("/departments");
  revalidatePath("/department");
  revalidatePath("/admin");
  revalidatePath("/team");
  revalidatePath("/onboarding");
  revalidatePath("/profile");
  revalidatePath("/dashboard");
}

/**
 * The gate for the two roster verbs below: the actor must hold the LEAD seat
 * in THIS department (an admin passes anywhere). A lead's authority over
 * people is bounded by the departments they lead, which is why the department
 * is the scope being checked rather than the target user.
 *
 * A MINI department's lead seat counts here — the member-level powers
 * (assign, fine, bonus in lib/manage.ts) already come off it, and a mini
 * department "runs itself", so its head managing the roster is exactly that.
 * What it never confers is org-wide powers like sign-up review — those stay
 * behind requireReviewer above, which excludes mini seats.
 */
async function requireLeadOf(departmentId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  if (isAdmin(session.user.email)) return session;
  const seat = await prisma.departmentMembership.findUnique({
    where: {
      userId_departmentId: { userId: session.user.id, departmentId },
    },
    select: { role: true },
  });
  if (seat?.role !== "LEAD") throw new Error("Not authorized");
  return session;
}

/**
 * Add an already-approved person to a department the actor leads, as a
 * MEMBER — the lead's counterpart to addMembership on /departments, minus the
 * parts that stay admin-only: no choosing the role (handing out a lead seat
 * is an admin act) and no adding an account nobody has let in yet (that's
 * what approveSignup above is for). An existing seat is left exactly as it
 * is. Mini departments' first-joiner lead claim (lib/miniDepartments.ts)
 * doesn't run here — the actor already leads the department, so there is no
 * vacant head seat to take.
 */
export async function addDepartmentMember(
  userId: string,
  departmentId: string,
) {
  await requireLeadOf(departmentId);

  const [user, dept] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    }),
    prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true, name: true },
    }),
  ]);
  if (!dept) throw new Error("Department not found");
  if (!user) throw new Error("User not found");
  if (!(await isApprovedUser({ id: user.id, email: user.email }))) {
    throw new Error("Approve their sign-up first — they're not in yet.");
  }

  const existing = await prisma.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
    select: { id: true },
  });
  if (existing) return;

  await prisma.$transaction(async (tx) => {
    await tx.departmentMembership.create({
      data: { userId, departmentId, role: "MEMBER" },
    });
    await notify(
      tx,
      userId,
      "OTHER",
      `You were added to the ${dept.name} department.`,
    );
  });
  revalidateMembershipViews();
}

/**
 * Take a MEMBER seat away in a department the actor leads. Lead seats are
 * untouchable here — a fellow lead is a peer, not a report (lib/manage.ts),
 * and the actor's own seat is the very thing conferring this power — so lead
 * seats keep moving through an admin on /departments. Dropping a member's
 * last seat is allowed (same as the admin verb): they land back on onboarding
 * to pick a department, and they're notified either way.
 */
export async function removeDepartmentMember(
  userId: string,
  departmentId: string,
) {
  await requireLeadOf(departmentId);

  const membership = await prisma.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
    select: {
      id: true,
      role: true,
      department: { select: { name: true } },
    },
  });
  if (!membership) return;
  if (membership.role !== "MEMBER") {
    throw new Error(
      "That's a lead seat — only an admin can move it, on the Departments page.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.departmentMembership.delete({ where: { id: membership.id } });
    await notify(
      tx,
      userId,
      "OTHER",
      `You were removed from the ${membership.department.name} department.`,
    );
  });
  revalidateMembershipViews();
}
