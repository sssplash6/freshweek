"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { formatMoney } from "@/lib/penalties";
import {
  PaySelectionProvider,
  SelectAllTick,
  type PayableRow,
} from "./PaySelection";
import { PanelSummary, type PanelStat } from "./PanelSummary";
import {
  PAYROLL_METHODS,
  PAYROLL_METHOD_LABEL,
  type PayrollMethod,
  type PayrollStatus,
} from "@/lib/payrollTypes";

/**
 * One request as the board sees it: a pre-rendered row plus the handful of
 * facts the board needs to find, count and order it. `node` is the finished
 * server-rendered row (detail and all) handed through untouched — the board
 * decides which rows appear, never what a row says, so the page keeps sole
 * control of which moves a row offers and to whom.
 */
export type PanelBoardItem = {
  id: string;
  node: ReactNode;
  name: string;
  departments: string[];
  status: PayrollStatus;
  statusLabel: string;
  method: PayrollMethod;
  net: number;
  /**
   * When this landed on the reviewer's desk, as epoch ms — when it was filed,
   * or for a legacy approved row when it was handed over. Null when nothing is
   * waiting (an already-paid row), which sorts to the back of "longest
   * waiting".
   */
  waitingSince: number | null;
  periodKey: string; // "2026-08" — sortable, and the pill's identity
  periodLabel: string; // "August 2026"
  /**
   * Whether this row may be ticked and paid in a batch. The page decides it
   * the same way it decides whether the row gets a Confirm button at all — the
   * request is awaiting payment AND this viewer is the reviewer — and the
   * board only counts what it is told. A row cannot make itself payable, and a
   * ticked row still has to get past the action's own checks.
   */
  payable?: boolean;
  /**
   * Which of the summary's money lines this row belongs to, decided by the
   * page from the status it alone interprets: money still on the reviewer's
   * desk, money already out, or neither (a request back with its filer, or one
   * that lapsed).
   */
  money?: "awaiting" | "paid" | "none";
  /**
   * Whether this row is part of the month's real money. An expired filing is
   * never paid — it rolls into the next cycle — so it is listed but not
   * totalled, which is what keeps this strip reconciling with the register.
   */
  countable?: boolean;
  /**
   * On a request split by department that is partly paid: how much of `net`
   * has already gone out. It moves from the "to pay" line to the "paid" one,
   * so a half-paid request doesn't read as wholly owed.
   */
  paidNet?: number;
};

/**
 * The ingredients for the figures above the list. The page supplies what only
 * it knows — which month this is, and who filed nothing — and the board does
 * the arithmetic, because only the board knows what is on screen.
 */
export type PanelBoardSummary = {
  /** "August 2026", naming the month total. */
  periodLabel: string;
  /** Under "Not filed": when filing closes, or that the month is held open. */
  notFiledHint: string;
  /** Everyone eligible who filed nothing this month. */
  unfiled: { id: string; name: string; departments: string[] }[];
  /**
   * Whether to list them under the queue. Only worth saying once filing has
   * closed — before that "did not file" is just "has not filed yet".
   */
  listUnfiled: boolean;
  /** The line above that list. */
  unfiledNote: string;
};

type SortKey = "default" | "waited" | "amount" | "name";

const SORT_KEYS: SortKey[] = ["default", "waited", "amount", "name"];

const SORT_LABEL: Record<SortKey, string> = {
  // "default" is the order the server handed the rows over, which means
  // "what needs a decision first".
  default: "Needs action first",
  waited: "Longest waiting",
  amount: "Largest amount",
  name: "Name A–Z",
};

/** Which filter a count is being computed for, so it can exclude itself. */
type Facet = "status" | "period" | "dept";

type Row = { item: PanelBoardItem; index: number; haystack: string };

/**
 * The working surface of the reviewer panel: the figures, search, faceted
 * filters, a payment source breakdown and sorting over rows that are already
 * on the page.
 *
 * The figures are part of the surface rather than a header above it: they are
 * recomputed from whatever the filters have left, so a department pill re-reads
 * the whole strip as that department's money. Only sorting leaves them alone.
 *
 * Everything here is client-side on purpose. The page already loads the whole
 * month it covers, so narrowing it is a re-render rather than a round trip,
 * and a month of payroll can be worked through without the page ever reloading
 * under the reviewer.
 *
 * The facets configure themselves from the rows: a filter row only appears
 * when there is more than one value to choose between, so a month with five
 * statuses in it grows status pills and a single-status list quietly doesn't,
 * without the page asking for either.
 */
