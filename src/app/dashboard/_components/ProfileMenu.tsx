"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { resolveAvatar } from "@/lib/avatar";
import { useDismissible } from "@/lib/useDismissible";
import { ThemeToggle } from "@/app/_components/ThemeToggle";
import { PencilIcon } from "./icons";

type Props = {
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
  isAdmin?: boolean;
  /** Leads at least one department — unlocks the department panel entry. */
  isLead?: boolean;
};

// Changing your animal lives on /profile (see ProfileAnimal) — the roster is
// far too big for this popover. Here it's identity only.
export function ProfileMenu({
  name,
  email,
  avatar: assigned,
  isAdmin,
  isLead,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissible(open, () => setOpen(false), ref);

  const avatar = resolveAvatar(assigned ?? null, email ?? name);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-line text-lg transition hover:ring-2 hover:ring-brand-soft ${avatar.bg}`}
        aria-expanded={open}
        aria-label="Account menu"
      >
        <span aria-hidden="true">{avatar.emoji}</span>
      </button>

      {open && (
        <div className="pop-in absolute right-0 z-10 mt-2 w-64 rounded-xl border border-line bg-surface p-1 shadow-lg">
          {/* Name, with editing the profile as a pencil right beside it —
              it's an action on this identity, not another destination. */}
          <div className="flex items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">
                {name ?? "Student"}
              </p>
              {email && (
                <p className="truncate text-xs text-muted-fg">{email}</p>
              )}
            </div>
            <Link
              href="/profile"
              onClick={() => setOpen(false)}
              aria-label="Edit profile"
              title="Edit profile"
              className="-mr-1 shrink-0 rounded-lg p-1.5 text-muted-fg transition hover:bg-canvas hover:text-brand"
            >
              <PencilIcon className="h-4 w-4" />
            </Link>
          </div>

          <div className="my-1 border-t border-line" />

          {/* Appearance */}
          <div className="px-3 py-2">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
              Appearance
            </p>
            <ThemeToggle />
          </div>

          <div className="my-1 border-t border-line" />

          <Link
            href="/guidelines"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-canvas"
          >
            Guidelines
          </Link>
          <Link
            href="/team"

            onClick={() => setOpen(false)}
            className="block rounded-lg px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-canvas"
          >
            Team
          </Link>
          <Link
            href="/penalties"

            onClick={() => setOpen(false)}
            className="block rounded-lg px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-canvas"
          >
            Penalties
          </Link>
          <Link
            href="/payroll"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-canvas"
          >
            Payroll
          </Link>

          <div className="my-1 border-t border-line" />

          {isLead && (
            <Link
              href="/department"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-left text-sm font-medium text-brand transition hover:bg-canvas"
            >
              My department
            </Link>
          )}
          {isAdmin && (
            <Link
              href="/admin"

              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-left text-sm font-medium text-brand transition hover:bg-canvas"
            >
              Admin panel
            </Link>
          )}
          <button
            type="button"

            onClick={() => signOut({ redirectTo: "/signin" })}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink transition hover:bg-canvas"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
