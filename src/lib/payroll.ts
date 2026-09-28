// Server-only payroll domain: who plays which role, the Tashkent month math,
// the status machine with its append-only audit log, the ledger snapshot taken
// at submit time, the lazy expiry + reminder sweeps (no cron anywhere — the
// lib/submissionFines.ts pattern), and the money write-back at PROCESSED.
//
//   DRAFT → WITH_LEAD → SUBMITTED → PROCESSED
//              ↺ (filer edits, and an edit to an approved request comes back)
//              └──▶ DECLINED → WITH_LEAD* ──▶ EXPIRED
//
// Server actions own authorization and notifications; this module owns the
// rules — every transition goes through applyTransition so no status change
// can skip the guard or the audit row.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/admin";
import {
  formatMoney,
  PENALTY_LABEL,
  type PenaltyType,
} from "@/lib/penalties";
import {
  parsePaymentDetails,
  payrollPeriodLabel,
  validatePaymentDetails,
  PAYROLL_CLOSED,
  PAYROLL_HELD_OPEN,
  isHeldOpenPeriod,
  isPayrollOpenFor,
  isPayrollRolloutTester,
  payrollOpenToEmails,
  PAYROLL_STATUS_LABEL,
  type PaymentDetails,
  type PayrollMethod,
} from "@/lib/payrollTypes";
import { approvableFilerIds } from "@/lib/payrollApproval";
import { notify } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";
import type { PayrollStatus, Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

// ----- Roles -----
//
// Payroll has two desks: the filer's DEPARTMENT LEAD, then finance. A filing
// waits on the lead, who passes it on or sends it back; finance then pays it
// or declines it, and cannot pay a request the lead has not passed.
//
// PAYING is not finance's alone any more. A lead settles their own department:
// once they have approved a member's request, they can confirm the payment of
// it too, one row at a time or a batch of them together (requirePayer below).
// It is the same verb finance holds, over a slice of one department instead of
// the company — the lead pays the people they just approved, so finance is not
// the bottleneck on a month where every request is already vouched for by the
// person who knows the work. Declining stays finance's: sending a request back
// is a different job from paying it, and the lead's own send-back already
// covers the stage the request is on their desk for.
//
// Finance is a LIST, not a person (BUILT_IN_FINANCE below). Whoever is on it
// holds the same desk: any of them can pay or decline any request, and the
// audit log records which one did. They also see each other's decisions — a
// decline tells the other reviewers in-app (tellOtherReviewers) precisely so
// two people don't work the same row.
// Who leads whom is lib/payrollApproval.ts; a filer with no lead skips
// straight to finance.
//
// The lead desk is NOT a revival of the admin stage this module used to run
// (tech@/shakhzod@ approving requests onward). That one was removed because it
// contributed nothing: it could only pass a request along or write a note, and
// the note is the decline finance already had. A lead holds something neither
// desk does — they know whether the work behind an expense or a bonus actually
// happened on their team — which is the whole reason a second desk is worth
// waiting on this time.
//
// Env vars ADD reviewers (the ADMIN_EMAILS convention) — handy for exercising
// the queue as dev@freshman.academy locally, and the way to hand someone the
// desk for a week without a deploy. PAYROLL_ADMIN_EMAILS is no longer read by
// anything; PAYROLL_FINANCE_EMAILS is the one that still adds a reviewer, and
// PAYROLL_OBSERVER_EMAILS adds a reader.
//
// Being a global admin (lib/admin.ts) means seeing everything payroll holds —
// the panel, the stats, the invoices — but NOT acting on a request. Deciding
// money and administering the app stay separate, as they did before.
//
// The OBSERVER list below exists because that admin read was, for a while,
// the only way to hand someone the whole payroll record — and paying for it
// with the /admin panel (deleting users, rewriting fines, bonuses, attendance)
// is far too much to grant somebody who only needs to read the books. So the
// read audience gets a list of its own: an observer sees exactly what an admin
// sees inside payroll and nothing at all outside it.

const BUILT_IN_FINANCE = [
  "valera@freshman.academy",
  "valentina@freshman.academy",
  "tech@freshman.academy",
];

/**
 * Read-only payroll: someone who needs the whole record without administering
 * the app or deciding money. Env var ADDS, the ADMIN_EMAILS convention.
 */
const BUILT_IN_PAYROLL_OBSERVERS = ["sega@freshman.academy"];

/**
 * Global admins who get NO payroll. The admin list (lib/admin.ts) is one flat
 * grant and payroll is the one part of it nobody should inherit by accident —
 * so an admin can be handed the app without being handed the books. Env var
 * ADDS, the ADMIN_EMAILS convention.
 */
const BUILT_IN_PAYROLL_EXCLUDED = ["dostonbps@gmail.com"];

function withEnvEmails(builtIn: string[], envVar: string): string[] {
  const fromEnv = (process.env[envVar] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...builtIn, ...fromEnv])];
}

/** The reviewer stage: who decides a request and pays it. */
export function financeEmails(): string[] {
  return withEnvEmails(BUILT_IN_FINANCE, "PAYROLL_FINANCE_EMAILS");
}

export function isFinance(email: string | null | undefined): boolean {
  return !!email && financeEmails().includes(email.toLowerCase());
}

