"use client";

import { useState } from "react";
import { ReportEditor } from "./ReportEditor";

export type HistoryRow = {
  ymd: string;
  label: string; // "Fri, 15 Aug"
  dotClass: string;
  statusLabel: string; // "Sent" / "Sent late" / "Not sent" / "No report"
  missed: boolean;
  timeLabel: string | null; // "02:15 PM" when sent
  content: string;
};

/**
 * The recent days below the composer: one quiet row per day, expanding in
 * place to edit and resend (or to write a missed day late — better late than
 * a hole in the record). One row open at a time.
 */
export function ReporterHistory({ rows }: { rows: HistoryRow[] }) {
  const [openYmd, setOpenYmd] = useState<string | null>(null);

  return (
    <ul className="rounded-xl border border-line bg-surface px-4 py-1">
      {rows.map((r) => {
        const open = openYmd === r.ymd;
        return (
          <li
            key={r.ymd}
            className="border-t border-line py-3 first:border-t-0"
          >
            <div className="flex items-baseline gap-3">
              <span
                className={`h-2 w-2 shrink-0 translate-y-px rounded-full ${r.dotClass}`}
                aria-hidden="true"
              />
              <span className="shrink-0 text-sm font-medium text-ink">
                {r.label}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-sm ${
                  r.missed ? "text-chart-bad" : "text-muted-fg"
                }`}
              >
                {r.content
                  ? r.content.replace(/\s+/g, " ")
                  : r.missed
                    ? "Not sent"
                    : r.statusLabel}
              </span>
              {r.timeLabel && (
                <span className="shrink-0 text-xs tabular-nums text-muted-fg">
                  {r.timeLabel}
                </span>
              )}
              <button
                type="button"
                onClick={() => setOpenYmd(open ? null : r.ymd)}
                className="shrink-0 text-sm font-semibold text-brand transition hover:text-brand-dark"
              >
                {open ? "Close" : r.content ? "Edit" : "Write it"}
              </button>
            </div>
            {open && (
              <div className="rise-in mt-3">
                <ReportEditor
                  dayYmd={r.ymd}
                  initialContent={r.content}
                  sendLabel={r.content ? "Send update" : "Send report"}
                  autoFocus
                  onSent={() => setOpenYmd(null)}
                  onCancel={() => setOpenYmd(null)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
