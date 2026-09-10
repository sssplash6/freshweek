"use client";

import { useState } from "react";
import { EditAssignedTask } from "./EditAssignedTask";

export type AssignedByMeItem = {
  id: string;
  title: string;
  recipient: string;
  emoji: string;
  bg: string;
  scope: "WEEKLY" | "MONTHLY";
  deadlineLabel: string | null;
  deadline: string | null; // YYYY-MM-DD, for the edit form
  note: string | null;
  done: boolean;
};

type Group = {
  recipient: string;
  emoji: string;
  bg: string;
  pending: AssignedByMeItem[];
  done: AssignedByMeItem[];
};

/**
 * The goals the signed-in user has assigned to others, one dropdown per
 * person (the daily-reports accordion pattern): the header states who and how
 * much is still pending, their tasks expand in place, and each person's
 * completed pile sits behind its own disclosure. People with pending goals come
 * first, so the ones who are all done drop below them. Only people who have been
 * assigned something appear; renders nothing when nobody has.
 */
export function AssignedByMe({ items }: { items: AssignedByMeItem[] }) {
  const [open, setOpen] = useState<string[]>([]);
  const [showDone, setShowDone] = useState<string[]>([]);

  if (items.length === 0) return null;

  const pendingTotal = items.filter((i) => !i.done).length;
  const groups: Group[] = [];
  const byRecipient = new Map<string, Group>();
  for (const item of items) {
    let g = byRecipient.get(item.recipient);
    if (!g) {
      g = {
        recipient: item.recipient,
        emoji: item.emoji,
        bg: item.bg,
        pending: [],
        done: [],
      };
      byRecipient.set(item.recipient, g);
      groups.push(g);
    }
    (item.done ? g.done : g.pending).push(item);
  }

  // Whoever still owes something sits at the top; the people who have finished
  // everything sink to the bottom. The sort is stable, so each half keeps the
  // order the goals came in.
  groups.sort(
    (a, b) => Number(b.pending.length > 0) - Number(a.pending.length > 0),
  );

  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">Assigned by you</p>
        {pendingTotal > 0 && (
          <span className="text-[11px] font-medium text-muted-fg">
            {pendingTotal} pending
          </span>
        )}
      </div>

      <div className="mt-1">
        {groups.map((g) => {
          const isOpen = open.includes(g.recipient);
          const doneOpen = showDone.includes(g.recipient);
          return (
            <div
              key={g.recipient}
              className="border-t border-line py-2.5 first:border-t-0 first:pt-2"
            >
              <button
                type="button"
                onClick={() => toggle(open, setOpen, g.recipient)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-2.5"
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line text-sm ${g.bg}`}
                  aria-hidden="true"
                >
                  {g.emoji}
                </span>
                <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink">
                  {g.recipient}
                </span>
                <span
                  className={`shrink-0 text-[11px] font-medium ${
                    g.pending.length > 0 ? "text-muted-fg" : "text-green-700"
                  }`}
                >
                  {g.pending.length > 0
                    ? `${g.pending.length} pending`
                    : "all done"}
                </span>
                <Chevron open={isOpen} />
              </button>

              {isOpen && (
                <div className="rise-in mt-1 pl-1.5">
                  {g.pending.length > 0 && (
                    <ul className="flex flex-col">
                      {g.pending.map((t) => (
                        <TaskRow key={t.id} task={t} />
                      ))}
                    </ul>
                  )}
                  {g.done.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          toggle(showDone, setShowDone, g.recipient)
                        }
                        aria-expanded={doneOpen}
                        className={`flex w-full items-center gap-1.5 text-left text-[11px] font-medium text-muted-fg transition hover:text-ink ${
                          g.pending.length > 0
                            ? "mt-2 border-t border-line pt-2"
                            : "mt-1"
                        }`}
                      >
                        <Chevron open={doneOpen} />
                        {`Completed (${g.done.length})`}
                      </button>
                      {doneOpen && (
                        <ul className="rise-in flex flex-col">
                          {g.done.map((t) => (
                            <TaskRow key={t.id} task={t} />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskRow({ task: t }: { task: AssignedByMeItem }) {
  const meta = [
    t.deadlineLabel ? `due ${t.deadlineLabel}` : null,
    t.scope === "MONTHLY" ? "monthly" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="border-t border-line py-2 first:border-t-0">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`min-w-0 text-xs font-medium ${
            t.done ? "text-muted-fg line-through" : "text-ink"
          }`}
        >
          {t.title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={`text-[11px] font-semibold ${
              t.done ? "text-green-700" : "text-muted-fg"
            }`}
          >
            {t.done ? "Done" : "Pending"}
          </span>
          <EditAssignedTask
            task={{
              id: t.id,
              title: t.title,
              note: t.note,
              deadline: t.deadline,
              scope: t.scope,
              recipientName: t.recipient,
            }}
          />
        </span>
      </div>
      {meta && <p className="mt-0.5 text-[11px] text-muted-fg">{meta}</p>}
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 transition-transform ${
        open ? "rotate-90" : ""
      }`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