/** The observer stage: who reads payroll and decides nothing in it. */
export function payrollObserverEmails(): string[] {
  return withEnvEmails(BUILT_IN_PAYROLL_OBSERVERS, "PAYROLL_OBSERVER_EMAILS");
}

/**
 * An observer holds no verb anywhere — not `isFinance`'s pay/decline, not
 * `requireSheetEditor`'s register, not the /admin panel. Everything it opens
 * is a page it can only look at, which is why it is safe to hand out.
 */
export function isPayrollObserver(email: string | null | undefined): boolean {
  return !!email && payrollObserverEmails().includes(email.toLowerCase());
}

/**
 * Being a global admin, minus the ones excluded above. Every payroll surface
 * that lets an admin in keys off THIS, never `isAdmin` directly — the panel,
 * the stats, the invoices, the register — so one list is the whole exclusion.
 */
export function isPayrollAdmin(email: string | null | undefined): boolean {
  return (
    isAdmin(email) &&
    !withEnvEmails(BUILT_IN_PAYROLL_EXCLUDED, "PAYROLL_EXCLUDED_EMAILS").includes(
      (email ?? "").toLowerCase(),
    )
  );
}

/**
 * Who may read the whole of payroll — the panel, the stats, anyone's invoice:
 * the reviewer, global admins, and observers. Reading is the wide door; every
 * verb below it is `isFinance` alone.
 */
export function canSeeAllPayroll(email: string | null | undefined): boolean {
  return isPayrollAdmin(email) || isFinance(email) || isPayrollObserver(email);
}

/**
 * Who keeps payroll's READ side open after payroll itself closes — the panel,
 * and the invoices and receipts a panel row links to. Global admins do, and so
 * do observers: the record is the whole reason they were given payroll at all,
 * and a reader locked out the moment the month shuts can answer nothing.
 *
 * Closing payroll (PAYROLL_CLOSED, or a restricted rollout that leaves an
 * account off PAYROLL_OPEN_TO) is about who may file and be paid. It is not
 * about the record: a month that was already filed, decided and paid stays
 * part of the books, and the people who administer the app have to be able to
 * look it up — not least to answer "what happened to my request?" from behind
 * a coming-soon screen.
 *
 * This unlocks reading and nothing else. Every payroll verb keeps its own
 * `isPayrollOpenFor` guard (../app/payroll/finance/actions.ts,
 * ../app/payroll/sheet/actions.ts, ../app/payroll/actions.ts) and refuses
 * while closed, and the panel draws no verb it cannot honour — so an admin
 * reading a shut payroll can pay nothing, decline nothing and record nothing.
 * An observer can do none of those three with payroll wide open either.
 * The lazy sweeps are safe for the same reason: both already return early
 * while closed, so opening the panel can't expire a row or email anyone.
 */
export function canReadPayrollWhileClosed(
  email: string | null | undefined,
): boolean {
  return isPayrollAdmin(email) || isPayrollObserver(email);
}

type SessionLike = {
  user?: { id?: string; email?: string | null };
} | null;

/** Throw unless the signed-in user is the reviewer; returns their id. */
export async function requireFinance(session: SessionLike): Promise<string> {
  const id = session?.user?.id;
  if (!id || !isFinance(session?.user?.email)) {
    throw new Error("Not authorized");
  }
  return id;
}

/**
 * Who may confirm a payment, and over whom.
 *
 * Two desks hold the same verb through different doors, so it is worked out
 * once here rather than re-derived by every caller:
 *
 *   • finance — `all: true`, the whole company, exactly `requireFinance`.
 *   • a department lead — the members of the normal departments they lead,
 *     which is `approvableFilerIds`: the same set they approve, so the desk
 *     that vouched for a request is the desk that can settle it. That set
 *     excludes the lead themselves, so nobody pays their own request, and it
 *     excludes mini departments, which carry no payroll desk at all.
 *
 * Anyone who is neither is refused here, before a submission is even read.
 * `mayPay` then decides the row: an id off a page proves nothing, so the
 * scope is re-applied per request rather than once per batch.
 */
export type Payer = {
  actorId: string;
  /** Finance: every filer. A lead: only `filerIds`. */
  all: boolean;
  filerIds: ReadonlySet<string>;
};

/** Throw unless the signed-in user may pay somebody; returns what they may pay. */
export async function requirePayer(session: SessionLike): Promise<Payer> {
  const actorId = session?.user?.id;
  if (!actorId) throw new Error("Not authorized");
  if (isFinance(session?.user?.email)) {
    return { actorId, all: true, filerIds: new Set() };
  }
  const led = await approvableFilerIds(prisma, actorId);
  if (led.size === 0) throw new Error("Not authorized");
  return { actorId, all: false, filerIds: led };
}

/** Whether this payer may settle `filerId`'s request. */
export function mayPay(payer: Payer, filerId: string): boolean {
  return payer.all || payer.filerIds.has(filerId);
}

/** User rows for a list of reviewer emails (those never signed in are skipped). */
export async function reviewerUsers(
  db: Db,
  emails: string[],
): Promise<{ id: string; email: string | null }[]> {
  return db.user.findMany({
    where: { email: { in: emails, mode: "insensitive" } },
    select: { id: true, email: true },
  });
}

