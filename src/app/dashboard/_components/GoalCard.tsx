"use client";

import {
  useEffect,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { clampPercent, subtaskPercent } from "@/lib/progress";
import type { ActionResult } from "@/lib/actionResult";
import { formatStamp } from "@/lib/dates";
import { useDismissible } from "@/lib/useDismissible";
import {
  addSubtask,
  deleteGoal,
  deleteSubtask,
  renameGoal,
  renameSubtask,
  setGoalCompleted,
  setGoalDeadline,
  setGoalPercent,
  setGoalPriority,
  shareGoal,
  shareSubtask,
  toggleSubtask,
} from "../actions";
import {
  PRIORITY_LABEL,
  PRIORITY_TEXT,
  type Priority,
} from "@/lib/priority";
import {
  CalendarIcon,
  CheckCircleIcon,
  ChevronIcon,
  FlagIcon,
  ShareIcon,
  TrashIcon,
} from "./icons";
import { DeadlinePicker } from "./DeadlinePicker";
import { PriorityPicker } from "./PriorityPicker";
import { CONTROL_PILL } from "./controlPill";

export type SubtaskView = {
  id: string;
  title: string;
  isDone: boolean;
  sharedTo: string[];
  receivedFrom: string | null;
};

// Exported so the archive's edit-week modal can render the same cards.
export type GoalView = {
  id: string;
  title: string;
  completed: boolean;
  deadline: string | null;
  priority: Priority | null;
  manualPercent: number | null;
  sharedTo: string[];
  receivedFrom: string | null;
  subtasks: SubtaskView[];
};

export type TeamMember = { id: string; name: string };

type OptAction =
  | { type: "toggle"; id: string; isDone: boolean }
  | { type: "add"; id: string; title: string }
  | { type: "rename"; id: string; title: string }
  | { type: "delete"; id: string };

export function GoalCard({
  goal,
  index,
  team,
  todayYmd,
  nowStamp,
  locked,
}: {
  goal: GoalView;
  index: number;
  team: TeamMember[];
  todayYmd: string;
  nowStamp: string;
  locked: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [confirmComplete, setConfirmComplete] = useState(false);
  // The completion rate typed in the confirm prompt (0–100). Seeded to 100 when
  // the prompt opens; committed as the goal's percent on confirm.
  const [completeRate, setCompleteRate] = useState("100");
  const [completed, applyCompleted] = useOptimistic(
    goal.completed,
    (_state: boolean, next: boolean) => next,
  );
  const [deadline, applyDeadline] = useOptimistic(
    goal.deadline,
    (_state: string | null, next: string | null) => next,
  );
  const [priority, applyPriority] = useOptimistic(
    goal.priority,
    (_state: Priority | null, next: Priority | null) => next,
  );
  const [manualPercent, applyManualPercent] = useOptimistic(
    goal.manualPercent,
    (_state: number | null, next: number | null) => next,
  );
  const [subtasks, applyOptimistic] = useOptimistic(
    goal.subtasks,
    (state: SubtaskView[], action: OptAction) => {
      switch (action.type) {
        case "toggle":
          return state.map((s) =>
            s.id === action.id ? { ...s, isDone: action.isDone } : s,
          );
        case "add":
          return [
            ...state,
            {
              id: action.id,
              title: action.title,
              isDone: false,
              sharedTo: [],
              receivedFrom: null,
            },
          ];
        case "rename":
          return state.map((s) =>
            s.id === action.id ? { ...s, title: action.title } : s,
          );
        case "delete":
          return state.filter((s) => s.id !== action.id);
      }
    },
  );

  // A manual/completion rate always wins; otherwise a completed goal reads 100
  // and an open one follows its subtasks. Mirrors goalPercent() with optimistic
  // state.
  const percent = manualPercent ?? (completed ? 100 : subtaskPercent(subtasks));

  /**
   * Run one optimistic mutation. useOptimistic already snaps the card back to
   * the server's state when the transition settles, so the missing half was
   * never the rollback — it was saying anything at all. Unhandled, a rejected
   * action escapes the transition and takes the whole dashboard to the error
   * boundary over one failed checkbox; caught, the card reverts and explains.
   */
  function reportError(e: unknown) {
    if (typeof e === "string") return setError(e);
    setError(e instanceof Error ? e.message : "That change didn't save.");
  }

  function run(optimistic: () => void, action: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      optimistic();
      try {
        await action();
      } catch (e) {
        reportError(e);
      }
    });
  }

  function onToggle(id: string, isDone: boolean) {
    run(
      () => {
        applyOptimistic({ type: "toggle", id, isDone });
        // The server clears any manual percent on toggle — mirror it here.
        applyManualPercent(null);
      },
      () => toggleSubtask(id, isDone),
    );

    // When checking a subtask just brought every subtask to done — and the goal
    // isn't already marked complete — prompt the user to confirm completion.
    const willAllBeDone =
      subtasks.length > 0 &&
      subtasks.every((s) => (s.id === id ? isDone : s.isDone));
    if (isDone && willAllBeDone && !completed) {
      setCompleteRate("100");
      setConfirmComplete(true);
    }
  }

  function confirmCompletion() {
    setConfirmComplete(false);
    if (completed) return;
    const rate = clampPercent(Number(completeRate.trim()) || 0);
    run(
      () => {
        applyCompleted(true);
        // Completing also records the rate as the goal's percent.
        applyManualPercent(rate);
      },
      () => setGoalCompleted(goal.id, true, rate),
    );
  }

  function onRenameSubtask(id: string, title: string) {
    run(
      () => applyOptimistic({ type: "rename", id, title }),
      () => renameSubtask(id, title),
    );
  }

  function onDeleteSubtask(id: string) {
    run(
      () => applyOptimistic({ type: "delete", id }),
      () => deleteSubtask(id),
    );
  }

  function onToggleCompleted() {
    // Completing always goes through the rate prompt ("how much did you finish?");
    // reopening a completed goal is immediate.
    if (!completed) {
      setCompleteRate("100");
      setConfirmComplete(true);
      return;
    }
    run(
      () => applyCompleted(false),
      () => setGoalCompleted(goal.id, false),
    );
  }

  function onSetDeadline(next: string | null) {
    run(
      () => applyDeadline(next),
      () => setGoalDeadline(goal.id, next),
    );
  }

  function onSetPriority(next: Priority | null) {
    run(
      () => applyPriority(next),
      () => setGoalPriority(goal.id, next),
    );
  }

  function onSetPercent(next: number) {
    run(
      () => applyManualPercent(next),
      () => setGoalPercent(goal.id, next),
    );
  }

  // Close the completion prompt on Escape and lock body scroll while it's
  // open — same behaviour as the app's other modals.
  useEffect(() => {
    if (!confirmComplete) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmComplete(false);
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [confirmComplete]);

  // Overdue only matters while the goal is still open.
  const overdue = !completed && deadline != null && deadline < nowStamp;
  const [curYear] = todayYmd.split("-").map(Number);

  return (
    <article
      className={`rounded-2xl border bg-surface p-5 shadow-sm transition-colors ${
        completed ? "border-brand ring-1 ring-brand/20" : "border-line"
      }`}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand">
            {index}
          </span>
          <GoalTitle
            goalId={goal.id}
            title={goal.title}
            readOnly={locked}
            onError={reportError}
          />
        </div>

        {error && (
          <p role="alert" className="pl-10 text-xs font-medium text-red-600">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-10">
          {/* Nothing to collapse until a first subtask exists — no "0 tasks". */}
          {subtasks.length > 0 && (
            <button
              type="button"
              onClick={() => setTasksOpen((v) => !v)}
              aria-expanded={tasksOpen}
              aria-label={tasksOpen ? "Hide subtasks" : "Show subtasks"}
              title={tasksOpen ? "Hide subtasks" : "Show subtasks"}
              // -ml-2 cancels the pill's own left padding so the chevron lines
              // up exactly with the start of the goal title above it.
              className={`${CONTROL_PILL} -ml-2 shrink-0 text-muted-fg hover:bg-canvas hover:text-ink`}
            >
              <ChevronIcon
                className={`h-3.5 w-3.5 transition-transform ${
                  tasksOpen ? "rotate-90" : ""
                }`}
              />
              <span className="tabular-nums">
                {subtasks.length} {subtasks.length === 1 ? "task" : "tasks"}
              </span>
            </button>
          )}
          <PercentChip
            percent={percent}
            editable
            manual={manualPercent != null}
            onCommit={onSetPercent}
          />

          {locked ? (
            <div className="flex shrink-0 items-center gap-2">
              {priority && (
                <span
                  className={`${CONTROL_PILL} ${PRIORITY_TEXT[priority]}`}
                  title={`Priority: ${PRIORITY_LABEL[priority]}`}
                >
                  <FlagIcon className="h-3.5 w-3.5" filled />
                  {PRIORITY_LABEL[priority]}
                </span>
              )}
              {deadline && (
                <span
                  className={`${CONTROL_PILL} tabular-nums ${
                    overdue
                      ? "bg-red-50 text-red-600"
                      : "bg-brand-soft text-brand"
                  }`}
                  title="Deadline"
                >
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {formatStamp(deadline, curYear)}
                </span>
              )}
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <PriorityPicker
                value={priority}
                onChange={onSetPriority}
                align="left"
              />
              <DeadlinePicker
                value={deadline}
                todayYmd={todayYmd}
                overdue={overdue}
                onChange={onSetDeadline}
                align="left"
              />
            </div>
          )}

          <span className="shrink-0">
            <CompleteButton
              completed={completed}
              allDone={percent === 100}
              onToggle={onToggleCompleted}
            />
          </span>
          <span className="shrink-0">
            <SharePicker
              team={team}
              alreadyShared={goal.sharedTo}
              onShare={(toUserId) => shareGoal(goal.id, toUserId)}
              onError={reportError}
              ariaLabel="Delegate goal"
              iconClassName="h-3.5 w-3.5"
              align="left"
              showLabel
            />
          </span>
          {!locked && (
            <span className="shrink-0">
              <DeleteGoalButton goalId={goal.id} onError={reportError} />
            </span>
          )}
        </div>
      </div>

      {(goal.receivedFrom || goal.sharedTo.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-10">
          {goal.receivedFrom && (
            <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">
              From {goal.receivedFrom}
            </span>
          )}
          {goal.sharedTo.length > 0 && (
            <span className="text-[11px] text-muted-fg">
              Shared to {goal.sharedTo.join(", ")}
            </span>
          )}
        </div>
      )}

      {/* progress bar — pointless on a fresh goal with nothing to measure, so
          it waits for a first subtask or a (manual/completed) percent. */}
      {(subtasks.length > 0 || percent > 0) && (
        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 ease-(--ease-in-out-strong)"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {/* Force-open when empty: the collapse toggle is gone then, and the
          add-subtask field must never be strandable behind a closed state. */}
      {(tasksOpen || subtasks.length === 0) && (
        <div className="rise-in">
          {/* subtasks */}
          {subtasks.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1">
              {subtasks.map((s) => (
                <SubtaskRow
                  key={s.id}
                  subtask={s}
                  team={team}
                  locked={locked}
                  onToggle={onToggle}
                  onRename={onRenameSubtask}
                  onDelete={onDeleteSubtask}
                  onError={reportError}
                />
              ))}
            </ul>
          )}

          {!locked && (
            <AddSubtaskForm
              goalId={goal.id}
              disabled={isPending}
              onOptimisticAdd={(id, title) =>
                startTransition(() => applyOptimistic({ type: "add", id, title }))
              }
              onError={reportError}
            />
          )}
        </div>
      )}

      {confirmComplete && (
        <div
          className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
          onClick={() => setConfirmComplete(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`Mark "${goal.title}" complete?`}
        >
          <div
            className="modal-in w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-center shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold text-ink">
              Mark “{goal.title}” complete?
            </h2>
            <p className="mt-1 text-sm text-muted-fg">
              How much of it did you actually finish? You can edit this later.
            </p>
            <label className="mt-4 flex items-center justify-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-fg">
                Completion rate
              </span>
              <span className="flex items-center rounded-lg border border-accent px-2 py-1 text-sm font-semibold text-accent-ink focus-within:ring-2 focus-within:ring-accent/30">
                <input
                  autoFocus
                  type="number"
                  min={0}
                  max={100}
                  value={completeRate}
                  onChange={(e) => setCompleteRate(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      confirmCompletion();
                    }
                  }}
                  aria-label="Completion rate percent"
                  className="w-12 bg-transparent text-right tabular-nums focus:outline-none"
                />
                %
              </span>
            </label>
            <div className="mt-5 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmComplete(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-muted-fg transition hover:bg-canvas"
              >
                Not yet
              </button>
              <button
                type="button"
                onClick={confirmCompletion}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark"
              >
                Mark complete
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

// Tooltip on a manually-set percent chip: names the otherwise-invisible rule
// that subtask toggles discard a manual percent.
const MANUAL_TITLE =
  "Set manually — toggling a subtask recomputes progress from subtasks";

/**
 * The goal's percent readout — click to type a manual value (0–100). Commits on
 * blur or Enter, cancels on Escape. Editable even once the goal is completed, so
 * a "done at 70%" rate can be adjusted after the fact. A manually-set percent
 * carries a marker dot: it overrides subtask progress, and toggling any subtask
 * clears it back to the derived value — the tooltip says so, since neither rule
 * is visible otherwise.
 */
function PercentChip({
  percent,
  editable,
  manual = false,
  onCommit,
}: {
  percent: number;
  editable: boolean;
  // True when the percent was typed in by hand rather than derived from subtasks.
  manual?: boolean;
  onCommit: (next: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");

  const manualDot = manual ? (
    <span
      className="h-1 w-1 shrink-0 rounded-full bg-current"
      aria-hidden="true"
    />
  ) : null;

  if (!editable) {
    return (
      <span
        className={`${CONTROL_PILL} shrink-0 tabular-nums text-accent-ink`}
        title={manual ? MANUAL_TITLE : undefined}
      >
        {percent}%{manualDot}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setText(String(percent));
          setEditing(true);
        }}
        title={manual ? MANUAL_TITLE : "Click to set the percent yourself"}
        aria-label={
          manual
            ? "Goal progress percent, set manually — click to edit"
            : "Edit goal progress percent"
        }
        className={`${CONTROL_PILL} shrink-0 tabular-nums text-accent-ink hover:bg-accent-soft`}
      >
        {percent}%{manualDot}
      </button>
    );
  }

  function commit() {
    setEditing(false);
    const parsed = Number(text.trim());
    if (text.trim() === "" || Number.isNaN(parsed)) return;
    const next = clampPercent(parsed);
    if (next !== percent) onCommit(next);
  }

  return (
    <span className="flex shrink-0 items-center text-sm font-semibold text-accent-ink">
      <input
        autoFocus
        type="number"
        min={0}
        max={100}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setText("");
            setEditing(false);
          }
        }}
        aria-label="Goal progress percent"
        className="w-12 rounded-md border border-accent bg-surface px-1 py-0.5 text-right text-sm font-semibold tabular-nums text-accent-ink focus:outline-none"
      />
      %
    </span>
  );
}

function CompleteButton({
  completed,
  allDone,
  onToggle,
}: {
  completed: boolean;
  allDone: boolean;
  onToggle: () => void;
}) {
  if (completed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Completed — click to reopen"
        aria-label="Mark goal as not completed"
        className={`${CONTROL_PILL} bg-brand text-white hover:bg-brand-dark`}
      >
        <CheckCircleIcon className="h-3.5 w-3.5" />
        Done
      </button>
    );
  }

  // Not completed yet. Brighten the tick once every subtask is done — that's the
  // moment a user is most likely to want to confirm the goal itself is finished.
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Mark this goal as completed"
      aria-label="Mark goal as completed"
      className={`${CONTROL_PILL} hover:bg-brand-soft hover:text-brand ${
        allDone ? "text-brand" : "text-muted-fg"
      }`}
    >
      <CheckCircleIcon className="h-3.5 w-3.5" />
      Done
    </button>
  );
}

function SubtaskRow({
  subtask: s,
  team,
  locked,
  onToggle,
  onRename,
  onDelete,
  onError,
}: {
  subtask: SubtaskView;
  team: TeamMember[];
  locked: boolean;
  onToggle: (id: string, isDone: boolean) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const isTemp = s.id.startsWith("temp-");

  return (
    <li className="group flex items-start gap-3 rounded-lg px-1 py-1.5 hover:bg-canvas">
      <input
        type="checkbox"
        checked={s.isDone}
        onChange={(e) => onToggle(s.id, e.target.checked)}
        aria-label={
          s.isDone
            ? `Mark "${s.title}" as not done`
            : `Mark "${s.title}" as done`
        }
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-line accent-brand focus:ring-brand"
      />
      <div className="min-w-0 flex-1">
        <EditableText
          value={s.title}
          readOnly={locked || isTemp}
          ariaLabel="Subtask title"
          onCommit={(title) => onRename(s.id, title)}
          className={`block w-full text-sm ${
            s.isDone ? "text-muted-fg line-through" : "text-ink"
          }`}
        />
        {(s.receivedFrom || s.sharedTo.length > 0) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {s.receivedFrom && (
              <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">
                From {s.receivedFrom}
              </span>
            )}
            {s.sharedTo.length > 0 && (
              <span className="text-[11px] text-muted-fg">
                Shared to {s.sharedTo.join(", ")}
              </span>
            )}
          </div>
        )}
      </div>

      {!isTemp && (
        <span className="mt-0.5">
          <SharePicker
            team={team}
            alreadyShared={s.sharedTo}
            onShare={(toUserId) => shareSubtask(s.id, toUserId)}
            onError={onError}
            ariaLabel="Delegate subtask"
          />
        </span>
      )}

      {!locked && <DeleteSubtaskButton onDelete={() => onDelete(s.id)} />}
    </li>
  );
}

/** Subtask deletion, two-step like goal deletion — never on a single misclick. */
function DeleteSubtaskButton({ onDelete }: { onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs">
        <button
          type="button"
          onClick={onDelete}
          className="rounded bg-red-500 px-1.5 py-0.5 font-medium text-white transition hover:bg-red-600"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded px-1.5 py-0.5 text-muted-fg transition hover:bg-canvas"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="mt-0.5 text-red-500 transition hover:text-red-600"
      aria-label="Delete subtask"
    >
      <TrashIcon className="h-4 w-4" />
    </button>
  );
}

/**
 * The "delegate to a teammate" dropdown, shared by goal and subtask rows —
 * what it delegates is up to the `onShare` callback.
 */
function SharePicker({
  team,
  alreadyShared,
  onShare,
  onError,
  ariaLabel,
  iconClassName = "h-4 w-4",
  align = "right",
  showLabel = false,
}: {
  team: TeamMember[];
  alreadyShared: string[];
  onShare: (toUserId: string) => Promise<ActionResult>;
  onError: (e: unknown) => void;
  ariaLabel: string;
  iconClassName?: string;
  align?: "left" | "right";
  // When true, render as a labelled control pill ("Delegate") to match the
  // other goal controls; otherwise a bare icon (used on compact subtask rows).
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useDismissible(open, () => setOpen(false), ref);

  // Search only: the full team is too long to scroll, so nothing is listed
  // until a name is typed.
  const q = query.trim().toLowerCase();
  const matches = q
    ? team.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8)
    : [];

  function share(toUserId: string) {
    startTransition(async () => {
      // Delegation can legitimately refuse (an unapproved recipient, say), so
      // the refusal has to reach the card rather than bubble out of the
      // transition.
      try {
        const result = await onShare(toUserId);
        if (!result.ok) onError(result.error);
      } catch (e) {
        onError(e);
      }
      setOpen(false);
      setQuery("");
    });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          showLabel
            ? `${CONTROL_PILL} text-brand hover:bg-brand-soft`
            : "text-brand transition hover:text-brand-dark"
        }
        aria-label={ariaLabel}
        aria-expanded={open}
        title="Delegate to a teammate"
      >
        <ShareIcon className={iconClassName} />
        {showLabel && <span>Delegate</span>}
      </button>

      {open && (
        <div
          className={`pop-in absolute z-10 mt-1 w-60 rounded-xl border border-line bg-surface p-1 shadow-lg ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const first = matches.find((m) => !alreadyShared.includes(m.name));
              if (first && !isPending) share(first.id);
            }}
            placeholder="Delegate to… type a name"
            aria-label="Search teammates"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
          />
          {q && matches.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-fg">
              {`No one matches “${query.trim()}”.`}
            </p>
          )}
          {matches.map((m) => {
            const done = alreadyShared.includes(m.name);
            return (
              <button
                key={m.id}
                type="button"
                disabled={done || isPending}
                onClick={() => share(m.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink transition hover:bg-canvas disabled:cursor-default disabled:text-muted-fg disabled:hover:bg-transparent"
              >
                <span className="truncate">{m.name}</span>
                {done && <span className="text-[11px] text-brand">shared</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GoalTitle({
  goalId,
  title,
  readOnly,
  onError,
}: {
  goalId: string;
  title: string;
  readOnly: boolean;
  onError: (e: unknown) => void;
}) {
  return (
    <EditableText
      value={title}
      readOnly={readOnly}
      ariaLabel="Goal title"
      onCommit={(next) => renameGoal(goalId, next).catch(onError)}
      className="min-w-0 flex-1 text-base font-semibold text-ink"
    />
  );
}

/**
 * An auto-growing textarea that reads as plain text but edits inline. Wraps to
 * show the full value (so long goals/subtasks are fully readable), commits on
 * blur or Enter, and reverts on Escape. Read-only renders the same wrapped text
 * without editing affordances.
 */
function EditableText({
  value,
  onCommit,
  readOnly,
  className,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  readOnly: boolean;
  className: string;
  ariaLabel: string;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Reconcile with the value from the server when it changes underneath us
  // (e.g. after a rename revalidates) — without an effect. See:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(value);
  }

  function resize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  // Size to content on mount and whenever the text changes.
  useLayoutEffect(resize, []);
  useLayoutEffect(resize, [text]);

  function commit() {
    const trimmed = text.trim();
    if (!trimmed || trimmed === value) {
      setText(value);
      return;
    }
    onCommit(trimmed);
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      value={text}
      readOnly={readOnly}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setText(value);
          e.currentTarget.blur();
        }
      }}
      aria-label={ariaLabel}
      className={`resize-none overflow-hidden break-words rounded border border-transparent bg-transparent px-1 py-0.5 transition-colors focus:outline-none ${
        readOnly
          ? "cursor-default focus:border-transparent"
          : "hover:border-line focus:border-brand focus:bg-surface"
      } ${className}`}
    />
  );
}

function DeleteGoalButton({
  goalId,
  onError,
}: {
  goalId: string;
  onError: (e: unknown) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => void deleteGoal(goalId).catch(onError)}
          className="rounded bg-red-500 px-2 py-1 font-medium text-white hover:bg-red-600"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded px-2 py-1 text-muted-fg hover:bg-canvas"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className={`${CONTROL_PILL} text-red-500 hover:bg-red-50 hover:text-red-600`}
      aria-label="Delete goal"
    >
      <TrashIcon className="h-3.5 w-3.5" />
      Delete
    </button>
  );
}

function AddSubtaskForm({
  goalId,
  disabled,
  onOptimisticAdd,
  onError,
}: {
  goalId: string;
  disabled: boolean;
  onOptimisticAdd: (tempId: string, title: string) => void;
  onError: (e: unknown) => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const title = value.trim();
    if (!title) return;
    setValue("");
    onOptimisticAdd(`temp-${Date.now()}`, title);
    void addSubtask(goalId, title).catch(onError);
    inputRef.current?.focus();
  }

  return (
    <form onSubmit={submit} className="mt-3 flex items-center gap-2">
      <button
        type="submit"
        disabled={disabled}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line text-muted-fg transition hover:border-accent hover:text-accent-ink disabled:opacity-50"
        aria-label="Add subtask"
      >
        +
      </button>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add a subtask"
        aria-label="New subtask title"
        className="flex-1 rounded-lg border border-line px-3 py-1.5 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
      />
    </form>
  );
}
