-- Bank transfer as a payout source.
--
-- The four sources finance settles through (Cash Uzbekistan, Payme, Uzbek
-- Company, Wise) all move money inside one rail. A plain wire doesn't: it needs
-- the beneficiary's own routing details — IBAN, SWIFT/BIC, the branch address —
-- which is what the form now asks for under this source. The details themselves
-- live in the existing paymentDetails Json column, so nothing changes shape;
-- what a source ASKS for is decided in code (paymentFieldsFor in
-- lib/payrollTypes.ts), and which sources may be chosen in
-- PAYROLL_METHODS_OFFERED.
--
-- Hand-written and idempotent. IF NOT EXISTS makes a re-run a no-op; the value
-- is appended after WISE_USD, the other source that pays out to an account the
-- person names, so the type's order matches the order schema.prisma lists.

ALTER TYPE "PayrollMethod" ADD VALUE IF NOT EXISTS 'BANK_TRANSFER' AFTER 'WISE_USD';