// ----- The calendar month, and its filing window, in Tashkent -----

const TASHKENT_UTC_OFFSET_HOURS = 5; // Asia/Tashkent is UTC+5, no DST
const OFFSET_MS = TASHKENT_UTC_OFFSET_HOURS * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/**
 * Which Tashkent calendar day an instant falls on, as a bare day count since
 * the epoch. Two instants are on the same Tashkent date exactly when their
 * counts match — no formatting, no per-comparison Date, and no second place
 * for the offset arithmetic to drift out of step with periodBoundsFor.
 */
function tashkentDayNumber(at: Date): number {
  return Math.floor((at.getTime() + OFFSET_MS) / DAY_MS);
}

export type PayrollPeriodBounds = {
  year: number;
  month: number; // 1–12
  startsAt: Date;
  endsAt: Date;
  filingOpensAt: Date;
  filingClosesAt: Date;
  remindAt: Date;
};

/**
 * The payroll period `now` falls in, all boundaries as UTC instants of
 * Tashkent wall-clock times.
 *
 * The month itself runs [1st 00:00, next 1st 00:00). Filing is deliberately
 * NOT open for all of it — the window is the last three days of the month plus
 * the first day of the next one:
 *
 *   opens  00:00:00 on (last day − 2)  … Aug 29th, for a 31-day August
 *   closes 23:59:59 on the 1st of M+1  … Sep 1st
 *
 * Four days, so everyone files against a nearly-final ledger (a request filed
 * on the 3rd would snapshot none of the month's later bonuses and fines) and
 * finance reviews one batch instead of a month-long trickle.
 *
 * Because that window crosses the month boundary, the 1st of a month still
 * belongs to the month BEFORE it as far as payroll is concerned — hence the
 * day-1 step-back below. Without it, /payroll would flip to the new month on
 * the very day the old month's window is meant to be closing, and the last day
 * of the window would be unreachable.
 *
 * `remindAt` is 09:00 on the opening day — nine hours into the window, not
 * before it: a nudge to file is only worth sending while filing can be done.
 */
export function periodBoundsFor(now: Date): PayrollPeriodBounds {
  const tash = new Date(now.getTime() + OFFSET_MS);
  // Date.UTC normalizes a month of −1 into the previous December, so a January
  // 1st rolls back to the year before on its own — but only if the year is
  // read off the NORMALIZED anchor rather than off `tash`.
  const anchor = new Date(
    Date.UTC(
      tash.getUTCFullYear(),
      tash.getUTCMonth() - (tash.getUTCDate() === 1 ? 1 : 0),
      1,
    ),
  );
  const year = anchor.getUTCFullYear();
  const m0 = anchor.getUTCMonth();
  const startsAt = new Date(Date.UTC(year, m0, 1) - OFFSET_MS);
  const endsAt = new Date(Date.UTC(year, m0 + 1, 1) - OFFSET_MS);
  // Day 0 of the next month is this month's last day — 28, 29, 30 or 31, so
  // the window is measured from the end and never lands on a missing date.
  const lastDay = new Date(Date.UTC(year, m0 + 1, 0)).getUTCDate();
  const filingOpensAt = new Date(Date.UTC(year, m0, lastDay - 2) - OFFSET_MS);
  // 23:59:59 on the 1st of M+1 is midnight starting its 2nd, less one second.
  const filingClosesAt = new Date(Date.UTC(year, m0 + 1, 2) - OFFSET_MS - 1_000);
  const remindAt = new Date(Date.UTC(year, m0, lastDay - 2, 9) - OFFSET_MS);
  return {
    year,
    month: m0 + 1,
    startsAt,
    endsAt,
    filingOpensAt,
    filingClosesAt,
    remindAt,
  };
}

/**
 * The same bounds for a month named outright rather than found from an
 * instant. The 15th is the anchor because it is the one date that can't be
 * caught by the day-1 step-back above, so the month asked for is the month
 * that comes back.
 */
export function periodBoundsForMonth(
  year: number,
  month: number,
): PayrollPeriodBounds {
  return periodBoundsFor(new Date(Date.UTC(year, month - 1, 15)));
}

/**
 * The PayrollPeriod row governing `now`, created on first touch. Rows only
 * exist from the feature's launch month onward, so closed-period surfaces
 * ("did not file", stats history) never reach back before payroll existed.
 *
 * A held-open period (PAYROLL_HELD_OPEN) displaces the calendar one for as
 * long as it is held: while August is being kept open there is no sense in
 * which September is the cycle people file against, and pointing "current" at
 * the calendar month would leave the held-open form unreachable — the very
 * thing holding it open was meant to allow. `update: {}` is what keeps the
 * stored window intact, so lifting the hold restores the original cutoff.
 */
export async function ensureCurrentPeriod(db: Db = prisma, now = new Date()) {
  const b = PAYROLL_HELD_OPEN
    ? periodBoundsForMonth(PAYROLL_HELD_OPEN.year, PAYROLL_HELD_OPEN.month)
    : periodBoundsFor(now);
  return db.payrollPeriod.upsert({
    where: { year_month: { year: b.year, month: b.month } },
    update: {},
    create: b,
  });
}

