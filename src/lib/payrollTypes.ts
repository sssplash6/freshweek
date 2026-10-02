// Client-safe payroll vocabulary. Mirrors the Prisma `PayrollStatus` and
// `PayrollMethod` enums (the lib/penalties.ts pattern) and holds the shared
// arithmetic and upload limits, so the form previews with exactly the numbers
// the server action then stores.
//
// Money is whole-dollar USD app-wide, with ONE exception: self-reported
// expenses are cents, because that is what a receipt says. They are summed
// exactly and the payout rounds half-up once, at the net — see computeNet.

import { formatMoney } from "@/lib/penalties";

/**
 * The kill switch for the whole payroll feature. While true every route under
 * /payroll shows the coming-soon screen (employees and both reviewer stages
 * alike), the lazy sweeps stay quiet so nothing expires or emails a reminder,
 * and every action refuses. Rows in the database are untouched either way, so
 * this can be flipped in both directions mid-flight — set it back to `true` to
 * shut the feature off again without losing anything.
 */
export const PAYROLL_CLOSED = false;

/**
 * Restricted rollout. While this list is non-empty, payroll is open ONLY to
 * these accounts; every other account sees exactly what the kill switch shows.
 * Empty the list to open payroll to the whole team again.
 *
 * This is deliberately a second, narrower switch rather than a change to
 * PAYROLL_CLOSED: the kill switch answers "is the feature on at all", this
 * answers "who can reach it yet", and a soft launch needs both to be true.
 * Everything keys off the same helper below — routes, server actions, the PDF
 * and receipt routes, and the two lazy sweeps — so there is no surface where
 * the list is enforced in one place and forgotten in another.
 */
export const PAYROLL_OPEN_TO: readonly string[] = [];

/**
 * Whether payroll is available to this account. The kill switch wins over the
 * allowlist, and an empty allowlist means everyone.
 */
export function isPayrollOpenFor(email: string | null | undefined): boolean {
  if (PAYROLL_CLOSED) return false;
  if (PAYROLL_OPEN_TO.length === 0) return true;
  return !!email && PAYROLL_OPEN_TO.includes(email.toLowerCase());
}

/**
 * Whether this account is testing a restricted rollout, as opposed to simply
 * being allowed to use a fully-open payroll. Only true while the allowlist is
 * in force — emptying it (full launch) makes this false for everyone, so no
 * exception granted to a tester can outlive the rollout it was granted for.
 */
export function isPayrollRolloutTester(email: string | null | undefined): boolean {
  return PAYROLL_OPEN_TO.length > 0 && isPayrollOpenFor(email);
}

/** The allowlist, lowercased — for the sweeps, which work in bulk. */
export function payrollOpenToEmails(): string[] {
  return PAYROLL_OPEN_TO.map((e) => e.toLowerCase());
}

/**
 * ONE period held open by hand, for everyone, with no closing date — the
 * standing exception to the four-day filing window.
 *
 * Filing normally runs the last three days of a month plus the 1st of the next
 * (see periodBoundsFor), and a month that shuts is shut: whoever missed it
 * files in the next cycle instead. Naming a period here suspends that for that
 * month alone, until someone sets this back to `null`:
 *
 *   • that month is the current cycle, whatever the calendar says, so /payroll
 *     keeps offering its form instead of moving on to the next month;
 *   • its filing window reads OPEN for every account, not just the rollout
 *     testers PAYROLL_OPEN_TO lets in early;
 *   • nothing in it lapses — a declined request has NO resubmit deadline while
 *     the month it belongs to has no closing date;
 *   • closing it again is this one edit, and the ordinary rules resume: the
 *     stored window is untouched the whole time, so the month reverts to the
 *     cutoff it was created with rather than to whatever the code now computes.
 *
 * It is deliberately a single period and not a list. This exists to be undone,
 * and a list is how one forgotten entry becomes a month that never closes.
 */
