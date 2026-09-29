"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/guidelines", label: "Guidelines" },
  { href: "/penalties", label: "Penalties" },
  { href: "/payroll", label: "Payroll" },
  { href: "/team", label: "Team" },
  { href: "/notifications", label: "Notifications" },
];

// Pages with their own chrome — the dashboard's full header (bell + profile)
// and the bare auth/onboarding screens — don't get the nav bar.
const HIDDEN = new Set(["/", "/dashboard", "/signin", "/onboarding", "/pending"]);

/**
 * A slim persistent nav for every page that isn't the dashboard. Until now
 * the only way off a subpage was "back to dashboard"; the bar makes the main
 * sections one click away from anywhere. Daily reports only exists for the
 * people in that loop (reporters and admins), and the content plan only for
 * the marketing department, so both links are opt-in via the root layout
 * rather than in the static list.
 */
export function SiteNav({
  showDailyReports = false,
  showMarketing = false,
}: {
  showDailyReports?: boolean;
  showMarketing?: boolean;
}) {
  const pathname = usePathname();
  if (HIDDEN.has(pathname)) return null;

  const links = [
    LINKS[0],
    ...(showDailyReports
      ? [{ href: "/daily-reports", label: "Daily reports" }]
      : []),
    ...(showMarketing ? [{ href: "/marketing", label: "Content plan" }] : []),
    ...LINKS.slice(1),
  ];

  return (
    <nav className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-5 overflow-x-auto px-4 py-2.5">
        <Link
          href="/dashboard"
          className="shrink-0 text-xs font-semibold uppercase tracking-widest text-brand transition hover:text-brand-dark"
        >
          freshman.academy
        </Link>
        <div className="flex items-center gap-4">
          {links.map((l) => {
            const active =
              pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`shrink-0 text-sm transition ${
                  active
                    ? "font-semibold text-ink"
                    : "text-muted-fg hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
