"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  normalizeInstagram,
  normalizeLinkedin,
  normalizeTelegram,
} from "@/lib/profile";
import { parseYmd } from "@/lib/dates";
import { AVATAR_EMOJIS } from "@/lib/avatar";
import { notify } from "@/lib/notifications";
import { claimVacantMiniLeads, miniLeadNotice } from "@/lib/miniDepartments";
import { isApprovedUser } from "@/lib/approval";

export type ProfileState = { error: string | null; saved: boolean };

/** Everywhere a membership change shows up. */
function revalidateMembershipViews() {
  revalidatePath("/profile");
  revalidatePath("/team");
  revalidatePath("/departments");
  revalidatePath("/department");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
}

/** Tell a department's lead(s) something, if it has any. */
async function notifyDepartmentLeads(departmentId: string, message: string) {
  const leads = await prisma.departmentMembership.findMany({
    where: { departmentId, role: "LEAD" },
    select: { userId: true },
  });
  if (leads.length === 0) return;
  await notify(
    prisma,
    leads.map((l) => l.userId),
    "OTHER",
    message,
  );
}

/**
 * Join a department as a member — self-service, from the profile page. Lead
 * roles are never self-assigned (admins hand those out on /departments) with
 * one exception: a mini department with no head yet is led by whoever joins it
 * first (see lib/miniDepartments.ts). An existing membership is left exactly as
 * it is. The department's lead(s) are told someone joined.
 */
export async function joinDepartment(departmentId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const userId = session.user.id;
  // Joining can hand out a mini department's lead seat, so this action needs
  // the approval gate its page has rather than trusting the page to hold it.
  if (!(await isApprovedUser({ id: userId, email: session.user.email }))) {
    throw new Error("Your account is still waiting for approval.");
  }

  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, name: true },
  });
  if (!department) throw new Error("Department not found");

  const existing = await prisma.departmentMembership.findUnique({
    where: {
      userId_departmentId: { userId, departmentId },
    },
    select: { id: true },
  });
  if (existing) return; // already in it — nothing to do

  const claimed = await prisma.$transaction(async (tx) => {
    await tx.departmentMembership.create({ data: { userId, departmentId } });
    return claimVacantMiniLeads(tx, userId, [departmentId]);
  });

  // A mini department's first joiner heads it — tell them, rather than
  // announcing them to themselves as a new member.
  if (claimed.length > 0) {
    await notify(prisma, userId, "OTHER", miniLeadNotice(department.name));
  } else {
    await notifyDepartmentLeads(
      departmentId,
      `${session.user.name ?? session.user.email ?? "Someone"} joined ${department.name} as a member.`,
    );
  }
  revalidateMembershipViews();
}

/**
 * Leave a department — self-service, member seats only. A lead seat is a
 * responsibility an admin gave out, so shedding it goes through an admin; and
 * the last membership can't be dropped (the dashboard requires at least one,
 * see lib/profile.ts).
 */
export async function leaveDepartment(departmentId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const membership = await prisma.departmentMembership.findUnique({
    where: {
      userId_departmentId: { userId: session.user.id, departmentId },
    },
    select: { id: true, role: true, department: { select: { name: true } } },
  });
  if (!membership) return; // already out
  if (membership.role === "LEAD") {
    throw new Error(
      "You lead this department — ask an admin to hand the lead role over first.",
    );
  }
  const seats = await prisma.departmentMembership.count({
    where: { userId: session.user.id },
  });
  if (seats <= 1) {
    throw new Error("You need at least one department — join another first.");
  }

  await prisma.departmentMembership.delete({ where: { id: membership.id } });
  await notifyDepartmentLeads(
    departmentId,
    `${session.user.name ?? session.user.email ?? "Someone"} left ${membership.department.name}.`,
  );
  revalidateMembershipViews();
}

/**
 * Save the editable profile fields for the signed-in user. Name, work phone
 * and Telegram stay required because they gate the dashboard (lib/profile.ts);
 * birthday no longer gates anything but is still required here, since this
 * form arrives with it prefilled and saving it away empty would only re-raise
 * the dashboard nag. LinkedIn and Instagram are optional. Email is not
 * editable — it's the Google sign-in identity — and the department/role pair
 * is org structure, managed by admins on /departments rather than self-served
 * here.
 */
export async function updateProfile(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const session = await auth();
  if (!session?.user?.id) return { error: "You're not signed in.", saved: false };

  const name = String(formData.get("name") ?? "").trim();
  const workPhone = String(formData.get("workPhone") ?? "").trim();
  const telegramUsername = normalizeTelegram(
    String(formData.get("telegramUsername") ?? ""),
  );
  const birthday = String(formData.get("birthday") ?? "").trim();
  const linkedin = normalizeLinkedin(String(formData.get("linkedin") ?? ""));
  const instagram = normalizeInstagram(String(formData.get("instagram") ?? ""));

  if (!name || !workPhone || !telegramUsername || !birthday) {
    return { error: "Name, phone, Telegram and birthday are required.", saved: false };
  }
  const birthdayDate = parseYmd(birthday);
  if (!birthdayDate) {
    return { error: "That birthday isn't a real date.", saved: false };
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      name,
      workPhone,
      telegramUsername,
      birthday: birthdayDate,
      linkedin: linkedin || null,
      instagram: instagram || null,
    },
  });

  revalidatePath("/profile");
  revalidatePath("/team");
  revalidatePath("/dashboard");
  return { error: null, saved: true };
}

export type SetAvatarResult =
  | { ok: true; emoji: string }
  | { ok: false; error: "taken" | "invalid" };

/**
 * Set the signed-in user's animal to `emoji`. One animal per person is a DB
 * constraint, so when someone else claims it first we report "taken" and the
 * picker puts the old one back.
 */
export async function setAvatar(emoji: string): Promise<SetAvatarResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "invalid" };
  if (!AVATAR_EMOJIS.includes(emoji)) return { ok: false, error: "invalid" };

  try {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { avatar: emoji },
    });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
      return { ok: false, error: "taken" };
    }
    throw e;
  }

  // Everywhere a face is drawn.
  revalidatePath("/profile");
  revalidatePath("/dashboard");
  revalidatePath("/team");
  revalidatePath("/admin");
  revalidatePath("/department");
  return { ok: true, emoji };
}