export const PAYROLL_HELD_OPEN: { year: number; month: number } | null = {
  year: 2026,
  month: 9,
};

/** Whether this period is the one being held open. */
export function isHeldOpenPeriod(period: {
  year: number;
  month: number;
}): boolean {
  return (
    PAYROLL_HELD_OPEN !== null &&
    period.year === PAYROLL_HELD_OPEN.year &&
    period.month === PAYROLL_HELD_OPEN.month
  );
}

/**
 * WITH_LEAD is the department lead's desk, between the filer and finance: a
 * request has to pass it before finance can pay anything (see the lifecycle on
 * PayrollStatus in schema.prisma). A filer with no lead skips it.
 *
 * APPROVED_BY_ADMIN is legacy and nothing enters it any more: it was a removed
 * ADMIN stage's hand-off to finance, not this one. The value stays because
 * rows and audit events still hold it, and a row left in it is still unpaid
 * money — the panel queues it beside SUBMITTED.
 */
export type PayrollStatus =
  | "DRAFT"
  | "WITH_LEAD"
  | "SUBMITTED"
  | "DECLINED"
  | "EXPIRED"
  | "APPROVED_BY_ADMIN"
  | "PROCESSED";

/**
 * How someone is paid — the "Source" column of the finance team's accounting
 * sheet, so a filed row reconciles against that sheet without translation.
 *
 * Most of these are RETIRED: payroll settles through five sources now (see
 * PAYROLL_METHODS_OFFERED), and the rest are here for the same reason
 * APPROVED_BY_ADMIN is still a status — rows filed under them exist, and a
 * paid request must keep saying how it was actually paid. Nothing new can be
 * filed under a retired source, and none of them is quietly rewritten into a
 * surviving one: a record of money that moved is not ours to restate.
 */
export type PayrollMethod =
  | "CASH_UZBEKISTAN"
  | "PAYME"
  | "UZBEK_COMPANY"
  | "WISE_USD"
  | "BANK_TRANSFER"
  // Retired — readable, never offered.
  | "CASH_SINGAPORE"
  | "UZS_CARD"
  | "VISA_CARD"
  | "STRIPE"
  | "SG_CASH"
  | "SG_BANK"
  | "KAPITAL_BANK"
  | "VARIOUS";

/**
 * The sources payroll actually uses, in the order finance names them. This is
 * the list the form offers and the only list a new filing may come from —
 * everything else in the enum is history.
 */
export const PAYROLL_METHODS_OFFERED: PayrollMethod[] = [
  "CASH_UZBEKISTAN",
  "PAYME",
  "UZBEK_COMPANY",
  "WISE_USD",
  "BANK_TRANSFER",
];

/**
 * Every value the column can hold, current first. Read-side lists (the panel's
 * by-source breakdown, the register) walk this one so a retired source still
 * shows up wherever an old row does.
 */
export const PAYROLL_METHODS: PayrollMethod[] = [
  ...PAYROLL_METHODS_OFFERED,
  "CASH_SINGAPORE",
  "UZS_CARD",
  "VISA_CARD",
  "STRIPE",
  "SG_CASH",
  "SG_BANK",
  "KAPITAL_BANK",
  "VARIOUS",
];

/** How each status reads in the UI — phrased for the employee's point of view. */
export const PAYROLL_STATUS_LABEL: Record<PayrollStatus, string> = {
  DRAFT: "Draft",
  // Desk-neutral: this label is read by the filer, by the lead looking at
  // someone else's request, and by finance. The filer's own page says "your
  // lead" in its banner, where the second person is actually true.
  WITH_LEAD: "With dept. lead",
  SUBMITTED: "With finance",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  // Legacy — the same desk as SUBMITTED, kept distinguishable in the panel's
  // status filter and in anyone's memory of where the row came from.
  APPROVED_BY_ADMIN: "With finance · approved",
  PROCESSED: "Paid",
};

