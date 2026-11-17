// The weekly goals report as a PDF: everyone's previous week and new week,
// split exactly like the admin tabs (lib/weeks.ts cycleWeeks). Admins only;
// a route isn't covered by the page's gate, so it checks for itself.

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";
import { isApprovedUser } from "@/lib/approval";
import { currentSubmissionCycle } from "@/lib/lateness";
import { cycleWeeks } from "@/lib/weeks";
import { goalPercent, isGoalComplete, weekPercent } from "@/lib/progress";
import { PRIORITY_LABEL } from "@/lib/priority";
import { departmentLine, isExpectedLead } from "@/lib/team";
import { formatDateTimeTz, formatStamp, formatYmd, toStamp, toYmd } from "@/lib/dates";
import {
  renderGoalsReport,
  type ReportPerson,
  type ReportWeek,
} from "@/lib/goalsReportPdf";

const person = { select: { name: true, email: true } } as const;
const nameOf = (u: { name: string | null; email: string | null }) =>
  u.name ?? u.email ?? "Someone";
const range = (w: { startDate: Date; endDate: Date }) =>
  `${formatYmd(toYmd(w.startDate))} – ${formatYmd(toYmd(w.endDate))}`;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return new Response("Sign in required", { status: 401 });
  if (!(await isApprovedUser(session.user)) || !isAdmin(session.user.email)) {
    return new Response("Not authorized", { status: 403 });
  }

  const now = new Date();
  const cycle = currentSubmissionCycle(now);

  const users = await prisma.user.findMany({
    where: { approvedAt: { not: null } },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    select: {
      name: true,
      email: true,
      memberships: {
        select: { role: true, department: { select: { name: true, mini: true } } },
      },
      // Same window as the admin roster: enough to find both cycle weeks even
      // for someone who reported ahead.
      weeks: {
        orderBy: { startDate: "desc" },
        take: 4,
        select: {
          startDate: true,
          endDate: true,
          submittedAt: true,
          submittedLate: true,
          goals: {
            orderBy: { position: "asc" },
            select: {
              title: true,
              priority: true,
              deadline: true,
              completedAt: true,
              manualPercent: true,
              incompleteReason: true,
              shareIn: { select: { fromUser: person } },
              sharesOut: { select: { toUser: person } },
              subtasks: {
                orderBy: { position: "asc" },
                select: {
                  title: true,
                  isDone: true,
                  shareIn: { select: { fromUser: person } },
                  sharesOut: { select: { toUser: person } },
                },
              },
            },
          },
        },
      },
    },
  });

  type Week = (typeof users)[number]["weeks"][number];
  const toReportWeek = (
    heading: string,
    week: Week | null,
    flags: (string | false | null | undefined)[],
  ): ReportWeek => ({
    heading,
    range: week ? range(week) : null,
    percent: week ? weekPercent(week.goals) : 0,
    // Unsubmitted reads as nothing here; for a lead, who owes it, it's a flag.
    status: week?.submittedAt
      ? `Submitted ${formatDateTimeTz(week.submittedAt)}`
      : null,
    flags: flags.filter((f): f is string => !!f),
    goals: (week?.goals ?? []).map((g) => ({
      title: g.title,
      percent: goalPercent(g),
      completed: isGoalComplete(g),
      priority: g.priority ? PRIORITY_LABEL[g.priority] : null,
      deadline: g.deadline ? formatStamp(toStamp(g.deadline)) : null,
      from: g.shareIn ? nameOf(g.shareIn.fromUser) : null,
      sharedTo: g.sharesOut.map((s) => nameOf(s.toUser)),
      incompleteReason: g.incompleteReason,
      subtasks: g.subtasks.map((s) => ({
        title: s.title,
        isDone: s.isDone,
        from: s.shareIn ? nameOf(s.shareIn.fromUser) : null,
        sharedTo: s.sharesOut.map((sh) => nameOf(sh.toUser)),
      })),
    })),
  });

  const people: ReportPerson[] = [];
  for (const u of users) {
    const { current, previous } = cycleWeeks(u.weeks, cycle.submissionDeadline);
    if (!current && !previous) continue;
    // Only leads owe the deadline, so Late and Didn't close are lead-only
    // flags, as on the admin tabs.
    const lead = isExpectedLead(u.memberships);
    people.push({
      name: nameOf(u),
      department: departmentLine(u.memberships) ?? "",
      weeks: [
        toReportWeek("Previous week", previous, [
          lead && previous?.submittedLate && "Late",
          lead && previous != null && current == null && "Didn't close",
        ]),
        toReportWeek("New week", current, [
          lead && current?.submittedLate && "Late",
          lead && current != null && !current.submittedAt && "Not submitted",
        ]),
      ],
    });
  }

  // The slot labels in the title: the cycle's own weeks, whatever any one
  // person's dates are.
  const newStart = cycle.weekStart;
  const day = 86_400_000;
  const label = (start: Date) =>
    range({ startDate: start, endDate: new Date(start.getTime() + 6 * day) });

  const bytes = await renderGoalsReport({
    generatedLabel: formatDateTimeTz(now),
    previousLabel: label(new Date(newStart.getTime() - 7 * day)),
    newLabel: label(newStart),
    people,
  });

  const filename = `Weekly goals ${toYmd(newStart)}.pdf`;
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
