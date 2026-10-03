"use client";

import { useEffect, useMemo, useState } from "react";
import { formatYmd, parseYmd, toYmd } from "@/lib/dates";
import { dayLabel } from "@/lib/dailyReportTypes";
import { addDaysYmd } from "@/lib/marketing";
import { ChevronIcon, PlusIcon } from "../../dashboard/_components/icons";
import { delegateTask, planShoot, schedulePost } from "../actions";
import { PostForm, PostItem, type PostRow, type ShootOption } from "./PostsPanel";
import { ShootForm, ShootItem, type ShootRow } from "./ShootsPanel";
import { TaskForm, TaskItem, type TaskRow } from "./TasksPanel";
import {
  addBtn,
  iconBtn,
  type Member,
  PanelHeader,
  secondaryBtn,
  useAction,
} from "./ui";

// The whole department's month on one grid — shoots, posts and task deadlines
// side by side, like the shared Google Calendar the team kept before. Weeks
// start Monday (the getWeekBounds convention in lib/weeks.ts). Chip colors
// identify the KIND of work — the guide document hues, which carry no state
// meaning per the palette semantics in globals.css — and only flip to a state
// color (warn/bad) when the row needs attention, matching the StatePill rules
// the lists below use. The selected day sits on top of the grid like a
// calendar app's day card: click anywhere on a cell and the card lists what's
// on it — the same interactive rows the panels below use, so a shoot's
// report form, a post's publish button and a task's progress all work right
// there — plus the three things you can add on that date, each form opening
// in the card with the date pre-filled. Clicking a chip goes further: it
// selects the day AND spotlights that row, scrolling it into view.

type CalItem =
  | { kind: "shoot"; row: ShootRow }
  | { kind: "post"; row: PostRow }
  | { kind: "task"; row: TaskRow };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS = 3;

/** The Monday-first week rows covering a "YYYY-MM" month (prev/next overflow). */
function monthWeeks(monthKey: string): string[][] {
  const first = parseYmd(`${monthKey}-01`);
  if (!first) return [];
  const lastYmd = addDaysYmd(
    toYmd(
      new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1),
      ),
    ),
    -1,
  );
  // Days between Monday and the 1st — the week's offset into the month.
  let cursor = addDaysYmd(`${monthKey}-01`, -((first.getUTCDay() + 6) % 7));
  const weeks: string[][] = [];
  while (cursor <= lastYmd) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDaysYmd(cursor, i)));
    cursor = addDaysYmd(cursor, 7);
  }
  return weeks;
}

function shiftMonth(monthKey: string, delta: number): string {
  const d = parseYmd(`${monthKey}-01`)!;
  return toYmd(
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)),
  ).slice(0, 7);
}

