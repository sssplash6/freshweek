"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  PanelRowShell,
  type PanelRowSummary,
} from "../_components/PanelRowShell";
import { RowTickSpacer } from "../_components/PaySelection";
import { approveAsLead, sendBackAsLead } from "./actions";

/**
 * A team member's request plus the lead's two moves at this stage: approve it,
 * or send it back with a required note. Paying comes after approval and on a
 * different row (SettleRow) — nobody pays a request that has not been
 * approved, the lead who would approve it included.
 *
 * Modelled on FinanceRow in ../panel, including the part that matters most:
 * there is no `canAct` prop. This component IS the permission — ../team/page
 * renders it only for a row that is waiting on THIS viewer, and the bare
 * PanelRowShell otherwise, so a row can never reason its way into showing a
 * button. The actions re-check the same thing server-side.
 *
 * A lead approves the request as filed and never edits it. Someone else's
 * claim stays theirs: if a line is wrong it goes back to them to fix, which is
 * also the only way the numbers finance eventually pays keep matching the
 * person who put their name to them.
 */
export function LeadRow({
  submissionId,
  summary,
  children,
}: {
  submissionId: string;
  summary: PanelRowSummary;
  children: ReactNode;
}) {
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function approve() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await approveAsLead(submissionId);
        if (!res.ok) setError(res.error);
      } catch {
        setError("Couldn't approve — try again.");
      }
    });
  }

  function sendBack() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await sendBackAsLead(submissionId, note);
        if (!res.ok) setError(res.error);
        else {
          setSendingBack(false);
          setNote("");
        }
      } catch {
        setError("Couldn't send it back — try again.");
      }
    });
  }

  return (
    <PanelRowShell
      summary={summary}
      // Nothing to tick until it is approved, but the column still has to line
      // up with the rows that can be batched (the spacer draws itself only
      // while something on the page is tickable).
      select={<RowTickSpacer />}
      footer={
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              disabled={isPending}
              onClick={approve}
              className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending && !sendingBack ? "Approving…" : "Approve for finance"}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                setError(null);
                setSendingBack(true);
              }}
              className="rounded-lg border border-red-200 px-3.5 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send back…
            </button>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>

          {sendingBack && (
            <div
              className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
              aria-label={`Send ${summary.name}'s request back`}
            >
              <div className="modal-in w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl">
                <h3 className="text-sm font-semibold text-ink">
                  Send {summary.name}&rsquo;s request back
                </h3>
                <p className="mt-1 text-xs text-muted-fg">
                  They get the note by email, with their form reopened and
                  prefilled. Once they refile it comes back here for your
                  approval, then goes to finance.
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
                    onClick={() => setSendingBack(false)}
                    className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isPending || note.trim().length === 0}
                    onClick={sendBack}
                    className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPending ? "Sending back…" : "Send it back"}
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