export const PAYROLL_METHOD_LABEL: Record<PayrollMethod, string> = {
  CASH_UZBEKISTAN: "Cash Uzbekistan",
  PAYME: "Payme",
  UZBEK_COMPANY: "Uzbek Company",
  // Still WISE_USD in the column, so every Wise row ever filed stays one
  // bucket on the panel and the sheet; finance calls it Wise, so it reads Wise.
  WISE_USD: "Wise",
  // A wire straight to the person's own bank — the one source that carries
  // cross-border routing (IBAN, SWIFT/BIC) rather than settling on a rail
  // finance already holds an account on.
  BANK_TRANSFER: "Bank transfer",
  CASH_SINGAPORE: "Cash Singapore",
  UZS_CARD: "Uzbek card",
  VISA_CARD: "Visa card",
  STRIPE: "Stripe",
  SG_CASH: "SG Cash",
  SG_BANK: "SG Bank",
  KAPITAL_BANK: "Kapital Bank",
  // The catch-all. It is "Various" in the finance sheet's Source column — the
  // enum value still says so — but the person filing is describing one payment
  // they want made a way that isn't listed, and "Other" is what that reads as.
  VARIOUS: "Other",
};

/**
 * True for a source someone may file under today — the check every
 * caller-supplied method goes through. It is deliberately narrower than "is a
 * value of the enum": the retired sources are still legal in the column so old
 * rows can keep theirs, and a hand-made POST naming one would otherwise file a
 * fresh request against a source nobody pays from.
 */
export function isOfferedPayrollMethod(v: unknown): v is PayrollMethod {
  return typeof v === "string" && (PAYROLL_METHODS_OFFERED as string[]).includes(v);
}

/**
 * The one method that needs an email typed alongside it. Cards and bank
 * transfers ask for their own fields — see paymentFieldsFor.
 */
export function methodNeedsWiseEmail(method: PayrollMethod): boolean {
  return method === "WISE_USD";
}

/** Whether this method is paid in physical cash — nothing else to collect. */
export function methodIsCash(method: PayrollMethod): boolean {
  return (
    method === "CASH_SINGAPORE" ||
    method === "CASH_UZBEKISTAN" ||
    method === "SG_CASH"
  );
}

/**
 * What the chosen payment method stores in `paymentDetails`.
 *
 * These are payout instructions, entered by the person being paid, so finance
 * can send the money without a side conversation. Card numbers used to be kept
 * out of the app deliberately; they are here now because the team asked to
 * collect them, and two rules keep that decision contained:
 *   • the emailed invoice PDF carries a MASKED number (last four only) — the
 *     PDF goes out through a third-party mail provider, and that is exactly
 *     what the old rule was protecting against;
 *   • full numbers are shown only in the app, to the filer and to finance.
 */
export type PaymentDetails = {
  wiseEmail?: string;
  cardHolder?: string;
  cardNumber?: string;
  phone?: string;
  accountHolder?: string;
  bankName?: string;
  accountNumber?: string;
  bankCode?: string;
  swift?: string;
  bankAddress?: string;
  paymentReference?: string;
  otherDetails?: string;
};

export type PaymentFieldKey = keyof PaymentDetails;

export type PaymentField = {
  key: PaymentFieldKey;
  label: string;
  placeholder: string;
  maxLength: number;
  /** Blocks filing when empty. Optional ones are still asked for, never demanded. */
  required: boolean;
  /** Drives the input type, the validation, and whether the PDF masks it. */
  kind: "email" | "card" | "phone" | "text" | "note";
};

