import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { BackLink } from "@/app/_components/BackLink";
import { PaymentDetailsPrompt } from "./_components/PaymentDetailsPrompt";
import { formatDateTimeTz, formatYmd, toYmd } from "@/lib/dates";
import { PENALTY_LABEL } from "@/lib/penalties";
import {
  canReadPayrollWhileClosed,
  canSeeAllPayroll,
  ensureCurrentPeriod,
  expireLapsedSubmissions,
  filingWindowState,
  filingWindowStateFor,
  formatTashkent,
  inFlightSubmission,
  pullLedgerSnapshot,
  reconcilePayrollReminders,
  submissionNeedingPaymentDetails,
} from "@/lib/payroll";
import {
  paymentDetailLines,
  paymentSummary,
  payrollEventLabel,
  payrollMonthName,
  parsePaymentDetails,
  payrollPeriodLabel,
  isHeldOpenPeriod,
  isPayrollOpenFor,
  isPayrollRolloutTester,
  PAYROLL_STATUS_BADGE,
  PAYROLL_STATUS_LABEL,
} from "@/lib/payrollTypes";
import { formatMoney } from "@/lib/penalties";
import { PayrollComingSoon } from "./_components/PayrollComingSoon";
import { PayrollForm } from "./_components/PayrollForm";
import type { LedgerLineView } from "./_components/LedgerBreakdown";
import { EditableSubmission } from "./_components/EditableSubmission";
import {
  SubmissionView,
  type SubmissionViewModel,
} from "./_components/SubmissionView";

export const metadata: Metadata = { title: "Payroll" };

/**
 * The employee's payroll home: file this month's pay request (or refile after
 * a decline), watch it move through review, and reach every past invoice.
 *
 * One request per calendar month, and filing is only open for a four-day
 * window — the last three days of the month plus the 1st of the next one (see
 * periodBoundsFor). Outside it this page says when the window opens or that it
 * closed, rather than showing a form the action would only reject. Missing the
 * window carries no penalty: the next month's snapshot sweeps up whatever is
 * still unpaid.
 *
 * One month at a time can be held open past its cutoff for everybody
 * (PAYROLL_HELD_OPEN), and while it is, it stays the month this page files
 * against — with a notice, because a form that outlives its own deadline
 * otherwise looks like a bug.
 */
