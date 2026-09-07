import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Your department" };
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";
import { manageableUserIds } from "@/lib/manage";
import { resolveAvatar } from "@/lib/avatar";
import { weekPercent } from "@/lib/progress";
import { formatDateTimeTz } from "@/lib/dates";
import { formatMoney } from "@/lib/penalties";
import { ensureCurrentPeriod } from "@/lib/payroll";
import { approvableFilerIds } from "@/lib/payrollApproval";
import { isPayrollOpenFor, payrollPeriodLabel } from "@/lib/payrollTypes";
import { BackLink } from "@/app/_components/BackLink";
import { LeadRoster, type LeadDepartment } from "./_components/LeadRoster";
import { PendingSignups } from "./_components/PendingSignups";

/**
 * The department panel for leads: the whole roster of every department the
 * viewer leads — the lead themself and any fellow leads included, so the list
 * reads as the actual team rather than "everyone except me" — with the lead's
 * three powers (assign a goal, fine, bonus) on the rows they apply to.
 *
 * Those powers do NOT extend to every row. A lead manages the MEMBER seats
 * under them, not themselves and not a peer lead, so each row carries a
 * `manageable` flag taken from lib/manage.ts — the same function the actions
 * re-check server-side, so the buttons can never offer what the action would
 * refuse. Admins have the wider /admin view; this is the day-to-day one.
 */