const FIELDS: Record<PaymentFieldKey, PaymentField> = {
  wiseEmail: {
    key: "wiseEmail",
    label: "Wise account email",
    placeholder: "you@example.com",
    maxLength: 200,
    required: true,
    kind: "email",
  },
  cardHolder: {
    key: "cardHolder",
    label: "Cardholder name",
    placeholder: "As printed on the card",
    maxLength: 120,
    required: true,
    kind: "text",
  },
  cardNumber: {
    key: "cardNumber",
    label: "Card number",
    placeholder: "8600 1234 5678 9012",
    maxLength: 30,
    required: true,
    kind: "card",
  },
  // Payme sends to a card or to the phone the account is registered on, so the
  // phone rides along as a second way to reach the same person — never
  // demanded, because the card number alone is enough to pay them.
  phone: {
    key: "phone",
    label: "Phone number",
    placeholder: "+998 90 123 45 67 (optional)",
    maxLength: 32,
    required: false,
    kind: "phone",
  },
  // Bank routing is asked for but never demanded: a filing window is four days
  // long, and nobody should miss it hunting for a branch code. Finance gets
  // whatever is known, and asks for the rest only if a transfer needs it.
  bankName: {
    key: "bankName",
    label: "Bank",
    placeholder: "Bank name (optional)",
    maxLength: 120,
    required: false,
    kind: "text",
  },
  accountNumber: {
    key: "accountNumber",
    label: "Account number",
    placeholder: "Account or IBAN (optional)",
    maxLength: 64,
    required: false,
    kind: "text",
  },
  bankCode: {
    key: "bankCode",
    label: "Bank code",
    placeholder: "Branch / routing code (optional)",
    maxLength: 32,
    required: false,
    kind: "text",
  },
  swift: {
    key: "swift",
    label: "SWIFT / BIC",
    placeholder: "e.g. ABCDUZ22 (optional)",
    maxLength: 16,
    required: false,
    kind: "text",
  },
  // The beneficiary, as the receiving bank has it. A wire is rejected outright
  // when this doesn't match the account, so it is asked for in full rather
  // than assumed from the filer's name in this app.
  accountHolder: {
    key: "accountHolder",
    label: "Account holder",
    placeholder: "Name exactly as the bank has it",
    maxLength: 120,
    required: true,
    kind: "text",
  },
  // Mandatory for a cross-border wire, unlike the branch code above: a
  // correspondent bank routes on the address, and a transfer without it comes
  // back days later — well after the filing window has shut.
  bankAddress: {
    key: "bankAddress",
    label: "Bank address",
    placeholder: "Branch address of the receiving bank",
    maxLength: 200,
    required: true,
    kind: "text",
  },
  // What the sender writes on the transfer. Left empty, finance uses the
  // invoice number and the period, which this app already knows — so it is
  // offered for the banks that insist on a particular wording, not demanded.
  paymentReference: {
    key: "paymentReference",
    label: "Payment reference",
    placeholder: "What the transfer should say (optional)",
    maxLength: 140,
    required: false,
    kind: "text",
  },
  otherDetails: {
    key: "otherDetails",
    label: "How to pay you",
    placeholder: "Describe the method and everything finance needs to send it",
    maxLength: 500,
    required: true,
    kind: "note",
  },
};

/**
 * A shared field as a stricter method asks for it — same KEY, so the value
 * still reads back through one place, with the wording and the requirement
 * that method needs. Bank routing is optional beside a card number (finance
 * can pay the card) and mandatory on its own (there is nothing else to pay),
 * and a cross-border form calls the account number an IBAN.
 */
function demanded(
  field: PaymentField,
  over: Partial<Omit<PaymentField, "key">> = {},
): PaymentField {
  return { ...field, required: true, ...over };
}

/**
 * What to ask for, given the method. ONE table — the form renders it, the
 * server validates against it, and the invoice reads it back, so a new field
 * can never appear on the form and go unstored (or be demanded by a validator
 * nothing displays).
 */
