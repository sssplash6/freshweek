// The reviewer's expanded view of one pay request: the arithmetic, the frozen
// snapshot, expenses with receipts, the payment source (nothing is withheld
// here — reviewers move the money, and since card numbers left the app there
// is nothing left to mask), the invoice PDF, and the audit trail.
// Server-rendered and passed into the interactive panel rows as children.

import { formatMoney } from "@/lib/penalties";
import { formatCents, payrollMathRows } from "@/lib/payrollTypes";
import { LedgerBreakdown, type LedgerLineView } from "./LedgerBreakdown";
import { PartsBreakdown, type PartView } from "./PartsBreakdown";
import type {
  SubmissionEventView,
  SubmissionExpenseView,
} from "./SubmissionView";

export type SubmissionDetailModel = {
  id: string;
  baseSalary: number;
  bonusesTotal: number;
  finesTotal: number;
  expensesTotalCents: number;
  netTotal: number;
  bonuses: LedgerLineView[];
  fines: LedgerLineView[];
  expenses: SubmissionExpenseView[];
  paymentLine: string;
  /** Everything finance needs to send the money, in full (the PDF masks it). */
  paymentDetails: { label: string; value: string }[];
  events: SubmissionEventView[];
  /** The department split, when the request has one (PayrollPart). */
  parts?: PartView[];
  /** Whether approvals and payments on the parts are live (not sent back). */
  partsLive?: boolean;
};

export function SubmissionDetail({ view }: { view: SubmissionDetailModel }) {
  const mathRows = payrollMathRows(view);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-line bg-canvas/60 p-3">
        <dl className="flex flex-col gap-1">
          {mathRows.map((r) => (
            <div key={r.label} className="flex items-center justify-between text-sm">
              <dt className="text-muted-fg">{r.label}</dt>
              <dd className={`font-medium tabular-nums ${r.tone ?? "text-ink"}`}>
                {r.value}
              </dd>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-line pt-2">
            <dt className="text-sm font-semibold text-ink">Total</dt>
            <dd className="text-base font-bold tabular-nums text-ink">
              {formatMoney(view.netTotal)}
            </dd>
          </div>
        </dl>
      </div>

      {view.parts && view.parts.length > 0 && (
        <PartsBreakdown parts={view.parts} showProgress={view.partsLive ?? true} />
      )}

      <LedgerBreakdown
        bonuses={view.bonuses}
        fines={view.fines}
        bonusesTotal={view.bonusesTotal}
        finesTotal={view.finesTotal}
      />

      {view.expenses.length > 0 && (
        <div className="rounded-lg border border-line p-3">
          <h4 className="text-xs font-semibold text-ink">Expenses</h4>
          <ul className="mt-2 flex flex-col">
            {view.expenses.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-3 border-t border-line py-1.5 text-xs first:border-t-0"
              >
                <span className="min-w-0 text-ink">
                  {e.label}
                  {e.receipt && (
                    <>
                      {" "}
                      <a
                        href={`/payroll/receipts/${e.receipt.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-brand hover:underline"
                      >
                        receipt ↗
                      </a>
                    </>
                  )}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-ink">
                  + {formatCents(e.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* "Source" is the accounting sheet's own column name. The panels
            group by it and finance reconciles against it line by line, so the
            detail names it the same way instead of inventing a synonym, and
            gives it a chip rather than burying it in grey body text. */}
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-fg">
            Source
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">
              {view.paymentLine}
            </span>
          </p>
          {/* In full here, and only here: this is the screen the payment gets
              made from. The emailed invoice carries the last four. */}
          {view.paymentDetails.length > 0 && (
            <dl className="mt-1.5 flex flex-col gap-0.5">
              {view.paymentDetails.map((d) => (
                <div key={d.label} className="flex gap-1.5 text-xs">
                  <dt className="text-muted-fg">{d.label}:</dt>
                  <dd className="min-w-0 break-words font-medium tabular-nums text-ink">
                    {d.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <a
          href={`/payroll/submissions/${view.id}/pdf`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 whitespace-nowrap rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-canvas"
        >
          Invoice PDF ↗
        </a>
      </div>

      <div className="border-t border-line pt-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
          History
        </h4>
        <ul className="mt-1.5 flex flex-col gap-1">
          {view.events.map((e) => (
            <li key={e.id} className="text-xs text-muted-fg">
              <span className="font-medium text-ink">{e.label}</span>
              {e.actorName && <> · {e.actorName}</>}
              <> · {e.dateLabel}</>
              {e.note && <p className="mt-0.5 italic">“{e.note}”</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
