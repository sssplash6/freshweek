// Serves a pay request's stored invoice PDF. The bytes live in Postgres
// (PayrollPdf) and are the canonical invoice for the submission's current
// snapshot — regenerated on resubmit, never on read, so what admins approved
// is byte-for-byte what everyone downloads later.

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canReadPayrollWhileClosed, canSeeAllPayroll } from "@/lib/payroll";
import { canApprovePayroll } from "@/lib/payrollApproval";
import { payrollPeriodLabel, isPayrollOpenFor } from "@/lib/payrollTypes";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return new Response("Sign in required", { status: 401 });
  // Payroll off, or this account isn't in the restricted rollout yet — with
  // the admin's read-only exception, because the panel stays open to them
  // while closed and every row on it has to keep opening its documents.
  if (
    !isPayrollOpenFor(session.user.email) &&
    !canReadPayrollWhileClosed(session.user.email)
  ) {
    return new Response("Payroll is closed", { status: 404 });
  }

  const { id } = await params;
  const submission = await prisma.payrollSubmission.findUnique({
    where: { id },
    select: {
      userId: true,
      user: { select: { name: true } },
      period: { select: { year: true, month: true } },
      pdf: { select: { bytes: true } },
    },
  });
  if (!submission) return new Response("Not found", { status: 404 });

  // The owner and everyone who reads the whole of payroll — nobody else (leads
  // get no payroll visibility into their members). The same test the panel
  // gates on, so a row visible there always has an invoice that opens.
  const allowed =
    submission.userId === session.user.id ||
    canSeeAllPayroll(session.user.email) ||
    // The filer's department lead, who has to approve this request before
    // finance may pay it (lib/payrollApproval.ts). The invoice is the same
    // request their team page already shows them, in the form they can keep.
    (await canApprovePayroll(prisma, session.user.id, submission.userId));
  if (!allowed) return new Response("Not authorized", { status: 403 });
  if (!submission.pdf) return new Response("No invoice generated", { status: 404 });

  const label = payrollPeriodLabel(submission.period.year, submission.period.month);
  const name = submission.user.name ?? "Invoice";
  // ASCII fallback plus RFC 5987 for names outside ASCII.
  const filename = `${name} — ${label}.pdf`;
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

  return new Response(Buffer.from(submission.pdf.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