export function paymentFieldsFor(method: PayrollMethod): PaymentField[] {
  switch (method) {
    case "WISE_USD":
      return [FIELDS.wiseEmail];
    case "PAYME":
      return [FIELDS.cardNumber, FIELDS.phone];
    // A wire to the person's own bank, asked for in the order a transfer form
    // asks for it: who is paid, then where the money lands, then how it is
    // routed across a border.
    case "BANK_TRANSFER":
      return [
        FIELDS.accountHolder,
        demanded(FIELDS.bankName, { placeholder: "Name of the receiving bank" }),
        demanded(FIELDS.accountNumber, {
          label: "IBAN / account number",
          placeholder: "e.g. GB29 NWBK 6016 1331 9268 19",
        }),
        demanded(FIELDS.swift, { placeholder: "e.g. ABCDUZ22" }),
        FIELDS.bankAddress,
        FIELDS.paymentReference,
      ];
    // Retired, but old rows still read back through here: they show what they
    // were filed with, minus the expiry date nothing asks for any more.
    case "UZS_CARD":
    case "KAPITAL_BANK":
      return [FIELDS.cardHolder, FIELDS.cardNumber];
    case "VISA_CARD":
      return [
        FIELDS.cardHolder,
        FIELDS.cardNumber,
        FIELDS.bankName,
        FIELDS.accountNumber,
        FIELDS.bankCode,
        FIELDS.swift,
      ];
    case "VARIOUS":
      return [FIELDS.otherDetails];
    default:
      // Cash and the Uzbek company pay from finance's own books, and the
      // retired Stripe/SG Bank sources settled off-app as they always did.
      return [];
  }
}

/** Digits only, for length checks and for masking. */
function cardDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

/**
 * A card number as finance should see it outside the app: last four only.
 * "8600123456789012" → "•••• 9012". Anything too short to have a meaningful
 * tail is masked whole.
 */
export function maskCardNumber(raw: string): string {
  const digits = cardDigits(raw);
  if (digits.length < 4) return "••••";
  return `•••• ${digits.slice(-4)}`;
}

/**
 * The first thing wrong with the details for this method, phrased for the
 * person filing — or null when they're good. Shared by the form and the server
 * action so the message is the same wherever it's hit.
 */
export function validatePaymentDetails(
  method: PayrollMethod,
  details: PaymentDetails,
): string | null {
  for (const f of paymentFieldsFor(method)) {
    const value = (details[f.key] ?? "").trim();
    if (!value) {
      if (f.required) return `${f.label} is required for ${PAYROLL_METHOD_LABEL[method]}.`;
      continue;
    }
    if (f.kind === "email" && !/^\S+@\S+\.\S+$/.test(value)) {
      return "Enter a valid Wise account email.";
    }
    if (f.kind === "card") {
      const digits = cardDigits(value);
      // Spaces and dashes are how people write a card down; the range covers
      // Uzcard/Humo (16) through the longest international PANs (19).
      if (digits.length < 12 || digits.length > 19 || !/^[0-9 -]+$/.test(value)) {
        return "Enter the full card number (digits only, spaces are fine).";
      }
    }
    if (f.kind === "phone" && cardDigits(value).length < 7) {
      return "Enter a full phone number, or leave it empty.";
    }
  }
  return null;
}

/** Safely read a Prisma Json column back into the details shape. */
export function parsePaymentDetails(v: unknown): PaymentDetails {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: PaymentDetails = {};
  for (const key of Object.keys(FIELDS) as PaymentFieldKey[]) {
    const raw = o[key];
    if (typeof raw === "string" && raw.trim()) out[key] = raw;
  }
  return out;
}

/**
 * The payout instructions as labelled lines, in the order they were asked for:
 * what the reviewer reads off the screen, and what the invoice prints.
 *
 * `mask` swaps the card number for its last four. The PDF passes it, because
 * that file is emailed; the in-app views don't, because finance has to type
 * the number somewhere to make the payment.
 */
export function paymentDetailLines(
  method: PayrollMethod,
  details: PaymentDetails,
  opts: { mask?: boolean } = {},
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  for (const f of paymentFieldsFor(method)) {
    const value = (details[f.key] ?? "").trim();
    if (!value) continue;
    lines.push({
      label: f.label,
      value: opts.mask && f.kind === "card" ? maskCardNumber(value) : value,
    });
  }
  return lines;
}

