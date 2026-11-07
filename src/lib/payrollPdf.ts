// Server-only: renders a pay request as the invoice PDF the team already uses
// (see the sample: brand lockup + INVOICE header, company block, Date /
// Balance Due, item table, Subtotal / Tax 0% / Total, Notes, Terms). The item
// table carries the pay breakdown — base salary, each bonus, each fine as a
// negative line, each expense — and Notes carries the chosen payment method.
//
// Pure CPU over the submission snapshot: bytes are stored in PayrollPdf and
// regenerated on every resubmission, never written to disk (Render's
// filesystem is ephemeral). DejaVu Sans is embedded (subset) instead of the
// built-in Helvetica because names and fine/bonus notes can be Cyrillic,
// which WinAnsi can't encode.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PENALTY_LABEL, type PenaltyType } from "@/lib/penalties";
import {
  methodIsCash,
  paymentDetailLines,
  PAYROLL_METHOD_LABEL,
  type PayrollMethod,
  type PaymentDetails,
} from "@/lib/payrollTypes";
import { formatYmd, toYmd } from "@/lib/dates";

export type InvoiceData = {
  /** Per-person sequence — stable across regenerations of the same request. */
  invoiceNo: number;
  employeeName: string;
  /** "Aug 19, 2026" — the (re)submission date in Tashkent. */
  dateLabel: string;
  /** "August 2026". */
  periodLabel: string;
  baseSalary: number;
  bonusLines: { amount: number; note: string | null; awardedAt: Date }[];
  fineLines: {
    amount: number;
    type: PenaltyType;
    note: string | null;
    issuedAt: Date;
  }[];
  /** Self-reported expenses, in cents — a receipt is $1.95, not $2. */
  expenses: { label: string; amountCents: number }[];
  /** What gets paid: the exact total rounded half-up to whole dollars. */
  netTotal: number;
  paymentMethod: PayrollMethod;
  paymentDetails: PaymentDetails;
  /**
   * The department split, for someone paid by more than one (PayrollPart).
   * Empty or absent for everyone else. `amount` is what that department pays
   * (lib/payrollParts.ts partAmount) and the amounts add up to `netTotal`.
   */
  parts?: {
    departmentName: string;
    salary: number;
    amount: number;
    carriesLedger: boolean;
  }[];
};

// ----- Page geometry (US Letter, like the sample) -----

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 50;
const RIGHT = PAGE_W - MARGIN_X; // 562
const BOTTOM = 60;

const INK = rgb(0.13, 0.14, 0.16);
const GRAY = rgb(0.45, 0.46, 0.48);
const BAND = rgb(0.945, 0.945, 0.95);
const HEADER_BG = rgb(0.23, 0.23, 0.25);
const WHITE = rgb(1, 1, 1);

// Item | Quantity | Rate | Amount column anchors.
const COL_ITEM = MARGIN_X + 8;
const COL_ITEM_MAX = 300;
const COL_QTY = 420;
const COL_RATE = 496;
const COL_AMOUNT = RIGHT - 8;
const ROW_H = 24;
// Extra height each wrapped continuation line of an item label adds to a row.
const ITEM_LINE_H = 12;

