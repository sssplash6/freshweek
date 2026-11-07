// The department split of a pay request (PayrollPart), as every surface shows
// it: the filer's own view, the lead's desk, and finance's panel. One row per
// department — what it pays, and where its part stands — so whoever is looking
// can see at once which half is theirs and which half is still outstanding.
// Server-rendered; nothing here mutates.

import { formatMoney } from "@/lib/penalties";
import type { PartLine } from "./partViews";

export type PartView = PartLine & {
  id: string;
  salary: number;
  carriesLedger: boolean;
  approved: boolean;
  /** "Paid Nov 2, 3:14 PM", or null while unpaid. */
  paidLabel: string | null;
  /** The viewer's own department's part — highlighted on a lead's desk. */
  mine?: boolean;
};

export function PartsBreakdown({
  parts,
  showProgress,
}: {
  parts: PartView[];
  /**
   * Whether approval and payment chips mean anything yet. A request sent back
   * to its filer, or expired, has no live approvals to show — just the split.
   */
  showProgress: boolean;
}) {
  if (parts.length === 0) return null;
  return (
    <div className="rounded-lg border border-line p-3">
      <h4 className="text-xs font-semibold text-ink">Paid by department</h4>
      <p className="mt-0.5 text-[11px] text-muted-fg">
        Each department&rsquo;s lead approves and pays its own part. The
        request is paid out once every part is.
      </p>
      <ul className="mt-2 flex flex-col">
        {parts.map((p) => (
          <li
            key={p.id}
            className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line py-2 text-xs first:border-t-0 ${
              p.mine ? "-mx-1.5 rounded-md bg-brand-soft/60 px-1.5" : ""
            }`}
          >
            <span className="min-w-0">
              <span className="font-semibold text-ink">{p.departmentName}</span>
              {p.mine && (
                <span className="ml-1.5 text-[11px] font-medium text-brand">
                  your department
                </span>
              )}
              {p.carriesLedger && parts.length > 1 && (
                <span className="block text-[11px] text-muted-fg">
                  {`${formatMoney(p.salary)} salary, plus the bonuses, fines and expenses`}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {showProgress && <PartStatus part={p} />}
              <span className="font-semibold tabular-nums text-ink">
                {formatMoney(p.amount)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PartStatus({ part }: { part: PartView }) {
  const [tone, text] = part.paidLabel
    ? ["bg-green-50 text-green-800", part.paidLabel]
    : part.approved
      ? ["bg-brand-soft text-brand", "Approved"]
      : ["bg-amber-50 text-amber-800", "Waiting on its lead"];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {text}
    </span>
  );
}
