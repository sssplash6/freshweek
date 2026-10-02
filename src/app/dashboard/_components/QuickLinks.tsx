import Link from "next/link";

/**
 * The dashboard's role shortcuts: the two destinations that used to be buried
 * in the profile menu for the people who work in them every day.
 *
 * "My Department" is the lead's day-to-day panel; "Payroll" goes straight to
 * the payroll panel (the review queue), not the personal /payroll filing page
 * everyone has in the menu. Each button is opt-in per viewer and the row
 * renders nothing when neither applies, so members see the dashboard as it was.
 *
 * A server component: plain links, no state.
 */
export function QuickLinks({
  showDepartment,
  showAllDepartments,
  showPayroll,
  payrollHref,
}: {
  /** Leads at least one department — their day-to-day panel. */
  showDepartment: boolean;
  /** An admin who leads nothing: /department would bounce them, so they get the admin-wide list. */
  showAllDepartments: boolean;
  showPayroll: boolean;
  /** The panel for admins who may read it; the filing page for the rest. */
  payrollHref: string;
}) {
  if (!showDepartment && !showAllDepartments && !showPayroll) return null;
  const cls =
    "inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-brand transition hover:bg-canvas hover:ring-2 hover:ring-brand-soft";
  return (
    <nav aria-label="Shortcuts" className="mb-5 flex flex-wrap gap-2">
      {showDepartment && (
        <Link href="/department" className={cls}>
          My Department
        </Link>
      )}
      {showAllDepartments && (
        <Link href="/departments" className={cls}>
          Departments
        </Link>
      )}
      {showPayroll && (
        <Link href={payrollHref} className={cls}>
          Payroll
        </Link>
      )}
    </nav>
  );
}
