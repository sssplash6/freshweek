-- The department lead's approval desk, between the filer and finance.
--
-- Only adds the value; nothing is backfilled. Every request already in flight
-- keeps the status it has, so a row sitting SUBMITTED today stays payable —
-- the gate applies to what is filed from here on, and nobody's pending pay is
-- pushed back a desk by the deploy.
ALTER TYPE "PayrollStatus" ADD VALUE 'WITH_LEAD' BEFORE 'SUBMITTED';
