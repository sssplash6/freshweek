import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";
import { resolveAvatar } from "@/lib/avatar";
import { departmentLine } from "@/lib/team";
import { COMPANY_TIME_ZONE, formatDateTimeTz, formatYmd } from "@/lib/dates";
import { formatMoney } from "@/lib/penalties";
import { BackLink } from "@/app/_components/BackLink";
import {
  canReadPayrollWhileClosed,
  canSeeAllPayroll,
  eligibleEmployees,
  ensureCurrentPeriod,
  expireLapsedSubmissions,
  filingWindowState,
  formatTashkent,
  isFinance,
  reconcilePayrollReminders,
} from "@/lib/payroll";
import {
  parsePaymentDetails,
  paymentDetailLines,
  paymentSummary,
  payrollPeriodLabel,
  isHeldOpenPeriod,
  isPayrollOpenFor,
  PAYROLL_METHOD_LABEL,
  PAYROLL_STATUS_BADGE,
  PAYROLL_STATUS_LABEL,
  type PayrollStatus,
} from "@/lib/payrollTypes";
import { PayrollComingSoon } from "../_components/PayrollComingSoon";
import {
  bonusLineViews,
  eventViews,
  fineLineViews,
} from "../_components/lineViews";
import {
  PanelBoard,
  type PanelBoardItem,
  type PanelBoardSummary,
} from "../_components/PanelBoard";
import { RowTickSpacer } from "../_components/PaySelection";
import {
  medianNet,
  sizeFlag,
  waitingFlag,
  type PanelFlag,
} from "../_components/PanelFlags";
import {
  PanelRowShell,
  type PanelRowSummary,
} from "../_components/PanelRowShell";
import { PanelSummary, type PanelStat } from "../_components/PanelSummary";
import { SubmissionDetail } from "../_components/SubmissionDetail";
import { BatchPayBar } from "./BatchPayBar";
import { FinanceRow } from "./FinanceRow";
// The two ways to read the same month, shared with the three redirects that
// land here so they cannot name a view this page does not have.
import { type PanelView } from "./redirects";
import { SheetTable, type SheetRow } from "./SheetTable";

export const metadata: Metadata = { title: "Payroll panel" };

/**
 * Queue display order: what is waiting on the reviewer first, then what is
 * back with the filer, then the record. DRAFT is deliberately absent — see
 * MONTH_SCOPE below.
 */
const STATUS_ORDER: PayrollStatus[] = [
  "SUBMITTED",
  "APPROVED_BY_ADMIN",
  // Waiting on someone who isn't the reviewer, so it sorts below what they
  // can act on — but above the record, because it is money still coming.
  "WITH_LEAD",
  "DECLINED",
  "PROCESSED",
  "EXPIRED",
];

/**
 * What is still waiting on the reviewer, and so what a row can be PAID from —
 * the panel's copy of PAYABLE in ../finance/actions.ts. A filing reaches this
 * desk as SUBMITTED once the filer's department lead has approved it, and
 * APPROVED_BY_ADMIN is the legacy row the removed admin stage had already
 * approved.
 *
 * WITH_LEAD is deliberately absent: it is on the lead's desk, not this one,
 * and no override pays it (see the PayrollStatus lifecycle). Such a row still
 * draws here — finance needs to see money that is coming and who is sitting on
 * it — it just draws without verbs. Declining one IS still possible, which is
 * why finance's own DECLINABLE is a wider set than this; the row gets that
 * button through the same wrapper, since a row awaiting a lead is exactly the
 * one a reviewer may need to unstick.
 */
const AWAITING: PayrollStatus[] = ["SUBMITTED", "APPROVED_BY_ADMIN"];

/**
 * The month's real money: an EXPIRED filing is never paid (it rolls into the
 * next cycle), so it is not part of the total, is not a line on the register,
 * and is not counted when working out what a "typical" net looks like. Same
 * set the stats page counts, which is what makes every total reconcile.
 */
const COUNTABLE: PayrollStatus[] = [
  "WITH_LEAD",
  "SUBMITTED",
  "DECLINED",
  "APPROVED_BY_ADMIN",
  "PROCESSED",
];