/**
 * Where `now` sits relative to a period's filing window. The bounds are read
 * off the row, never recomputed here: a period keeps the window it was created
 * with, so a rule change can't retroactively reopen or shut a month people
 * already filed under.
 */
export type FilingWindowState = "BEFORE" | "OPEN" | "CLOSED";

export type PeriodWindow = {
  year: number;
  month: number;
  filingOpensAt: Date;
  filingClosesAt: Date;
};

export function filingWindowState(
  period: PeriodWindow,
  now: Date,
): FilingWindowState {
  // The standing exception, and the only one that applies to everybody: a
  // held-open month has no cutoff, so it can't be past one.
  if (isHeldOpenPeriod(period)) return "OPEN";
  if (now < period.filingOpensAt) return "BEFORE";
  if (now > period.filingClosesAt) return "CLOSED";
  return "OPEN";
}

/**
 * The window as it applies to ONE person.
 *
 * A restricted rollout (PAYROLL_OPEN_TO) exists to be tested, and the window
 * is only four days a month — so an allowlisted tester who has to wait for it
 * cannot exercise the feature they were given early access to. While the
 * rollout is on, its members file whenever they like; the moment the list is
 * emptied for a full launch they are back on the window with everyone else,
 * so this can't quietly become a permanent exemption for whoever tested.
 *
 * The exception is announced in the UI rather than applied silently: someone
 * filing in the middle of the month should know the window didn't apply to
 * them, or they'll report the window itself as broken.
 */
export function filingWindowStateFor(
  email: string | null | undefined,
  period: PeriodWindow,
  now: Date,
): FilingWindowState {
  if (isPayrollRolloutTester(email)) return "OPEN";
  return filingWindowState(period, now);
}

// ----- Status machine -----

const TRANSITIONS: Record<PayrollStatus, readonly PayrollStatus[]> = {
  // Filing lands on the lead's desk, or on finance's when the filer has no
  // lead to answer to (lib/payrollApproval.ts).
  DRAFT: ["WITH_LEAD", "SUBMITTED"],
  // The lead's desk: they pass it to finance, they or finance send it back, or
  // the filer edits it under them (same status, fresh snapshot, audit event
  // either way).
  //
  // No EXPIRED edge: nothing sweeps this desk. A request here is waiting on
  // the LEAD, not on the filer, so a clock that runs out on it would punish
  // the wrong person — and expiring it would be an override of the gate by
  // the calendar. What keeps it from waiting forever is finance's decline
  // (DECLINABLE in app/payroll/finance/actions.ts): they cannot pay a request
  // the lead hasn't passed, but they can always send it back to the filer,
  // whose resubmit window does expire. So there is exactly one exit from a
  // stalled approval, it belongs to a person, and it is in the audit log.
  WITH_LEAD: ["WITH_LEAD", "SUBMITTED", "DECLINED"],
  // SUBMITTED → SUBMITTED is a filer editing a request that never had a lead;
  // one that DID goes back to WITH_LEAD instead, because an edit rewrites the
  // very numbers the lead approved and their stamp can't carry over to money
  // they never saw.
  SUBMITTED: ["WITH_LEAD", "SUBMITTED", "DECLINED", "PROCESSED"],
  DECLINED: ["WITH_LEAD", "SUBMITTED", "EXPIRED"],
  // Legacy. Nothing enters this state any more — it was the admin stage's
  // hand-off to finance, and there is no admin stage. Rows that were sitting
  // in it when the stage was removed are still live money, so they keep both
  // exits and the queue offers them the same two verbs as a SUBMITTED row.
  // The send-back to SUBMITTED is gone with the desk it went back to.
  // The self-edge is finance revising the figures before paying (see
  // editSubmissionAsFinance): the status doesn't move, but the event lands so
  // the change is in the trail. A legacy row is still live money on the same
  // desk, so it is editable exactly like a SUBMITTED one.
  APPROVED_BY_ADMIN: ["APPROVED_BY_ADMIN", "DECLINED", "PROCESSED"],
  EXPIRED: [],
  PROCESSED: [],
};

/**
 * The statuses that block filing another period (see PayrollSubmission docs).
 * WITH_LEAD is one of them: a request waiting on its lead is money nobody has
 * ruled on yet, and letting September be filed over it would put the same
 * bonuses and fines into two snapshots — exactly what this list prevents.
 */
export const IN_FLIGHT_STATUSES: PayrollStatus[] = [
  "WITH_LEAD",
  "SUBMITTED",
  "DECLINED",
  "APPROVED_BY_ADMIN",
];

export function assertTransition(from: PayrollStatus, to: PayrollStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(
      `A request that is “${PAYROLL_STATUS_LABEL[from]}” can't move to “${PAYROLL_STATUS_LABEL[to]}”.`,
    );
  }
}

/**
 * The only way a submission changes status. Guards the transition against the
 * machine, applies it optimistically (the row must still be in `from`, so two
 * reviewers acting at once can't both land), and writes the audit event in the
 * same breath. `data` carries the transition's scalar side effects
 * (resubmitDeadline, processedAt, …); `actorId` null means the system.
 */
