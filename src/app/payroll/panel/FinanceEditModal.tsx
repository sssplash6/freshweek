"use client";

import { useState, useTransition } from "react";
import {
  computeNet,
  formatCents,
  parseAmountCents,
} from "@/lib/payrollTypes";
import { formatMoney, PENALTY_CURRENCY } from "@/lib/penalties";
import { editSubmissionAsFinance } from "../finance/actions";

/**
 * What the reviewer may change on one request, as the panel hands it over.
 * Amounts are the CURRENT snapshot; the form can lower a ledger-bound line or
 * drop it, never raise it — raising a bonus is a new award and raising a fine
 * deduction settles money nobody owes, and both are refused server-side too.
 */
export type FinanceEditModel = {
  baseSalary: number;
  bonusLines: { id: string; label: string; amount: number }[];
  fineLines: { id: string; label: string; amount: number }[];
  expenses: { id: string; label: string; amountCents: number; hasReceipt: boolean }[];
};

type ExpenseDraft = {
  /** Existing line id, or null for one the reviewer added. */
  id: string | null;
  label: string;
  /** As typed, in dollars — parsed to cents on save. */
  amount: string;
  hasReceipt: boolean;
};

/**
 * Revise a request's figures before paying it.
 *
 * The net is computed with the same `computeNet` the action uses, so the figure
 * previewed here is the figure that gets written — including the half-up
 * rounding, which is the one place a preview and a payout could otherwise
 * disagree by a cent.
 */
