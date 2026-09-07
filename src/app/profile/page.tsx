import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Your profile" };
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { toYmd } from "@/lib/dates";
import { BackLink } from "@/app/_components/BackLink";
import { ProfileForm } from "./ProfileForm";
import { ProfileAnimal } from "./ProfileAnimal";
import { ProfileDepartments } from "./ProfileDepartments";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);

  const [user, departments, avatarOwners] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        name: true,
        email: true,
        avatar: true,
        workPhone: true,
        telegramUsername: true,
        memberships: {
          select: {
            role: true,
            department: { select: { id: true, name: true } },
          },
        },
        birthday: true,
        linkedin: true,
        instagram: true,
      },
    }),
    prisma.department.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    // Animals already spoken for — the picker greys those out.
    prisma.user.findMany({
      where: { avatar: { not: null } },
      select: { avatar: true },
    }),
  ]);
  if (!user) redirect("/signin");

  // Seats they hold (led ones first), and departments still open to join.
  const memberships = [...user.memberships]
    .sort(
      (a, b) =>
        Number(b.role === "LEAD") - Number(a.role === "LEAD") ||
        a.department.name.localeCompare(b.department.name),
    )
    .map((m) => ({
      departmentId: m.department.id,
      name: m.department.name,
      role: m.role,
    }));
  const mine = new Set(memberships.map((m) => m.departmentId));
  const joinable = departments.filter((d) => !mine.has(d.id));

  return (
    <main className="flex flex-1 justify-center bg-canvas px-6 py-10">
      <div className="w-full max-w-lg">
        <BackLink href="/dashboard" label="My dashboard" />

        <div className="mt-4 rounded-2xl border border-line bg-surface p-8 shadow-sm">
          <h1 className="mt-1 text-2xl font-bold text-ink">Your profile</h1>
          <p className="mt-2 text-sm text-muted-fg">
            Update your details. Socials appear on{" "}
            <Link href="/team" className="font-medium text-brand hover:underline">
              Team
            </Link>
            .
          </p>

          <ProfileForm
            defaults={{
              name: user.name ?? "",
              email: user.email ?? "",
              workPhone: user.workPhone ?? "",
              telegramUsername: user.telegramUsername ?? "",
              birthday: user.birthday ? toYmd(user.birthday) : "",
              linkedin: user.linkedin ?? "",
              instagram: user.instagram ?? "",
            }}
          />
        </div>

        <ProfileAnimal
          assigned={user.avatar}
          seed={user.email ?? user.name}
          takenByOthers={avatarOwners
            .map((u) => u.avatar as string)
            .filter((e) => e !== user.avatar)}
        />

        <ProfileDepartments memberships={memberships} joinable={joinable} />
      </div>
    </main>
  );
}
