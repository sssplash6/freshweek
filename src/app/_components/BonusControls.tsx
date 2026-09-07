"use client";

import { useState, useTransition } from "react";
import { PENALTY_CURRENCY } from "@/lib/penalties";
import { LockIcon, PencilIcon, TrashIcon } from "@/app/dashboard/_components/icons";
import { deleteBonus, editBonus } from "@/app/admin/actions";

/**
 * Fix or remove one bonus, wherever a bonus is listed to someone who may act
 * on it — the /admin recent list, a person's row on /admin, a member's row on
 * /department. One component so the same money record can't be corrected
 * three different ways, and so the paid-out lock is stated identically
 * everywhere.
 *
 * Both verbs are the same scope as awarding (lib/manage.ts), re-checked in the
 * action: admins anyone, a lead the people under them and themselves.
 *
 * It renders inline, in the tail of the row it belongs to. Editing takes over
 * that tail rather than opening a dialog, so the row you are correcting stays
 * on screen and in place — every host row is `flex-wrap`, which lets the form
 * drop onto its own line when the row is too narrow to hold it.
 */
export function BonusControls({
  bonusId,
  amount,
  note,
  locked = false,
}: {
  bonusId: string;
  amount: number;
  note: string | null;
  /** Paid out through payroll: the invoice is a record, so nothing may change. */
  locked?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draftAmount, setDraftAmount] = useState(String(amount));
  const [draftNote, setDraftNote] = useState(note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (locked) {
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-fg"
        title="Paid out through payroll — this one can't be changed."
      >
        <LockIcon className="h-3 w-3" />
        Paid out
      </span>
    );
  }

  function save() {
    const value = Math.round(Number(draftAmount));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await editBonus(bonusId, value, draftNote);
        setEditing(false);
      } catch (e) {
        // The action's own words when it has any — "already paid out through
        // payroll" tells the person what to do; "couldn't save" doesn't.
        setError(e instanceof Error ? e.message : "Couldn't save that.");
      }
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      try {
        await deleteBonus(bonusId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't remove that.");
        setConfirming(false);
      }
    });
  }

  if (editing) {
    return (
      <span className="flex w-full flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-fg">Amount</span>
          <input
            type="number"
            min={1}
            autoFocus
            value={draftAmount}
            onChange={(e) => setDraftAmount(e.target.value)}
            className="w-24 rounded-lg border border-line px-2.5 py-1 text-sm text-ink focus:border-brand focus:outline-none"
          />
          <span className="text-[11px] text-muted-fg">{PENALTY_CURRENCY}</span>
        </label>
        <input
          type="text"
          value={draftNote}
          onChange={(e) => setDraftNote(e.target.value)}
          placeholder="Note (optional) — what it was for"
          maxLength={500}
          className="min-w-32 flex-1 rounded-lg border border-line px-3 py-1 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
        />
        <button
          type="button"
          disabled={isPending}
          onClick={save}
          className="shrink-0 rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            // Back to the stored values, not to whatever was half-typed — a
            // reopened form starting from an abandoned draft is a trap.
            setDraftAmount(String(amount));
            setDraftNote(note ?? "");
            setError(null);
            setEditing(false);
          }}
          className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-fg transition hover:bg-line"
        >
          Cancel
        </button>
        {error && <span className="w-full text-xs text-red-600">{error}</span>}
      </span>
    );
  }

  if (confirming) {
    return (
      <span className="flex shrink-0 flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          disabled={isPending}
          onClick={remove}
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
        {error && <span className="w-full text-xs text-red-600">{error}</span>}
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-muted-fg transition hover:text-brand"
        aria-label="Edit bonus"
        title="Edit bonus"
      >
        <PencilIcon className="h-4 w-4" />
      </button>
      {/* Destructive, so it unfolds into Remove/Cancel rather than firing on
          one misclick — the house rule for every money record. */}
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-muted-fg transition hover:text-red-500"
        aria-label="Remove bonus"
        title="Remove bonus"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
      {error && <span className="w-full text-xs text-red-600">{error}</span>}
    </span>
  );
}