/**
 * How this person gets paid, in one line: "Payme · •••• 9012", "Wise · a@b.c",
 * "Cash Uzbekistan" — the sheet's own wording plus the one identifying detail.
 * Always masked: this is a summary for lists and headers, and the full number
 * is a click away in the details below it.
 */
export function paymentSummary(
  method: PayrollMethod,
  details: PaymentDetails,
): string {
  const label = PAYROLL_METHOD_LABEL[method];
  if (details.wiseEmail) return `${label} · ${details.wiseEmail}`;
  if (details.cardNumber) return `${label} · ${maskCardNumber(details.cardNumber)}`;
  // An IBAN carries letters, so this is the last four CHARACTERS rather than
  // maskCardNumber's last four digits.
  if (details.accountNumber) {
    const account = details.accountNumber.replace(/\s+/g, "");
    return `${label} · •••• ${account.slice(-4).toUpperCase()}`;
  }
  // Payme to a phone and no card: the number is the whole address, so it is
  // what identifies the payout.
  if (details.phone) return `${label} · ${details.phone}`;
  return label;
}

/**
 * The pay arithmetic. Base, bonuses and fines are whole dollars; expenses are
 * cents, because that's what a receipt says ($1.95 for a tool subscription).
 */
export type PayrollTotals = {
  baseSalary: number;
  bonusesTotal: number;
  finesTotal: number;
  expensesTotalCents: number;
};

/** The exact total in cents, before anything is rounded. */
export function netTotalCents(t: PayrollTotals): number {
  return (
    (t.baseSalary + t.bonusesTotal - t.finesTotal) * 100 + t.expensesTotalCents
  );
}

/**
 * The one formula: base + bonuses − fines + expenses, rounded half-up to whole
 * dollars — $600.95 is paid as $601, $1001.4 as $1001.
 *
 * The rounding happens HERE and nowhere else. Rounding each expense on the way
 * in would restate what someone spent (and drop anything under 50¢ entirely);
 * rounding the sum once moves the payout by at most half a dollar, and every
 * line still reads back exactly as it was filed.
 */
export function computeNet(t: PayrollTotals): number {
  return Math.round(netTotalCents(t) / 100);
}

/**
 * The cents the final rounding added or shaved — 0 when the total was already
 * whole. Shown as its own line wherever the breakdown is displayed, so the
 * figures visibly add up instead of missing by a few cents.
 */
export function roundingCents(t: PayrollTotals): number {
  return computeNet(t) * 100 - netTotalCents(t);
}

/**
 * The breakdown every surface shows — the form's live preview, the filer's own
 * request, the reviewer's panel — so all three read the same and the rounding
 * line can never appear on one and not another. `Total` is rendered separately
 * by each (they style it differently); these are the rows above it.
 */