/**
 * The merged rule for what this page loads, reconciling what the two pages it
 * replaces used to fetch separately.
 *
 *   • DRAFT is never loaded, by either view. A draft only exists inside the
 *     filing transaction and is gone before it commits, so there is no such
 *     row to show — /payroll/review filtered it out in memory and the register
 *     excluded it by listing COUNTABLE; both meant the same thing.
 *
 *   • EXPIRED *is* loaded, because the queue must show it: a request that
 *     lapsed is part of the month's history and a reviewer looking for
 *     someone's filing needs to find it rather than conclude they never filed.
 *     The register then drops it again (COUNTABLE) and says so in a footnote,
 *     because an expired filing settles no money and a register is a record of
 *     money moving. So the two views disagree about EXPIRED on purpose, and
 *     they now disagree over one loaded set instead of two queries that could
 *     drift apart.
 */
const MONTH_SCOPE = { status: { not: "DRAFT" } } as const;

/**
 * The company's calendar day as "YYYY-MM-DD", for the register's Date column.
 *
 * lib/dates offers a UTC calendar day (`toYmd`) and a full Tashkent stamp
 * (`formatDateTimeTz`), and neither is what a register wants: a request filed
 * at 21:00 Tashkent is already the next day in UTC, so `toYmd` would file it
 * under tomorrow. en-CA is the locale whose short date is already in ISO
 * order, which both `formatYmd` and a spreadsheet can read.
 */
