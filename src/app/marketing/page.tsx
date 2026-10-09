import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { BackLink } from "@/app/_components/BackLink";
import { assertApproved } from "@/lib/approval";
import { resolveAvatar } from "@/lib/avatar";
import { formatTimeTz } from "@/lib/dailyReportTypes";
import { formatDateTimeTz, toYmd } from "@/lib/dates";
import {
  addDaysYmd,
  isPostPlatform,
  postState,
  relativeDayLabel,
  shootState,
  taskDue,
  tashkentHm,
  tashkentYmd,
} from "@/lib/marketing";
import { isDepartmentLead, marketingAccess, marketingMembers } from "@/lib/marketingAccess";
import { prisma } from "@/lib/prisma";
import { reconcileShootReminders } from "@/lib/shootReminders";
import { CalendarPanel } from "./_components/CalendarPanel";
import { ShootsPanel, type ShootRow } from "./_components/ShootsPanel";
import { PostsPanel, type PostRow, type ShootOption } from "./_components/PostsPanel";
import { TasksPanel, type TaskRow } from "./_components/TasksPanel";

export const metadata: Metadata = { title: "Content plan" };

/** How far back a reported shoot still shows up in the post form's picker. */
const SHOOT_PICKER_DAYS = 90;

type PersonLite = {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
};

function toMember(u: PersonLite) {
  const av = resolveAvatar(u.avatar, u.email ?? u.id);
  return { id: u.id, name: u.name ?? u.email ?? "—", emoji: av.emoji, bg: av.bg };
}

/** "Today" → "today" mid-sentence; weekday labels keep their capital. */
function inSentence(label: string) {
  return ["Today", "Tomorrow", "Yesterday"].includes(label) ? label.toLowerCase() : label;
}

/**
 * The marketing department's content plan: the production calendar (what gets
 * shot, when, where, by whom), the posting calendar (what goes out when, and
 * where), and the tasks teammates hand each other. Department membership is
 * the access — every page gates on its own line, before any query.
 */
