"use client";

import { useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "@/lib/actionResult";
import { PROGRAMS } from "@/lib/marketing";
import { XIcon } from "../../dashboard/_components/icons";

// The content plan's shared pieces — one set of field, button and row styles
// for all three panels, so a shoot, a post and a task read as one tool.

export type Member = { id: string; name: string; emoji: string; bg: string };

export const inputCls =
  "w-full min-w-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none disabled:opacity-60";
export const primaryBtn =
  "ro:hidden inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryBtn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-brand transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50";
export const ghostBtn =
  "inline-flex items-center justify-center rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-fg transition hover:bg-canvas hover:text-ink disabled:opacity-50";
export const iconBtn =
  "rounded-lg p-1.5 text-muted-fg transition hover:bg-canvas hover:text-ink disabled:opacity-50";
export const dangerIconBtn = `ro:hidden ${iconBtn} hover:bg-red-500/10 hover:text-red-600`;
export const addBtn =
  "ro:hidden inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-xs font-semibold text-muted-fg transition hover:border-brand hover:text-brand";
export const linkCls = "font-medium text-brand hover:underline";

/**
 * Runs a server action that returns an ActionResult, with pending + inline
 * error state. Catching here keeps a failure next to the control that caused
 * it (the global Toaster only sees rejections nobody handled).
 */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(fn: () => Promise<ActionResult>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onOk?.();
      } catch {
        setError("Couldn’t save that — check your connection and try again.");
      }
    });
  }
  return { pending, error, setError, run };
}

export function MemberChip({ m, muted = false }: { m: Member; muted?: boolean }) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${muted ? "text-muted-fg" : "text-ink"}`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${m.bg}`}
        aria-hidden="true"
      >
        {m.emoji}
      </span>
      <span className="truncate">{m.name}</span>
    </span>
  );
}

/** A labelled form field; the label sits above so it never disappears on typing. */
export function Field({
  label,
  optional = false,
  className = "",
  children,
}: {
  label: string;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
        {label}
        {optional && <span className="font-normal normal-case tracking-normal"> · optional</span>}
      </span>
      {children}
    </label>
  );
}

/** Which program the row is for: a select shared by all three forms. */
export function ProgramField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Program" optional>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        <option value="">No program</option>
        {PROGRAMS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The program a row is tagged with, beside its title. */
export function ProgramTag({ program }: { program: string | null }) {
  if (!program) return null;
  return (
    <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium text-muted-fg">
      {program}
    </span>
  );
}

/** A state word with its dot — the same mark the daily-report lists use. */
export function StatePill({
  label,
  dot,
  text,
}: {
  label: string;
  dot: string;
  text: string;
}) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs font-medium text-red-600">
      {children}
    </p>
  );
}

/** The inline "are you sure" strip for destructive actions. */
export function ConfirmBar({
  message,
  detail,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  message: string;
  detail?: string | null;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rise-in mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-red-600">{message}</span>
        {detail && <span className="block text-muted-fg">{detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="rounded-lg bg-red-500 px-2.5 py-1 font-semibold text-white transition hover:bg-red-600 disabled:opacity-50"
        >
          {pending ? "Working…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Keep it"
          title="Keep it"
          className="rounded-lg p-1 text-muted-fg transition hover:text-ink"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

/** A panel's title row: heading, one-line purpose, and its primary add button. */
export function PanelHeader({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3 px-1">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-fg">{hint}</p>
      </div>
      {children}
    </div>
  );
}

/** The small uppercase label over a group of rows ("Today", "Needs a report"). */
export function GroupLabel({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warn" | "bad";
}) {
  const color =
    tone === "warn" ? "text-chart-warn" : tone === "bad" ? "text-chart-bad" : "text-muted-fg";
  return (
    <h3 className={`mb-1.5 mt-4 px-1 text-[11px] font-semibold uppercase tracking-wide first:mt-0 ${color}`}>
      {children}
    </h3>
  );
}

export function RowList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {children}
    </ul>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted-fg">
      {children}
    </div>
  );
}

/**
 * A row's free-text note (a shoot's brief, a task's detail), held to three
 * lines so one long brief can't stretch a whole list. "Show more" appears only
 * when the text actually runs past the clamp.
 */
export function ClampedNote({ children }: { children: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children, open]);

  return (
    <div className="mt-1.5 text-xs text-muted-fg">
      <p ref={ref} className={`whitespace-pre-wrap break-words${open ? "" : " line-clamp-3"}`}>
        {children}
      </p>
      {(overflows || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="mt-0.5 font-medium text-ink/70 hover:text-ink hover:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * A collapsible history list (reported shoots, published posts, done tasks):
 * closed by default, searchable once it's long, and paged so years of rows
 * never render at once.
 */
export function Archive<T extends { id: string }>({
  label,
  items,
  searchText,
  render,
  pageSize = 10,
}: {
  label: string;
  items: T[];
  searchText: (item: T) => string;
  render: (item: T) => ReactNode;
  pageSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(pageSize);
  if (items.length === 0) return null;

  const needle = q.trim().toLowerCase();
  const matches = needle
    ? items.filter((i) => searchText(i).toLowerCase().includes(needle))
    : items;
  const visible = matches.slice(0, shown);

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-fg transition hover:text-ink"
      >
        <span
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          ›
        </span>
        {label}
        <span className="rounded-full bg-canvas px-1.5 py-0.5 text-[10px] tabular-nums">
          {items.length}
        </span>
      </button>
      {open && (
        <div className="rise-in mt-1.5">
          {items.length > pageSize && (
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setShown(pageSize);
              }}
              placeholder="Search by title…"
              aria-label={`Search ${label.toLowerCase()}`}
              className={`${inputCls} mb-2`}
            />
          )}
          {visible.length > 0 ? (
            <RowList>{visible.map(render)}</RowList>
          ) : (
            <EmptyState>Nothing matches “{q.trim()}”.</EmptyState>
          )}
          {matches.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + pageSize)}
              className={`${ghostBtn} mt-1.5 w-full`}
            >
              Show {Math.min(pageSize, matches.length - shown)} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Rows grouped under their day heading, in the order they arrive. */
export function byDay<T extends { dayLabel: string }>(rows: T[]) {
  const groups: { label: string; rows: T[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last?.label === r.dayLabel) last.rows.push(r);
    else groups.push({ label: r.dayLabel, rows: [r] });
  }
  return groups;
}

/**
 * A row's left-hand clock: just the time under a day heading, or the day over
 * the time for rows outside the day grouping (overdue, archive).
 */
export function RowClock({
  clock,
  dayLabel,
  timeLabel,
}: {
  clock: "time" | "when";
  dayLabel: string;
  timeLabel: string;
}) {
  return (
    <div className="w-[4.75rem] shrink-0 pt-0.5 text-xs tabular-nums">
      {clock === "when" && (
        <span className="block font-semibold text-ink">{dayLabel}</span>
      )}
      <span
        className={`block ${clock === "when" ? "text-muted-fg" : "font-semibold text-ink"}`}
      >
        {timeLabel}
      </span>
    </div>
  );
}

/**
 * Options for an assignee picker: the roster, plus the current assignee if
 * they've since left the department — otherwise the select would silently
 * show someone else (or "Unassigned") and saving would reassign the row.
 */
export function assigneeOptions(members: Member[], current: Member | null) {
  if (!current || members.some((m) => m.id === current.id)) return members;
  return [{ ...current, name: `${current.name} (left marketing)` }, ...members];
}
