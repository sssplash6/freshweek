import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertApproved } from "@/lib/approval";
import { isDailyReporter, isDailyReportRecipient } from "@/lib/dailyReports";
import { ReporterView } from "./_components/ReporterView";
import { ReviewView } from "./_components/ReviewView";

export const metadata: Metadata = { title: "Daily reports" };

/**
 * One address, two sides: reporters write here, the recipient (and other
 * admins) read here. Anyone else has nothing on this page and goes back to
 * their dashboard.
 */
export default async function DailyReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  await assertApproved(session.user);
  const email = session.user.email;
  const reporter = isDailyReporter(email);
  // The reports are for one reader: the recipient. Other admins have no
  // window into them.
  const recipient = isDailyReportRecipient(email);
  const sp = await searchParams;

  // A recipient who also reports lands on their composer; the team view stays
  // one click away (?view=review) and any calendar navigation (?m/?d) keeps
  // them on it.
  const wantsReview =
    sp.view === "review" ||
    typeof sp.m === "string" ||
    typeof sp.d === "string";

  if (recipient && (wantsReview || !reporter)) {
    return (
      <ReviewView
        monthParam={typeof sp.m === "string" ? sp.m : undefined}
        dayParam={typeof sp.d === "string" ? sp.d : undefined}
      />
    );
  }
  if (reporter) {
    return <ReporterView userId={session.user.id} showReviewLink={recipient} />;
  }
  redirect("/dashboard");
}
