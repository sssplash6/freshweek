"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  PanelRowShell,
  type PanelRowSummary,
} from "../_components/PanelRowShell";
import { RowTick, RowTickSpacer } from "../_components/PaySelection";
// The pay verb stays in ../finance, next to the state machine it drives —
// there is one payment path, and a lead calling it is the same call finance
// makes (requirePayer in lib/payroll.ts scopes it to their people).
import { confirmPayment, undoPayment } from "../finance/actions";

/**
 * A request this lead has already approved, plus the move that finishes it:
 * confirm that it is paid. The tick beside it hands the row to the batch bar
 * instead, to be settled alongside the rest of the department.
 *
 * Like LeadRow, this component IS the permission — there is no `canPay` prop.
 * ../team/page renders it only for a row of theirs that is awaiting payment,
 * and the read-only shell otherwise, so a row cannot reason its way into a
 * button; `confirmPayment` re-checks both the status and the filer server-side
 * before any money moves.
 *
 * Confirming is a RECORD OF A PAYMENT MADE, not a transfer: the money leaves
 * by whatever the person asked for (their payout details are on the detail
 * below), and this is what writes the fine deductions back to the ledger,
 * consumes the bonuses, and emails them the final invoice. So it says so — a
 * button that reads "Confirm payment" on a desk that has never paid anybody
 * before is worth one line of explanation.
 */
export function SettleRow({
  submissionId,
  summary,
  children,
}: {
  submissionId: string;
  summary: PanelRowSummary;
  children: ReactNode;
}) {
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

  return (
    <PanelRowShell
      summary={summary}
      select={
        <RowTick id={submissionId} name={summary.name} disabled={isPending} />
      }
      footer={
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <button
            type="button"
            disabled={isPending}
            onClick={confirm}
            className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Confirming…" : "Confirm payment"}
          </button>
          <p className="min-w-0 flex-1 text-xs text-muted-fg">
            Once they have the money: this records the fine deductions, marks
            the bonuses paid out, and emails them the final invoice.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      }
    >
      {children}
    </PanelRowShell>
  );
}

/**
 * A request this lead has paid, plus the way back from a mis-click: undo the
 * payment. Two steps on purpose — an undo reverses fine deductions, so it asks
 * once. `undoPayment` re-checks status and filer server-side like the rest.
 */
export function PaidRow({
  submissionId,
  summary,
  children,
}: {
  submissionId: string;
  summary: PanelRowSummary;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function undo() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await undoPayment(submissionId);
        if (!res.ok) setError(res.error);
      } catch {
        setError("Couldn't undo — try again.");
      }
    });
  }

  return (
    <PanelRowShell
      summary={summary}
      select={<RowTickSpacer />}
      footer={
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {asking ? (
            <>
              <button
                type="button"
                disabled={isPending}
                onClick={undo}
                className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPending ? "Undoing…" : "Yes, undo payment"}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => setAsking(false)}
                className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted-fg transition hover:text-ink"
              >
                Cancel
              </button>
              <p className="min-w-0 flex-1 text-xs text-muted-fg">
                Puts it back to waiting for payment and reverses the fine
                deductions it recorded.
              </p>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setAsking(true)}
              className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted-fg transition hover:text-ink"
            >
              Undo payment
            </button>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      }
    >
      {children}
    </PanelRowShell>
  );
}