/** Cents → "$1,234.00" / "$1.95" / "-$20.00" (the sample renders cents). */
function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(
    abs % 100,
  ).padStart(2, "0")}`;
}

/** Whole dollars → cents, for the lines the app keeps as whole dollars. */
const cents = (dollars: number) => dollars * 100;

function truncate(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}...`;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(probe, size) <= maxWidth || !line) {
      line = probe;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Fonts + the brand lockup, read once per process. The logo was lifted from
// the team's own sample invoice (private/brand/invoice-logo.jpg).
let assetsPromise: Promise<{
  regular: Uint8Array;
  bold: Uint8Array;
  logo: Uint8Array;
}> | null = null;

function loadAssets() {
  assetsPromise ??= (async () => {
    const fontsDir = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
    const [regular, bold, logo] = await Promise.all([
      readFile(path.join(fontsDir, "DejaVuSansCondensed.ttf")),
      readFile(path.join(fontsDir, "DejaVuSansCondensed-Bold.ttf")),
      readFile(path.join(process.cwd(), "private", "brand", "invoice-logo.jpg")),
    ]);
    return { regular, bold, logo };
  })();
  return assetsPromise;
}

export async function renderPayrollInvoice(
  data: InvoiceData,
): Promise<Uint8Array<ArrayBuffer>> {
  const assets = await loadAssets();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(assets.regular, { subset: true });
  const bold = await doc.embedFont(assets.bold, { subset: true });
  const logo = await doc.embedJpg(assets.logo);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 45;

  const text = (
    t: string,
    x: number,
    at: number,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {},
  ) =>
    page.drawText(t, {
      x,
      y: at,
      font: opts.font ?? font,
      size: opts.size ?? 10,
      color: opts.color ?? INK,
    });
  const rightText = (
    t: string,
    xRight: number,
    at: number,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {},
  ) =>
    text(t, xRight - (opts.font ?? font).widthOfTextAtSize(t, opts.size ?? 10), at, opts);

  // ----- Header: lockup left, INVOICE right -----
  const logoW = 168;
  const logoH = (logoW / logo.width) * logo.height;
  page.drawImage(logo, { x: MARGIN_X, y: y - logoH, width: logoW, height: logoH });
  rightText("INVOICE", RIGHT, y - 24, { size: 30, color: rgb(0.35, 0.36, 0.38) });
  rightText(`# ${data.invoiceNo}`, RIGHT, y - 40, { size: 11, color: GRAY });
  y -= logoH + 24;

  // ----- Company block (left) / Date + Balance Due (right) -----
  const blockTop = y;
  text("Freshman Pte. Ltd.", MARGIN_X, y, { font: bold, size: 10.5 });
  y -= 14;
  text("34 Draycott Drive", MARGIN_X, y);
  y -= 14;
  text("Singapore 259426", MARGIN_X, y);
  y -= 24;

  rightText("Date:", 470, blockTop, { color: GRAY });
  rightText(data.dateLabel, RIGHT, blockTop);
  const bandY = blockTop - 30;
  page.drawRectangle({ x: 360, y: bandY - 7, width: RIGHT - 360, height: 22, color: BAND });
  rightText("Balance Due:", 470, bandY, { font: bold, size: 10.5 });
  rightText(usd(cents(data.netTotal)), COL_AMOUNT, bandY, { font: bold, size: 10.5 });

  // ----- Bill To -----
  text("Bill To:", MARGIN_X, y, { color: GRAY });
  y -= 15;
  text(truncate(bold, data.employeeName, 11, 280), MARGIN_X, y, { font: bold, size: 11 });
  y -= 34;

  // ----- Item table -----
  const drawTableHeader = () => {
    page.drawRectangle({ x: MARGIN_X, y: y - 7, width: RIGHT - MARGIN_X, height: 24, color: HEADER_BG });
    text("Item", COL_ITEM, y, { color: WHITE });
    rightText("Quantity", COL_QTY, y, { color: WHITE });
    rightText("Rate", COL_RATE, y, { color: WHITE });
    rightText("Amount", COL_AMOUNT, y, { color: WHITE });
    y -= ROW_H + 4;
  };
  // Start a fresh page when fewer than `needed` points remain above the margin.
  const ensureRoom = (needed: number, withTableHeader: boolean) => {
    if (y - needed >= BOTTOM) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - 50;
    if (withTableHeader) drawTableHeader();
  };

  const when = (d: Date) => formatYmd(toYmd(d));
  // Every row is in cents so the column adds up exactly; only the expenses
  // actually carry any.
  // A split request lists each department's salary on its own line, so the
  // invoice says who owes what; everyone else keeps the one line.
  const parts = data.parts ?? [];
  const salaryRows =
    parts.length > 0
      ? parts.map((p) => ({
          label: `Base salary — ${data.periodLabel} (${p.departmentName})`,
          amount: cents(p.salary),
        }))
      : [{ label: `Base salary — ${data.periodLabel}`, amount: cents(data.baseSalary) }];
  const rows: { label: string; amount: number }[] = [
    ...salaryRows,
    ...data.bonusLines.map((b) => ({
      label: `Bonus (${when(b.awardedAt)})${b.note ? ` — ${b.note}` : ""}`,
      amount: cents(b.amount),
    })),
    ...data.fineLines.map((f) => ({
      label:
        (f.type === "OTHER" ? "Fine" : `${PENALTY_LABEL[f.type]} fine`) +
        ` (${when(f.issuedAt)})${f.note ? ` — ${f.note}` : ""}`,
      amount: cents(-f.amount),
    })),
    ...data.expenses.map((e) => ({
      label: `Expense — ${e.label}`,
      amount: e.amountCents,
    })),
  ];

  drawTableHeader();
  for (const row of rows) {
    // Expense explanations and fine/bonus notes are written to be read, so the
    // item column wraps them and the row grows instead of cutting the sentence
    // off mid-word. The numbers stay on the row's first line.
    const lines = wrap(bold, row.label, 10, COL_ITEM_MAX);
    const rowH = ROW_H + (lines.length - 1) * ITEM_LINE_H;
    ensureRoom(rowH, true);
    lines.forEach((line, i) => {
      // Only bites on a single unbreakable token wider than the column.
      text(truncate(bold, line, 10, COL_ITEM_MAX), COL_ITEM, y - i * ITEM_LINE_H, {
        font: bold,
      });
    });
    rightText("1", COL_QTY, y);
    rightText(usd(row.amount), COL_RATE, y);
    rightText(usd(row.amount), COL_AMOUNT, y);
    y -= rowH;
  }
  y -= 12;

  // ----- Totals (right column) -----
  //
  // Subtotal is what the lines above literally add up to; Total is what gets
  // paid, rounded to the whole dollar the payout runs in. When those differ,
  // the rounding is its own line rather than an unexplained few cents — an
  // invoice whose column doesn't add up is one finance has to come back about.
  const subtotal = rows.reduce((s, r) => s + r.amount, 0);
  const rounding = cents(data.netTotal) - subtotal;
  const totalRows: [string, string, boolean][] = [
    ["Subtotal:", usd(subtotal), false],
    ["Tax (0%):", usd(0), false],
    ...(rounding !== 0
      ? ([["Rounding:", usd(rounding), false]] as [string, string, boolean][])
      : []),
    ["Total:", usd(cents(data.netTotal)), true],
  ];
  ensureRoom(totalRows.length * 20 + 12, false);
  for (const [label, value, isBold] of totalRows) {
    rightText(label, COL_RATE, y, { color: GRAY, font: isBold ? bold : font });
    rightText(value, COL_AMOUNT, y, { font: isBold ? bold : font });
    y -= 20;
  }
  y -= 24;

  // ----- Who pays which part (split requests only) -----
  //
  // Each department pays its own part, and the bonuses, fines and expenses
  // come with exactly one of them — so the total alone doesn't tell either
  // lead what to send. The parts add up to the Total above.
  if (parts.length > 0) {
    const splitLines = parts.map(
      (p) =>
        `${p.departmentName}: ${usd(cents(p.amount))}` +
        (p.carriesLedger && parts.length > 1
          ? " (salary, plus the bonuses, fines and expenses above)"
          : ""),
    );
    ensureRoom(15 + splitLines.length * 14 + 10, false);
    text("Paid by department:", MARGIN_X, y, { color: GRAY });
    y -= 15;
    for (const line of splitLines) {
      for (const piece of wrap(font, line, 10, 400)) {
        ensureRoom(14, false);
        text(piece, MARGIN_X, y);
        y -= 14;
      }
    }
    y -= 14;
  }

  // ----- Notes: how to pay this person -----
  //
  // The payout instructions the filer entered, with ONE substitution: a card
  // number prints as its last four digits. This PDF is emailed — to every
  // finance address on approval, and back to the employee on payout — and a
  // full card number has no business travelling through a third-party mail
  // provider. Finance reads the whole number in the app, where it is entered.
  //
  // "Preferred" because the method is what the employee asked for, not what
  // finance is bound to: the same wording the employee sees on the form.
  const method = data.paymentMethod;
  const noteLines = [`Preferred payment method: ${PAYROLL_METHOD_LABEL[method]}`];
  const details = paymentDetailLines(method, data.paymentDetails, { mask: true });
  for (const line of details) {
    noteLines.push(`${line.label}: ${line.value}`);
  }
  if (details.length === 0 && !methodIsCash(method)) {
    // Stripe, SG Bank — settled off-app, so finance reads this
    // as "you already know where". Cash needs no second line at all.
    noteLines.push("Account details: arranged directly with finance");
  }
  if (details.some((l) => l.value.startsWith("••••"))) {
    noteLines.push("Full card number is in the app — shown to finance there.");
  }
  ensureRoom(15 + noteLines.length * 14 + 10, false);
  text("Notes:", MARGIN_X, y, { color: GRAY });
  y -= 15;
  for (const line of noteLines) {
    for (const piece of wrap(font, line, 10, 400)) {
      ensureRoom(14, false);
      text(piece, MARGIN_X, y);
      y -= 14;
    }
  }
  y -= 14;

  // ----- Terms (kept verbatim from the team's sample) -----
  const terms = [
    "—Note that the payment is not refundable",
    "—The signed contract reflects the terms and conditions",
  ];
  ensureRoom(15 + terms.length * 14, false);
  text("Terms:", MARGIN_X, y, { color: GRAY });
  y -= 15;
  for (const line of terms) {
    text(line, MARGIN_X, y);
    y -= 14;
  }

  // pdf-lib allocates over a plain ArrayBuffer; the assertion pins the
  // generic so the bytes feed Prisma's Bytes input without widening.
  return (await doc.save()) as Uint8Array<ArrayBuffer>;
}
