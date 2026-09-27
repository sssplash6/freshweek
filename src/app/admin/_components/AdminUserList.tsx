"use client";

import { useState, useTransition } from "react";
import { resolveAvatar } from "@/lib/avatar";
import {
  DEFAULT_MANUAL_PENALTY,
  formatMoney,
  PENALTY_CURRENCY,
} from "@/lib/penalties";
import { TrashIcon } from "../../dashboard/_components/icons";
import { BonusControls } from "@/app/_components/BonusControls";
import {
  addBonus,
  addManualPenalty,
  deletePenalty,
  deleteUser,
  moveUserWeekToCurrent,
} from "../actions";

export type AdminGoal = {
  id: string;
  title: string;
  percent: number;
  completed: boolean;
  deadlineLabel: string | null;
  // Reason given for not finishing, captured when the period was closed.
  incompleteReason: string | null;
  subtasks: { title: string; isDone: boolean }[];
};

// An admin-assigned task (separate from the person's own weekly goals).
export type AdminTask = {
  id: string;
  title: string;
  note: string | null;
  deadlineLabel: string | null;
  done: boolean;
};

export type AdminPenalty = {
  id: string;
  label: string;
  /** What's still owed on it. */
  amount: number;
  /** Already settled against it, or null when nothing has been paid yet. */
  partPaid: number | null;
  fullAmount: number;
  note: string | null;
  dateLabel: string;
};

export type AdminBonus = {
  id: string;
  amount: number;
  note: string | null;
  dateLabel: string;
  /** Paid out through payroll — shown, but not changeable. */
  locked: boolean;
};

export type AdminUser = {
  id: string;
  name: string | null;
  email: string | null;
  // Department leads owe the weekly cycle (and the Monday meeting); members
  // don't, so every expectation flag below only ever lights up for a lead.
  lead: boolean;
  department: string | null;
  avatar: string | null;
  weekLabel: string | null;
  // Previous-week only: they never closed the week out (still stuck on it).
  notClosed: boolean;
  // Set when they've already closed this week and started a later one — the
  // range of that later week, which is what their own dashboard shows.
  aheadLabel: string | null;
  // Set when their live week is still one from before this cycle (never
  // closed) — the range of that stuck week.
  behindLabel: string | null;
  late: boolean;
  submittedAtLabel: string | null;
  percent: number;
  goalCount: number;
  completedCount: number;
  penaltyTotal: number;
  penalties: AdminPenalty[];
  bonusTotal: number;
  bonuses: AdminBonus[];
  goals: AdminGoal[];
  tasks: AdminTask[];
};

type SubmitFilter = "all" | "submitted" | "not-submitted";

// Per-tab wording. "next-week" relabels the submitted signal as "Reported"
// (reporting auto-submits the new week) and points the copy at next week.
export type AdminListVariant = "week" | "previous-week" | "month";
const VARIANT_LABELS: Record<
  AdminListVariant,
  { done: string; notDone: string; noun: string; goalsWord: string }
> = {
  week: { done: "Submitted", notDone: "Not submitted", noun: "week", goalsWord: "Goals" },
  "previous-week": {
    done: "Submitted",
    notDone: "Not submitted",
    noun: "week",
    goalsWord: "Goals",
  },
  month: { done: "Submitted", notDone: "Not submitted", noun: "month", goalsWord: "Goals" },
};

