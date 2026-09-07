import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/penalties";
import { BackLink } from "@/app/_components/BackLink";
import {
  canReadPayrollWhileClosed,
  canSeeAllPayroll,
  ensureCurrentPeriod,
  expireLapsedSubmissions,
  reconcilePayrollReminders,
} from "@/lib/payroll";
import {
  payrollMonthName,
  payrollPeriodLabel,
  isPayrollOpenFor,
  PAYROLL_METHOD_LABEL,
  type PayrollMethod,
} from "@/lib/payrollTypes";
import { PayrollComingSoon } from "../_components/PayrollComingSoon";
import { ColumnChart, PairColumnChart, RowBars } from "./charts";

export const metadata: Metadata = { title: "Payroll stats" };

// Money that is real for a month: filed and alive. EXPIRED filings never get
// paid (they roll to the next cycle), so they count as outstanding instead.
const COUNTABLE = ["SUBMITTED", "DECLINED", "APPROVED_BY_ADMIN", "PROCESSED"] as const;

// Everything here is whole dollars except expenses, which are summed in cents
// and only rounded once, at the row that displays them — the same rule the
// payout itself follows.
type Sums = {
  net: number;
  base: number;
  bonuses: number;
  fines: number;
  expensesCents: number;
  count: number;
};
const ZERO: Sums = { net: 0, base: 0, bonuses: 0, fines: 0, expensesCents: 0, count: 0 };

function addTo(s: Sums, x: {
  netTotal: number;
  baseSalary: number;
  bonusesTotal: number;
  finesTotal: number;
  expensesTotalCents: number;
}): Sums {
  return {
    net: s.net + x.netTotal,
    base: s.base + x.baseSalary,
    bonuses: s.bonuses + x.bonusesTotal,
    fines: s.fines + x.finesTotal,
    expensesCents: s.expensesCents + x.expensesTotalCents,
    count: s.count + 1,
  };
}

/** A cents sum → the whole dollars this page reports in. */
const dollars = (cents: number) => Math.round(cents / 100);

/** "▲ $120 · +8%" / "▼ $50 · −3%" / "no change" — neutral ink, spend isn't good or bad. */
function delta(cur: number, prev: number | null): string {
  if (prev == null) return "first month on record";
  const diff = cur - prev;
  if (diff === 0) return "no change vs last month";
  const arrow = diff > 0 ? "▲" : "▼";
  const pct = prev > 0 ? ` · ${diff > 0 ? "+" : "−"}${Math.round((Math.abs(diff) / prev) * 100)}%` : "";
  return `${arrow} ${formatMoney(Math.abs(diff))}${pct} vs last month`;
}

/**
 * Payroll stats for the money reviewers (admins + finance): the selected
 * month's totals and split with month-over-month deltas, the 12-month trend,
 * per-department and payment-method breakdowns, bonuses vs fines over time,
 * and filed vs outstanding (deferred people count as outstanding).
 */