function monthName(monthKey: string): string {
  const d = parseYmd(`${monthKey}-01`)!;
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Timed rows first (by their Tashkent clock), then date-only tasks. */
function sortDayItems(items: CalItem[]) {
  const timeOf = (i: CalItem) => (i.kind === "task" ? "99:99" : i.row.timeHm);
  items.sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}

/**
 * Chip color = kind, unless the row needs attention — then it takes the state
 * color instead (attention beats type, same as the lists' StatePill). Done,
 * published and reported rows wash out to the muted slot: they happened.
 */
function chipCls(item: CalItem): string {
  switch (item.kind) {
    case "shoot":
      if (item.row.state === "awaiting-report")
        return "bg-chart-warn/15 text-chart-warn";
      return item.row.state === "reported"
        ? "bg-canvas text-muted-fg"
        : "bg-guide-indigo-soft text-guide-indigo-ink";
    case "post":
      if (item.row.state === "overdue") return "bg-chart-bad/10 text-chart-bad";
      return item.row.state === "out"
        ? "bg-canvas text-muted-fg"
        : "bg-guide-plum-soft text-guide-plum-ink";
    case "task":
      if (item.row.done) return "bg-canvas text-muted-fg";
      return item.row.due === "overdue"
        ? "bg-chart-bad/10 text-chart-bad"
        : "bg-guide-olive-soft text-guide-olive-ink";
  }
}

/** The type dot in the legend — the same hue the chip carries. */
const DOT_CLS: Record<CalItem["kind"], string> = {
  shoot: "bg-guide-indigo-ink",
  post: "bg-guide-plum-ink",
  task: "bg-guide-olive-ink",
};

const KIND_LABEL: Record<CalItem["kind"], string> = {
  shoot: "Shoot",
  post: "Post",
  task: "Task due",
};

/** The day card's "add" row — the same three verbs the panels' buttons use. */
const ADD_LABEL: Record<CalItem["kind"], string> = {
  shoot: "Plan a shoot",
  post: "Schedule a post",
  task: "Hand over a task",
};

/** One-line chip text — time first so a busy day still scans by the clock. */
function chipText(item: CalItem): string {
  if (item.kind === "task") {
    return `${item.row.assignee.emoji} ${item.row.title}`;
  }
  const who = item.kind === "shoot" && item.row.assignee ? `${item.row.assignee.emoji} ` : "";
  return `${item.row.timeHm} ${who}${item.row.title}`;
}

/**
 * The clicked day's card, pinned above the grid: its items — the same
 * interactive rows the panels below render, so everything that can be done
 * to a shoot, post or task works here too — then the three things that can
 * land on the day. Picking an action unfolds that form in place — Google
 * Calendar's click-a-day popover, flattened into the card. A chip click
 * arrives as openKey: that row is tinted and scrolled into view.
 */
function DayAgenda({
  items,
  ymd,
  todayYmd,
  members,
  shootOptions,
  openKey,
}: {
  items: CalItem[];
  ymd: string;
  todayYmd: string;
  members: Member[];
  shootOptions: ShootOption[];
  openKey: string | null;
}) {
  const [composing, setComposing] = useState<CalItem["kind"] | null>(null);
  const { pending, error, setError, run } = useAction();
  const open = (kind: CalItem["kind"]) => {
    setError(null);
    setComposing(kind);
  };
  const close = () => setComposing(null);
  const dateLabel = dayLabel(ymd, Number(todayYmd.slice(0, 4)));

  // Bring the clicked chip's row into view — on a crowded day it can sit
  // above the fold of the card.
  useEffect(() => {
    if (!openKey) return;
    document
      .getElementById(`cal-${openKey}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [openKey]);

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-line bg-surface">
      <h3 className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
        <span className="text-sm font-semibold text-ink">{dateLabel}</span>
        {ymd === todayYmd && (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">
            Today
          </span>
        )}
        {items.length > 0 && (
          <span className="ms-auto text-xs font-normal text-muted-fg">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        )}
      </h3>
      {items.length === 0 ? (
        <p className="px-4 py-5 text-center text-sm text-muted-fg">
          Nothing on this day.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const key = `${item.kind}-${item.row.id}`;
            const spotlight = {
              id: `cal-${key}`,
              highlighted: key === openKey,
            };
            switch (item.kind) {
              case "shoot":
                return (
                  <ShootItem
                    key={key}
                    {...spotlight}
                    shoot={item.row}
                    members={members}
                    clock="time"
                  />
                );
              case "post":
                return (
                  <PostItem
                    key={key}
                    {...spotlight}
                    post={item.row}
                    shootOptions={shootOptions}
                    clock="time"
                  />
                );
              case "task":
                return (
                  <TaskItem
                    key={key}
                    {...spotlight}
                    task={item.row}
                    members={members}
                  />
                );
            }
          })}
        </ul>
      )}
      {composing === null ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-canvas/50 px-3 py-2">
          {(Object.keys(ADD_LABEL) as CalItem["kind"][]).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => open(kind)}
              className={addBtn}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {ADD_LABEL[kind]}
            </button>
          ))}
        </div>
      ) : (
        <div className="border-t border-line bg-canvas/50 px-4 py-3">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
            {ADD_LABEL[composing]} · {dateLabel}
          </p>
          {composing === "shoot" && (
            <ShootForm
              members={members}
              defaultDate={ymd}
              submitLabel="Add to calendar"
              pending={pending}
              error={error}
              onCancel={close}
              onSubmit={(v) => run(() => planShoot(v), close)}
            />
          )}
          {composing === "post" && (
            <PostForm
              shootOptions={shootOptions}
              defaultDate={ymd}
              submitLabel="Add to calendar"
              pending={pending}
              error={error}
              onCancel={close}
              onSubmit={(v) => run(() => schedulePost(v), close)}
            />
          )}
          {composing === "task" && (
            <TaskForm
              members={members}
              defaultDue={ymd}
              submitLabel="Hand it over"
              pending={pending}
              error={error}
              onCancel={close}
              onSubmit={(v) => run(() => delegateTask(v), close)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function CalendarPanel({
  shoots,
  posts,
  tasks,
  todayYmd,
  members,
  shootOptions,
}: {
  shoots: ShootRow[];
  posts: PostRow[];
  tasks: TaskRow[];
  todayYmd: string;
  members: Member[];
  shootOptions: ShootOption[];
}) {
  const [month, setMonth] = useState(todayYmd.slice(0, 7));
  const [selected, setSelected] = useState(todayYmd);
  /** The chip last clicked — its row is spotlighted in the day card. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const select = (ymd: string, key: string | null = null) => {
    setSelected(ymd);
    setOpenKey(key);
  };

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalItem[]>();
    const push = (ymd: string, item: CalItem) => {
      const arr = map.get(ymd) ?? [];
      arr.push(item);
      map.set(ymd, arr);
    };
    for (const s of shoots) push(s.dateYmd, { kind: "shoot", row: s });
    for (const p of posts) push(p.dateYmd, { kind: "post", row: p });
    for (const t of tasks) if (t.dueYmd) push(t.dueYmd, { kind: "task", row: t });
    for (const items of map.values()) sortDayItems(items);
    return map;
  }, [shoots, posts, tasks]);

  const weeks = useMemo(() => monthWeeks(month), [month]);
  const onThisMonth = month === todayYmd.slice(0, 7);
  const selectedItems = itemsByDay.get(selected) ?? [];

  return (
    <section id="calendar" className="scroll-mt-6">
      <PanelHeader
        title="Calendar"
        hint="The whole department's month at a glance — shoots, posts and task deadlines together."
      />

      <DayAgenda
        key={selected}
        items={selectedItems}
        ymd={selected}
        todayYmd={todayYmd}
        members={members}
        shootOptions={shootOptions}
        openKey={openKey}
      />

      <div className="mb-2 flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
          aria-label="Previous month"
          className={iconBtn}
        >
          <ChevronIcon className="h-4 w-4 rotate-180" />
        </button>
        <h3 className="min-w-36 text-center text-sm font-semibold text-ink">
          {monthName(month)}
        </h3>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          aria-label="Next month"
          className={iconBtn}
        >
          <ChevronIcon className="h-4 w-4" />
        </button>
        {!onThisMonth && (
          <button
            type="button"
            onClick={() => {
              setMonth(todayYmd.slice(0, 7));
              select(todayYmd);
            }}
            className={`${secondaryBtn} ms-1`}
          >
            Today
          </button>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-3">
          {(Object.keys(DOT_CLS) as CalItem["kind"][]).map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-fg"
            >
              <span className={`h-2 w-2 rounded-full ${DOT_CLS[k]}`} />
              {KIND_LABEL[k]}
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <div className="grid grid-cols-7 gap-px bg-line">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="bg-surface px-1.5 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-fg"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px border-t border-line bg-line">
          {weeks.flat().map((ymd) => {
            const inMonth = ymd.startsWith(month);
            const items = itemsByDay.get(ymd) ?? [];
            const isToday = ymd === todayYmd;
            const isSelected = ymd === selected;
            const dayNum = Number(ymd.slice(8));
            return (
              // The whole cell is the click target — the number button stays
              // for keyboard users. Chips stop the bubble: their click selects
              // the day AND opens that item, not just the day.
              <div
                key={ymd}
                onClick={() => select(ymd)}
                className={`flex min-h-[4.5rem] cursor-pointer flex-col gap-0.5 p-1 transition sm:min-h-24 sm:p-1.5 ${
                  isSelected
                    ? "bg-brand-soft/60"
                    : inMonth
                      ? "bg-surface hover:bg-canvas"
                      : "bg-canvas/60 hover:bg-canvas"
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    select(ymd);
                  }}
                  aria-label={`${dayLabel(ymd)} — ${items.length === 0 ? "nothing planned" : `${items.length} items`}`}
                  aria-pressed={isSelected}
                  className={`flex h-6 min-w-6 items-center justify-center self-start rounded-full px-1 text-[11px] font-semibold tabular-nums ${
                    isToday
                      ? "bg-brand text-white"
                      : isSelected
                        ? "text-brand"
                        : inMonth
                          ? "text-ink hover:bg-canvas"
                          : "text-muted-fg hover:bg-surface"
                  }`}
                >
                  {dayNum === 1 ? formatYmd(ymd) : dayNum}
                </button>
                {items.slice(0, MAX_CHIPS).map((item) => (
                  <button
                    key={`${item.kind}-${item.row.id}`}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      select(ymd, `${item.kind}-${item.row.id}`);
                    }}
                    title={chipText(item)}
                    className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium leading-4 transition hover:brightness-95 ${chipCls(item)}`}
                  >
                    {chipText(item)}
                  </button>
                ))}
                {items.length > MAX_CHIPS && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      select(ymd);
                    }}
                    className="px-1.5 text-left text-[11px] font-medium text-muted-fg transition hover:text-ink"
                  >
                    +{items.length - MAX_CHIPS} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
