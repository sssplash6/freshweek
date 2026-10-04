"use client";

import { useRef, useState, useTransition } from "react";
import { submitPayroll } from "../actions";
import { formatMoney } from "@/lib/penalties";
import {
  computeNet,
  formatCents,
  MAX_PAYROLL_EXPENSES,
  parseAmountCents,
  roundingCents,
  MAX_RECEIPT_BYTES,
  methodIsCash,
  paymentFieldsFor,
  validatePaymentDetails,
  PAYROLL_METHOD_LABEL,
  PAYROLL_METHODS_OFFERED,
  RECEIPT_MIME_TYPES,
  type PaymentDetails,
  type PaymentFieldKey,
  type PayrollMethod,
} from "@/lib/payrollTypes";
import { TrashIcon } from "@/app/dashboard/_components/icons";
import { LedgerBreakdown, type LedgerLineView } from "./LedgerBreakdown";
import { ResubmitCountdown } from "./ResubmitCountdown";

type ExpenseDraft = {
  key: number;
  /** Set when the line came back from a declined submission — resubmitting
   * keeps that row (and its stored receipt) instead of recreating it. */
  existingId: string | null;
  existingReceiptName: string | null;
  label: string;
  amount: string;
  file: File | null;
};

/**
 * Cents → what the field shows: "1.95", or "39" when there are no cents. The
 * amount is never rounded on the way in or out — only the net is.
 */
function centsToInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export type PrefillExpense = {
  id: string;
  label: string;
  amountCents: number;
  receiptName: string | null;
};

/**
 * The monthly filing form: self-reported base salary, the read-only ledger
 * snapshot preview, repeatable expense lines with optional receipts, the
 * payment method, and the running arithmetic — base + bonuses − fines +
 * expenses — shown as sums, not just a result. One submit files the request
 * and generates the invoice PDF; the same form reopens to refile after a
 * decline, or to edit a request finance hasn't reached yet (see `mode`).
 */
