import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { resolveAvatar } from "@/lib/avatar";
import { departmentLine } from "@/lib/team";
import { formatDateTimeTz } from "@/lib/dates";
import { formatMoney } from "@/lib/penalties";
import { BackLink } from "@/app/_components/BackLink";
import {
  ensureCurrentPeriod,
  expireLapsedSubmissions,
  formatTashkent,
} from "@/lib/payroll";
import { approvableFilerIds } from "@/lib/payrollApproval";
import {
  formatCents,
  parsePaymentDetails,
  paymentDetailLines,
  paymentSummary,
  payrollPeriodLabel,
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
import { BatchPayBar } from "../_components/BatchPayBar";
import { PanelRowShell, type PanelRowSummary } from "../_components/PanelRowShell";
import {
  PaySelectionProvider,
  RowTickSpacer,
  SelectAllTick,
  type PayableRow,
} from "../_components/PaySelection";
import { SubmissionDetail } from "../_components/SubmissionDetail";
import { LeadRow } from "./LeadRow";
import { SettleRow } from "./SettleRow";

/**
 * What this desk may PAY — the panel's AWAITING and finance's PAYABLE, one
 * list per surface because each is a copy for deciding what to draw and never
 * the guard (../finance/actions.ts re-reads the status and the filer).
 *
 * WITH_LEAD is absent here as it is there: a request nobody has approved is
 * not payable by anyone, the lead included. They approve it first — which is
 * what puts their name in the audit trail as the person who vouched for it —
 * and settle it on the next pass.
 */
const PAYABLE: PayrollStatus[] = ["SUBMITTED", "APPROVED_BY_ADMIN"];

export const metadata: Metadata = { title: "Your team's pay requests" };

/**
 * The department lead's payroll desk: what their people asked for this month,
 * and the approval finance is waiting on.
 *
 * Scoped by lib/payrollApproval.ts and nothing else — a lead sees the members
 * of the normal departments they lead, and no one else's request appears here
 * at any status.
 *
 * Three verbs: approve, send back, and — once approved — confirm the payment,
 * one row or a ticked batch of them (requirePayer in lib/payroll.ts). A lead
 * settles their own department, so a month that is already vouched for does
 * not queue behind finance. What they still do not get is anything about
 * someone else's request: declining a request that has left their desk is
 * finance's, and so is the register and every other department.
 *
 * Payout instructions follow the verb. They used to be withheld on the
 * grounds that a card number is for the person sending the money — which is
 * now this page, for a request it may settle, and nobody can pay a Payme card
 * they cannot read. A row this lead cannot pay still shows none.
 *
 * Past months are readable through the period links, because "what did my team
 * claim in August" is the other half of the question this page answers — but
 * only a request still on this desk carries buttons.
 */
export default async function TeamPayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string | string[] }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  const viewerId = session.user.id;

  if (!isPayrollOpenFor(session.user.email)) return <PayrollComingSoon />;

  // Who this viewer may approve. Empty means they lead nothing (or only a mini
  // department, which runs itself) — there is no desk to show them.
  const scope = await approvableFilerIds(prisma, viewerId);
  if (scope.size === 0) redirect("/dashboard");

  const now = new Date();
  // Same lazy sweeps every payroll surface runs before it reads, so nobody
  // sees or acts on a window that is really over.
  await expireLapsedSubmissions(now);
  const current = await ensureCurrentPeriod(prisma, now);

  const periods = await prisma.payrollPeriod.findMany({
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: { id: true, year: true, month: true },
  });
  const { p } = await searchParams;
  const wanted = Array.isArray(p) ? p[0] : p;
  const selected =
    periods.find((row) => row.id === wanted) ??
    periods.find((row) => row.id === current.id) ??
    periods[0];
  const label = payrollPeriodLabel(selected.year, selected.month);

  const scopeIds = [...scope];
  const submissions = await prisma.payrollSubmission.findMany({
    where: {
      periodId: selected.id,
      userId: { in: scopeIds },
      // DRAFT only exists inside the filing transaction, so there is never
      // such a row to show (the panel drops it for the same reason).
      status: { not: "DRAFT" },
    },
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
      lastSubmittedAt: true,
      resubmitDeadline: true,
      graceDayUsed: true,
      processedAt: true,
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

  // What the team asked for. EXPIRED filings are left out of the money: they
  // are never paid (they roll into the next cycle), so counting them would
  // overstate the month — the same rule the panel's totals use, which is what
  // keeps the two pages agreeing about a month.
  const counted = submissions.filter((s) => s.status !== "EXPIRED");
  const requestedTotal = counted.reduce((sum, s) => sum + s.netTotal, 0);
  const expensesTotalCents = counted.reduce(
    (sum, s) => sum + s.expensesTotalCents,
    0,
  );
  const compensationsTotal = counted.reduce((sum, s) => sum + s.bonusesTotal, 0);
  const waiting = submissions.filter((s) => s.status === "WITH_LEAD");
  // Approved and unpaid: what this lead can settle now, and what the tick
  // column and the batch bar are handed. Same order as the list.
  const toSettle = submissions.filter((s) => PAYABLE.includes(s.status));
  const settleTotal = toSettle.reduce((sum, s) => sum + s.netTotal, 0);
  const selectable: PayableRow[] = toSettle.map((s) => ({
    id: s.id,
    name: s.user.name ?? s.user.email ?? "—",
    net: s.netTotal,
  }));

  // Who on the team hasn't filed for this period at all — a lead chasing an
  // approval usually wants the other half of that list too.
  const filed = new Set(submissions.map((s) => s.user.id));
  const unfiled = await prisma.user.findMany({
    where: { id: { in: scopeIds.filter((id) => !filed.has(id)) } },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    select: { id: true, name: true, email: true },
  });

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <header className="mb-6">
        <BackLink href="/department" label="Department" />
        <h1 className="mt-3 text-2xl font-bold text-ink">
          Your team&rsquo;s pay requests
        </h1>
        <p className="mt-1 text-sm text-muted-fg">
          {`${label} · what the people you lead have claimed, and what finance is waiting on you to approve.`}
        </p>
      </header>

      {periods.length > 1 && (
        <nav className="mb-6 flex flex-wrap gap-1.5" aria-label="Period">
          {periods.slice(0, 8).map((row) => {
            const isSelected = row.id === selected.id;
            return (
              <a
                key={row.id}
                href={`/payroll/team?p=${row.id}`}
                aria-current={isSelected ? "page" : undefined}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                  isSelected
                    ? "border-brand bg-brand text-white"
                    : "border-line text-muted-fg hover:bg-canvas hover:text-ink"
                }`}
              >
                {payrollPeriodLabel(row.year, row.month)}
              </a>
            );
          })}
        </nav>
      )}

      {/* The figures first: bullet one of what this page is for. Requested is
          the net of each request — salary plus compensations and expenses,
          less any fines — because that is the number finance will actually
          pay, and the two parts a lead has a say in are broken out beside it. */}
      <section className="mb-6 grid gap-3 sm:grid-cols-3">
        <Figure
          label="Requested"
          value={formatMoney(requestedTotal)}
          note={`${counted.length} ${counted.length === 1 ? "request" : "requests"}`}
        />
        <Figure
          label="Compensations"
          value={formatMoney(compensationsTotal)}
          note="bonuses in those requests"
        />
        <Figure
          label="Expenses"
          value={formatCents(expensesTotalCents)}
          note="reimbursements claimed"
        />
      </section>

      {waiting.length > 0 && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">
            {`${waiting.length} ${waiting.length === 1 ? "request needs" : "requests need"} your approval.`}
          </span>{" "}
          {"Nobody can pay them — you or finance — until you approve."}
        </p>
      )}

      {toSettle.length > 0 && (
        <p className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink">
          <span className="font-semibold">
            {`${toSettle.length} approved ${toSettle.length === 1 ? "request is" : "requests are"} waiting to be paid — ${formatMoney(settleTotal)}.`}
          </span>{" "}
          <span className="text-muted-fg">
            {"Pay them however each person asked, then confirm it here. Finance can settle them too, whoever gets there first."}
          </span>
        </p>
      )}

      {submissions.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-8 text-center text-sm text-muted-fg">
          {`Nobody on your team has filed for ${label} yet.`}
        </p>
      ) : (
        /* The provider is what makes a batch possible at all: the ticks on
           the rows and the bar that pays them are siblings, and this is the
           ancestor they share. It is handed exactly the rows awaiting
           payment, so a row that has just been paid drops out of the batch by
           itself when the page revalidates. */
        <PaySelectionProvider selectable={selectable}>
          {toSettle.length > 1 && (
            <div className="mb-2 flex justify-end">
              <SelectAllTick />
            </div>
          )}
          <ul className="flex flex-col gap-2">
            {submissions.map((s) => {
              const canSettle = PAYABLE.includes(s.status);
              const av = resolveAvatar(s.user.avatar, s.user.email ?? s.user.id);
              const metaLine =
                s.status === "DECLINED" && s.resubmitDeadline
                  ? `Sent back · resubmit by ${formatTashkent(s.resubmitDeadline)}${
                      s.graceDayUsed ? " · grace day" : ""
                    }`
                  : s.status === "PROCESSED" && s.processedAt
                    ? `Paid ${formatDateTimeTz(s.processedAt)}`
                    : s.lastSubmittedAt
                      ? `Filed ${formatDateTimeTz(s.lastSubmittedAt)}`
                      : null;

              const summary: PanelRowSummary = {
                name: s.user.name ?? s.user.email ?? "—",
                deptLine: departmentLine(s.user.memberships),
                emoji: av.emoji,
                bg: av.bg,
                metaLine,
                netLabel: formatMoney(s.netTotal),
                // No attention flags here: "waited too long" and "unusually
                // large" are the reviewer's triage across the whole company, and
                // a lead reading five of their own people's requests has the
                // context those marks are a substitute for.
                flags: [],
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
                    // Only where this lead is the one paying: settling a
                    // request needs the account it goes to, approving one needs
                    // the amounts and the receipts and nothing else.
                    paymentDetails: canSettle
                      ? paymentDetailLines(
                          s.paymentMethod,
                          parsePaymentDetails(s.paymentDetails),
                        )
                      : [],
                    events: eventViews(s.events, formatDateTimeTz),
                  }}
                />
              );

              // PanelRowShell is the <li>, so each shape is keyed here rather
              // than wrapped in one.
              if (s.status === "WITH_LEAD") {
                return (
                  <LeadRow key={s.id} submissionId={s.id} summary={summary}>
                    {detail}
                  </LeadRow>
                );
              }
              if (canSettle) {
                return (
                  <SettleRow key={s.id} submissionId={s.id} summary={summary}>
                    {detail}
                  </SettleRow>
                );
              }
              return (
                <PanelRowShell
                  key={s.id}
                  summary={summary}
                  // Nothing to tick on a settled or sent-back row, but the
                  // column has to line up with the rows that do.
                  select={<RowTickSpacer />}
                >
                  {detail}
                </PanelRowShell>
              );
            })}
          </ul>
          {/* Only mounted for a desk already established as one that may pay
              something — see BatchPayBar. */}
          <BatchPayBar />
        </PaySelectionProvider>
      )}

      {unfiled.length > 0 && (
        <section className="mt-6 rounded-xl border border-line bg-surface px-4 py-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
            Not filed yet
          </h2>
          <p className="mt-1 text-sm text-ink">
            {unfiled.map((u) => u.name ?? u.email ?? "—").join(", ")}
          </p>
          <p className="mt-1 text-xs text-muted-fg">
            Nothing to approve from them — a request only reaches you once it
            is filed.
          </p>
        </section>
      )}
    </main>
  );
}

/** One headline figure. Three of these are the answer to "how much did my team ask for". */
function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
        {label}
      </p>
      <p className="mt-0.5 text-2xl font-bold leading-none tabular-nums text-ink">
        {value}
      </p>
      <p className="mt-1.5 text-xs text-muted-fg">{note}</p>
    </div>
  );
}