export function AdminUserList({
  users,
  currentUserId,
  variant = "week",
}: {
  users: AdminUser[];
  currentUserId: string;
  variant?: AdminListVariant;
}) {
  const [filter, setFilter] = useState<SubmitFilter>("all");
  const labels = VARIANT_LABELS[variant];

  if (users.length === 0) {
    return <p className="px-1 text-sm text-muted-fg">No users yet.</p>;
  }

  // "Submitted" = they've submitted their goals for the current period (anyone
  // can, voluntarily). "Not submitted" is the nag list, so it holds only the
  // department leads who actually owe a submission.
  const submittedCount = users.filter((u) => u.submittedAtLabel != null).length;
  const counts = {
    all: users.length,
    submitted: submittedCount,
    "not-submitted": users.filter((u) => u.lead && u.submittedAtLabel == null)
      .length,
  };
  const visible = users.filter((u) => {
    if (filter === "submitted") return u.submittedAtLabel != null;
    if (filter === "not-submitted") return u.lead && u.submittedAtLabel == null;
    return true;
  });

  const FILTERS: { key: SubmitFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "submitted", label: labels.done },
    { key: "not-submitted", label: labels.notDone },
  ];

  // Leads first, members after, each under a small header (shown only when
  // both groups are present, so a filtered view doesn't carry a lone label).
  const leads = visible.filter((u) => u.lead);
  const members = visible.filter((u) => !u.lead);
  const showHeaders = leads.length > 0 && members.length > 0;

  const renderGroup = (list: AdminUser[], header: string) =>
    list.length > 0 && (
      <div>
        {showHeaders && (
          <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
            {header} ({list.length})
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {list.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              isSelf={u.id === currentUserId}
              labels={labels}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <>
      <div className="mb-3 inline-flex rounded-lg border border-line bg-canvas p-0.5 text-xs font-semibold">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-md px-3 py-1.5 transition ${
              filter === f.key
                ? "bg-brand text-white"
                : "text-muted-fg hover:text-ink"
            }`}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="px-1 text-sm text-muted-fg">No people match this filter.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {renderGroup(leads, "Department leads")}
          {renderGroup(members, "Members")}
        </div>
      )}
    </>
  );
}

function UserRow({
  user: u,
  isSelf,
  labels,
}: {
  user: AdminUser;
  isSelf: boolean;
  labels: { done: string; notDone: string; noun: string; goalsWord: string };
}) {
  const [open, setOpen] = useState(false);
  const [addingFine, setAddingFine] = useState(false);
  const [addingBonus, setAddingBonus] = useState(false);
  const canExpand =
    u.goalCount > 0 ||
    u.tasks.length > 0 ||
    u.penalties.length > 0 ||
    u.bonuses.length > 0;
  const periodNoun = labels.noun;
  const avatar = resolveAvatar(u.avatar, u.email ?? u.id);

  return (
    <li className="rounded-xl border border-line bg-surface">
      <div className="flex items-center">
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        className={`group flex min-w-0 flex-1 items-center gap-3 p-4 text-left ${
          canExpand ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg ${avatar.bg}`}
          aria-hidden="true"
        >
          {avatar.emoji}
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-semibold text-ink">
            <span className="truncate">{u.name ?? "—"}</span>
            {u.late && (
              <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-600">
                Late
              </span>
            )}
            {u.notClosed && (
              <span className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-orange-700">
                Didn&rsquo;t close
              </span>
            )}
            {u.aheadLabel && (
              <span
                className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-orange-700"
                title={`Already closed this week and started ${u.aheadLabel} — the goals here are the closed week's.`}
              >
                Week ahead
              </span>
            )}
            {u.behindLabel && (
              <span
                className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-orange-700"
                title={`Still on ${u.behindLabel} — never closed it.`}
              >
                Week behind
              </span>
            )}
            {u.lead && u.goalCount === 0 && (
              <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                No goals
              </span>
            )}
            {u.penaltyTotal > 0 && (
              <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-600">
                {formatMoney(u.penaltyTotal)}
              </span>
            )}
            {u.bonusTotal > 0 && (
              <span className="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-700">
                +{formatMoney(u.bonusTotal)}
              </span>
            )}
            {/* The red flag is an unmet expectation, so members never get one —
                a member's voluntary submission still earns the green chip. */}
            {u.submittedAtLabel ? (
              <span className="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-700">
                {labels.done}
              </span>
            ) : u.lead ? (
              <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-600">
                {labels.notDone}
              </span>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted-fg">
            {u.email ?? "no email"}
            {u.department ? ` · ${u.department}` : ""}
          </p>
          {/* Which period this row is actually about, then its submission. The
              range matters most for someone running ahead or behind, whose own
              dashboard is on a different week than the tab. */}
          <p className="truncate text-xs text-muted-fg">
            {[
              u.weekLabel,
              u.submittedAtLabel
                ? `${labels.goalsWord} submitted ${u.submittedAtLabel}`
                : u.lead
                  ? `${labels.goalsWord} not submitted yet`
                  : "No submission expected",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {/* Wraps rather than truncates — clipped mid-sentence, the warning
              reads as noise instead of an explanation of the goals below. */}
          {u.aheadLabel && (
            <p className="text-xs text-orange-700">
              {`Already on ${u.aheadLabel} — the goals below are the week they closed, not what they're working on now.`}
            </p>
          )}
        </div>

        <div className="hidden w-40 shrink-0 sm:block">
          {u.goalCount > 0 ? (
            <>
              <div className="flex items-center justify-between text-xs text-muted-fg">
                <span>
                  {u.completedCount}/{u.goalCount} done
                </span>
                <span className="font-semibold tabular-nums text-accent-ink">
                  {u.percent}%
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${u.percent}%` }}
                />
              </div>
            </>
          ) : (
            <span className="text-xs text-muted-fg">No goals this {periodNoun}</span>
          )}
        </div>

        {canExpand && (
          <span
            className={`shrink-0 text-muted-fg transition group-hover:text-ink ${
              open ? "rotate-90" : ""
            }`}
            aria-hidden="true"
          >
            ›
          </span>
        )}
      </button>

      <div className="flex shrink-0 items-center gap-2 pr-4">
        <button
          type="button"
          onClick={() => {
            setAddingBonus(false);
            setAddingFine((v) => !v);
          }}
          className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
          title="Issue a fine to this person"
        >
          Fine
        </button>
        <button
          type="button"
          onClick={() => {
            setAddingFine(false);
            setAddingBonus((v) => !v);
          }}
          className="shrink-0 rounded-lg border border-green-200 px-2.5 py-1 text-xs font-medium text-green-700 transition hover:bg-green-50"
          title="Award a bonus to this person"
        >
          Bonus
        </button>
        {/* Only for someone whose live week is off this cycle's — ahead or
            behind — the cases there's anything to repair. */}
        {(u.aheadLabel ?? u.behindLabel) && (
          <FixWeekButton
            userId={u.id}
            offLabel={(u.aheadLabel ?? u.behindLabel)!}
          />
        )}
        {isSelf ? (
          // Invisible stand-in matching the delete button's footprint (px-4
          // around an h-4 w-4 icon) so every row's columns line up.
          <span className="w-12 shrink-0" aria-hidden="true" />
        ) : (
          <DeleteUserButton userId={u.id} name={u.name ?? u.email} />
        )}
      </div>
      </div>

      {addingFine && (
        <AddFineForm
          userId={u.id}
          name={u.name ?? u.email}
          onDone={() => setAddingFine(false)}
        />
      )}

      {addingBonus && (
        <AddBonusForm
          userId={u.id}
          name={u.name ?? u.email}
          onDone={() => setAddingBonus(false)}
        />
      )}

      {open && canExpand && (
        <div className="rise-in border-t border-line px-4 py-2">
          {u.goals.length > 0 && (
            <ul>
              {u.goals.map((g) => (
                <li key={g.id} className="py-1.5 text-sm">
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        g.completed ? "bg-brand" : "bg-line"
                      }`}
                    />
                    <span
                      className={`min-w-0 flex-1 break-words ${
                        g.completed ? "text-muted-fg line-through" : "text-ink"
                      }`}
                    >
                      {g.title}
                    </span>
                    {g.deadlineLabel && (
                      <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-medium text-muted-fg">
                        Due {g.deadlineLabel}
                      </span>
                    )}
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-accent-ink">
                      {g.percent}%
                    </span>
                  </div>
                  {g.incompleteReason && (
                    <p className="mt-0.5 pl-5 text-xs italic text-muted-fg">
                      “{g.incompleteReason}”
                    </p>
                  )}
                  {g.subtasks.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 pl-5">
                      {g.subtasks.map((s, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2 text-xs text-muted-fg"
                        >
                          <span
                            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ${
                              s.isDone
                                ? "border-brand/40 bg-brand/10 text-brand"
                                : "border-line text-transparent"
                            }`}
                            aria-hidden="true"
                          >
                            ✓
                          </span>
                          <span
                            className={`min-w-0 break-words ${
                              s.isDone ? "line-through opacity-70" : ""
                            }`}
                          >
                            {s.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          {u.tasks.length > 0 && (
            <div className={u.goals.length > 0 ? "mt-2 border-t border-line pt-2" : ""}>
              <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                Assigned tasks
              </p>
              <ul>
                {u.tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-1.5 text-sm">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        t.done ? "bg-amber-500" : "bg-amber-200"
                      }`}
                    />
                    <span
                      className={`min-w-0 flex-1 break-words ${
                        t.done ? "text-muted-fg line-through" : "text-ink"
                      }`}
                    >
                      {t.title}
                      {t.note ? (
                        <span className="text-muted-fg"> · {t.note}</span>
                      ) : null}
                    </span>
                    {t.deadlineLabel && (
                      <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-medium text-muted-fg">
                        Due {t.deadlineLabel}
                      </span>
                    )}
                    <span
                      className={`shrink-0 text-xs font-semibold ${
                        t.done ? "text-amber-700" : "text-muted-fg"
                      }`}
                    >
                      {t.done ? "Done" : "Open"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {u.penalties.length > 0 && (
            <div
              className={
                u.goals.length > 0 || u.tasks.length > 0
                  ? "mt-2 border-t border-line pt-2"
                  : ""
              }
            >
              <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                Fines
              </p>
              <ul>
                {u.penalties.map((p) => (
                  <PenaltyRow key={p.id} penalty={p} />
                ))}
              </ul>
            </div>
          )}

          {u.bonuses.length > 0 && (
            <div
              className={
                u.goals.length > 0 || u.tasks.length > 0 || u.penalties.length > 0
                  ? "mt-2 border-t border-line pt-2"
                  : ""
              }
            >
              <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                Bonuses
              </p>
              <ul>
                {u.bonuses.map((b) => (
                  <BonusRow key={b.id} bonus={b} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function PenaltyRow({ penalty: p }: { penalty: AdminPenalty }) {
  return (
    <li className="flex items-start gap-3 py-1.5 text-sm">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500" />
      <span className="min-w-0 flex-1 break-words text-ink">
        {p.label}
        {p.note ? <span className="text-muted-fg"> · {p.note}</span> : ""}
      </span>
      <span className="shrink-0 text-[11px] text-muted-fg">{p.dateLabel}</span>
      {p.partPaid !== null && (
        <span className="shrink-0 text-[11px] tabular-nums text-green-700">
          {formatMoney(p.partPaid)} of {formatMoney(p.fullAmount)} paid
        </span>
      )}
      <span className="shrink-0 text-xs font-semibold tabular-nums text-red-600">
        {formatMoney(p.amount)}
      </span>
      <ConfirmDeleteButton
        label="Remove fine"
        onConfirm={() => deletePenalty(p.id)}
      />
    </li>
  );
}

/**
 * Trash icon that unfolds into an inline Remove/Cancel pair — money records
 * (and anything else destructive) never disappear on a single misclick.
 */
function ConfirmDeleteButton({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs">
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => void (await onConfirm()))
          }
          className="rounded bg-red-500 px-2 py-1 font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
        >
          {isPending ? "Removing…" : "Remove"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming(false)}
          className="rounded px-2 py-1 text-muted-fg transition hover:bg-canvas"
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
      className="shrink-0 text-muted-fg transition hover:text-red-500"
      aria-label={label}
      title={label}
    >
      <TrashIcon className="h-4 w-4" />
    </button>
  );
}

function AddFineForm({
  userId,
  name,
  onDone,
}: {
  userId: string;
  name: string | null;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(DEFAULT_MANUAL_PENALTY));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await addManualPenalty(userId, value, note);
        onDone();
      } catch {
        setError("Couldn't add the fine.");
      }
    });
  }

  return (
    <div className="rise-in border-t border-line bg-canvas/50 px-4 py-3">
      <p className="mb-2 text-xs font-semibold text-ink">
        Fine {name ?? "user"}{" "}
        <span className="font-normal text-muted-fg">
          (for meeting skips, use attendance below)
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-xs text-muted-fg">Amount</span>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-28 rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink focus:border-brand focus:outline-none"
          />
          <span className="text-xs text-muted-fg">{PENALTY_CURRENCY}</span>
        </label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional) — e.g. missed Monday standup"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
        />
        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="shrink-0 rounded-lg bg-red-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-600 disabled:opacity-50"
        >
          {isPending ? "Adding…" : "Add fine"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onDone}
          className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-fg transition hover:bg-line"
        >
          Cancel
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function BonusRow({ bonus: b }: { bonus: AdminBonus }) {
  return (
    // flex-wrap: the inline edit form takes the row's tail and needs somewhere
    // to go on a narrow screen (see BonusControls).
    <li className="flex flex-wrap items-start gap-3 py-1.5 text-sm">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-green-500" />
      {/* Wraps rather than truncates — the note is the whole reason for the
          bonus, so it stays readable however long it runs. */}
      <span className="min-w-0 flex-1 break-words text-ink">
        Bonus
        {b.note ? <span className="text-muted-fg"> · {b.note}</span> : ""}
      </span>
      <span className="shrink-0 text-[11px] text-muted-fg">{b.dateLabel}</span>
      <span className="shrink-0 text-xs font-semibold tabular-nums text-green-700">
        +{formatMoney(b.amount)}
      </span>
      <BonusControls
        bonusId={b.id}
        amount={b.amount}
        note={b.note}
        locked={b.locked}
      />
    </li>
  );
}

function AddBonusForm({
  userId,
  name,
  onDone,
}: {
  userId: string;
  name: string | null;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(DEFAULT_MANUAL_PENALTY));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await addBonus(userId, value, note);
        onDone();
      } catch {
        setError("Couldn't add the bonus.");
      }
    });
  }

  return (
    <div className="rise-in border-t border-line bg-green-50/40 px-4 py-3">
      <p className="mb-2 text-xs font-semibold text-ink">
        Bonus {name ?? "user"}{" "}
        <span className="font-normal text-muted-fg">(great work, extra effort…)</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-xs text-muted-fg">Amount</span>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-28 rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink focus:border-brand focus:outline-none"
          />
          <span className="text-xs text-muted-fg">{PENALTY_CURRENCY}</span>
        </label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional) — e.g. shipped the launch early"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
        />
        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="shrink-0 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-green-700 disabled:opacity-50"
        >
          {isPending ? "Adding…" : "Add bonus"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onDone}
          className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-fg transition hover:bg-line"
        >
          Cancel
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Pulls someone who's running ahead (or stuck behind) onto the current week:
// re-dates their live week, or — if they got ahead by closing this week early —
// reopens the week they closed and folds the ahead one into it. Either way no goals are lost, so
// one confirmation step is enough.
function FixWeekButton({
  userId,
  offLabel,
}: {
  userId: string;
  offLabel: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1 pr-3 text-xs">
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              await moveUserWeekToCurrent(userId);
              setConfirming(false);
            })
          }
          className="whitespace-nowrap rounded bg-brand px-2 py-1 font-medium text-white transition hover:bg-brand-dark disabled:opacity-50"
          title={`Bring them from ${offLabel} to the current week (goals kept)`}
        >
          {isPending ? "Moving…" : "Move to this week"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming(false)}
          className="rounded px-2 py-1 text-muted-fg transition hover:bg-canvas"
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
      className="shrink-0 whitespace-nowrap rounded-lg border border-orange-200 px-2.5 py-1 text-xs font-medium text-orange-700 transition hover:bg-orange-50"
      title={`They're on ${offLabel} — move them to the current week (goals kept)`}
    >
      Fix week
    </button>
  );
}

function DeleteUserButton({
  userId,
  name,
}: {
  userId: string;
  name: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1 pr-4 text-xs">
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              await deleteUser(userId);
            })
          }
          className="rounded bg-red-500 px-2 py-1 font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
        >
          {isPending ? "Deleting…" : "Delete"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming(false)}
          className="rounded px-2 py-1 text-muted-fg transition hover:bg-canvas"
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
      className="shrink-0 px-4 text-muted-fg transition hover:text-red-500"
      aria-label={`Delete ${name ?? "user"}`}
      title="Delete user"
    >
      <TrashIcon className="h-4 w-4" />
    </button>
  );
}
