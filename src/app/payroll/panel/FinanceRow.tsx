"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  PanelRowShell,
  type PanelRowSummary,
} from "../_components/PanelRowShell";
import { RowTick } from "../_components/PaySelection";
// The reviewer's moves stay in ../finance, next to the state machine they
// drive. Only the UI moved here when the three panels merged.
import { confirmPayment, declineSubmission } from "../finance/actions";
import { FinanceEditModal, type FinanceEditModel } from "./FinanceEditModal";

/**
 * A panel row plus the reviewer's moves — pay it, or decline it back to the
 * filer with a required note (a small modal) — and the tick that hands it to
 * the batch bar instead, to be paid alongside the other ticked rows. The
 * revalidated page moves the row on success; this component only holds the
 * open/typing state.
 *
 * `edit` is the third verb: revising the figures before paying, instead of
 * declining a request over a typo. Absent means the page did not offer it, so
 * there is nothing to open.
 *
 * There is no `canAct` prop, and that distinction matters: /payroll/panel
 * renders this component only for a row the reviewer may pay. A row can
 * therefore never talk itself into showing a button by inspecting its own
 * status, which is the failure mode a single merged panel invites.
 *
 * It used to be one of a pair — an admin stage approved a request onward and
 * finance paid it. With one stage the two rows became one, and the decline
 * that was the admin's is the reviewer's: it is also how a payment refused for
 * snapshot drift gets back to the only person who can refile it.
 */
export function FinanceRow({
  submissionId,
  summary,
  edit,
  children,
}: {
  submissionId: string;
  summary: PanelRowSummary;
  edit?: FinanceEditModel;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await confirmPayment(submissionId);
        if (!res.ok) setError(res.error);
      } catch {
        setError("Couldn't confirm — try again.");
      }
    });
  }

  function decline() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await declineSubmission(submissionId, note);
        if (!res.ok) setError(res.error);
        else {
          setDeclining(false);
          setNote("");
        }
      } catch {
        setError("Couldn't decline — try again.");
      }
    });
  }

  return (
    <PanelRowShell
      summary={summary}
      // The tick and the Confirm button below are the same permission seen
      // twice: the page established that this viewer may pay this request.
      // RowTick draws nothing when the row is outside a board that can batch.
      select={
        <RowTick id={submissionId} name={summary.name} disabled={isPending} />
      }
      footer={
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              disabled={isPending}
              onClick={confirm}
              className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending && !declining ? "Confirming…" : "Confirm payment"}
            </button>
            {edit && (
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  setError(null);
                  setEditing(true);
                }}
                className="rounded-lg border border-line px-3.5 py-2 text-sm font-semibold text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
              >
                Edit figures…
              </button>
            )}
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                setError(null);
                setDeclining(true);
              }}
              className="rounded-lg border border-red-200 px-3.5 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Decline…
            </button>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>

          {editing && edit && (
            <FinanceEditModal
              submissionId={submissionId}
              name={summary.name}
              model={edit}
              onClose={() => setEditing(false)}
            />
          )}

          {declining && (
            <div
              className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
              aria-label={`Decline ${summary.name}'s request`}
            >
              <div className="modal-in w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl">
                <h3 className="text-sm font-semibold text-ink">
                  Decline {summary.name}&rsquo;s request
                </h3>
                <p className="mt-1 text-xs text-muted-fg">
                  The note reopens their form until the filing deadline &mdash;
                  declining on the window&rsquo;s last day adds one more day.
                </p>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  autoFocus
                  rows={3}
                  maxLength={1000}
                  placeholder="What needs fixing — required"
                  className="mt-3 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
                />
                {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setDeclining(false)}
                    className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isPending || note.trim().length === 0}
                    onClick={decline}
                    className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPending ? "Declining…" : "Decline request"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      }
    >
      {children}
    </PanelRowShell>
  );
}
