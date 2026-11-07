// Read-only view of a filed pay request — what the employee sees once their
// submission is in (or through) review: status, the frozen snapshot breakdown,
// expenses with receipts, how they'll be paid, the invoice PDF, and the full
// audit trail. Server-rendered; nothing here mutates.

import { formatMoney } from "@/lib/penalties";
import {
  formatCents,
  payrollMathRows,
  PAYROLL_STATUS_BADGE,
  PAYROLL_STATUS_LABEL,
  type PayrollStatus,
} from "@/lib/payrollTypes";
import { LedgerBreakdown, type LedgerLineView } from "./LedgerBreakdown";
import { PartsBreakdown, type PartView } from "./PartsBreakdown";

export type SubmissionEventView = {
  id: string;
  label: string;
  actorName: string | null; // null = the system
  dateLabel: string;
  note: string | null;
};

export type SubmissionExpenseView = {
  id: string;
  label: string;
  /** Cents — a filed expense keeps the price that was actually paid. */
  amountCents: number;
  receipt: { id: string; filename: string } | null;
};

export type SubmissionViewModel = {
  id: string;
  status: PayrollStatus;
  banner: { tone: string; text: string } | null;
  baseSalary: number;
  bonusesTotal: number;
  finesTotal: number;
  expensesTotalCents: number;
  netTotal: number;
  bonuses: LedgerLineView[];
  fines: LedgerLineView[];
  expenses: SubmissionExpenseView[];
  paymentLine: string;
  /** The payout instructions, labelled — shown in full, unlike on the PDF. */
  paymentDetails: { label: string; value: string }[];
  events: SubmissionEventView[];
  /** The department split, when the request has one (PayrollPart). */
  parts?: PartView[];
  /** Overrides the status badge — "Partly paid" on a split request. */
  statusLabel?: string;
};

export function SubmissionView({
  heading,
  view,
}: {
  heading: string;
  view: SubmissionViewModel;
}) {
  const mathRows = payrollMathRows(view);

  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{heading}</h2>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${PAYROLL_STATUS_BADGE[view.status]}`}
        >
          {view.statusLabel ?? PAYROLL_STATUS_LABEL[view.status]}
        </span>
      </div>

      {view.banner && (
        <div className={`mt-3 rounded-lg border p-3 text-sm ${view.banner.tone}`}>
          {view.banner.text}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-line bg-canvas/60 p-3">
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
        <div className="mt-4">
          <PartsBreakdown
            parts={view.parts}
            showProgress={view.status !== "DECLINED" && view.status !== "EXPIRED"}
          />
        </div>
      )}

      <div className="mt-4">
        <LedgerBreakdown
          bonuses={view.bonuses}
          fines={view.fines}
          bonusesTotal={view.bonusesTotal}
          finesTotal={view.finesTotal}
        />
      </div>

      {view.expenses.length > 0 && (
        <div className="mt-4 rounded-lg border border-line p-3">
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-fg">
            Paying to: <span className="font-medium text-ink">{view.paymentLine}</span>
          </p>
          {/* Your own details, in full — you typed them, and seeing them back
              is how you catch a mistyped digit before finance pays it. */}
          {view.paymentDetails.length > 0 && (
            <dl className="mt-1 flex flex-col gap-0.5">
              {view.paymentDetails.map((d) => (
                <div key={d.label} className="flex gap-1.5 text-xs">
                  <dt className="text-muted-fg">{d.label}:</dt>
                  <dd className="min-w-0 break-words font-medium text-ink">
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
          className="shrink-0 whitespace-nowrap rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-brand shadow-sm transition hover:bg-canvas"
        >
          Invoice PDF ↗
        </a>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
          History
        </h4>
        <ul className="mt-2 flex flex-col gap-1.5">
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
    </section>
  );
}