export default async function MarketingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  const access =
    (await marketingAccess(session.user)) ??
    ((await isDepartmentLead(session.user.id))
      ? { member: false, manager: false }
      : null);
  if (!access) redirect("/dashboard");
  // Other departments' leads: look, don't touch (see lib/marketingAccess.ts).
  const viewOnly = !access.member && !access.manager;

  // Upcoming-shoot reminders ride page loads — the lazy no-cron pattern the
  // dashboard already runs for fines and the payroll nudge. Best-effort.
  await reconcileShootReminders().catch(() => {});

  const userId = session.user.id;
  const now = new Date();
  const todayYmd = tashkentYmd(now);
  const weekEndYmd = addDaysYmd(todayYmd, 6);

  const [members, shoots, posts, tasks] = await Promise.all([
    marketingMembers(),
    prisma.contentShoot.findMany({
      orderBy: { shootAt: "asc" },
      select: {
        id: true,
        title: true,
        shootAt: true,
        location: true,
        note: true,
        finishedUrl: true,
        rawUrl: true,
        reportedAt: true,
        reportedBy: { select: { name: true } },
        assignee: { select: { id: true, name: true, email: true, avatar: true } },
        _count: { select: { posts: true } },
      },
    }),
    prisma.contentPost.findMany({
      orderBy: { publishAt: "asc" },
      select: {
        id: true,
        title: true,
        publishAt: true,
        publishedAt: true,
        platforms: true,
        caption: true,
        postUrl: true,
        shoot: { select: { id: true, title: true, finishedUrl: true } },
      },
    }),
    prisma.marketingTask.findMany({
      orderBy: [{ dueOn: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        note: true,
        dueOn: true,
        percent: true,
        completedAt: true,
        createdById: true,
        createdBy: { select: { name: true } },
        assignee: { select: { id: true, name: true, email: true, avatar: true } },
      },
    }),
  ]);

  const memberViews = members.map(toMember);

  // ----- Shoots -----
  const toShootRow = (s: (typeof shoots)[number]): ShootRow => ({
    id: s.id,
    title: s.title,
    location: s.location,
    note: s.note,
    dateYmd: tashkentYmd(s.shootAt),
    timeHm: tashkentHm(s.shootAt),
    timeLabel: formatTimeTz(s.shootAt),
    dayLabel: relativeDayLabel(tashkentYmd(s.shootAt), todayYmd),
    state: shootState(s, now),
    assignee: s.assignee ? toMember(s.assignee) : null,
    finishedUrl: s.finishedUrl,
    rawUrl: s.rawUrl,
    reportedLabel: s.reportedAt
      ? `Filed${s.reportedBy?.name ? ` by ${s.reportedBy.name}` : ""} · ${formatDateTimeTz(s.reportedAt)}`
      : null,
    postCount: s._count.posts,
  });
  const shootRows = shoots.map(toShootRow);
  const awaitingShoots = shootRows.filter((s) => s.state === "awaiting-report");
  const upcomingShoots = shootRows.filter((s) => s.state === "upcoming");
  const reportedShoots = shootRows.filter((s) => s.state === "reported").reverse();

  // The post form links to shoots worth posting from: anything still live,
  // and what was reported recently — that's where finished cuts come from.
  const pickerSince = now.getTime() - SHOOT_PICKER_DAYS * 86_400_000;
  const shootOptions: ShootOption[] = shoots
    .filter((s) => !s.reportedAt || s.shootAt.getTime() >= pickerSince)
    .reverse()
    .map((s) => ({
      id: s.id,
      label: `${s.title} · ${relativeDayLabel(tashkentYmd(s.shootAt), todayYmd)}${
        s.reportedAt ? " · reported" : ""
      }`,
    }));

  // ----- Posts -----
  const toPostRow = (p: (typeof posts)[number]): PostRow => ({
    id: p.id,
    title: p.title,
    dateYmd: tashkentYmd(p.publishAt),
    timeHm: tashkentHm(p.publishAt),
    timeLabel: formatTimeTz(p.publishAt),
    dayLabel: relativeDayLabel(tashkentYmd(p.publishAt), todayYmd),
    state: postState(p, now),
    platforms: p.platforms.filter(isPostPlatform),
    caption: p.caption,
    postUrl: p.postUrl,
    shoot: p.shoot,
    publishedLabel: p.publishedAt ? `Marked published ${formatDateTimeTz(p.publishedAt)}` : null,
  });
  const postRows = posts.map(toPostRow);
  const overduePosts = postRows.filter((p) => p.state === "overdue");
  const scheduledPosts = postRows.filter((p) => p.state === "scheduled");
  const publishedPosts = postRows.filter((p) => p.state === "out").reverse();

  // ----- Tasks -----
  const toTaskRow = (t: (typeof tasks)[number]): TaskRow => {
    const dueYmd = t.dueOn ? toYmd(t.dueOn) : null;
    const done = t.completedAt != null;
    const mine = t.assignee.id === userId;
    const setByMe = t.createdById === userId;
    return {
      id: t.id,
      title: t.title,
      note: t.note,
      dueYmd,
      dueLabel: dueYmd ? inSentence(relativeDayLabel(dueYmd, todayYmd)) : null,
      due: taskDue(dueYmd, done, todayYmd),
      percent: t.percent,
      done,
      completedLabel: t.completedAt
        ? `done ${inSentence(relativeDayLabel(tashkentYmd(t.completedAt), todayYmd))}`
        : null,
      createdById: t.createdById,
      setterName: t.createdBy?.name ?? "Someone",
      assignee: toMember(t.assignee),
      canMove: access.manager || mine || setByMe,
      canEdit: access.manager || setByMe,
    };
  };
  const taskRows = tasks.map(toTaskRow);
  const openTasks = taskRows.filter((t) => !t.done);
  const doneTasks = taskRows
    .map((t, i) => ({ t, at: tasks[i].completedAt?.getTime() ?? 0 }))
    .filter((x) => x.t.done)
    .sort((a, b) => b.at - a.at)
    .map((x) => x.t);

  // ----- Overview -----
  const shootsThisWeek = upcomingShoots.filter((s) => s.dateYmd <= weekEndYmd);
  const nextShoot = upcomingShoots[0];
  const postsThisWeek = scheduledPosts.filter((p) => p.dateYmd <= weekEndYmd);
  const myOpen = access.member
    ? openTasks.filter((t) => t.assignee.id === userId)
    : openTasks;
  const myOverdue = myOpen.filter((t) => t.due === "overdue").length;
  const myToday = myOpen.filter((t) => t.due === "today").length;

  const tiles: {
    href: string;
    label: string;
    value: number;
    tone: "plain" | "warn" | "bad";
    sub: string;
  }[] = [
    {
      href: "#shoots",
      label: "Shoots · next 7 days",
      value: shootsThisWeek.length,
      tone: "plain",
      sub: nextShoot
        ? `Next: ${inSentence(nextShoot.dayLabel)}, ${nextShoot.timeLabel}`
        : "Nothing planned",
    },
    {
      href: "#shoots",
      label: "Waiting for Drive links",
      value: awaitingShoots.length,
      tone: awaitingShoots.length > 0 ? "warn" : "plain",
      sub: awaitingShoots.length > 0 ? "Filmed, report not filed" : "All reports filed",
    },
    {
      href: "#posts",
      label: "Posts · next 7 days",
      value: postsThisWeek.length,
      tone: overduePosts.length > 0 ? "bad" : "plain",
      sub:
        overduePosts.length > 0
          ? `${overduePosts.length} past time, not marked published`
          : "Nothing overdue",
    },
    {
      href: "#tasks",
      label: access.member ? "Tasks for you" : "Open tasks",
      value: myOpen.length,
      tone: myOverdue > 0 ? "bad" : myToday > 0 ? "warn" : "plain",
      sub:
        myOverdue > 0
          ? `${myOverdue} overdue`
          : myToday > 0
            ? `${myToday} due today`
            : "Nothing overdue",
    },
  ];
  const toneText = { plain: "text-ink", warn: "text-chart-warn", bad: "text-chart-bad" };

  return (
    <div
      data-readonly={viewOnly ? "" : undefined}
      className="mx-auto w-full max-w-6xl flex-1 px-4 py-8"
    >
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-widest text-brand">
            Marketing
          </div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Content plan</h1>
          <p className="mt-1 text-sm text-muted-fg">
            {viewOnly
              ? "View only: the marketing team runs this plan."
              : "Plan shoots, schedule posts and hand each other work."}{" "}
            All times are Tashkent time (GMT+5).
          </p>
        </div>
        <BackLink href="/dashboard" label="Dashboard" />
      </header>

      {memberViews.length === 0 && (
        <div className="mb-6 rounded-xl border border-chart-warn/50 bg-surface px-4 py-3 text-sm text-ink">
          Nobody is in the Marketing department yet, so there’s no one to assign
          shoots or tasks to.{" "}
          {access.manager && (
            <Link href="/departments" className="font-medium text-brand hover:underline">
              Add people on Departments
            </Link>
          )}
        </div>
      )}

      <nav
        aria-label="Content plan at a glance"
        className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        {tiles.map((t) => (
          <a
            key={t.label}
            href={t.href}
            className="group rounded-xl border border-line bg-surface px-4 py-3 transition hover:border-brand/40 hover:bg-canvas"
          >
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
              {t.label}
            </span>
            <span className={`mt-1 block text-2xl font-bold tabular-nums ${toneText[t.tone]}`}>
              {t.value}
            </span>
            <span
              className={`mt-0.5 block truncate text-xs ${
                t.tone === "plain" ? "text-muted-fg" : toneText[t.tone]
              }`}
            >
              {t.sub}
            </span>
          </a>
        ))}
      </nav>

      <div className="mb-10">
        <CalendarPanel
          shoots={shootRows}
          posts={postRows}
          tasks={taskRows}
          todayYmd={todayYmd}
          members={memberViews}
          shootOptions={shootOptions}
        />
      </div>

      <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-8">
        <ShootsPanel
          awaiting={awaitingShoots}
          upcoming={upcomingShoots}
          reported={reportedShoots}
          members={memberViews}
          todayYmd={todayYmd}
        />
        <PostsPanel
          overdue={overduePosts}
          scheduled={scheduledPosts}
          published={publishedPosts}
          shootOptions={shootOptions}
          todayYmd={todayYmd}
        />
      </div>

      <div className="mt-10">
        <TasksPanel
          open={openTasks}
          done={doneTasks}
          members={memberViews}
          currentUserId={userId}
          canBeAssigned={access.member}
        />
      </div>
    </div>
  );
}
