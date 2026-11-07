// Server-only: rebuild a submission's invoice PDF from what was stored.
//
// The PDF is generated inside the submit transaction from the values being
// written. Anything that edits a FILED request afterwards — adding the payment
// details that were never asked for, say — would otherwise leave the stored
// bytes describing an older version of the truth, and that file is what gets
// emailed to finance.
//
// Everything the invoice needs is already on the row (the snapshot lines are
// copies precisely so the breakdown survives the source moving), so this reads
// it back rather than recomputing anything. No money is touched.

import { prisma } from "@/lib/prisma";
import { partAmount } from "@/lib/payrollParts";
import { renderPayrollInvoice } from "@/lib/payrollPdf";
import {
  parsePaymentDetails,
  payrollPeriodLabel,
} from "@/lib/payrollTypes";
import type { Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

export async function regenerateInvoicePdf(
  db: Db,
  submissionId: string,
): Promise<void> {
  const s = await db.payrollSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      submittedAt: true,
      lastSubmittedAt: true,
      baseSalary: true,
      netTotal: true,
      paymentMethod: true,
      paymentDetails: true,
      user: { select: { name: true, email: true } },
      period: { select: { year: true, month: true } },
      bonusLines: {
        orderBy: { awardedAt: "asc" },
        select: { amount: true, note: true, awardedAt: true },
      },
      fineLines: {
        orderBy: { issuedAt: "asc" },
        select: { amount: true, type: true, note: true, issuedAt: true },
      },
      expenses: {
        orderBy: { position: "asc" },
        select: { label: true, amountCents: true },
      },
      parts: {
        orderBy: { position: "asc" },
        select: { departmentName: true, salary: true, carriesLedger: true },
      },
    },
  });
  if (!s) return;

  // The same invoice number the original render used: this person's Nth
  // request ever, by creation order, so a regenerated file keeps its identity.
  const invoiceNo =
    (await db.payrollSubmission.count({
      where: { userId: s.userId, createdAt: { lt: s.createdAt } },
    })) + 1;

  // The date the invoice carries is when the request was filed, not now — a
  // regenerated file documents the same event.
  const filedAt = s.lastSubmittedAt ?? s.submittedAt ?? s.createdAt;

  const bytes = await renderPayrollInvoice({
    invoiceNo,
    employeeName: s.user.name ?? s.user.email ?? "—",
    dateLabel: filedAt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "Asia/Tashkent",
    }),
    periodLabel: payrollPeriodLabel(s.period.year, s.period.month),
    baseSalary: s.baseSalary,
    bonusLines: s.bonusLines,
    fineLines: s.fineLines,
    expenses: s.expenses,
    netTotal: s.netTotal,
    paymentMethod: s.paymentMethod,
    paymentDetails: parsePaymentDetails(s.paymentDetails),
    parts: s.parts.map((p) => ({
      ...p,
      amount: partAmount(p, s.parts, s.netTotal),
    })),
  });

  await db.payrollPdf.upsert({
    where: { submissionId: s.id },
    update: { bytes },
    create: { submissionId: s.id, bytes },
  });
}
