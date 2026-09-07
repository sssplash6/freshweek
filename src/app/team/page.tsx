import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Team" };
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { resolveAvatar } from "@/lib/avatar";
import { departmentLine, isLead } from "@/lib/team";
import { formatYmd, toYmd } from "@/lib/dates";
import { BackLink } from "@/app/_components/BackLink";
import { TeamDirectory, type TeamRow } from "./_components/TeamDirectory";

export default async function TeamPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);

  // Approved teammates only. Keyed off a name alone, the directory also listed
  // sign-ups still waiting in the queue — people who can't reach any page but
  // /pending — handing their name and email to the whole company as though they
  // already worked here. Everyone predating the approval gate was backfilled as
  // approved by its migration, so nobody real drops off.
  const members = await prisma.user.findMany({
    where: { name: { not: null }, approvedAt: { not: null } },
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
      memberships: {
        select: { role: true, department: { select: { name: true } } },
      },
      workPhone: true,
      telegramUsername: true,
      linkedin: true,
      instagram: true,
      birthday: true,
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });

  // Shape each person once; the search, the phone cards and the desktop table
  // are all renderings of this same list, not separate queries.
  const rows: TeamRow[] = members.map((m) => {
    const avatar = resolveAvatar(m.avatar, m.email ?? m.name);
    return {
      id: m.id,
      name: m.name,
      isYou: m.id === session.user.id,
      emoji: avatar.emoji,
      bg: avatar.bg,
      department: departmentLine(m.memberships),
      lead: isLead(m.memberships),
      email: m.email,
      workPhone: m.workPhone,
      telegram: m.telegramUsername,
      linkedin: m.linkedin,
      instagram: m.instagram,
      birthdayLabel: m.birthday ? formatYmd(toYmd(m.birthday)) : null,
    };
  });

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Team</h1>
          <p className="mt-1 text-sm text-muted-fg">
            {`${members.length} ${members.length === 1 ? "person" : "people"} · ${
              members.filter((m) => isLead(m.memberships)).length
            } department leads`}
          </p>
        </div>
        <BackLink href="/dashboard" label="My dashboard" />
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-fg">
          No members yet. People show up here once they finish onboarding and
          fill in their profile.
        </p>
      ) : (
        <TeamDirectory rows={rows} />
      )}
    </main>
  );
}