export default async function DepartmentPanelPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  const userId = session.user.id;

  const [led, pendingUsers] = await Promise.all([
    prisma.departmentMembership.findMany({
    where: { userId, role: "LEAD" },
    orderBy: { department: { name: "asc" } },
    select: {
      department: {
        select: {
          id: true,
          name: true,
          memberships: {
            // The whole department, leads included — the viewer is a seat in
            // their own team list, not an absence from it. Leads first (enum
            // order puts LEAD before MEMBER), then alphabetically.
            orderBy: [
              { role: "asc" },
              { user: { name: "asc" } },
              { user: { email: "asc" } },
            ],
            select: {
              role: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  avatar: true,
                  weeks: {
                    where: { isCurrent: true },
                    select: {
                      submittedAt: true,
                      createdAt: true,
                      goals: {
                        select: {
                          completedAt: true,
                          manualPercent: true,
                          subtasks: { select: { isDone: true } },
                        },
                      },
                    },
                  },
                  penalties: {
                    where: { paidAt: null },
                    select: { amount: true, paidAmount: true },
                  },
                  assignedTasks: {
                    where: { completedAt: null },
                    select: { id: true },
                  },
                  // Their bonuses, so a lead can fix one they got wrong
                  // instead of asking an admin to. Capped: the panel is for
                  // correcting a recent award, not an audit trail.
                  bonuses: {
                    orderBy: { createdAt: "desc" },
                    take: 10,
                    select: {
                      id: true,
                      amount: true,
                      note: true,
                      createdAt: true,
                      payrollSubmissionId: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    }),
    // Sign-ups waiting to be let in — reviewing them is a lead power too.
    // The department each one named on /pending comes along: it is what tells
    // a lead whose new joiner this is, and every lead sees the whole queue.
    prisma.user.findMany({
      where: { approvedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        createdAt: true,
        requestedDepartment: { select: { name: true } },
      },
    }),
  ]);

  // Not a lead anywhere — this panel isn't theirs.
  if (led.length === 0) redirect("/dashboard");

  // Who the viewer may actually act on. Straight from lib/manage.ts, which is
  // what assignTask/addManualPenalty/addBonus re-check, so a row can never
  // show a button whose action would then refuse it.
  //
  // Two scopes, because the powers no longer travel together: a lead may fine
  // and bonus themselves, but not assign themselves a task. Same function,
  // same flag the actions pass.
  const actor = { id: userId, email: session.user.email };
  const [assignScope, moneyScope] = await Promise.all([
    manageableUserIds(actor),
    manageableUserIds(actor, { allowSelf: true }),
  ]);

  const pending = pendingUsers.map((u) => {
    const av = resolveAvatar(u.avatar, u.email ?? u.id);
    return {
      id: u.id,
      name: u.name ?? u.email ?? "—",
      email: u.email,
      emoji: av.emoji,
      bg: av.bg,
      joinedLabel: formatDateTimeTz(u.createdAt),
      department: u.requestedDepartment?.name ?? null,
    };
  });

  const departments: LeadDepartment[] = led.map(({ department: d }) => ({
    id: d.id,
    name: d.name,
    people: d.memberships.map(({ role, user: u }) => {
      const av = resolveAvatar(u.avatar, u.email ?? u.id);
      // A redeploy race can leave duplicate current weeks; prefer the
      // submitted one, then the fullest (same tie-break as getOrCreate).
      const week = [...u.weeks].sort(
        (a, b) =>
          Number(b.submittedAt != null) - Number(a.submittedAt != null) ||
          b.goals.length - a.goals.length ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
      return {
        id: u.id,
        name: u.name ?? u.email ?? "—",
        emoji: av.emoji,
        bg: av.bg,
        lead: role === "LEAD",
        isSelf: u.id === userId,
        canAssign: assignScope === "all" || assignScope.has(u.id),
        canMoney: moneyScope === "all" || moneyScope.has(u.id),
        goalCount: week?.goals.length ?? 0,
        weekPercent: week ? weekPercent(week.goals) : 0,
        submittedAtLabel: week?.submittedAt
          ? formatDateTimeTz(week.submittedAt)
          : null,
        outstanding: u.penalties.reduce(
          (s, p) => s + (p.amount - p.paidAmount),
          0,
        ),
        openTasks: u.assignedTasks.length,
        bonuses: u.bonuses.map((b) => ({
          id: b.id,
          amount: b.amount,
          note: b.note,
          dateLabel: formatDateTimeTz(b.createdAt),
          locked: b.payrollSubmissionId !== null,
        })),
      };
    }),
  }));

  const peopleCount = new Set(
    departments.flatMap((d) => d.people.map((p) => p.id)),
  ).size;

  /**
   * This lead's payroll desk, in one line: what their people have claimed for
   * the current period and how much of it is waiting on them.
   *
   * Scoped by lib/payrollApproval.ts, not by `departments` above — leading a
   * mini department carries no payroll desk, so the two lists genuinely
   * differ. Read-only here; the verbs are on /payroll/team.
   *
   * Skipped entirely while payroll is closed for this account: the figure
   * would be a number nobody can act on, under a link to a coming-soon screen.
   */
  const payrollScope = isPayrollOpenFor(session.user.email)
    ? await approvableFilerIds(prisma, userId)
    : new Set<string>();
  let teamPayroll: {
    label: string;
    requested: number;
    waiting: number;
    count: number;
  } | null = null;
  if (payrollScope.size > 0) {
    const period = await ensureCurrentPeriod(prisma, new Date());
    const rows = await prisma.payrollSubmission.findMany({
      where: {
        periodId: period.id,
        userId: { in: [...payrollScope] },
        // EXPIRED is never paid and DRAFT never really exists — the same
        // countable set /payroll/team and the finance panel total.
        status: { notIn: ["DRAFT", "EXPIRED"] },
      },
      select: { status: true, netTotal: true },
    });
    teamPayroll = {
      label: payrollPeriodLabel(period.year, period.month),
      requested: rows.reduce((sum, r) => sum + r.netTotal, 0),
      waiting: rows.filter((r) => r.status === "WITH_LEAD").length,
      count: rows.length,
    };
  }

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-brand">
            Department lead
          </div>
          <h1 className="mt-1 text-2xl font-bold text-ink">
            {departments.length === 1
              ? departments[0].name
              : "Your departments"}
          </h1>
          <p className="mt-1 text-sm text-muted-fg">
            {`${peopleCount} ${peopleCount === 1 ? "person" : "people"} in your ${
              departments.length === 1 ? "department" : "departments"
            }, you included. `}
            Assign goals, issue fines, and award bonuses on the members under
            you — each lands on their dashboard with a notification, and
            everything shows in the admin ledgers too.
          </p>
        </div>
        <BackLink href="/dashboard" label="My dashboard" />
      </header>

      {pending.length > 0 && (
        <div className="mb-4">
          <PendingSignups
            signups={pending}
            canRemove={isAdmin(session.user.email)}
          />
        </div>
      )}

      {teamPayroll && (
        <Link
          href="/payroll/team"
          className={`mb-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 transition ${
            teamPayroll.waiting > 0
              ? "border-amber-200 bg-amber-50 hover:bg-amber-100/70"
              : "border-line bg-surface hover:bg-canvas"
          }`}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">
              {teamPayroll.waiting > 0
                ? `${teamPayroll.waiting} pay ${
                    teamPayroll.waiting === 1 ? "request needs" : "requests need"
                  } your approval`
                : `Your team's ${teamPayroll.label} pay requests`}
            </span>
            <span className="block text-xs text-muted-fg">
              {teamPayroll.count === 0
                ? `Nobody has filed for ${teamPayroll.label} yet.`
                : `${formatMoney(teamPayroll.requested)} requested across ${
                    teamPayroll.count
                  } ${teamPayroll.count === 1 ? "request" : "requests"}${
                    teamPayroll.waiting > 0
                      ? " — finance can't pay the waiting ones until you approve"
                      : ""
                  }.`}
            </span>
          </span>
          <span className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">
            {teamPayroll.waiting > 0 ? "Review" : "Open"}
          </span>
        </Link>
      )}

      <LeadRoster departments={departments} />
    </div>
  );
}