export function PanelBoard({
  items,
  searchPlaceholder = "Search name, department or source…",
  sourceNote,
  emptyHint,
  batchBar,
  summary,
}: {
  items: PanelBoardItem[];
  searchPlaceholder?: string;
  /** One line under the source grid — why the split matters at this stage. */
  sourceNote?: string;
  /** What to say when the filters match nothing. */
  emptyHint: string;
  /**
   * What acts on the ticked rows, supplied by the page because the board holds
   * no verbs of its own — it decides which rows are on screen, never what may
   * be done to them. Rendered inside the selection, so it reads the ticks
   * through the context and shows itself only when there are some.
   */
  batchBar?: ReactNode;
  /**
   * The figures over the list. Passing them makes the strip part of the board
   * rather than a static header, which is the whole point: filter to one
   * department and the money follows.
   */
  summary?: PanelBoardSummary;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<PayrollStatus | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [dept, setDept] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("default");

  // One lowercase haystack per row, built once. Searching the source and the
  // month as well as the person means "wise" or "july" narrows the list too,
  // which is how a reviewer actually thinks about a batch.
  const rows: Row[] = useMemo(
    () =>
      items.map((item, index) => ({
        item,
        index,
        haystack: [
          item.name,
          ...item.departments,
          PAYROLL_METHOD_LABEL[item.method],
          item.periodLabel,
          item.statusLabel,
        ]
          .join(" ")
          .toLowerCase(),
      })),
    [items],
  );

  // Facet values, in the order the server sent them (statuses already arrive
  // most-urgent-first) or newest-first for months.
  const statuses = useMemo(() => {
    const seen = new Map<PayrollStatus, string>();
    for (const i of items) if (!seen.has(i.status)) seen.set(i.status, i.statusLabel);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);

  const periods = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of items) if (!seen.has(i.periodKey)) seen.set(i.periodKey, i.periodLabel);
    return [...seen.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([value, label]) => ({ value, label }));
  }, [items]);

  const depts = useMemo(() => {
    const seen = new Set<string>();
    for (const i of items) for (const d of i.departments) seen.add(d);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const q = query.trim().toLowerCase();

  // A row passes when every active filter accepts it. `except` lets a facet
  // count itself out, so each pill reads "what you'd get if you picked this"
  // rather than "what you'd get if you picked this on top of itself" — which
  // would show every unselected pill at zero.
  const passes = (r: Row, except: Facet | null) =>
    (!q || r.haystack.includes(q)) &&
    (except === "status" || !status || r.item.status === status) &&
    (except === "period" || !period || r.item.periodKey === period) &&
    (except === "dept" || !dept || r.item.departments.includes(dept));

  const countFor = (facet: Facet, match: (r: Row) => boolean) =>
    rows.filter((r) => passes(r, facet) && match(r)).length;

  const visible = rows
    .filter((r) => passes(r, null))
    .sort((a, b) => {
      // Every comparator falls back to the server's order, so equal rows never
      // shuffle between renders.
      if (sort === "amount") return b.item.net - a.item.net || a.index - b.index;
      if (sort === "name") {
        return a.item.name.localeCompare(b.item.name) || a.index - b.index;
      }
      if (sort === "waited") {
        // Oldest arrival first; rows that aren't waiting on anyone go last.
        const av = a.item.waitingSince ?? Number.POSITIVE_INFINITY;
        const bv = b.item.waitingSince ?? Number.POSITIVE_INFINITY;
        return av - bv || a.index - b.index;
      }
      return a.index - b.index;
    });

  const shownTotal = visible.reduce((s, r) => s + r.item.net, 0);

  // The source split: how much money each payment method accounts for in what
  // is on screen. Finance pays out per source and reconciles against the
  // "Source" column of the accounting sheet, so this is the run sheet — a
  // breakdown to work from, not a filter. (Narrowing to one source is what the
  // search box is for: a source's name is part of every row's haystack.)
  // Not memoized: a panel holds a month of requests at most, so this is a few
  // hundred comparisons — cheaper than the dependency list it would take to
  // memoize a closure over four filters correctly.
  const sources = PAYROLL_METHODS.map((m) => {
    const matching = visible.filter((r) => r.item.method === m);
    return {
      method: m,
      count: matching.length,
      total: matching.reduce((s, r) => s + r.item.net, 0),
    };
  }).filter((s) => s.count > 0);

  const sourceMax = Math.max(1, ...sources.map((s) => s.total));

  /**
   * What may be ticked right now: the payable rows THAT ARE ON SCREEN, in the
   * order they are shown. Filtering is how a reviewer picks a batch — narrow
   * to one department, or search a payment source, then tick them all — so the
   * selection is scoped to the view rather than to the month, and a row
   * filtered away leaves the batch with it (see PaySelectionProvider).
   */
  const selectable: PayableRow[] = visible
    .filter((r) => r.item.payable)
    .map((r) => ({
      id: r.item.id,
      name: r.item.name,
      net: r.item.net - (r.item.paidNet ?? 0),
    }));
  const narrowed =
    q !== "" || status !== null || period !== null || dept !== null;

  function clearFilters() {
    setQuery("");
    setStatus(null);
    setPeriod(null);
    setDept(null);
  }

  /**
   * The figures over the list, recomputed as the filters narrow it — filter to
   * one department and every number here is that department's.
   *
   * They follow every filter EXCEPT the status pills, because these three
   * money lines ARE a status breakdown: filtering them by status would leave
   * two of the three reading zero and the third repeating the "in view" line
   * below. Picking "With finance" narrows the list, not the month it is part
   * of.
   */
  const counted = rows.filter((r) => passes(r, "status"));
  const sumOf = (list: Row[]) => list.reduce((s, r) => s + r.item.net, 0);
  const awaiting = counted.filter((r) => r.item.money === "awaiting");
  const settled = counted.filter((r) => r.item.money === "paid");
  // A partly paid split request is still awaiting, but only its unpaid parts.
  const partlyPaid = awaiting.reduce((s, r) => s + (r.item.paidNet ?? 0), 0);
  const awaitingSources = new Set(awaiting.map((r) => r.item.method)).size;
  // Who never filed, under the same narrowing — a department's strip that
  // counted the whole company's non-filers would not be that department's.
  const unfiled = (summary?.unfiled ?? []).filter(
    (p) =>
      (!q || `${p.name} ${p.departments.join(" ")}`.toLowerCase().includes(q)) &&
      (!dept || p.departments.includes(dept)),
  );

  const stats: PanelStat[] = summary
    ? [
        {
          label: "To pay",
          value: formatMoney(sumOf(awaiting) - partlyPaid),
          hint:
            awaiting.length > 0
              ? `${awaiting.length} ${awaiting.length === 1 ? "request" : "requests"} · ${awaitingSources} ${awaitingSources === 1 ? "source" : "sources"}`
              : "Nothing on that desk",
          tone: awaiting.length > 0 ? "brand" : "muted",
        },
        {
          label: "Paid",
          value: formatMoney(sumOf(settled) + partlyPaid),
          hint: `${settled.length} ${settled.length === 1 ? "request" : "requests"} settled`,
          tone: settled.length > 0 ? "brand" : "muted",
        },
        {
          label: `${summary.periodLabel} total`,
          value: formatMoney(sumOf(counted.filter((r) => r.item.countable))),
          hint: `${counted.length} filed · ${settled.length} paid`,
          tone: "ink",
        },
        {
          label: "Not filed",
          value: String(unfiled.length),
          hint: summary.notFiledHint,
          tone: "muted",
        },
      ]
    : [];

  const pillClass = (active: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition ${
      active
        ? "border-brand bg-brand-soft text-brand"
        : "border-line text-muted-fg hover:text-ink"
    }`;

  const withCount = (label: string, n: number) => (n > 0 ? `${label} · ${n}` : label);

  return (
    <PaySelectionProvider selectable={selectable}>
      <div>
        <PanelSummary stats={stats} />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="min-w-0 flex-1 basis-56 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort requests"
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
          {narrowed && (
            <button
              type="button"
              onClick={clearFilters}
              className="whitespace-nowrap rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted-fg transition hover:text-ink"
            >
              Clear filters
            </button>
          )}
        </div>

        {statuses.length > 1 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setStatus(null)} className={pillClass(!status)}>
              All statuses
            </button>
            {statuses.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setStatus(status === s.value ? null : s.value)}
                aria-pressed={status === s.value}
                className={pillClass(status === s.value)}
              >
                {withCount(s.label, countFor("status", (r) => r.item.status === s.value))}
              </button>
            ))}
          </div>
        )}

        {periods.length > 1 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setPeriod(null)} className={pillClass(!period)}>
              All months
            </button>
            {periods.map((x) => (
              <button
                key={x.value}
                type="button"
                onClick={() => setPeriod(period === x.value ? null : x.value)}
                aria-pressed={period === x.value}
                className={pillClass(period === x.value)}
              >
                {withCount(x.label, countFor("period", (r) => r.item.periodKey === x.value))}
              </button>
            ))}
          </div>
        )}

        {depts.length > 1 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setDept(null)} className={pillClass(!dept)}>
              All departments
            </button>
            {depts.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDept(dept === d ? null : d)}
                aria-pressed={dept === d}
                className={pillClass(dept === d)}
              >
                {withCount(d, countFor("dept", (r) => r.item.departments.includes(d)))}
              </button>
            ))}
          </div>
        )}

        {sources.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 px-1">
              <h3 className="text-xs font-semibold text-ink">By payment source</h3>
              {sourceNote && <p className="text-[11px] text-muted-fg">{sourceNote}</p>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {sources.map((s) => (
                <div
                  key={s.method}
                  className="rounded-xl border border-line bg-surface px-3 py-2"
                >
                  <span className="block truncate text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                    {PAYROLL_METHOD_LABEL[s.method]}
                  </span>
                  <span className="mt-0.5 block text-sm font-bold tabular-nums text-ink">
                    {formatMoney(s.total)}
                  </span>
                  {/* Share of the largest source, so the grid reads as a
                      breakdown at a glance rather than eight equal cards. */}
                  <span
                    className="mt-1.5 block h-1 overflow-hidden rounded-full bg-line"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${Math.round((s.total / sourceMax) * 100)}%` }}
                    />
                  </span>
                  <span className="mt-1 block text-[11px] text-muted-fg">
                    {s.count} {s.count === 1 ? "request" : "requests"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
          <p className="text-xs text-muted-fg">
            Showing{" "}
            <span className="font-semibold text-ink">
              {visible.length} of {items.length}
            </span>{" "}
            · {formatMoney(shownTotal)} in view
          </p>
          {/* Ticking is scoped to what is shown, so its control belongs on the
              line that says what is shown. */}
          <SelectAllTick />
        </div>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface px-4 py-8 text-center">
            <p className="text-sm font-semibold text-ink">Nothing here</p>
            <p className="mt-1 text-xs text-muted-fg">{emptyHint}</p>
            {narrowed && (
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 rounded-lg border border-line px-3.5 py-2 text-xs font-semibold text-brand transition hover:bg-canvas"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((r) => (
              <Fragment key={r.item.id}>{r.item.node}</Fragment>
            ))}
          </ul>
        )}

        {/* Kept next to the "Not filed" figure it belongs to, so the two
            always agree about which department is being looked at. */}
        {summary && summary.listUnfiled && unfiled.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-1 px-1 text-sm font-semibold text-ink">
              Did not file
            </h2>
            <p className="mb-3 px-1 text-xs text-muted-fg">
              {summary.unfiledNote}
            </p>
            <ul className="flex flex-col gap-1.5">
              {unfiled.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm"
                >
                  <span className="min-w-0 truncate text-ink">{e.name}</span>
                  <span className="shrink-0 text-xs text-muted-fg">
                    Files next cycle
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {batchBar}
      </div>
    </PaySelectionProvider>
  );
}