export default async function PayrollPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  // Closed: bail before the sweeps so nothing expires or emails while shut.
  // Anyone who reads payroll while closed (an admin, an observer) is pointed
  // on to the panel, the one payroll surface that stays readable — this page
  // has nothing to offer them, since there is no filing to do.
  if (!isPayrollOpenFor(session.user.email)) {
    return (
      <PayrollComingSoon
        panelLink={canReadPayrollWhileClosed(session.user.email)}
      />
    );
  }

  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { select: { id: true }, take: 1 },
    },
  });
  if (!me) redirect("/signin");
  if (me.memberships.length === 0) redirect("/onboarding");

  // The lazy sweeps every payroll surface runs before reading: lapse dead
  // decline windows, and fire the once-per-period filing reminder when due.
  const now = new Date();
  await expireLapsedSubmissions(now);
  await reconcilePayrollReminders(now);
  const period = await ensureCurrentPeriod(prisma, now);
  const label = payrollPeriodLabel(period.year, period.month);
  // Where we are in the filing window. Everything the page offers to DO keys
  // off this; the server action re-checks it, so this only decides what is
  // worth showing.
  const filingWindow = filingWindowStateFor(me.email, period, now);
  const filingOpen = filingWindow === "OPEN";
  // Held open by hand (PAYROLL_HELD_OPEN): the month has no cutoff until
  // someone lifts it, so every "closes …" on this page has no date to name.
  const heldOpen = isHeldOpenPeriod(period);
  const closesLabel = heldOpen ? null : formatTashkent(period.filingClosesAt);
  // A rollout tester is inside the window by definition (see
  // filingWindowStateFor). Say so where it would otherwise look like the
  // window simply isn't working — filing on the 25th when the card elsewhere
  // says the window opens on the 29th needs an explanation on the page, not
  // just in the code.
  const windowBypassed =
    isPayrollRolloutTester(me.email) &&
    filingWindowState(period, now) !== "OPEN";
  // The window's closing day falls in the FOLLOWING month, so name that month
  // in the copy — "the 1st" on its own reads as this month's. December wraps.
  const nextMonthName = payrollMonthName(period.month === 12 ? 1 : period.month + 1);

  const current = await prisma.payrollSubmission.findUnique({
    where: { userId_periodId: { userId: me.id, periodId: period.id } },
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
      resubmitDeadline: true,
      processedAt: true,
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

  const history = await prisma.payrollSubmission.findMany({
    where: { userId: me.id, NOT: { periodId: period.id } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      netTotal: true,
      submittedAt: true,
      period: { select: { year: true, month: true } },
    },
  });

  // Prefill the form with how this person was paid last time.
  const latest = await prisma.payrollSubmission.findFirst({
    where: { userId: me.id },
    orderBy: { createdAt: "desc" },
    select: { baseSalary: true, paymentMethod: true, paymentDetails: true },
  });
  const prefill = {
    baseSalary: latest?.baseSalary ?? null,
    // A first-time filer has no previous method to copy. The team is
    // Tashkent-based and most people are paid in cash there, so that is the
    // one that needs changing least often — and it is the value the old CASH
    // enum member migrated onto, so returning filers land where they were.
    method: latest?.paymentMethod ?? ("CASH_UZBEKISTAN" as const),
    details: parsePaymentDetails(latest?.paymentDetails),
  };

  // A request filed before the card/bank fields existed has nothing finance
  // can pay from, and the filer has no way to know. Ask, here and on the
  // dashboard, until it's answered.
  const needsDetails = await submissionNeedingPaymentDetails(session.user.id);

  const canFileFresh = !current && filingOpen;
  const canResubmit = current?.status === "DECLINED"; // lapsed ones were swept above
  // Still in the queue, untouched by a reviewer, and the window is still open.
  // The review is the other bound: an admin acting on it closes editing early,
  // whatever the clock says.
  const canEdit = current?.status === "SUBMITTED" && filingOpen;
  const blocking = canFileFresh ? await inFlightSubmission(prisma, me.id) : null;

  const dateOf = (d: Date) => formatYmd(toYmd(d), period.year);
  const snapshot =
    (canFileFresh && !blocking) || canResubmit || canEdit
      ? await pullLedgerSnapshot(prisma, me.id).then((s) => ({
          bonuses: s.bonusLines.map((l) => ({
            id: l.bonusId,
            label: "Bonus",
            dateLabel: dateOf(l.awardedAt),
            note: l.note,
            amount: l.amount,
          })),
          fines: s.fineLines.map((l) => ({
            id: l.penaltyId,
            label: PENALTY_LABEL[l.type],
            dateLabel: dateOf(l.issuedAt),
            note: l.note,
            amount: l.amount,
          })),
          bonusesTotal: s.bonusesTotal,
          finesTotal: s.finesTotal,
        }))
      : null;

  // The last decline's note, for the reopened form's banner.
  const declineNote =
    canResubmit && current
      ? (current.events.findLast((e) => e.toStatus === "DECLINED")?.note ?? null)
      : null;

  const view: SubmissionViewModel | null =
    current && !canResubmit
      ? {
          id: current.id,
          status: current.status,
          banner:
            current.status === "WITH_LEAD"
              ? {
                  tone: "border-amber-200 bg-amber-50 text-amber-800",
                  text: `With your department lead for approval — finance sees it once they pass it on.${
                    filingOpen
                      ? ""
                      : " Filing is closed, so it stands exactly as filed; your lead can send it back if something needs changing."
                  }`,
                }
              : current.status === "SUBMITTED"
              ? {
                  tone: "border-brand/30 bg-brand-soft text-brand",
                  // Editing follows the filing window, so say so here rather
                  // than letting the Edit button quietly go missing.
                  text: `With finance for payment — you'll get a notification when it moves.${
                    filingOpen
                      ? ""
                      : " Filing is closed, so it stands exactly as filed; finance can send it back if something needs changing."
                  }`,
                }
              : current.status === "APPROVED_BY_ADMIN"
                ? {
                    tone: "border-accent/40 bg-accent-soft text-accent-ink",
                    text: "Approved — with finance for payment.",
                  }
                : current.status === "PROCESSED"
                  ? {
                      tone: "border-green-200 bg-green-50/60 text-green-800",
                      text: `Paid out${current.processedAt ? ` · ${formatDateTimeTz(current.processedAt)}` : ""}. The fine deduction was recorded on your ledger.`,
                    }
                  : current.status === "EXPIRED"
                    ? {
                        tone: "border-line bg-canvas text-muted-fg",
                        text: "The resubmit window lapsed. No penalty — file again in next month's cycle; anything unpaid rolls into that snapshot automatically.",
                      }
                    : null,
          baseSalary: current.baseSalary,
          bonusesTotal: current.bonusesTotal,
          finesTotal: current.finesTotal,
          expensesTotalCents: current.expensesTotalCents,
          netTotal: current.netTotal,
          bonuses: current.bonusLines.map(
            (l): LedgerLineView => ({
              id: l.id,
              label: "Bonus",
              dateLabel: dateOf(l.awardedAt),
              note: l.note,
              amount: l.amount,
            }),
          ),
          fines: current.fineLines.map(
            (l): LedgerLineView => ({
              id: l.id,
              label: PENALTY_LABEL[l.type],
              dateLabel: dateOf(l.issuedAt),
              note: l.note,
              amount: l.amount,
            }),
          ),
          expenses: current.expenses,
          paymentLine: paymentSummary(
            current.paymentMethod,
            parsePaymentDetails(current.paymentDetails),
          ),
          // Unmasked: both of these screens live behind the app's own auth, and
          // the payment is made from one of them. Only the emailed PDF masks.
          paymentDetails: paymentDetailLines(
            current.paymentMethod,
            parsePaymentDetails(current.paymentDetails),
          ),
          events: current.events.map((e) => ({
            id: e.id,
            label: payrollEventLabel(e.fromStatus, e.toStatus),
            actorName: e.actor ? (e.actor.name ?? e.actor.email ?? null) : null,
            dateLabel: formatDateTimeTz(e.createdAt),
            note: e.note,
          })),
        }
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Payroll</h1>
          <p className="mt-1 text-sm text-muted-fg">
            One pay request per calendar month — your bonuses and fines are
            pulled in automatically, you add salary and expenses.
          </p>
        </div>
        <BackLink href="/dashboard" label="Dashboard" />
      </header>

      {needsDetails && (
        <PaymentDetailsPrompt
          pending={{
            submissionId: needsDetails.id,
            method: needsDetails.method,
            details: needsDetails.details,
            periodLabel: needsDetails.periodLabel,
          }}
        />
      )}

      {/* One link, not three. The reviewer stages and the register merged
          into /payroll/panel, where the verbs on a row come from the viewer's
          role — so there is no longer a URL per audience to choose between,
          and this can be gated once on "may see payroll money at all". */}
      {canSeeAllPayroll(me.email) && (
        <div className="-mt-2 mb-5 flex flex-wrap gap-2">
          <Link
            href="/payroll/panel"
            className="whitespace-nowrap rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-brand shadow-sm transition hover:bg-canvas"
          >
            Payroll panel
          </Link>
          <Link
            href="/payroll/stats"
            className="whitespace-nowrap rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-brand shadow-sm transition hover:bg-canvas"
          >
            Stats
          </Link>
        </div>
      )}

      {/* The month is past its cutoff and the form is still here. Say why, or
          it reads as the window having failed — and say that it ends when
          someone decides, since there is no date to plan around. */}
      {heldOpen && (
        <div className="mb-5 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">
            {`${label} is being held open`}
          </p>
          <p className="mt-1 text-sm text-muted-fg">
            {`Filing for ${label} would normally have closed ${formatTashkent(period.filingClosesAt)}. It's open to everyone as an exception, with no new deadline — file whenever you're ready, and you'll be told before it closes.`}
          </p>
        </div>
      )}

      {/* Filing is normally shut outside the window; it's open here because
          this account is on the restricted-rollout allowlist. Announce it —
          otherwise filing mid-month looks like the window is broken. */}
      {windowBypassed && (
        <div className="mb-5 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">
            Filing is open to you early
          </p>
          <p className="mt-1 text-sm text-muted-fg">
            {`Payroll is in a restricted rollout, so the filing window doesn't apply to your account yet — you can file ${label} now to try it out. For everyone else the window is ${formatTashkent(period.filingOpensAt)} to ${formatTashkent(period.filingClosesAt)}, and it will apply to you too once the rollout opens up.`}
          </p>
        </div>
      )}

      {/* No `resubmitDeadline` check: a decline inside a held-open month is
          given none (resubmitWindowFor), and the form is what the person needs
          most in exactly that case. */}
      {canResubmit && snapshot && current && (
        <PayrollForm
          periodLabel={label}
          closesLabel={closesLabel}
          snapshot={snapshot}
          prefill={{
            baseSalary: current.baseSalary,
            method: current.paymentMethod,
            details: parsePaymentDetails(current.paymentDetails),
            expenses: current.expenses.map((e) => ({
              id: e.id,
              label: e.label,
              amountCents: e.amountCents,
              receiptName: e.receipt?.filename ?? null,
            })),
          }}
          mode={{
            kind: "refile",
            deadlineIso: current.resubmitDeadline?.toISOString() ?? null,
            deadlineLabel: current.resubmitDeadline
              ? formatTashkent(current.resubmitDeadline)
              : null,
            note: declineNote,
          }}
        />
      )}

      {view && !canEdit && (
        <SubmissionView heading={`Your ${label} request`} view={view} />
      )}

      {canEdit && view && snapshot && current && (
        <EditableSubmission
          heading={`Your ${label} request`}
          view={view}
          form={
            <PayrollForm
              periodLabel={label}
              closesLabel={closesLabel}
              snapshot={snapshot}
              prefill={{
                baseSalary: current.baseSalary,
                method: current.paymentMethod,
                details: parsePaymentDetails(current.paymentDetails),
                expenses: current.expenses.map((e) => ({
                  id: e.id,
                  label: e.label,
                  amountCents: e.amountCents,
                  receiptName: e.receipt?.filename ?? null,
                })),
              }}
              mode={{ kind: "edit" }}
            />
          }
        />
      )}

      {canFileFresh && blocking && (
        <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-ink">
            {label} filing is waiting on your last request
          </h2>
          <p className="mt-2 text-sm text-muted-fg">
            Your {payrollMonthName(blocking.period.month)} pay request is still
            in review (
            <span className="font-medium text-ink">
              {PAYROLL_STATUS_LABEL[blocking.status]}
            </span>
            ). Filing for {label} unlocks the moment it&rsquo;s processed —
            otherwise the same bonuses and fines would land in two invoices.
          </p>
        </section>
      )}

      {canFileFresh && !blocking && snapshot && (
        <PayrollForm
          periodLabel={label}
          closesLabel={closesLabel}
          snapshot={snapshot}
          prefill={prefill}
          mode={{ kind: "file" }}
        />
      )}

      {!current && filingWindow === "BEFORE" && (
        <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-ink">
            {label} filing opens {formatTashkent(period.filingOpensAt)}
          </h2>
          <p className="mt-2 text-sm text-muted-fg">
            {`The window is the last three days of ${payrollMonthName(period.month)} plus the 1st of ${nextMonthName} — open until ${formatTashkent(period.filingClosesAt)}. Your request snapshots the whole month's bonuses and fines, so it's filed once the month is nearly over. You'll get a reminder the morning it opens.`}
          </p>
        </section>
      )}

      {!current && filingWindow === "CLOSED" && (
        <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-ink">
            {label} filing has closed
          </h2>
          <p className="mt-2 text-sm text-muted-fg">
            Filing closed {formatTashkent(period.filingClosesAt)}. No penalty —
            you&rsquo;ll simply file in next month&rsquo;s cycle, and anything
            unpaid (bonuses, fines) rolls into that snapshot automatically.
          </p>
        </section>
      )}

      {history.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 px-1 text-sm font-semibold text-ink">
            Past requests
          </h2>
          <ul className="flex flex-col gap-2">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="text-sm font-medium text-ink">
                    {payrollPeriodLabel(h.period.year, h.period.month)}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${PAYROLL_STATUS_BADGE[h.status]}`}
                  >
                    {PAYROLL_STATUS_LABEL[h.status]}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm font-semibold tabular-nums text-ink">
                    {formatMoney(h.netTotal)}
                  </span>
                  <a
                    href={`/payroll/submissions/${h.id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="whitespace-nowrap rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-canvas"
                  >
                    PDF ↗
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