export function PayrollForm({
  periodLabel,
  closesLabel,
  snapshot,
  prefill,
  mode,
}: {
  periodLabel: string;
  /** When filing shuts, or null while the period is held open with no cutoff. */
  closesLabel: string | null;
  snapshot: {
    bonuses: LedgerLineView[];
    fines: LedgerLineView[];
    bonusesTotal: number;
    finesTotal: number;
  };
  prefill: {
    baseSalary: number | null;
    method: PayrollMethod;
    details: PaymentDetails;
    /** The declined submission's expense lines, back on the reopened form. */
    expenses?: PrefillExpense[];
  };
  /**
   * Which of the three ways this form is open:
   *  - file   — nothing filed for this period yet
   *  - refile — finance declined it; there's a clock and a reason
   *  - edit   — it's filed and nobody has reviewed it, so it can still change
   */
  mode:
    | { kind: "file" }
    | {
        kind: "refile";
        /** Null while the period is held open: no cutoff, so no clock. */
        deadlineIso: string | null;
        deadlineLabel: string | null;
        note: string | null;
      }
    | { kind: "edit" };
}) {
  const [base, setBase] = useState(
    prefill.baseSalary != null ? String(prefill.baseSalary) : "",
  );
  // Optional second base salary (another department). Not stored separately:
  // it is summed into the one baseSalary figure everything downstream uses.
  const [base2, setBase2] = useState<string | null>(null);
  const [expenses, setExpenses] = useState<ExpenseDraft[]>(() =>
    (prefill.expenses ?? []).map((e, i) => ({
      key: i + 1,
      existingId: e.id,
      existingReceiptName: e.receiptName,
      label: e.label,
      amount: centsToInput(e.amountCents),
      file: null,
    })),
  );
  const nextKey = useRef((prefill.expenses?.length ?? 0) + 1);
  const [method, setMethod] = useState<PayrollMethod>(prefill.method);
  // One bag for every payout field. Switching method changes which of them are
  // asked for (paymentFieldsFor) but keeps what was already typed, so flicking
  // between the two card methods doesn't wipe the card you just entered — only
  // the fields the chosen method asks for are submitted.
  const [details, setDetails] = useState<PaymentDetails>(prefill.details);
  const detailFields = paymentFieldsFor(method);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const base1Value = /^\d+$/.test(base.trim()) ? Number(base.trim()) : null;
  const base2Trim = base2?.trim() ?? "";
  const base2Value = base2Trim === "" ? 0 : /^\d+$/.test(base2Trim) ? Number(base2Trim) : null;
  const baseValue =
    base1Value == null || base2Value == null ? null : base1Value + base2Value;
  const expensesTotalCents = expenses.reduce(
    (s, e) => s + (parseAmountCents(e.amount) ?? 0),
    0,
  );
  const totals = {
    baseSalary: baseValue ?? 0,
    bonusesTotal: snapshot.bonusesTotal,
    finesTotal: snapshot.finesTotal,
    expensesTotalCents,
  };
  // What lands in the account: the exact sum, rounded to the whole dollar once.
  const net = computeNet(totals);
  const rounding = roundingCents(totals);

  function patchExpense(key: number, patch: Partial<ExpenseDraft>) {
    setExpenses((prev) =>
      prev.map((e) => (e.key === key ? { ...e, ...patch } : e)),
    );
  }

  function patchDetail(key: PaymentFieldKey, value: string) {
    setDetails((prev) => ({ ...prev, [key]: value }));
  }

  function pickReceipt(key: number, file: File | null) {
    if (file) {
      if (file.size > MAX_RECEIPT_BYTES) {
        setError("That receipt is over 4MB — attach a smaller file.");
        return;
      }
      if (!RECEIPT_MIME_TYPES.includes(file.type)) {
        setError("Receipts must be an image or a PDF.");
        return;
      }
    }
    setError(null);
    patchExpense(key, { file });
  }

  function submit() {
    if (baseValue == null) {
      setError("Enter your base salary in whole dollars.");
      return;
    }
    for (const e of expenses) {
      if (!e.label.trim()) {
        setError("Every expense needs a label.");
        return;
      }
      if (parseAmountCents(e.amount) == null) {
        setError(`Expense “${e.label.trim()}” needs an amount in dollars.`);
        return;
      }
    }
    const detailsError = validatePaymentDetails(method, details);
    if (detailsError) {
      setError(detailsError);
      return;
    }
    if (net < 0) {
      setError("The total can't go below zero — your fines exceed the rest.");
      return;
    }

    setError(null);
    const fd = new FormData();
    fd.set("baseSalary", String(baseValue));
    fd.set("paymentMethod", method);
    for (const f of detailFields) {
      fd.set(`detail_${f.key}`, (details[f.key] ?? "").trim());
    }
    fd.set(
      "expenses",
      JSON.stringify(
        expenses.map((e) => ({
          ...(e.existingId ? { id: e.existingId } : {}),
          label: e.label.trim(),
          amount: e.amount.trim(),
        })),
      ),
    );
    expenses.forEach((e, i) => {
      if (e.file) fd.set(`receipt_${i}`, e.file);
    });

    startTransition(async () => {
      try {
        const res = await submitPayroll(fd);
        if (!res.ok) setError(res.error);
        // On success the revalidated page swaps this form for the status view.
      } catch {
        setError("Couldn't submit — please try again.");
      }
    });
  }

  const mathRows: { label: string; value: string; tone?: string }[] = [
    { label: "Base salary", value: formatMoney(baseValue ?? 0) },
    {
      label: "Bonuses",
      value: `+ ${formatMoney(snapshot.bonusesTotal)}`,
      tone: "text-green-700",
    },
    {
      label: "Fines",
      value: `− ${formatMoney(snapshot.finesTotal)}`,
      tone: "text-red-600",
    },
    { label: "Expenses", value: `+ ${formatCents(expensesTotalCents)}` },
    // Only when there is one. Without this line the column visibly misses by a
    // few cents, which reads as a bug rather than as the rounding it is.
    ...(rounding !== 0
      ? [
          {
            label: "Rounding",
            value: `${rounding > 0 ? "+" : "−"} ${formatCents(Math.abs(rounding))}`,
          },
        ]
      : []),
  ];

  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      {mode.kind === "refile" && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="text-sm font-semibold text-red-700">
            Declined — fix it and resend
          </p>
          {mode.note && (
            <p className="mt-1 text-xs text-ink">“{mode.note}”</p>
          )}
          <div className="mt-1.5">
            {mode.deadlineIso && mode.deadlineLabel ? (
              <ResubmitCountdown
                deadlineIso={mode.deadlineIso}
                deadlineLabel={mode.deadlineLabel}
              />
            ) : (
              // Nothing to count down to — the month has no cutoff yet, and a
              // ticking clock would invent one.
              <p className="text-xs text-red-700">
                {`No deadline — ${periodLabel} is being held open, so resend it whenever you're ready.`}
              </p>
            )}
          </div>
        </div>
      )}

      {/* No countdown here on purpose: an edit is bounded by the review, not
          by a clock. It stops being possible the moment an admin acts. */}
      {mode.kind === "edit" && (
        <div className="mb-4 rounded-lg border border-brand/30 bg-brand-soft p-3">
          <p className="text-sm font-semibold text-brand">
            In review — you can still change it
          </p>
          <p className="mt-1 text-xs text-ink">
            Resending replaces what finance sees and tells them it changed.
            Once it is paid or declined, this closes.
          </p>
        </div>
      )}

      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">
          {mode.kind === "file"
            ? `File for ${periodLabel}`
            : mode.kind === "refile"
              ? `Refile for ${periodLabel}`
              : `Edit your ${periodLabel} request`}
        </h2>
        {mode.kind === "file" && (
          <span className="shrink-0 text-[11px] text-muted-fg">
            {closesLabel ? `Filing closes ${closesLabel}` : "Filing held open"}
          </span>
        )}
      </div>

      {/* Base salary */}
      <div className="mt-4">
        <label
          htmlFor="payroll-base"
          className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg"
        >
          Base salary (USD)
        </label>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-fg">$</span>
          <input
            id="payroll-base"
            type="text"
            inputMode="numeric"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="500"
            className="w-32 rounded-lg border border-line px-3 py-2 text-sm tabular-nums text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
          />
          {base2 === null ? (
            <button
              type="button"
              onClick={() => setBase2("")}
              aria-label="Add a base salary from another department"
              title="Add a base salary from another department"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-lg leading-none text-muted-fg hover:border-brand hover:text-brand"
            >
              +
            </button>
          ) : (
            <>
              <span className="text-sm font-semibold text-muted-fg">+ $</span>
              <input
                type="text"
                inputMode="numeric"
                value={base2}
                onChange={(e) => setBase2(e.target.value)}
                placeholder="Other department"
                aria-label="Second base salary (other department)"
                className="w-32 rounded-lg border border-line px-3 py-2 text-sm tabular-nums text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setBase2(null)}
                aria-label="Remove the second base salary"
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-lg leading-none text-muted-fg hover:border-red-300 hover:text-red-600"
              >
                ×
              </button>
            </>
          )}
        </div>
      </div>

      {/* Ledger snapshot preview */}
      <div className="mt-5">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
          From the ledger — snapshotted the moment you submit
        </p>
        <LedgerBreakdown {...snapshot} />
      </div>

      {/* Expenses */}
      <div className="mt-5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
          Miscellaneous expenses
        </p>
        {expenses.length > 0 && (
          <ul className="mt-2 flex flex-col gap-2">
            {expenses.map((e, i) => (
              <li key={e.key} className="rise-in flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={e.label}
                  onChange={(ev) => patchExpense(e.key, { label: ev.target.value })}
                  placeholder={`Expense ${i + 1} — e.g. taxi to a partner meeting`}
                  aria-label={`Expense ${i + 1} description`}
                  maxLength={120}
                  className="min-w-40 flex-1 rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
                />
                <div className="flex items-center gap-1 rounded-lg border border-line px-3 py-2">
                  <span className="text-sm text-muted-fg">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={e.amount}
                    onChange={(ev) => patchExpense(e.key, { amount: ev.target.value })}
                    placeholder="0"
                    aria-label={`Expense ${i + 1} amount in dollars`}
                    className="w-14 bg-transparent text-sm tabular-nums text-ink placeholder:text-muted-fg focus:outline-none"
                  />
                </div>
                <label className="cursor-pointer rounded-lg border border-line px-3 py-2 text-xs font-medium text-brand transition hover:bg-canvas">
                  {e.file ? (
                    <span className="max-w-32 truncate align-middle">
                      {e.file.name}
                    </span>
                  ) : e.existingReceiptName ? (
                    <span className="max-w-32 truncate align-middle">
                      {e.existingReceiptName}
                    </span>
                  ) : (
                    "Receipt (optional)"
                  )}
                  <input
                    type="file"
                    accept={RECEIPT_MIME_TYPES.join(",")}
                    className="sr-only"
                    onChange={(ev) => pickReceipt(e.key, ev.target.files?.[0] ?? null)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setExpenses((prev) => prev.filter((x) => x.key !== e.key))
                  }
                  aria-label={`Remove expense ${i + 1}`}
                  className="rounded-lg p-2 text-red-500 transition hover:bg-canvas"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {expenses.length < MAX_PAYROLL_EXPENSES ? (
          <button
            type="button"
            onClick={() =>
              setExpenses((prev) => [
                ...prev,
                {
                  key: nextKey.current++,
                  existingId: null,
                  existingReceiptName: null,
                  label: "",
                  amount: "",
                  file: null,
                },
              ])
            }
            className="mt-2 rounded-lg border border-dashed border-line px-3 py-2 text-xs font-semibold text-brand transition hover:border-brand/40 hover:bg-canvas"
          >
            + Add an expense
          </button>
        ) : (
          // At the cap the button used to just vanish, which reads as the form
          // breaking rather than as a limit — say so instead.
          <p className="mt-2 text-xs text-muted-fg">
            {`That's the maximum of ${MAX_PAYROLL_EXPENSES} expense lines — combine a few, or put the rest on next month's request.`}
          </p>
        )}
      </div>

      {/* Preferred payment method */}
      <div className="mt-5">
        <label
          htmlFor="payroll-method"
          className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg"
        >
          Preferred payment method
        </label>
        {/* A dropdown rather than the pills this used to be: the list mirrors
            the accounting sheet's "Source" column, and it changes with that
            sheet — options come straight from PAYROLL_METHODS_OFFERED, so
            finance adding or dropping a source never touches this file.
            A request filed under a source that has since been retired keeps it
            listed, exactly once, so reopening that form shows what was chosen
            instead of silently moving the money somewhere else. Picking
            anything current drops it from the list, because it can't be
            chosen again. */}
        <div className="mt-1.5">
          <select
            id="payroll-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as PayrollMethod)}
            className="w-72 max-w-full rounded-lg border border-line px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
          >
            {(PAYROLL_METHODS_OFFERED.includes(method)
              ? PAYROLL_METHODS_OFFERED
              : [method, ...PAYROLL_METHODS_OFFERED]
            ).map((m) => (
              <option key={m} value={m}>
                {PAYROLL_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        {/* Whatever this method asks for. The list is data (paymentFieldsFor),
            so a new method's fields appear here — and are validated and stored
            — without touching this file. */}
        {detailFields.length > 0 && (
          <div className="rise-in mt-2 flex flex-wrap gap-2">
            {detailFields.map((f) => (
              <label key={f.key} className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-fg">
                  {f.label}
                </span>
                {f.kind === "note" ? (
                  <textarea
                    value={details[f.key] ?? ""}
                    onChange={(e) => patchDetail(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    maxLength={f.maxLength}
                    rows={3}
                    className="w-72 max-w-full rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
                  />
                ) : (
                  <input
                    type={
                      f.kind === "email"
                        ? "email"
                        : f.kind === "phone"
                          ? "tel"
                          : "text"
                    }
                    inputMode={f.kind === "card" ? "numeric" : undefined}
                    autoComplete="off"
                    value={details[f.key] ?? ""}
                    onChange={(e) => patchDetail(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    maxLength={f.maxLength}
                    className="w-72 max-w-full rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
                  />
                )}
              </label>
            ))}
          </div>
        )}
        {/* Card numbers are typed here, so say where they go. The invoice is
            emailed, so it carries the last four only — the full number stays
            in the app, where finance reads it to make the payment. */}
        {detailFields.some((f) => f.kind === "card") && (
          <p className="rise-in mt-2 text-xs text-muted-fg">
            Finance sees these to pay you. The emailed invoice shows only the
            last four digits.
          </p>
        )}
        {methodIsCash(method) && (
          <p className="rise-in mt-2 text-xs text-muted-fg">
            Nothing else needed — you&rsquo;ll be paid in cash.
          </p>
        )}
        {/* The Uzbek company, and the retired off-app sources. */}
        {detailFields.length === 0 && !methodIsCash(method) && (
          <p className="rise-in mt-2 text-xs text-muted-fg">
            Finance will arrange the details with you directly — nothing to
            enter here.
          </p>
        )}
      </div>

      {/* The arithmetic, then the one button */}
      <div className="mt-5 rounded-lg border border-line bg-canvas/60 p-3">
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
            <dt className="text-sm font-semibold text-ink">You&rsquo;ll receive</dt>
            <dd
              className={`text-base font-bold tabular-nums ${net < 0 ? "text-red-600" : "text-ink"}`}
            >
              {formatMoney(net)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending
            ? "Submitting…"
            : mode.kind === "file"
              ? "Submit pay request"
              : mode.kind === "refile"
                ? "Resubmit pay request"
                : "Save and resend"}
        </button>
        <p className="text-xs text-muted-fg">
          {mode.kind === "edit"
            ? "Rebuilds your invoice PDF and tells finance it changed."
            : "Generates your invoice PDF and sends it to finance for payment."}
        </p>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
