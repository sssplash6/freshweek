import { formatMoney } from "@/lib/penalties";
import { BonusControls } from "@/app/_components/BonusControls";

export type BonusRow = {
  id: string;
  amount: number;
  note: string | null;
  who: string;
  dateLabel: string;
  /** Paid out through payroll — shown, but not changeable. */
  locked: boolean;
};

export function RecentBonuses({ bonuses }: { bonuses: BonusRow[] }) {
  if (bonuses.length === 0) {
    return <p className="text-sm text-muted-fg">No bonuses yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {bonuses.map((b) => (
        // flex-wrap so the edit form can drop onto its own line instead of
        // squeezing the amount off the row (see BonusControls).
        <li
          key={b.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{b.who}</p>
            {b.note && (
              <p className="break-words text-xs text-muted-fg">{b.note}</p>
            )}
          </div>
          <span className="hidden shrink-0 text-xs text-muted-fg sm:block">
            {b.dateLabel}
          </span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-green-700">
            +{formatMoney(b.amount)}
          </span>
          <BonusControls
            bonusId={b.id}
            amount={b.amount}
            note={b.note}
            locked={b.locked}
          />
        </li>
      ))}
    </ul>
  );
}
