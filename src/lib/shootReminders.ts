// Server-only: the "a shoot is coming" nudge. The lazy no-cron pattern of
// reconcileDailyReportReminders (lib/dailyReportFines.ts) and the payroll
// reminder: no scheduled job exists, so the sweep runs on page loads — the
// /marketing page and, for marketing members, the dashboard — and each shoot
// claims its reminder with `reminderSentAt`, an atomic update that makes a
// lost race between two loads send it once at most.
//
// A shoot enters the window SHOOT_REMINDER_WINDOW_MS (24h) before its instant;
// unassigned shoots never remind — there is nobody to nudge. Rescheduling or
// reassigning a shoot clears the claim (marketing/actions.ts updateShoot), so
// the new slot or the new creator gets a reminder of their own.
//
// Unlike the daily-report reminder, a failed email does NOT release the claim:
// the in-app nudge is written first and did land, so a retry would only stack
// a duplicate in the bell on every page load for as long as mail is down (or
// forever, for an address Resend rejects). No fine rides on this reminder,
// which is what justifies the daily-report sweep's retry-and-maybe-repeat.

import { formatDateTimeTz } from "@/lib/dates";
import { sendEmail } from "@/lib/email";
import { SHOOT_REMINDER_WINDOW_MS } from "@/lib/marketing";
import { notify } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";

export async function reconcileShootReminders(now: Date = new Date()) {
  const windowEnd = new Date(now.getTime() + SHOOT_REMINDER_WINDOW_MS);
  const due = await prisma.contentShoot.findMany({
    where: {
      reminderSentAt: null,
      assigneeId: { not: null },
      shootAt: { gte: now, lte: windowEnd },
    },
    select: {
      id: true,
      title: true,
      shootAt: true,
      location: true,
      assignee: { select: { id: true, name: true, email: true } },
    },
  });

  const appUrl = process.env.AUTH_URL ?? "https://www.freshweek.org";
  for (const shoot of due) {
    if (!shoot.assignee) continue;
    // The claim: whichever load writes reminderSentAt first owns the send.
    const claim = await prisma.contentShoot.updateMany({
      where: { id: shoot.id, reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    if (claim.count === 0) continue;

    const when = formatDateTimeTz(shoot.shootAt);
    const message = `Shoot coming up: “${shoot.title}” — ${when} at ${shoot.location}.`;
    await notify(prisma, shoot.assignee.id, "MARKETING", message);

    if (shoot.assignee.email) {
      const sent = await sendEmail({
        to: shoot.assignee.email,
        subject: `Shoot reminder: ${shoot.title}`,
        text: `${message}\n\nAfterwards, file the Drive links on the content plan:\n${appUrl}/marketing\n\n— FreshWeek content plan`,
      });
      if (!sent) {
        console.error(
          `reconcileShootReminders: email for shoot ${shoot.id} did not go out; the in-app reminder did`,
        );
      }
    }
  }
}