export async function applyTransition(
  db: Db,
  opts: {
    submissionId: string;
    from: PayrollStatus;
    to: PayrollStatus;
    actorId: string | null;
    note?: string | null;
    data?: Prisma.PayrollSubmissionUpdateManyMutationInput;
  },
): Promise<void> {
  assertTransition(opts.from, opts.to);
  const updated = await db.payrollSubmission.updateMany({
    where: { id: opts.submissionId, status: opts.from },
    data: { ...opts.data, status: opts.to },
  });
  if (updated.count === 0) {
    throw new Error("This request changed while you were acting — reload and try again.");
  }
  await db.payrollEvent.create({
    data: {
      submissionId: opts.submissionId,
      actorId: opts.actorId,
      fromStatus: opts.from,
      toStatus: opts.to,
      note: opts.note?.trim().slice(0, 1000) || null,
    },
  });
}

/**
 * The deadline a decline at `now` leaves the filer, and whether it runs past
 * the month's filing cutoff (the once-per-period grace day).
 *
 * A decline does NOT start a fresh 24-hour clock. The filer already has a
 * deadline — the cutoff their period closes on — and being sent back to fix a
 * note is no reason to shorten it. The old min(now + 24h, cutoff + 24h) did
 * exactly that: declining on the 27th handed back a deadline of the 28th and
 * quietly took days of runway off someone who still had the whole window. So
 * the ordinary case hands the cutoff back unchanged.
 *
 * The one exception is a decline ON the window's last day — the 1st of M+1,
 * where filingClosesAt sits, NOT the last day of the month itself (see
 * periodBoundsFor). A decline at 22:00 that day would leave two hours to redo
 * a whole pay request, so the deadline runs one day past the cutoff instead.
 * That is the grace day, and `usesGraceDay` reports it so the caller can spend
 * the once-per-period flag.
 *
 * "Last day" is a Tashkent calendar-day test, never a UTC one: 00:30 on the
 * 1st in Tashkent is still the 31st in UTC, so five hours out of every day
 * would be judged against the wrong date — the exact hours a late-night
 * decline is most likely to land in.
 *
 * A HELD-OPEN period returns no deadline at all. The deadline is the month's
 * cutoff and a held-open month has none, so there is nothing to hand back:
 * `null` says "not yet", and it is the honest answer rather than a date. The
 * alternative — handing back the stored cutoff, which is already in the past —
 * would decline a request straight into a lapsed window, and a request that
 * cannot be refiled is exactly what holding the month open was meant to
 * prevent. What bounds the refile instead is the filing window itself, tested
 * in submitPayroll, so lifting the hold closes these windows with the month.
 *
 * The result therefore only ever takes two values, cutoff or cutoff + 24h, and
 * as time passes it moves from the first to the second and never back. That is
 * what makes re-declines safe: a second decline can neither push the deadline
 * further out once the grace day is spent, nor claw back a deadline it already
 * granted — so the caller needs no `graceDayUsed` input to stay idempotent.
 *
 * This clock is the reason refiling a DECLINED request is NOT gated by the
 * filing window: the grace day exists precisely to run past it.
 */
export function resubmitWindowFor(
  now: Date,
  period: { year: number; month: number; filingClosesAt: Date },
): { deadline: Date | null; usesGraceDay: boolean } {
  if (isHeldOpenPeriod(period)) return { deadline: null, usesGraceDay: false };
  const { filingClosesAt } = period;
  // >= and not ===: nothing expires a SUBMITTED request, so an admin can
  // decline days after the cutoff. Such a decline belongs with the last-day
  // case (already past the deadline it would otherwise be handed), never with
  // the shorter one.
  const onLastDay = tashkentDayNumber(now) >= tashkentDayNumber(filingClosesAt);
  // Copied, not aliased — the caller's `filingClosesAt` is a live Prisma row
  // field and this value is written straight onto another row.
  const deadline = new Date(filingClosesAt.getTime() + (onLastDay ? DAY_MS : 0));
  return { deadline, usesGraceDay: deadline.getTime() > filingClosesAt.getTime() };
}

/**
 * Move DECLINED submissions whose resubmit window has lapsed to EXPIRED.
 * Lazy and idempotent — called from every payroll surface before it reads, so
 * nobody ever sees (or acts on) a window that is really over. The optimistic
 * update makes concurrent sweeps write one audit row, not two.
 *
 * Two shapes of lapsed window, because a decline is deadlined against its
 * period's cutoff and a held-open period has no cutoff to be deadlined
 * against (see resubmitWindowFor):
 *
 *   • a deadline that has passed — the ordinary case;
 *   • no deadline at all, on a period whose filing has since closed. That is
 *     how a request declined while a month was held open is settled once the
 *     hold is lifted: it lapses with the month, not silently on the stale
 *     cutoff the row still carries. It also finally settles legacy declines
 *     written before resubmitDeadline existed, which could not be refiled
 *     either and were sitting DECLINED for good — blocking the filer from
 *     ever filing again (DECLINED is in IN_FLIGHT_STATUSES).
 *
 * Nothing in a held-open period lapses under either shape: its filing window
 * is open, so no window in it is over.
 */
