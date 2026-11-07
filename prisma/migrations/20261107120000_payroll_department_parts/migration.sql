-- Split pay requests by department, for people who work in more than one.
--
-- Purely additive: a new table and a nullable column. Nothing is backfilled —
-- every request already filed has no parts and keeps working exactly as
-- before (one salary, one approval, one payment). Parts only appear on what is
-- filed from here on, by someone who holds seats in two or more departments.

-- CreateEnum
CREATE TYPE "PayrollPartAction" AS ENUM ('APPROVED', 'PAID', 'UNPAID');

-- AlterTable
ALTER TABLE "PayrollEvent" ADD COLUMN     "partAction" "PayrollPartAction";

-- CreateTable
CREATE TABLE "PayrollPart" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "departmentId" TEXT,
    "departmentName" TEXT NOT NULL,
    "salary" INTEGER NOT NULL,
    "carriesLedger" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,

    CONSTRAINT "PayrollPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollPart_departmentId_idx" ON "PayrollPart"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPart_submissionId_departmentId_key" ON "PayrollPart"("submissionId", "departmentId");

-- AddForeignKey
ALTER TABLE "PayrollPart" ADD CONSTRAINT "PayrollPart_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "PayrollSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPart" ADD CONSTRAINT "PayrollPart_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPart" ADD CONSTRAINT "PayrollPart_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPart" ADD CONSTRAINT "PayrollPart_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