export function FinanceEditModal({
  submissionId,
  name,
  model,
  onClose,
}: {
  submissionId: string;
  name: string;
  model: FinanceEditModel;
  onClose: () => void;
}) {
  const [baseSalary, setBaseSalary] = useState(String(model.baseSalary));
  const [bonuses, setBonuses] = useState(
    model.bonusLines.map((l) => ({ ...l, value: String(l.amount) })),
  );
  const [fines, setFines] = useState(
    model.fineLines.map((l) => ({ ...l, value: String(l.amount) })),
  );
  const [expenses, setExpenses] = useState<ExpenseDraft[]>(
    model.expenses.map((e) => ({
      id: e.id,
      label: e.label,
      amount: (e.amountCents / 100).toFixed(2),
      hasReceipt: e.hasReceipt,
    })),
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const salaryNum = Math.max(0, Math.round(Number(baseSalary) || 0));
  const bonusesTotal = bonuses.reduce((s, b) => s + (Math.round(Number(b.value)) || 0), 0);
  const finesTotal = fines.reduce((s, f) => s + (Math.round(Number(f.value)) || 0), 0);
  const expensesTotalCents = expenses.reduce(
    (s, e) => s + (parseAmountCents(e.amount) ?? 0),
    0,
  );
  const netPreview = computeNet({
    baseSalary: salaryNum,
    bonusesTotal,
    finesTotal,
    expensesTotalCents,
  });

  function save() {
    for (const e of expenses) {
      if (!e.label.trim()) {
        setError("Every expense line needs a label.");
        return;
      }
      if (parseAmountCents(e.amount) == null) {
        setError(`“${e.label}” needs a valid amount.`);
        return;
      }
    }
    if (!reason.trim()) {
      setError("Say what you changed and why — the filer is told.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await editSubmissionAsFinance(submissionId, {
          reason,
          baseSalary: salaryNum,
          expenses: expenses.map((e) => ({
            id: e.id,
            label: e.label.trim(),
            amountCents: parseAmountCents(e.amount) ?? 0,
          })),
          bonusLines: bonuses.map((b) => ({
            id: b.id,
            amount: Math.round(Number(b.value)) || 0,
          })),
          fineLines: fines.map((f) => ({
            id: f.id,
            amount: Math.round(Number(f.value)) || 0,
          })),
        });
        if (!res.ok) setError(res.error);
        else onClose();
      } catch {
        setError("Couldn't save that — try again.");
      }
    });
  }

  return (
    <div
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Revise ${name}'s request`}
    >
      <div className="modal-in flex max-h-[88vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-xl">
        <h3 className="text-sm font-semibold text-ink">
          Revise {name}&rsquo;s request
        </h3>
        <p className="mt-1 text-xs text-muted-fg">
          Nothing is paid yet. {name} is told what changed and why, and gets the
          revised invoice.
        </p>

        <label className="mt-4 flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-ink">Base salary</span>
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              value={baseSalary}
              onChange={(e) => setBaseSalary(e.target.value)}
              className="w-32 rounded-lg border border-line px-2.5 py-1 text-right text-sm tabular-nums text-ink focus:border-brand focus:outline-none"
            />
            <span className="text-[11px] text-muted-fg">{PENALTY_CURRENCY}</span>
          </span>
        </label>

        {bonuses.length > 0 && (
          <Section
            title="Compensations"
            hint="Lower or zero a line. A zeroed bonus returns to the ledger for next month; a lowered one revises the bonus itself, and they're told."
          >
            {bonuses.map((b, i) => (
              <LineRow
                key={b.id}
                label={b.label}
                value={b.value}
                max={b.amount}
                onChange={(v) =>
                  setBonuses((prev) =>
                    prev.map((p, j) => (i === j ? { ...p, value: v } : p)),
                  )
                }
              />
            ))}
          </Section>
        )}

        {fines.length > 0 && (
          <Section
            title="Fine deductions"
            hint="Lower or zero a line to deduct less this month. Whatever is left stays owed and rolls into the next filing."
          >
            {fines.map((f, i) => (
              <LineRow
                key={f.id}
                label={f.label}
                value={f.value}
                max={f.amount}
                onChange={(v) =>
                  setFines((prev) =>
                    prev.map((p, j) => (i === j ? { ...p, value: v } : p)),
                  )
                }
              />
            ))}
          </Section>
        )}

        <Section title="Expenses" hint="Edit, remove or add a line.">
          {expenses.map((e, i) => (
            <div key={e.id ?? `new-${i}`} className="flex items-center gap-2">
              <input
                type="text"
                value={e.label}
                maxLength={120}
                onChange={(ev) =>
                  setExpenses((prev) =>
                    prev.map((p, j) => (i === j ? { ...p, label: ev.target.value } : p)),
                  )
                }
                className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1 text-sm text-ink focus:border-brand focus:outline-none"
              />
              {e.hasReceipt && (
                <span className="shrink-0 text-[11px] text-muted-fg" title="Has a receipt">
                  📎
                </span>
              )}
              <input
                type="text"
                inputMode="decimal"
                value={e.amount}
                onChange={(ev) =>
                  setExpenses((prev) =>
                    prev.map((p, j) => (i === j ? { ...p, amount: ev.target.value } : p)),
                  )
                }
                className="w-24 shrink-0 rounded-lg border border-line px-2.5 py-1 text-right text-sm tabular-nums text-ink focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setExpenses((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${e.label || "expense"}`}
                className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-fg transition hover:text-red-500"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setExpenses((prev) => [
                ...prev,
                { id: null, label: "", amount: "0.00", hasReceipt: false },
              ])
            }
            className="self-start rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand-soft/60"
          >
            + Add a line
          </button>
        </Section>

        <div className="mt-4 flex items-center justify-between rounded-lg border border-line bg-canvas/60 px-3 py-2">
          <span className="text-xs font-medium text-muted-fg">
            {`Net (was ${formatMoney(
              computeNet({
                baseSalary: model.baseSalary,
                bonusesTotal: model.bonusLines.reduce((s, l) => s + l.amount, 0),
                finesTotal: model.fineLines.reduce((s, l) => s + l.amount, 0),
                expensesTotalCents: model.expenses.reduce((s, e) => s + e.amountCents, 0),
              }),
            )})`}
          </span>
          <span className="text-base font-bold tabular-nums text-ink">
            {formatMoney(netPreview)}
          </span>
        </div>
        <p className="mt-1 text-right text-[11px] text-muted-fg">
          {`expenses ${formatCents(expensesTotalCents)}`}
        </p>

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="What changed and why — required, and sent to them"
          className="mt-3 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
        />

        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            disabled={isPending}
            onClick={onClose}
            className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-canvas"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || netPreview < 0 || reason.trim().length === 0}
            onClick={save}
            className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save revision"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
        {title}
      </p>
      <p className="text-[11px] leading-snug text-muted-fg">{hint}</p>
      {children}
    </div>
  );
}

/** One ledger-bound line: its own note, and an amount that can only come down. */
function LineRow({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-xs text-ink" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-[11px] text-muted-fg">
        {`of ${formatMoney(max)}`}
      </span>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 shrink-0 rounded-lg border border-line px-2.5 py-1 text-right text-sm tabular-nums text-ink focus:border-brand focus:outline-none"
      />
    </div>
  );
}