const tashkentYmd = new Intl.DateTimeFormat("en-CA", {
  timeZone: COMPANY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * When a legacy row landed on the reviewer's desk: the last hand-off from the
 * admin stage that used to exist, read off the audit trail. Only an
 * APPROVED_BY_ADMIN row has one — everything filed since goes straight to the
 * reviewer, so its clock starts at `lastSubmittedAt` instead.
 */
function approvedAt(
  events: readonly { toStatus: string; createdAt: Date }[],
): Date | null {
  const handoff = [...events]
    .reverse()
    .find((e) => e.toStatus === "APPROVED_BY_ADMIN");
  return handoff?.createdAt ?? null;
}

/**
 * The one reviewer panel: a month of pay requests, read either as a queue of
 * expandable rows or as the finance team's register, with one period selector
 * and one summary strip over both.
 *
 * It replaces /payroll/review, /payroll/finance and /payroll/sheet, which
 * showed overlapping slices of the same rows to overlapping audiences and each
 * wrote out their own month picker. Those three URLs now redirect here.
 *
 * WHICH VERBS A ROW OFFERS COMES FROM THE VIEWER'S ROLE, NEVER FROM THE URL.
 * The role flags are computed once, below, and passed down; a row is wrapped
 * in FinanceRow only when it is awaiting payment AND the viewer is the
 * reviewer, and is otherwise the bare read-only shell. No component re-derives
 * a permission from a status, and every action re-checks its own role server
 * side regardless — what is rendered here is never what makes a move legal.
 *
 * The period is the only thing the queue keeps in the URL besides the view,
 * because it changes which rows are fetched. Everything else a reviewer does
 * to the queue (status, search, department, order) happens in
 * the browser over rows already on the page, so working down a month never
 * reloads it under them.
 */
export default async function PayrollPanelPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; view?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  /**
   * Closed payroll: everyone gets the coming-soon screen employees do — except
   * a global admin or a payroll observer, who keep this panel as a read-only
   * record (see canReadPayrollWhileClosed). The reviewer does NOT: paying is
   * exactly what closing payroll stops, so a reviewer with no verbs left has
   * nothing to be here for, and letting them in would only look like the
   * switch had failed.
   */
  const payrollOpen = isPayrollOpenFor(session.user.email);
  if (!payrollOpen && !canReadPayrollWhileClosed(session.user.email)) {
    return <PayrollComingSoon />;
  }
  // Reading the panel is for everyone who reviews money — both stages, global
  // admins, and payroll observers, who read and nothing more. Acting on a row
  // is narrower, and decided per row below.
  if (!canSeeAllPayroll(session.user.email)) redirect("/dashboard");

  /**
   * The viewer's roles, worked out exactly once for the whole page.
   *
   *   canPay     — the reviewer's pay/decline, matching `requireFinance` in
   *                ../finance/actions.ts. A global admin who is not the
   *                reviewer gets no verbs here: they read every row on the
   *                page and can move none of them.
   *   canRecord  — recording a settled figure on the register. The reviewer or
   *                a global admin, the same test `requireSheetEditor` in
   *                ../sheet/actions.ts applies: deciding a request and writing
   *                down what settled it are different jobs. A payroll observer
   *                is neither, so the register stays read-only for them too —
   *                the one power they hold is opening this page.
   *
   * Both are copies of a server-side guard, for deciding what to draw. Neither
   * is the guard.
   */
  // While payroll is closed the panel is strictly a record: both flags go
  // false for everyone, because every action behind them refuses anyway and a
  // button that throws is worse than no button.
  const canPay = payrollOpen && isFinance(session.user.email);
  const canRecord = payrollOpen && (canPay || isAdmin(session.user.email));

  const now = new Date();
  await expireLapsedSubmissions(now);
  await reconcilePayrollReminders(now);
  const currentPeriod = await ensureCurrentPeriod(prisma, now);

  const { p, view: viewParam } = await searchParams;
  const view: PanelView = viewParam === "sheet" ? "sheet" : "queue";

  const periods = await prisma.payrollPeriod.findMany({
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: {
      id: true,
      year: true,
      month: true,
      filingOpensAt: true,
      filingClosesAt: true,
    },
  });
  // One definition now that there is one page — this used to be written out in
  // both /payroll/review and /payroll/sheet.
  const periodKeyOf = (x: { year: number; month: number }) =>
    `${x.year}-${String(x.month).padStart(2, "0")}`;
  const selected =
    periods.find((x) => periodKeyOf(x) === p) ??
    periods.find((x) => x.id === currentPeriod.id) ??
    periods[0];
  const label = payrollPeriodLabel(selected.year, selected.month);
  const periodKey = periodKeyOf(selected);
  // Read through filingWindowState, not off the column: a month held open
  // (PAYROLL_HELD_OPEN) is past its stored cutoff and still accepting filings,
  // so the raw comparison would report it closed and start naming people who
  // "did not file" while they still can.
  const periodClosed = filingWindowState(selected, now) === "CLOSED";
  const heldOpen = isHeldOpenPeriod(selected);

  /** Every link on the page: pick a month, or a view, and keep the other. */
  const hrefFor = (key: string, to: PanelView) =>
    `/payroll/panel?p=${key}${to === "sheet" ? "&view=sheet" : ""}`;

  /**
   * The month, loaded ONCE. Both views are readings of these same rows: two
   * queries is how a register and a queue end up disagreeing about a month.
   *
   * The explicit order is load-bearing for the register. Postgres returns an
   * unordered heap and an UPDATE physically moves a row, so without it,
   * recording one figure reshuffled the table under the person doing it —
   * which is how a number ends up typed against the wrong name.
   */
  const submissions = await prisma.payrollSubmission.findMany({
    where: { periodId: selected.id, ...MONTH_SCOPE },
    orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      baseSalary: true,
      bonusesTotal: true,
      finesTotal: true,
      expensesTotalCents: true,
      netTotal: true,
      paymentMethod: true,
      paymentDetails: true,
      submittedAt: true,
      lastSubmittedAt: true,
      resubmitDeadline: true,
      graceDayUsed: true,
      processedAt: true,
      // The register's three hand-recorded columns.
      amountUzs: true,
      amountSgdCents: true,
      wiseFeeCents: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          memberships: {
            select: { role: true, department: { select: { name: true } } },
          },
        },
      },
      bonusLines: {
        orderBy: { awardedAt: "asc" },
        select: { id: true, amount: true, note: true, awardedAt: true },
      },
      fineLines: {
        orderBy: { issuedAt: "asc" },
        select: { id: true, amount: true, type: true, note: true, issuedAt: true },
      },
      expenses: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          label: true,
          amountCents: true,
          receipt: { select: { id: true, filename: true } },
        },
      },
      events: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          fromStatus: true,
          toStatus: true,
          note: true,
          createdAt: true,
          actor: { select: { name: true, email: true } },
        },
      },
    },
  });

  type PanelSubmission = (typeof submissions)[number];

  const nameOf = (s: PanelSubmission) => s.user.name ?? s.user.email ?? "—";

  // Who never filed this period (any non-draft submission counts as filed).
  const employees = await eligibleEmployees(prisma);
  const filedIds = new Set(submissions.map((s) => s.user.id));
  const unfiled = employees.filter((e) => !filedIds.has(e.id));

  const toPay = submissions.filter((s) => AWAITING.includes(s.status));
  const paid = submissions.filter((s) => s.status === "PROCESSED");
  const countable = submissions.filter((s) => COUNTABLE.includes(s.status));
  const toPayTotal = toPay.reduce((s, x) => s + x.netTotal, 0);
  const toPaySources = new Set(toPay.map((s) => s.paymentMethod)).size;
  const paidTotal = paid.reduce((s, x) => s + x.netTotal, 0);
  const monthTotal = countable.reduce((s, x) => s + x.netTotal, 0);

  /**
   * An unpaid request crosses the filing cutoff by design, so one filed in
   * July can still be waiting while this page is showing August. The old
   * /payroll/finance listed every period at once and could not miss one; a
   * month-scoped panel can, so the months with outstanding payments are named
   * here rather than quietly left off. Two scalar columns over a handful of
   * rows — this is a pointer to work, not a second load of the month.
   */
  const elsewhere = await prisma.payrollSubmission.findMany({
    where: { status: { in: AWAITING }, periodId: { not: selected.id } },
    select: { periodId: true, netTotal: true },
  });
  const carryOver = periods
    .map((x) => {
      const rows = elsewhere.filter((e) => e.periodId === x.id);
      return {
        id: x.id,
        key: periodKeyOf(x),
        label: payrollPeriodLabel(x.year, x.month),
        count: rows.length,
        total: rows.reduce((s, r) => s + r.netTotal, 0),
      };
    })
    .filter((x) => x.count > 0);

  /**
   * The month at a glance, for the register. The queue builds its own copy of
   * this strip inside the board (see `boardSummary` below): there the figures
   * follow the filters, so narrowing to a department shows that department's
   * money, and only the board knows what the filters left on screen. The sheet
   * has no filters, so its strip is this one, computed once here.
   */
  const stats: PanelStat[] = [
    {
      label: "To pay",
      value: formatMoney(toPayTotal),
      hint:
        toPay.length > 0
          ? `${toPay.length} ${toPay.length === 1 ? "request" : "requests"} · ${toPaySources} ${toPaySources === 1 ? "source" : "sources"}`
          : "Nothing on that desk",
      tone: toPay.length > 0 ? "brand" : "muted",
    },
    {
      label: "Paid",
      value: formatMoney(paidTotal),
      hint: `${paid.length} ${paid.length === 1 ? "request" : "requests"} settled`,
      tone: paid.length > 0 ? "brand" : "muted",
    },
    {
      label: `${label} total`,
      value: formatMoney(monthTotal),
      hint: `${submissions.length} filed · ${paid.length} paid`,
      tone: "ink",
    },
    {
      label: "Not filed",
      value: String(unfiled.length),
      hint: heldOpen
        ? "Filing held open — no cutoff"
        : `Filing ${periodClosed ? "closed" : "closes"} ${formatTashkent(selected.filingClosesAt)}`,
      tone: "muted",
    },
  ];

  // "Typical" for this month, used to flag a net that towers over the rest.
  // Expired filings are excluded so a dead row can't skew the middle.
  const median = medianNet(countable.map((s) => s.netTotal));

  /**
   * The queue's own order: most urgent status first, then oldest first inside
   * a status — the order someone working top-down should follow. Sorting a
   * copy leaves `submissions` in the register's order, and because that order
   * is already total (submittedAt, then id) this sort is deterministic too.
   */
  const queue = [...submissions].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      (a.lastSubmittedAt?.getTime() ?? 0) - (b.lastSubmittedAt?.getTime() ?? 0),
  );

  const items: PanelBoardItem[] = queue.map((s) => {
    const av = resolveAvatar(s.user.avatar, s.user.email ?? s.user.id);
    const handedOver = approvedAt(s.events);
    /**
     * Whose clock is running on this row, and since when. A filed request has
     * been on the reviewer's desk since it was filed; a legacy approved one
     * since the hand-off that put it there. Anything else is decided, and
     * nobody is waiting on it.
     */
    const waitingSince =
      s.status === "SUBMITTED" || s.status === "WITH_LEAD"
        ? s.lastSubmittedAt
        : s.status === "APPROVED_BY_ADMIN"
          ? handedOver
          : null;

    const metaLine =
      s.status === "WITH_LEAD"
        ? `${s.lastSubmittedAt ? `Filed ${formatDateTimeTz(s.lastSubmittedAt)} · ` : ""}waiting on their department lead`
        : s.status === "DECLINED" && s.resubmitDeadline
        ? `Resubmit by ${formatTashkent(s.resubmitDeadline)}${s.graceDayUsed ? " · grace day" : ""}`
        : // Declined inside a held-open month, so it carries no deadline —
          // saying when it was filed instead would hide that it is waiting on
          // the filer, with nothing counting down.
          s.status === "DECLINED" && heldOpen
          ? "Resubmit — no deadline while the month is held open"
          : s.status === "PROCESSED" && s.processedAt
          ? `Paid ${formatDateTimeTz(s.processedAt)}`
          : s.status === "APPROVED_BY_ADMIN" && handedOver
            ? `Approved ${formatDateTimeTz(handedOver)}`
            : s.lastSubmittedAt
              ? `Filed ${formatDateTimeTz(s.lastSubmittedAt)}`
              : null;

    const flags = [
      waitingFlag(waitingSince, now),
      sizeFlag(s.netTotal, median),
    ].filter((f): f is PanelFlag => f !== null);

    // One summary shape for all three row kinds. The merged queue mixes
    // statuses AND payment sources in one list, so every row carries both
    // badges — on the two panels this replaces, each showed only the one its
    // single-purpose list did not already imply.
    const summary: PanelRowSummary = {
      name: nameOf(s),
      deptLine: departmentLine(s.user.memberships),
      emoji: av.emoji,
      bg: av.bg,
      metaLine,
      netLabel: formatMoney(s.netTotal),
      flags,
      statusLabel: PAYROLL_STATUS_LABEL[s.status],
      statusBadge: PAYROLL_STATUS_BADGE[s.status],
      sourceLabel: PAYROLL_METHOD_LABEL[s.paymentMethod],
    };

    const detail = (
      <SubmissionDetail
        view={{
          id: s.id,
          baseSalary: s.baseSalary,
          bonusesTotal: s.bonusesTotal,
          finesTotal: s.finesTotal,
          expensesTotalCents: s.expensesTotalCents,
          netTotal: s.netTotal,
          bonuses: bonusLineViews(s.bonusLines, selected.year),
          fines: fineLineViews(s.fineLines, selected.year),
          expenses: s.expenses,
          paymentLine: paymentSummary(
            s.paymentMethod,
            parsePaymentDetails(s.paymentDetails),
          ),
          // Unmasked: both of these screens live behind the app's own auth, and
          // the payment is made from one of them. Only the emailed PDF masks.
          paymentDetails: paymentDetailLines(
            s.paymentMethod,
            parsePaymentDetails(s.paymentDetails),
          ),
          events: eventViews(s.events, formatDateTimeTz),
        }}
      />
    );

    /**
     * The one place a row's verbs are decided: whether the row is still
     * waiting on a decision, AND whether the viewer is the reviewer. Neither
     * alone is enough, and anyone else gets the shell, which has no move to
     * offer and does not even pull the action module into the bundle.
     */
    const payable = AWAITING.includes(s.status) && canPay;
    // A request still on a lead's desk: unpayable by anyone, but the reviewer
    // keeps the send-back, which is the only exit if that approval never
    // comes (see FinanceRow's `mode`, and DECLINABLE in ../finance/actions).
    const unstickable = s.status === "WITH_LEAD" && canPay;
    const node = payable || unstickable ? (
      <FinanceRow
        submissionId={s.id}
        summary={summary}
        mode={payable ? "pay" : "unstick"}
      >
        {detail}
      </FinanceRow>
    ) : (
      // No tick of its own, but the space one takes — the spacer draws itself
      // only while the board has something tickable, so a settled month is not
      // indented for a column it does not have.
      <PanelRowShell summary={summary} select={<RowTickSpacer />}>
        {detail}
      </PanelRowShell>
    );

    return {
      id: s.id,
      name: summary.name,
      departments: s.user.memberships.map((m) => m.department.name),
      status: s.status,
      statusLabel: PAYROLL_STATUS_LABEL[s.status],
      method: s.paymentMethod,
      net: s.netTotal,
      waitingSince: waitingSince?.getTime() ?? null,
      periodKey,
      periodLabel: label,
      payable,
      // What this row is to the money lines. The page reads the status; the
      // board only adds up what it is handed.
      money: AWAITING.includes(s.status)
        ? "awaiting"
        : s.status === "PROCESSED"
          ? "paid"
          : "none",
      countable: COUNTABLE.includes(s.status),
      node,
    };
  });

  /**
   * The register reads chronologically, oldest first — the order the money
   * moved. `submittedAt` is when the request was first filed and is the date
   * the sheet records; `lastSubmittedAt` only stands in for rows written
   * before that column existed, a fallback the query cannot express. `id`
   * breaks the tie, because two people filing in the same second is ordinary
   * and the rows must not swap places between renders.
   */
  const filedAt = (s: PanelSubmission) => s.submittedAt ?? s.lastSubmittedAt;
  const sheetRows: SheetRow[] = [...countable]
    .sort(
      (a, b) =>
        (filedAt(a)?.getTime() ?? 0) - (filedAt(b)?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .map((s) => {
      const at = filedAt(s);
      const ymd = at ? tashkentYmd.format(at) : "";
      return {
        id: s.id,
        // The year is in the page heading, so the cell drops it and stays narrow.
        dateLabel: at ? formatYmd(ymd, selected.year) : "—",
        dateYmd: ymd,
        dateTitle: at ? formatDateTimeTz(at) : "Filing date unknown",
        name: nameOf(s),
        deptLine: departmentLine(s.user.memberships),
        amountUzs: s.amountUzs,
        amountSgdCents: s.amountSgdCents,
        wiseFeeCents: s.wiseFeeCents,
        sourceLabel: PAYROLL_METHOD_LABEL[s.paymentMethod],
        baseSalary: s.baseSalary,
        bonusesTotal: s.bonusesTotal,
        finesTotal: s.finesTotal,
        netTotal: s.netTotal,
      };
    });

  /**
   * What the queue's strip needs beyond the rows themselves. `listUnfiled`
   * carries the same rule the page used to apply around the list below —
   * before the window closes, "did not file" only means "has not filed yet".
   */
  const boardSummary: PanelBoardSummary = {
    periodLabel: label,
    notFiledHint: heldOpen
      ? "Filing held open — no cutoff"
      : `Filing ${periodClosed ? "closed" : "closes"} ${formatTashkent(selected.filingClosesAt)}`,
    unfiled: unfiled.map((e) => ({
      id: e.id,
      name: e.name ?? e.email ?? "—",
      departments: e.memberships.map((m) => m.department.name),
    })),
    listUnfiled: periodClosed,
    unfiledNote:
      "Nobody here is chased or penalized — they simply file in the next month\u2019s cycle, and that snapshot sweeps up anything unpaid.",
  };

  // Counted off the rows already loaded rather than re-queried: a month with
  // expired filings is short a few lines on the register, and dropping them
  // silently would look like it had lost something.
  const expiredCount = submissions.filter((s) => s.status === "EXPIRED").length;

  const pillClass = (active: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition ${
      active
        ? "border-brand bg-brand-soft text-brand"
        : "border-line text-muted-fg hover:text-ink"
    }`;

  const VIEWS: { key: PanelView; label: string }[] = [
    { key: "queue", label: "Queue" },
    { key: "sheet", label: "Sheet" },
  ];

  return (
    // The register is ten columns wide and the queue is a list, so the page
    // takes the width its content needs. Both classes are written out because
    // Tailwind only ships classes it can see in the source.
    <main
      className={`mx-auto w-full flex-1 px-4 py-8 ${
        view === "sheet" ? "max-w-7xl" : "max-w-4xl"
      }`}
    >
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Payroll panel</h1>
          <p className="mt-1 text-sm text-muted-fg">
            {view === "sheet"
              ? `${label} as a register — one line per request, in the same columns as the finance team's monthly tab. `
              : `Every ${label} request, most urgent first. `}
            {view === "sheet"
              ? canRecord
                ? "UZS, SGD and the Wise fee are yours to fill in as each payment settles."
                : "The settled amounts are recorded by finance."
              : canPay
                ? "Confirming a payment records the fine deduction and closes the request; declining sends it back with a note. Tick several rows to pay them in one go."
                : "Read-only — requests are decided and paid by finance."}
          </p>
        </div>
        <BackLink href="/payroll" label="Payroll" />
      </header>

      {/* Reachable while payroll is shut, and only by an admin — so say which
          of the two it is, or a panel with every verb missing reads as broken
          rather than as closed. */}
      {!payrollOpen && (
        <div className="mb-5 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">
            Payroll is closed — this is the record
          </p>
          <p className="mt-1 text-sm text-muted-fg">
            Everyone else sees the coming-soon screen, and nothing here can be
            paid, declined or recorded until payroll reopens. What was already
            filed is still listed in full, invoices and receipts included, and
            no request expires or is chased while the feature is shut.
          </p>
        </div>
      )}

      {carryOver.length > 0 && (
        <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-fg">
          <span>Also awaiting payment in</span>
          {carryOver.map((x) => (
            <Link
              key={x.id}
              href={hrefFor(x.key, view)}
              className="font-semibold text-brand hover:underline"
            >
              {`${x.label} · ${formatMoney(x.total)}`}
            </Link>
          ))}
          <span>— approvals may cross a filing cutoff.</span>
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Same month, read two ways. Both links carry the selected period, so
            switching view never silently moves the reader to another month. */}
        <div
          className="inline-flex shrink-0 gap-1 rounded-full border border-line bg-surface p-1"
          role="group"
          aria-label="Panel view"
        >
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={hrefFor(periodKey, v.key)}
              aria-current={view === v.key ? "page" : undefined}
              className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold transition ${
                view === v.key
                  ? "bg-brand-soft text-brand"
                  : "text-muted-fg hover:text-ink"
              }`}
            >
              {v.label}
            </Link>
          ))}
        </div>

        {periods.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {periods.map((x) => (
              <Link
                key={x.id}
                href={hrefFor(periodKeyOf(x), view)}
                className={pillClass(x.id === selected.id)}
              >
                {payrollPeriodLabel(x.year, x.month)}
              </Link>
            ))}
          </div>
        )}
      </div>

      {view === "sheet" ? (
        <>
          <PanelSummary stats={stats} />

          {sheetRows.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface px-4 py-8 text-center">
              <p className="text-sm font-semibold text-ink">
                Nothing to register
              </p>
              <p className="mt-1 text-xs text-muted-fg">
                {label} requests appear here the moment someone files.
              </p>
            </div>
          ) : (
            <SheetTable
              rows={sheetRows}
              editable={canRecord}
              periodKey={periodKey}
            />
          )}

          {expiredCount > 0 && (
            <p className="mt-3 px-1 text-xs text-muted-fg">
              {`${expiredCount} expired ${expiredCount === 1 ? "filing is" : "filings are"} not listed — an expired request is never paid, it rolls into the next month's cycle.`}
            </p>
          )}
        </>
      ) : (
        <>
          {items.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface px-4 py-8 text-center">
              <p className="text-sm font-semibold text-ink">Nothing filed yet</p>
              <p className="mt-1 text-xs text-muted-fg">
                {label} requests land here the moment someone files.
              </p>
            </div>
          ) : (
            <PanelBoard
              items={items}
              searchPlaceholder="Search name, department, source or status…"
              sourceNote="Pay out per source, then reconcile against the sheet."
              emptyHint={`No ${label} requests match these filters.`}
              // The batch bar is a verb, so it comes from here and only for
              // the reviewer — the board itself never grows one.
              batchBar={canPay ? <BatchPayBar /> : undefined}
              summary={boardSummary}
            />
          )}
        </>
      )}
    </main>
  );
}
