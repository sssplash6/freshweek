// Snapshot rows → display rows, shared by every payroll surface (employee
// view, admin queue, finance queue) so a bonus or fine line always reads the
// same everywhere. Client-safe: pure mapping over serializable data.

import { formatYmd, toYmd } from "@/lib/dates";
import { PENALTY_LABEL, type PenaltyType } from "@/lib/penalties";
import {
  payrollEventLabel,
  type PayrollPartAction,
  type PayrollStatus,
} from "@/lib/payrollTypes";
import type { LedgerLineView } from "./LedgerBreakdown";
import type { SubmissionEventView } from "./SubmissionView";

export function bonusLineViews(
  lines: { id: string; amount: number; note: string | null; awardedAt: Date }[],
  year: number,
): LedgerLineView[] {
  return lines.map((l) => ({
    id: l.id,
    label: "Bonus",
    dateLabel: formatYmd(toYmd(l.awardedAt), year),
    note: l.note,
    amount: l.amount,
  }));
}

export function fineLineViews(
  lines: {
    id: string;
    amount: number;
    type: PenaltyType;
    note: string | null;
    issuedAt: Date;
  }[],
  year: number,
): LedgerLineView[] {
  return lines.map((l) => ({
    id: l.id,
    label: PENALTY_LABEL[l.type],
    dateLabel: formatYmd(toYmd(l.issuedAt), year),
    note: l.note,
    amount: l.amount,
  }));
}

export function eventViews(
  events: {
    id: string;
    fromStatus: PayrollStatus | null;
    toStatus: PayrollStatus;
    partAction?: PayrollPartAction | null;
    note: string | null;
    createdAt: Date;
    actor: { name: string | null; email: string | null } | null;
  }[],
  formatDate: (d: Date) => string,
): SubmissionEventView[] {
  return events.map((e) => ({
    id: e.id,
    label: payrollEventLabel(e.fromStatus, e.toStatus, e.partAction),
    actorName: e.actor ? (e.actor.name ?? e.actor.email ?? null) : null,
    dateLabel: formatDate(e.createdAt),
    note: e.note,
  }));
}