export function payrollMathRows(
  t: PayrollTotals,
): { label: string; value: string; tone?: string }[] {
  const rounding = roundingCents(t);
  return [
    { label: "Base salary", value: formatMoney(t.baseSalary) },
    {
      label: "Bonuses",
      value: `+ ${formatMoney(t.bonusesTotal)}`,
      tone: "text-green-700",
    },
    {
      label: "Fines",
      value: `− ${formatMoney(t.finesTotal)}`,
      tone: "text-red-600",
    },
    { label: "Expenses", value: `+ ${formatCents(t.expensesTotalCents)}` },
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
}

/**
 * Cents → "$1.95", or "$39" when it's a whole number of dollars, so amounts
 * without cents read the same as the rest of the app (formatMoney). Negative
 * values keep the sign inside: "-$0.05".
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = dollars.toLocaleString("en-US");
  return rest === 0
    ? `${sign}$${whole}`
    : `${sign}$${whole}.${String(rest).padStart(2, "0")}`;
}

/**
 * An amount as typed → cents, or null if it isn't a positive amount. Accepts
 * "1.95", "39", " 2.5 "; rejects "", "abc", "0" and negatives. Anything past
 * two decimals settles to the nearest cent, so "1.956" files as $1.96.
 *
 * Shared by the form and the server action deliberately: the number the filer
 * sees totalled has to be the number that gets stored.
 */
export function parseAmountCents(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Scale before rounding — 1.95 * 100 is 194.99999999999997 in binary floating
  // point, and truncating that would file $1.94.
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null;
}

/** Guard rail so a typo can't file an absurd amount (mirrors MAX_PENALTY). */
export const MAX_PAYROLL_AMOUNT = 100_000_000;

/** The same guard rail in cents, for the expense lines that carry them. */
export const MAX_PAYROLL_AMOUNT_CENTS = MAX_PAYROLL_AMOUNT * 100;

/** Expense line items per submission — plenty for "miscellaneous". */
export const MAX_PAYROLL_EXPENSES = 15;

/** Receipt upload caps. The server action re-checks both (the client hint is
 * courtesy, not enforcement); next.config.ts raises the action body limit to
 * fit a submission's worth of receipts. */
export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024; // 4MB per file
export const RECEIPT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
];

/** Status pill classes — semantic tokens flip for dark; raw hues follow the
 * app's existing chip convention (policy cards, notices). */
export const PAYROLL_STATUS_BADGE: Record<PayrollStatus, string> = {
  DRAFT: "bg-canvas text-muted-fg",
  // Amber: waiting on a person, which is the panel's "needs someone" colour
  // (the assigned-task chip), not the brand's "in hand" blue.
  WITH_LEAD: "bg-amber-50 text-amber-700",
  SUBMITTED: "bg-brand-soft text-brand",
  DECLINED: "bg-red-50 text-red-700",
  EXPIRED: "bg-canvas text-muted-fg",
  APPROVED_BY_ADMIN: "bg-accent-soft text-accent-ink",
  PROCESSED: "bg-green-50 text-green-700",
};

/**
 * One audit-trail row's verb, disambiguated by where it came from — the same
 * arrival reads differently depending on the desk it came from, and a trail
 * that says "Declined" for both desks tells the filer nothing about who to
 * talk to. The two APPROVED_BY_ADMIN lines describe history only — no new
 * event moves through that status — and stay so an old trail still reads
 * correctly.
 */
export function payrollEventLabel(
  from: PayrollStatus | null,
  to: PayrollStatus,
): string {
  if (to === "WITH_LEAD") {
    if (from === "DECLINED") return "Resubmitted — with the lead";
    if (from === "WITH_LEAD") return "Edited and resent";
    if (from === "SUBMITTED") return "Edited — back to the lead";
    return "Filed — with the lead";
  }
  if (to === "SUBMITTED") {
    if (from === "WITH_LEAD") return "Approved by the lead — sent to finance";
    if (from === "DECLINED") return "Resubmitted";
    if (from === "APPROVED_BY_ADMIN") return "Sent back by finance";
    if (from === "SUBMITTED") return "Edited and resent";
    // No lead to answer to, so the filing landed on the finance desk itself.
    return "Filed";
  }
  if (to === "DECLINED") {
    return from === "WITH_LEAD" ? "Sent back by the lead" : "Declined";
  }
  if (to === "APPROVED_BY_ADMIN") return "Approved — sent to finance";
  if (to === "PROCESSED") return "Paid out";
  if (to === "EXPIRED") return "Expired — resubmit window lapsed";
  return PAYROLL_STATUS_LABEL[to];
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** (2026, 8) → "August 2026". `month` is 1-based, as stored on PayrollPeriod. */
export function payrollPeriodLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** (2026, 8) → "August" — for copy where the year is obvious. */
export function payrollMonthName(month: number): string {
  return MONTH_NAMES[month - 1];
}
