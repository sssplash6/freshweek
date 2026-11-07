// Part rows → display rows for PartsBreakdown, shared by every payroll surface
// so a department's part reads the same on the filer's page, the lead's desk
// and finance's panel. Client-safe: pure mapping over serializable data.

import { partAmount } from "@/lib/payrollTypes";
import type { PartView } from "./PartsBreakdown";

/** One part, named and priced. */
export type PartLine = { departmentName: string; amount: number };

export function partViews(
  parts: {
    id: string;
    departmentId: string | null;
    departmentName: string;
    salary: number;
    carriesLedger: boolean;
    approvedAt: Date | null;
    paidAt: Date | null;
  }[],
  netTotal: number,
  opts: {
    formatDate: (d: Date) => string;
    /** The viewer's own departments, to mark their part. */
    mine?: ReadonlySet<string>;
  },
): PartView[] {
  return parts.map((p) => ({
    id: p.id,
    departmentName: p.departmentName,
    salary: p.salary,
    carriesLedger: p.carriesLedger,
    amount: partAmount(p, parts, netTotal),
    approved: p.approvedAt !== null,
    paidLabel: p.paidAt ? `Paid ${opts.formatDate(p.paidAt)}` : null,
    mine: p.departmentId !== null && (opts.mine?.has(p.departmentId) ?? false),
  }));
}

/** The select every surface uses to load a request's parts for partViews. */
export const PART_VIEW_SELECT = {
  orderBy: { position: "asc" },
  select: {
    id: true,
    departmentId: true,
    departmentName: true,
    salary: true,
    carriesLedger: true,
    approvedAt: true,
    paidAt: true,
  },
} as const;