export async function expireLapsedSubmissions(now = new Date()): Promise<void> {
  // Closed: a decline window that lapses while nobody can refile isn't the
  // employee's fault, so nothing expires until payroll reopens.
  if (PAYROLL_CLOSED) return;
  // Same reasoning per-account during a restricted rollout: someone outside
  // the allowlist can't reach the form, so their window must not tick down.
  const allowed = payrollOpenToEmails();
  const lapsed = await prisma.payrollSubmission.findMany({
    where: {
      status: "DECLINED",
      OR: [
        { resubmitDeadline: { lt: now } },
        { resubmitDeadline: null, period: { filingClosesAt: { lt: now } } },
      ],
      ...(PAYROLL_HELD_OPEN
        ? {
            NOT: {
              period: {
                year: PAYROLL_HELD_OPEN.year,
                month: PAYROLL_HELD_OPEN.month,
              },
            },
          }
        : {}),
      ...(allowed.length > 0
        ? { user: { email: { in: allowed, mode: "insensitive" as const } } }
        : {}),
    },
    select: { id: true },
  });
  for (const s of lapsed) {
    const updated = await prisma.payrollSubmission.updateMany({
      where: { id: s.id, status: "DECLINED" },
      data: { status: "EXPIRED" },
    });
    if (updated.count === 0) continue; // another request expired it first
    await prisma.payrollEvent.create({
      data: {
        submissionId: s.id,
        actorId: null,
        fromStatus: "DECLINED",
        toStatus: "EXPIRED",
        note: "Resubmit window lapsed.",
      },
    });
  }
}

// ----- Who files -----

/**
 * Everyone expected to file: approved and onboarded (≥1 department seat).
 * Unlike weekly-goal expectations this is NOT lead-gated — members get paid
 * too. A lead does now hold one payroll power over their members: approving
 * what they file, before finance can pay it (lib/payrollApproval.ts). It is
 * approval only — no lead files, edits, declines or pays on anyone's behalf.
 */
export async function eligibleEmployees(db: Db = prisma) {
  return db.user.findMany({
    where: { approvedAt: { not: null }, memberships: { some: {} } },
    // The departments come along because the panel groups non-filers by them:
    // a department's figures have to be able to say how many of ITS people
    // never filed. Every row here has at least one membership by definition of
    // the `where`, so this is a join that was already implied.
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { select: { department: { select: { name: true } } } },
    },
    orderBy: { name: "asc" },
  });
}

/**
 * The submission blocking this user from filing a new period, if any. At most
 * one request may be in flight across all periods — filing September while
 * August is still SUBMITTED would put the same bonuses and fines into two
 * snapshots and pay them twice. Callers run expireLapsedSubmissions first so
 * a dead DECLINED row doesn't block anyone.
 */
export async function inFlightSubmission(db: Db, userId: string) {
  return db.payrollSubmission.findFirst({
    where: { userId, status: { in: IN_FLIGHT_STATUSES } },
    select: {
      id: true,
      status: true,
      period: { select: { year: true, month: true } },
    },
  });
}

// ----- The ledger snapshot -----

export type LedgerSnapshot = {
  bonusLines: {
    bonusId: string;
    amount: number;
    note: string | null;
    awardedAt: Date;
  }[];
  fineLines: {
    penaltyId: string;
    amount: number; // outstanding at snapshot, not face value
    type: PenaltyType;
    note: string | null;
    issuedAt: Date;
  }[];
  bonusesTotal: number;
  finesTotal: number;
};

/**
 * What the ledger owes and is owed by this person right now: every bonus not
 * yet paid out through payroll, and the OUTSTANDING balance of every open
 * fine (partial payments already exist, so face value would over-deduct).
 * Copied onto the submission at (re)submit time — never read live again.
 */
export async function pullLedgerSnapshot(
  db: Db,
  userId: string,
): Promise<LedgerSnapshot> {
  const bonuses = await db.bonus.findMany({
    where: { userId, payrollSubmissionId: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, amount: true, note: true, createdAt: true },
  });
  const fines = await db.penalty.findMany({
    where: { userId, paidAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      amount: true,
      paidAmount: true,
      type: true,
      note: true,
      createdAt: true,
    },
  });

  const bonusLines = bonuses.map((b) => ({
    bonusId: b.id,
    amount: b.amount,
    note: b.note,
    awardedAt: b.createdAt,
  }));
  const fineLines = fines
    .map((f) => ({
      penaltyId: f.id,
      amount: f.amount - f.paidAmount,
      type: f.type,
      note: f.note,
      issuedAt: f.createdAt,
    }))
    .filter((l) => l.amount > 0);

  return {
    bonusLines,
    fineLines,
    bonusesTotal: bonusLines.reduce((s, l) => s + l.amount, 0),
    finesTotal: fineLines.reduce((s, l) => s + l.amount, 0),
  };
}

// ----- Processing (the reviewer confirms payment) -----

export type ProcessResult =
  | { ok: true; batchId: string | null }
  | { ok: false; reasons: string[] };

