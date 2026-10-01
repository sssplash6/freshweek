"use client";

import { useRef, useState } from "react";
import {
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "../../dashboard/_components/icons";
import { MAX_TASK_NOTE, MAX_TASK_TITLE, type TaskDue } from "@/lib/marketing";
import {
  delegateTask,
  deleteTask,
  setTaskDone,
  setTaskProgress,
  updateTask,
} from "../actions";
import {
  addBtn,
  Archive,
  assigneeOptions,
  ConfirmBar,
  dangerIconBtn,
  EmptyState,
  ErrorText,
  Field,
  ghostBtn,
  iconBtn,
  inputCls,
  linkCls,
  type Member,
  MemberChip,
  PanelHeader,
  primaryBtn,
  RowList,
  useAction,
} from "./ui";

export type TaskRow = {
  id: string;
  title: string;
  note: string | null;
  dueYmd: string | null;
  dueLabel: string | null;
  due: TaskDue;
  percent: number;
  done: boolean;
  completedLabel: string | null;
  createdById: string | null;
  setterName: string;
  assignee: Member;
  /** Setter or assignee (or a manager): may move progress / mark done. */
  canMove: boolean;
  /** Setter (or a manager): may edit and withdraw. */
  canEdit: boolean;
};

type TaskValues = {
  title: string;
  note: string | null;
  dueOn: string | null;
  assigneeId: string;
};

export function TaskForm({
  members,
  initial,
  defaultDue,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  members: Member[];
  initial?: TaskRow;
  /** Pre-filled due date for a fresh task — the day picked on the calendar. */
  defaultDue?: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (v: TaskValues) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [assigneeId, setAssigneeId] = useState(initial?.assignee.id ?? "");
  const [dueOn, setDueOn] = useState(initial?.dueYmd ?? defaultDue ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const ready = title.trim() !== "" && assigneeId !== "";
  const options = assigneeOptions(members, initial?.assignee ?? null);

  return (
    <form
      className="rise-in flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || pending) return;
        onSubmit({ title, note: note.trim() || null, dueOn: dueOn || null, assigneeId });
      }}
    >
      <Field label="What needs doing?">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Edit the open day reel"
          maxLength={MAX_TASK_TITLE}
          autoFocus
          required
          className={inputCls}
        />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Who does it">
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            required
            className={inputCls}
          >
            <option value="" disabled>
              Pick a teammate…
            </option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due" optional>
          <input
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>
      <Field label="Details" optional>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Links, specs, what “done” looks like"
          maxLength={MAX_TASK_NOTE}
          rows={2}
          className={`${inputCls} resize-y`}
        />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={ghostBtn}>
          Cancel
        </button>
        <button type="submit" disabled={pending || !ready} className={primaryBtn}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * The honest-percent control: a range input that commits on release (not on
 * every drag tick, or each percent would write a row). The last committed
 * value is remembered so release + blur don't send the same number twice.
 */
function ProgressControl({
  task,
  onCommit,
  pending,
}: {
  task: TaskRow;
  onCommit: (percent: number) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState(task.percent);
  const sent = useRef(task.percent);
  const commit = () => {
    if (value === sent.current) return;
    sent.current = value;
    onCommit(value);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        disabled={pending}
        onChange={(e) => setValue(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={(e) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key))
            commit();
        }}
        onBlur={commit}
        aria-label={`Progress on ${task.title}`}
        aria-valuetext={`${value}%`}
        className="h-1.5 w-32 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-accent-ink">
        {value}%
      </span>
    </div>
  );
}

/** Read-only progress for people outside the pair. */
function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-accent-ink">
        {percent}%
      </span>
    </div>
  );
}

const DUE_TEXT: Record<TaskDue, string> = {
  overdue: "font-semibold text-chart-bad",
  today: "font-semibold text-chart-warn",
  later: "text-muted-fg",
  none: "text-muted-fg",
};

function TaskItem({ task, members }: { task: TaskRow; members: Member[] }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const { pending, error, setError, run } = useAction();
  const toggle = (m: typeof mode) => {
    setError(null);
    setMode(mode === m ? "view" : m);
  };
  const done = () => setMode("view");

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        {task.canMove ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => setTaskDone(task.id, !task.done))}
            title={task.done ? "Reopen" : "Mark done"}
            aria-label={task.done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
            aria-pressed={task.done}
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] transition disabled:opacity-50 ${
              task.done
                ? "border-chart-good bg-chart-good text-white"
                : "border-muted-fg text-transparent hover:border-chart-good hover:text-chart-good"
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-6.5" />
            </svg>
          </button>
        ) : (
          <span
            className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border-[1.5px] ${
              task.done ? "border-chart-good bg-chart-good" : "border-line"
            }`}
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={`break-words text-sm font-semibold ${
                task.done ? "text-muted-fg line-through decoration-muted-fg/40" : "text-ink"
              }`}
            >
              {task.title}
            </span>
            {task.dueLabel && !task.done && (
              <span className={`text-xs ${DUE_TEXT[task.due]}`}>
                {task.due === "overdue"
                  ? `Overdue · was due ${task.dueLabel}`
                  : task.due === "today"
                    ? "Due today"
                    : `Due ${task.dueLabel}`}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-fg">
            <span>{task.setterName}</span>
            <span aria-hidden="true">→</span>
            <span className="sr-only">handed to</span>
            <MemberChip m={task.assignee} />
            {task.completedLabel && <span>· {task.completedLabel}</span>}
          </div>
          {task.note && mode !== "edit" && (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-muted-fg">
              {task.note}
            </p>
          )}
          {!task.done && (
            <div className="mt-2">
              {task.canMove ? (
                <ProgressControl
                  // Remount on a server-side change (done → 100, reopen → 90)
                  // so the slider never shows a stale local value.
                  key={task.percent}
                  task={task}
                  pending={pending}
                  onCommit={(p) => run(() => setTaskProgress(task.id, p))}
                />
              ) : (
                <ProgressBar percent={task.percent} />
              )}
            </div>
          )}
        </div>
        {task.canEdit && (
          <span className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => toggle("edit")}
              title="Edit task"
              aria-label={`Edit ${task.title}`}
              aria-expanded={mode === "edit"}
              className={`${iconBtn} ${mode === "edit" ? "bg-canvas text-ink" : ""}`}
            >
              <PencilIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => toggle("delete")}
              title="Withdraw task"
              aria-label={`Withdraw ${task.title}`}
              className={dangerIconBtn}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </span>
        )}
      </div>

      {mode === "edit" && (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
          <TaskForm
            members={members}
            initial={task}
            submitLabel="Save changes"
            pending={pending}
            error={error}
            onCancel={done}
            onSubmit={(v) => run(() => updateTask(task.id, v), done)}
          />
        </div>
      )}

      {mode === "delete" && (
        <ConfirmBar
          message={`Withdraw “${task.title}”?`}
          detail={`It disappears for ${task.assignee.name} too.`}
          confirmLabel="Withdraw"
          pending={pending}
          onConfirm={() => run(() => deleteTask(task.id), done)}
          onCancel={done}
        />
      )}

      {error && mode !== "edit" && (
        <div className="mt-1.5">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </li>
  );
}

type Filter = "mine" | "set" | "all";

export function TasksPanel({
  open,
  done,
  members,
  currentUserId,
  canBeAssigned,
}: {
  open: TaskRow[];
  done: TaskRow[];
  members: Member[];
  currentUserId: string;
  /** False for an admin outside the department — "Mine" is meaningless then. */
  canBeAssigned: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const { pending, error, setError, run } = useAction();

  const isMine = (t: TaskRow) => t.assignee.id === currentUserId;
  const isSet = (t: TaskRow) => t.createdById === currentUserId;
  const counts = {
    mine: open.filter(isMine).length,
    set: open.filter(isSet).length,
    all: open.length,
  };
  const [filter, setFilter] = useState<Filter>(
    canBeAssigned && counts.mine > 0 ? "mine" : "all",
  );
  const pick = (f: Filter) => (f === "mine" ? isMine : f === "set" ? isSet : () => true);
  const shownOpen = open.filter(pick(filter));
  const shownDone = done.filter(pick(filter));

  const tabs: { id: Filter; label: string }[] = [
    ...(canBeAssigned ? [{ id: "mine" as const, label: "For me" }] : []),
    { id: "set", label: "Set by me" },
    { id: "all", label: "Everyone" },
  ];

  return (
    <section id="tasks" className="scroll-mt-6">
      <PanelHeader
        title="Team tasks"
        hint="Work you hand each other. Separate from your weekly goals — it doesn’t count toward them."
      >
        {!composing && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setComposing(true);
            }}
            className={addBtn}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Hand over a task
          </button>
        )}
      </PanelHeader>

      {composing && (
        <div className="mb-4 rounded-xl border border-line bg-surface p-4 shadow-sm">
          <TaskForm
            members={members}
            submitLabel="Hand it over"
            pending={pending}
            error={error}
            onCancel={() => setComposing(false)}
            onSubmit={(v) =>
              run(
                () => delegateTask(v),
                () => {
                  setComposing(false);
                  // Keep the new task in view: one handed to someone else
                  // wouldn't show under "For me".
                  if (filter === "mine" && v.assigneeId !== currentUserId) setFilter("set");
                },
              )
            }
          />
        </div>
      )}

      <div
        role="group"
        aria-label="Show tasks"
        className="mb-2 inline-flex rounded-lg border border-line bg-surface p-0.5"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={filter === t.id}
            onClick={() => setFilter(t.id)}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              filter === t.id ? "bg-brand-soft text-brand" : "text-muted-fg hover:text-ink"
            }`}
          >
            {t.label}
            <span className="ms-1 tabular-nums opacity-70">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {shownOpen.length > 0 ? (
        <RowList>
          {shownOpen.map((t) => (
            <TaskItem key={t.id} task={t} members={members} />
          ))}
        </RowList>
      ) : (
        !composing && (
          <EmptyState>
            {filter === "mine"
              ? "Nothing on your plate from the team."
              : filter === "set"
                ? "You haven’t handed anything over."
                : "No open tasks."}{" "}
            <button type="button" onClick={() => setComposing(true)} className={linkCls}>
              Hand over a task
            </button>
          </EmptyState>
        )
      )}

      <Archive
        key={filter}
        label="Done"
        items={shownDone}
        searchText={(t) => `${t.title} ${t.assignee.name} ${t.setterName}`}
        render={(t) => <TaskItem key={t.id} task={t} members={members} />}
      />
    </section>
  );
}