export default async function PayrollStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; dept?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  // Closed: reviewers see the same screen employees do, before any sweep runs.
  // The panel is the one payroll surface that outlives the switch, so a reader
  // who lands here while closed is pointed at it rather than dead-ended.
  if (!isPayrollOpenFor(session.user.email)) {
    return (
      <PayrollComingSoon
        panelLink={canReadPayrollWhileClosed(session.user.email)}
      />
    );
  }
  if (!canSeeAllPayroll(session.user.email)) redirect("/payroll");

  const now = new Date();
  await expireLapsedSubmissions(now);
  await reconcilePayrollReminders(now);
  const currentPeriod = await ensureCurrentPeriod(prisma, now);

  const { p, dept } = await searchParams;

  const periods = await prisma.payrollPeriod.findMany({
    orderBy: [{ year: "asc" }, { month: "asc" }],
    select: { id: true, year: true, month: true },
  });
  const selected =
    periods.find((x) => `${x.year}-${String(x.month).padStart(2, "0")}` === p) ??
    periods.find((x) => x.id === currentPeriod.id) ??
    periods[periods.length - 1];
  const label = payrollPeriodLabel(selected.year, selected.month);

  const departments = await prisma.department.findMany({
    orderBy: { name: "asc" },
    select: { name: true },
  });

  const [employeesAll, subsAll] = await Promise.all([
    prisma.user.findMany({
      where: { approvedAt: { not: null }, memberships: { some: {} } },
      select: {
        id: true,
        memberships: { select: { department: { select: { name: true } } } },
      },
    }),
    prisma.payrollSubmission.findMany({
      where: { status: { in: [...COUNTABLE] } },
      select: {
        periodId: true,
        netTotal: true,
        baseSalary: true,
        bonusesTotal: true,
        finesTotal: true,
        expensesTotalCents: true,
        paymentMethod: true,
        user: {
          select: {
            id: true,
            memberships: { select: { department: { select: { name: true } } } },
          },
        },
      },
    }),
  ]);

  const inDept = (m: { department: { name: string } }[]) =>
    !dept || m.some((x) => x.department.name === dept);
  const employees = employeesAll.filter((e) => inDept(e.memberships));
  const subs = subsAll.filter((s) => inDept(s.user.memberships));

  // Scoped sums per period, for the tiles and both time charts.
  const byPeriod = new Map<string, Sums>();
  for (const s of subs) {
    byPeriod.set(s.periodId, addTo(byPeriod.get(s.periodId) ?? ZERO, s));
  }

  const selectedIdx = periods.findIndex((x) => x.id === selected.id);
  const window = periods.slice(Math.max(0, selectedIdx - 11), selectedIdx + 1);
  const monthLabel = (x: { year: number; month: number }) =>
    x.month === 1
      ? `Jan ’${String(x.year).slice(2)}`
      : payrollMonthName(x.month).slice(0, 3);

  const current = byPeriod.get(selected.id) ?? ZERO;
  const prevCal = selected.month === 1
    ? { year: selected.year - 1, month: 12 }
    : { year: selected.year, month: selected.month - 1 };
  const prevPeriod = periods.find(
    (x) => x.year === prevCal.year && x.month === prevCal.month,
  );
  const prev = prevPeriod ? (byPeriod.get(prevPeriod.id) ?? ZERO) : null;

  // Selected month, this scope: who filed, how they're paid.
  const selectedSubs = subs.filter((s) => s.periodId === selected.id);
  const filedIds = new Set(selectedSubs.map((s) => s.user.id));
  const outstanding = employees.filter((e) => !filedIds.has(e.id));

  const methodCounts = new Map<PayrollMethod, number>();
  for (const s of selectedSubs) {
    methodCounts.set(s.paymentMethod, (methodCounts.get(s.paymentMethod) ?? 0) + 1);
  }

  // Department roll-up for the month, across ALL departments (the filter above
  // scopes everything else). Multi-seat people count in each of their
  // departments — the house convention — so columns can overlap.
  const deptSums = new Map<string, number>();
  const selectedAll = subsAll.filter((s) => s.periodId === selected.id);
  for (const s of selectedAll) {
    for (const m of s.user.memberships) {
      deptSums.set(
        m.department.name,
        (deptSums.get(m.department.name) ?? 0) + s.netTotal,
      );
    }
  }

  const href = (patch: { p?: string; dept?: string | null }) => {
    const q = new URLSearchParams();
    const nextP = "p" in patch ? patch.p : p;
    const nextDept = "dept" in patch ? patch.dept : dept;
    if (nextP) q.set("p", nextP);
    if (nextDept) q.set("dept", nextDept);
    const qs = q.toString();
    return `/payroll/stats${qs ? `?${qs}` : ""}`;
  };
  const pillClass = (active: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition ${
      active
        ? "border-brand bg-brand-soft text-brand"
        : "border-line text-muted-fg hover:text-ink"
    }`;

  const splitRows: { label: string; cur: number; prev: number | null; tone?: string }[] = [
    { label: "Base salaries", cur: current.base, prev: prev?.base ?? null },
    { label: "Bonuses", cur: current.bonuses, prev: prev?.bonuses ?? null, tone: "text-green-700" },
    { label: "Fines deducted", cur: current.fines, prev: prev?.fines ?? null, tone: "text-red-600" },
    {
      label: "Expenses",
      cur: dollars(current.expensesCents),
      prev: prev ? dollars(prev.expensesCents) : null,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-bold text-ink">Payroll stats</h1>
          <p className="mt-1 text-sm text-muted-fg">
            {label}
            {dept ? ` · ${dept}` : " · all departments"} — filed requests only;
            an expired or unfiled month counts as outstanding, not as payroll.
          </p>
        </div>
        <BackLink href="/payroll" label="Payroll" />
      </header>

      {periods.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {[...periods].reverse().map((x) => (
            <Link
              key={x.id}
              href={href({ p: `${x.year}-${String(x.month).padStart(2, "0")}` })}
              className={pillClass(x.id === selected.id)}
            >
              {payrollPeriodLabel(x.year, x.month)}
            </Link>
          ))}
        </div>
      )}
      {departments.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          <Link href={href({ dept: null })} className={pillClass(!dept)}>
            All departments
          </Link>
          {departments.map((d) => (
            <Link
              key={d.name}
              href={href({ dept: d.name })}
              className={pillClass(dept === d.name)}
            >
              {d.name}
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
            Filed
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-ink">
            {current.count}
            <span className="text-base font-semibold text-muted-fg">
              {" "}
              of {employees.length}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-fg">
            {outstanding.length === 0
              ? "Everyone's in."
              : `${outstanding.length} outstanding (deferred included) — they file next cycle.`}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
            Total payroll
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-ink">
            {formatMoney(current.net)}
          </p>
          <p className="mt-1 text-xs tabular-nums text-muted-fg">
            {delta(current.net, prev?.net ?? null)}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
            The split
          </p>
          <dl className="mt-2 flex flex-col gap-1">
            {splitRows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-2 text-xs">
                <dt className="text-muted-fg">{r.label}</dt>
                <dd className="text-right">
                  <span className={`font-semibold tabular-nums ${r.tone ?? "text-ink"}`}>
                    {formatMoney(r.cur)}
                  </span>
                  {r.prev != null && r.cur !== r.prev && (
                    <span className="ml-1 tabular-nums text-[10px] text-muted-fg">
                      {r.cur > r.prev ? "▲" : "▼"}
                      {formatMoney(Math.abs(r.cur - r.prev))}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <section className="mt-6 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Payroll, last 12 months</h2>
        <p className="mb-2 mt-0.5 text-xs text-muted-fg">
          Net totals of filed requests{dept ? ` · ${dept}` : ""}.
        </p>
        <ColumnChart
          points={window.map((x) => ({
            label: monthLabel(x),
            value: (byPeriod.get(x.id) ?? ZERO).net,
          }))}
          color="var(--color-chart-flow)"
          ariaLabel="Total payroll per month over the last 12 months"
        />
      </section>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">Departments — {label}</h2>
          <p className="mb-3 mt-0.5 text-xs text-muted-fg">
            Net payroll per department. People with seats in several
            departments count in each, so bars can overlap.
          </p>
          {deptSums.size === 0 ? (
            <p className="text-xs text-muted-fg">Nothing filed this month yet.</p>
          ) : (
            <RowBars
              rows={[...deptSums.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([name, value]) => ({
                  label: name,
                  value,
                  valueLabel: formatMoney(value),
                }))}
              color="var(--color-brand)"
            />
          )}
        </section>

        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">
            Preferred payment methods — {label}
          </h2>
          <p className="mb-3 mt-0.5 text-xs text-muted-fg">
            How the filed requests want to be paid{dept ? ` · ${dept}` : ""}.
          </p>
          {selectedSubs.length === 0 ? (
            <p className="text-xs text-muted-fg">Nothing filed this month yet.</p>
          ) : (
            <RowBars
              rows={(Object.keys(PAYROLL_METHOD_LABEL) as PayrollMethod[])
                .map((m) => ({ m, n: methodCounts.get(m) ?? 0 }))
                .filter((x) => x.n > 0)
                .sort((a, b) => b.n - a.n)
                .map((x) => ({
                  label: PAYROLL_METHOD_LABEL[x.m],
                  value: x.n,
                  valueLabel: `${x.n} ${x.n === 1 ? "person" : "people"}`,
                }))}
              color="var(--color-brand)"
            />
          )}
        </section>
      </div>

      <section className="mt-3 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Bonuses vs fines</h2>
        <p className="mb-2 mt-0.5 text-xs text-muted-fg">
          What each month&rsquo;s filings added in bonuses against what they
          deducted in fines{dept ? ` · ${dept}` : ""}.
        </p>
        <PairColumnChart
          points={window.map((x) => {
            const s = byPeriod.get(x.id) ?? ZERO;
            return { label: monthLabel(x), a: s.bonuses, b: s.fines };
          })}
          aLabel="Bonuses"
          bLabel="Fines"
          aColor="var(--color-chart-flow)"
          bColor="var(--color-chart-bad)"
          ariaLabel="Bonuses and fines per month over the last 12 months"
        />
      </section>
    </div>
  );
}