/**
 * Pay a submission out: verify the snapshot still matches the ledger, write
 * the fine deduction back as ONE FinePayment batch (source PAYROLL — it reads
 * as a receipt on /penalties and undoes there like any settlement), stamp the
 * bonuses consumed, and move to PROCESSED.
 *
 * The re-check is the invoice-immutability guard: if someone settled a
 * snapshotted fine in cash or deleted a snapshotted bonus after filing, the
 * filed numbers no longer describe reality — processing is refused with the
 * exact reasons, and the reviewer declines it back for a fresh snapshot
 * instead of silently paying wrong amounts. The per-fine optimistic locks
 * (the recordSettlement idiom) close the race window inside the transaction.
 *
 * Pays from whichever status the request is waiting in: SUBMITTED, or the
 * legacy APPROVED_BY_ADMIN of a row the removed admin stage had already
 * approved. Both mean the same thing now — money the reviewer has not sent
 * out yet — and the audit row records which one it moved from.
 */
export async function processSubmission(opts: {
  submissionId: string;
  actorId: string;
}): Promise<ProcessResult> {
  return prisma.$transaction(async (tx) => {
    const sub = await tx.payrollSubmission.findUnique({
      where: { id: opts.submissionId },
      select: {
        id: true,
        status: true,
        fineLines: true,
        bonusLines: true,
      },
    });
    if (!sub) throw new Error("Request not found.");
    if (sub.status !== "SUBMITTED" && sub.status !== "APPROVED_BY_ADMIN") {
      throw new Error("Only a request awaiting payment can be processed.");
    }

    // Re-check every snapshotted source against the live ledger.
    const reasons: string[] = [];
    const finesById = new Map<
      string,
      { amount: number; paidAmount: number; paidAt: Date | null }
    >();
    for (const line of sub.fineLines) {
      const label = `${PENALTY_LABEL[line.type]} fine (${formatMoney(line.amount)})`;
      const penalty = line.penaltyId
        ? await tx.penalty.findUnique({
            where: { id: line.penaltyId },
            select: { amount: true, paidAmount: true, paidAt: true },
          })
        : null;
      if (!penalty) {
        reasons.push(`${label} was deleted after filing.`);
        continue;
      }
      finesById.set(line.penaltyId!, penalty);
      if (penalty.paidAt !== null || penalty.amount - penalty.paidAmount < line.amount) {
        reasons.push(`${label} was settled outside payroll after filing.`);
      }
    }
    for (const line of sub.bonusLines) {
      const label = `${formatMoney(line.amount)} bonus`;
      const bonus = line.bonusId
        ? await tx.bonus.findUnique({
            where: { id: line.bonusId },
            select: { amount: true, payrollSubmissionId: true },
          })
        : null;
      if (!bonus) reasons.push(`${label} was deleted after filing.`);
      else if (bonus.payrollSubmissionId) reasons.push(`${label} was already paid out.`);
      else if (bonus.amount !== line.amount) reasons.push(`${label} changed amount after filing.`);
    }
    if (reasons.length > 0) return { ok: false, reasons };

    // Fine write-back: exactly the snapshotted amount against exactly that
    // fine — never oldest-first over whatever happens to be open today, or a
    // fine raised after filing could eat money the invoice never deducted.
    const batchId = sub.fineLines.length > 0 ? randomUUID() : null;
    const now = new Date();
    for (const line of sub.fineLines) {
      const fine = finesById.get(line.penaltyId!)!;
      const paidAmount = fine.paidAmount + line.amount;
      const updated = await tx.penalty.updateMany({
        where: { id: line.penaltyId!, paidAt: null, paidAmount: fine.paidAmount },
        data: {
          paidAmount,
          ...(paidAmount === fine.amount
            ? { paidAt: now, settledById: opts.actorId }
            : {}),
        },
      });
      if (updated.count === 0) {
        throw new Error("The fines ledger changed while processing — try again.");
      }
      await tx.finePayment.create({
        data: {
          penaltyId: line.penaltyId!,
          amount: line.amount,
          batchId: batchId!,
          source: "PAYROLL",
          recordedById: opts.actorId,
        },
      });
    }

    // Bonuses are consumed by this submission — they can never snapshot again.
    const bonusIds = sub.bonusLines.map((l) => l.bonusId!);
    if (bonusIds.length > 0) {
      const stamped = await tx.bonus.updateMany({
        where: { id: { in: bonusIds }, payrollSubmissionId: null },
        data: { payrollSubmissionId: sub.id },
      });
      if (stamped.count !== bonusIds.length) {
        throw new Error("The bonus ledger changed while processing — try again.");
      }
    }

    await applyTransition(tx, {
      submissionId: sub.id,
      from: sub.status,
      to: "PROCESSED",
      actorId: opts.actorId,
      data: { processedAt: now, fineBatchId: batchId },
    });
    return { ok: true, batchId };
  });
}

// ----- Reminder sweep -----

/** Absolute base for links in payroll emails (same var Auth.js builds from). */
export function appUrl(): string {
  return process.env.AUTH_URL ?? "https://www.freshweek.org";
}

/**
 * The filing reminder: 09:00 Tashkent on the day the filing window opens,
 * in-app + email to every eligible employee who hasn't submitted this period.
 * It lands INSIDE the window on purpose — the window is only four days long,
 * so the one reminder people get should be one they can act on immediately.
 * No cron exists — this runs lazily on payroll/dashboard loads, and the
 * optimistic claim on `reminderSentAt` makes it fire exactly once per period
 * however many requests race it. Declined and expired people are not nagged:
 * they DID file (their decline carries its own deadline), and an expired
 * filing rolls to next month by design.
 */
