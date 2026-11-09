-- A person may file more than one request for a month, by exception
-- (PAYROLL_EXTRA_FILINGS). Every existing request is the first of its month.
ALTER TABLE "PayrollSubmission" ADD COLUMN "filing" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "PayrollSubmission_userId_periodId_key";

CREATE UNIQUE INDEX "PayrollSubmission_userId_periodId_filing_key" ON "PayrollSubmission"("userId", "periodId", "filing");
