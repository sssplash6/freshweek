"use client";

import { useState, useTransition } from "react";
import { formatMoney } from "@/lib/penalties";
import { usePaySelection } from "./PaySelection";
import { confirmPayments } from "../finance/actions";

/**
 * The batch end of the row ticks: one bar over the bottom of the panel while
 * anything is ticked, and the confirmation that pays them.
 *
 * Like the rows it settles, this component IS the permission — there is no
 * `canPay` prop. A page renders it only for a viewer who may pay something:
 * /payroll/panel for the reviewer, /payroll/team for a department lead over
 * their own members. Anyone else never has the action module in their bundle,
 * whatever they manage to tick. (Nothing ticks for them either: the ticks live
 * on FinanceRow and SettleRow, and a page only renders those on a row it has
 * established this viewer may pay.)
 *
 * The bar is the count and the money; the modal is the list. Paying several
 * people is one click more than paying one on purpose — the tick is what
 * chooses, and seeing the names and the total together is the last chance to
 * notice that the filter you paid from was not the one you meant.
 */
export function BatchPayBar() {
  const selection = usePaySelection();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * What the last batch did, kept so the modal can name who did not go
   * through. Cleared whenever the modal is opened again, so an old failure
   * cannot be read as a fresh one.
   */
  const [failed, setFailed] = useState<{ name: string; error: string }[]>([]);
  const [paid, setPaid] = useState(0);
  const [isPending, startTransition] = useTransition();

  const selected = selection?.selected ?? [];
  const total = selected.reduce((sum, r) => sum + r.net, 0);
  const n = selected.length;

  if (!selection || n === 0) return null;

  function pay() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await confirmPayments(selected.map((r) => r.id));
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setPaid(res.paid);
        setFailed(res.failed.map((f) => ({ name: f.name, error: f.error })));
        // Everything settled: the paid rows are no longer payable, so the
        // revalidated page prunes them out of the selection by itself and the
        // bar goes with them. A partial batch keeps the modal open instead,
        // because the names that failed are the whole point of the answer.
        if (res.failed.length === 0) setOpen(false);
      } catch {
        setError("Couldn't confirm those payments — try again.");
      }
    });
  }

  return (
    <>
      {/* The strip is full width so the bar can centre in it, and lets clicks
          through everywhere the bar itself is not. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4">
        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-surface px-4 py-3 shadow-xl">
          <span className="text-sm font-semibold text-ink">
            {n} selected
            <span className="text-muted-fg"> · </span>
            <span className="tabular-nums">{formatMoney(total)}</span>
          </span>
          <button
            type="button"
            onClick={selection.clear}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted-fg transition hover:text-ink"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setError(null);
              setFailed([]);
              setPaid(0);
              setOpen(true);
            }}
            className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {`Confirm ${n} ${n === 1 ? "payment" : "payments"}`}
          </button>
        </div>
      </div>

      {open && (
        <div
          className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm these payments"
        >
          <div className="modal-in w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-ink">
              {`Confirm ${n} ${n === 1 ? "payment" : "payments"}`}
            </h3>
            <p className="mt-1 text-xs text-muted-fg">
              Each one records its fine deduction, closes the request and emails
              the person their final invoice.
            </p>

            <ul className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-line">
              {selected.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="min-w-0 truncate text-ink">{r.name}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-ink">
                    {formatMoney(r.net)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 flex items-center justify-between gap-3 px-1 text-sm">
              <span className="font-semibold text-ink">Total</span>
              <span className="font-bold tabular-nums text-ink">
                {formatMoney(total)}
              </span>
            </p>

            {/* A batch settles one request at a time, so some of it going
                through and some of it not is an ordinary answer, not an error
                — say which people still need a decision. */}
            {failed.length > 0 && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-3">
                <p className="text-xs font-semibold text-red-700">
                  {`${paid} paid · ${failed.length} still ${failed.length === 1 ? "needs" : "need"} a decision`}
                </p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {failed.map((f) => (
                    <li key={f.name} className="text-xs text-red-700">
                      <span className="font-semibold">{f.name}</span>
                      {` — ${f.error}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
              >
                {failed.length > 0 ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={pay}
                className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPending
                  ? "Paying…"
                  : failed.length > 0
                    ? `Retry ${n}`
                    : `Pay ${n} ${n === 1 ? "request" : "requests"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