export async function reconcilePayrollReminders(now = new Date()): Promise<void> {
  // Closed: never nag people to file a feature they can't reach. The claim on
  // reminderSentAt is left unset, so reopening still gets its one reminder.
  if (PAYROLL_CLOSED) return;
  const period = await ensureCurrentPeriod(prisma, now);
  if (period.reminderSentAt) return;
  // Both bounds are read off the row, so a HELD-OPEN period is silent here
  // even though it is the current one: its `remindAt` fired long ago and its
  // stored cutoff is past. Holding a month open extends the deadline, it does
  // not re-nudge the team about a month they were already reminded of — a
  // second all-hands email is a decision for whoever held it open to make.
  if (now < period.remindAt || now > period.filingClosesAt) return;

  const claimed = await prisma.payrollPeriod.updateMany({
    where: { id: period.id, reminderSentAt: null },
    data: { reminderSentAt: now },
  });
  if (claimed.count === 0) return; // another request beat us to it

  const [employees, filed] = await Promise.all([
    eligibleEmployees(prisma),
    prisma.payrollSubmission.findMany({
      where: { periodId: period.id, status: { not: "DRAFT" } },
      select: { userId: true },
    }),
  ]);
  const filedIds = new Set(filed.map((s) => s.userId));
  // Only people who can actually reach the form. During a restricted rollout
  // everyone else would get an email pointing at a coming-soon screen.
  const unfiled = employees.filter(
    (e) => !filedIds.has(e.id) && isPayrollOpenFor(e.email),
  );
  if (unfiled.length === 0) return; // nobody to remind — the claim is spent

  const label = payrollPeriodLabel(period.year, period.month);
  // Phrased as an opening, not a last call: this fires at 09:00 on the morning
  // the window opens, so "you haven't filed yet" would be scolding someone for
  // missing a deadline that only just became reachable. It still carries the
  // close time, because the whole window is four days.
  const message =
    `Payroll for ${label} is open — file your pay request by ` +
    `${formatTashkent(period.filingClosesAt)}.`;

  // The claim above is what stops several page loads all sending this. But a
  // claim that survives a failed delivery doesn't lose one reminder — it
  // suppresses the only one this period will ever get, right before a deadline
  // people are fined against. So hand it back on failure and let the next load
  // try again. That can re-notify someone the first attempt did reach; a
  // duplicate nudge is the cheaper mistake by a wide margin.
  try {
    await notify(
      prisma,
      unfiled.map((e) => e.id),
      "PAYROLL",
      message,
    );
    const sent = await Promise.all(
      unfiled
        .filter((e) => e.email)
        .map((e) =>
          sendEmail({
            to: e.email!,
            subject: `Payroll: ${label} filing is open`,
            text:
              `Hi${e.name ? ` ${e.name}` : ""},\n\n` +
              `Filing for ${label} opened this morning. Your bonuses and fines ` +
              `are pulled in automatically — you add your salary and any ` +
              `expenses.\n\n` +
              `The window closes ${formatTashkent(period.filingClosesAt)}.\n\n` +
              `File it here: ${appUrl()}/payroll\n\n— FreshWeek`,
          }),
        ),
    );
    if (sent.some((ok) => !ok)) {
      throw new Error("at least one payroll reminder email did not go out");
    }
  } catch (e) {
    console.error("reconcilePayrollReminders: releasing the claim to retry", e);
    await prisma.payrollPeriod.updateMany({
      where: { id: period.id },
      data: { reminderSentAt: null },
    });
  }
}

/** "Sun, Aug 31, 11:59 PM (Tashkent)" — deadlines always read in company time. */
export function formatTashkent(at: Date): string {
  return (
    at.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Tashkent",
    }) + " (Tashkent)"
  );
}

// ----- Payment details owed on an already-filed request -----

/**
 * A filed request that is missing the payout details its method now asks for.
 *
 * The card and bank fields didn't exist when some requests were filed — those
 * methods used to store nothing, on the reasoning that finance would sort it
 * out over Telegram. Anyone who filed before that changed has a request in the
 * queue that finance can't pay from, and no reason to know it. This finds it so
 * the app can ask (see PaymentDetailsPrompt).
 *
 * Only requests where the money HASN'T moved: PROCESSED is already paid and
 * EXPIRED is closed, so neither is worth chasing anyone about.
 */
export async function submissionNeedingPaymentDetails(
  userId: string,
  db: Db = prisma,
): Promise<{
  id: string;
  method: PayrollMethod;
  details: PaymentDetails;
  periodLabel: string;
} | null> {
  const rows = await db.payrollSubmission.findMany({
    where: { userId, status: { notIn: ["PROCESSED", "EXPIRED"] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      paymentMethod: true,
      paymentDetails: true,
      period: { select: { year: true, month: true } },
    },
  });

  for (const r of rows) {
    const details = parsePaymentDetails(r.paymentDetails);
    if (validatePaymentDetails(r.paymentMethod, details) == null) continue;
    return {
      id: r.id,
      method: r.paymentMethod,
      details,
      periodLabel: payrollPeriodLabel(r.period.year, r.period.month),
    };
  }
  return null;
}
