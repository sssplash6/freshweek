"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  PanelRowShell,
  type PanelRowSummary,
} from "../_components/PanelRowShell";
import { RowTick, RowTickSpacer } from "../_components/PaySelection";
// The reviewer's moves stay in ../finance, next to the state machine they
// drive. Only the UI moved here when the three panels merged.
import { confirmPayment, declineSubmission } from "../finance/actions";

/**
 * A panel row plus the reviewer's moves — pay it, or decline it back to the
 * filer with a required note (a small modal) — and the tick that hands it to
 * the batch bar instead, to be paid alongside the other ticked rows. The
 * revalidated page moves the row on success; this component only holds the
 * open/typing state.
 *
 * `mode` is which verbs the PAGE has established for this row, never a
 * permission this row worked out for itself:
 *
 *   "pay"     — the reviewer's own desk: confirm payment, or decline.
 *   "unstick" — a request still waiting on its department lead. It cannot be
 *               paid by anyone (PAYABLE in ../finance/actions.ts) so there is
 *               no Confirm button and no batch tick, but sending it back to
 *               the filer stays available: a request parked on an absent
 *               lead's desk blocks that person from ever filing again, and
 *               this is the one exit from it.
 *
 * There is still no `canAct` prop, and that distinction matters: /payroll/panel
 * renders this component only for the reviewer, and picks the mode from the
 * row's stage. A row can therefore never talk itself into showing a button by
 * inspecting its own status, which is the failure mode a single merged panel
 * invites.
 *
 * It used to be one of a pair — an admin stage approved a request onward and
 * finance paid it. With one stage the two rows became one, and the decline
 * that was the admin's is the reviewer's: it is also how a payment refused for
 * snapshot drift gets back to the only person who can refile it.
 */
export function FinanceRow({
  submissionId,
  summary,
  mode = "pay",
  children,
}: {
  submissionId: string;
  summary: PanelRowSummary;
  mode?: "pay" | "unstick";
  children: ReactNode;
}) {
  const payable = mode === "pay";
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
      // In "pay" mode the tick and the Confirm button below are the same
      // permission seen twice: the page established that this viewer may pay
      // this request. RowTick draws nothing when the row is outside a board
      // that can batch.
      select={
        payable ? (
          <RowTick id={submissionId} name={summary.name} disabled={isPending} />
        ) : (
          // Nothing to batch on a row nobody can pay, but the column still
          // has to line up with the rows around it.
          <RowTickSpacer />
        )
      }
      footer={
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {payable && (
              <button
                type="button"
                disabled={isPending}
                onClick={confirm}
                className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPending && !declining ? "Confirming…" : "Confirm payment"}
              </button>
            )}
            {!payable && (
              <p className="text-xs text-muted-fg">
                Waiting on their department lead — it can&rsquo;t be paid until
                they approve it.
              </p>
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
              {payable ? "Decline…" : "Send back to filer…"}
            </button>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>

          {declining && (
            <div
              className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
              aria-label={
                payable
                  ? `Decline ${summary.name}'s request`
                  : `Send ${summary.name}'s request back`
              }
            >
              <div className="modal-in w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl">
                <h3 className="text-sm font-semibold text-ink">
                  {payable ? "Decline" : "Send back"} {summary.name}
                  &rsquo;s request
                </h3>
                <p className="mt-1 text-xs text-muted-fg">
                  {payable ? (
                    <>
                      The note reopens their form until the filing deadline
                      &mdash; declining on the window&rsquo;s last day adds one
                      more day.
                    </>
                  ) : (
                    <>
                      This takes the request off their lead&rsquo;s desk and
                      returns it to the person who filed it, with the note and
                      the usual resubmit deadline. Their lead still has to
                      approve whatever they refile.
                    </>
                  )}
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
                    {isPending
                      ? payable
                        ? "Declining…"
                        : "Sending back…"
                      : payable
                        ? "Decline request"
                        : "Send it back"}
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
