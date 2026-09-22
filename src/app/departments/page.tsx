import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Departments" };
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";
import { resolveAvatar } from "@/lib/avatar";
import { BackLink } from "@/app/_components/BackLink";
import { DepartmentManager, type Person } from "./_components/DepartmentManager";

export default async function DepartmentsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  if (!isAdmin(session.user.email)) redirect("/dashboard");

  const [departments, users] = await Promise.all([
    prisma.department.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        mini: true,
        memberships: {
          // Leads first (enum order), then alphabetically.
          orderBy: [
            { role: "asc" },
            { user: { name: "asc" } },
            { user: { email: "asc" } },
          ],
          select: {
            role: true,
            user: {
              select: { id: true, name: true, email: true, avatar: true },
            },
          },
        },
      },
    }),
    // Everyone, for the add-person selects — and to find who holds no seat at
    // all (mid-onboarding, or their departments were deleted).
    prisma.user.findMany({
      orderBy: [{ name: "asc" }, { email: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        memberships: { select: { departmentId: true } },
      },
    }),
  ]);

  const toPerson = (
    u: { id: string; name: string | null; email: string | null; avatar: string | null },
    lead: boolean,
  ): Person => {
    const av = resolveAvatar(u.avatar, u.email ?? u.id);
    return {
      id: u.id,
      name: u.name ?? u.email ?? "—",
      email: u.email,
      emoji: av.emoji,
      bg: av.bg,
      lead,
    };
  };

  const deptViews = departments.map((d) => ({
    id: d.id,
    name: d.name,
    mini: d.mini,
    people: d.memberships.map((m) => toPerson(m.user, m.role === "LEAD")),
  }));

  const unassigned = users
    .filter((u) => u.memberships.length === 0)
    .map((u) => toPerson(u, false));

  const allPeople = users.map((u) => ({
    id: u.id,
    name: u.name ?? u.email ?? "—",
  }));

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-brand">
            Admin
          </div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Departments</h1>
        </div>
        <BackLink href="/admin" label="Team overview" />
      </header>

      <DepartmentManager
        departments={deptViews}
        unassigned={unassigned}
        allPeople={allPeople}
        currentUserId={session.user.id}
      />
    </div>
  );
}
