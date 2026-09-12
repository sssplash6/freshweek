"use client";

import { useMemo, useState } from "react";
import { ROLE_LABEL } from "@/lib/team";
import { COMPANY_TIME_ZONE } from "@/lib/dates";
import { buildXlsx, downloadXlsx, type XlsxColumn } from "@/lib/xlsx";

/**
 * One person as the directory shows them: already shaped by the page, so the
 * two layouts below and the search over them all read the same list.
 */
export type TeamRow = {
  id: string;
  name: string | null;
  isYou: boolean;
  emoji: string;
  bg: string;
  department: string | null;
  lead: boolean;
  email: string | null;
  workPhone: string | null;
  telegram: string | null;
  linkedin: string | null;
  instagram: string | null;
  birthdayLabel: string | null;
};

/** A LinkedIn value (URL or handle) → a full https URL. */
function linkedinUrl(v: string): string {
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^.*linkedin\.com\/(in\/)?/i, "").replace(/^@/, "");
  return `https://www.linkedin.com/in/${handle}`;
}

/**
 * The roster as a spreadsheet: how to reach someone, and nothing else. The
 * social handles and birthdays the page carries are deliberately left behind —
 * an exported file gets mailed around and outlives the roster it came from, so
 * the personal columns stay on the page, where they're only ever seen by
 * someone signed in and current.
 */
const EXPORT_COLUMNS: XlsxColumn[] = [
  { header: "Name", width: 24 },
  { header: "Department", width: 30 },
  { header: "Role", width: 12 },
  { header: "Email", width: 30 },
  { header: "Work phone", width: 18 },
  { header: "Telegram", width: 18 },
];

/**
 * The directory itself: a search box over the whole roster, then the same
 * people as phone cards or as a table. Filtering happens here rather than on
 * the server because the whole company fits on the page already — typing
 * narrows it instantly instead of costing a round trip per keystroke.
 */
export function TeamDirectory({ rows }: { rows: TeamRow[] }) {
  const [query, setQuery] = useState("");

  // Every field a person is listed by, flattened into one lowercase string, so
  // a search reaches a department, a handle or a phone number — not just a
  // name. Whoever you're looking for, you can type what you remember of them.
  const searchable = useMemo(
    () =>
      rows.map((r) => ({
        row: r,
        haystack: [
          r.name,
          r.department,
          r.lead ? ROLE_LABEL.LEAD : ROLE_LABEL.MEMBER,
          r.email,
          r.workPhone,
          r.telegram,
          r.linkedin,
          r.instagram,
          r.birthdayLabel,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      })),
    [rows],
  );

  // Terms match independently, so "marketing lead" narrows by both rather than
  // hunting for that exact phrase inside a single field.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = searchable
    .filter(({ haystack }) => terms.every((t) => haystack.includes(t)))
    .map(({ row }) => row);

  /**
   * The people currently on screen, as an .xlsx. Deliberately `visible` and
   * not `rows`: the button sits inside the same toolbar as the search, and a
   * search that has narrowed the page to one department should narrow the
   * export with it — otherwise the file quietly disagrees with what was on
   * screen when it was asked for. Empty cells stay empty rather than taking
   * the table's em dash, which a spreadsheet would treat as a value.
   */
  function downloadExcel() {
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: COMPANY_TIME_ZONE,
    });
    downloadXlsx(
      buildXlsx({
        sheetName: "Team",
        columns: EXPORT_COLUMNS,
        rows: visible.map((r) => [
          r.name ?? "",
          r.department ?? "",
          r.lead ? ROLE_LABEL.LEAD : ROLE_LABEL.MEMBER,
          r.email ?? "",
          r.workPhone ?? "",
          r.telegram ? `@${r.telegram}` : "",
        ]),
      }),
      `team-${today}.xlsx`,
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, department, email…"
          aria-label="Search the team"
          className="min-w-0 flex-1 basis-56 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
        />
        {terms.length > 0 && (
          <>
            <p className="text-xs text-muted-fg" aria-live="polite">
              {`${visible.length} of ${rows.length} shown`}
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="whitespace-nowrap rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted-fg transition hover:text-ink"
            >
              Clear search
            </button>
          </>
        )}
        <button
          type="button"
          onClick={downloadExcel}
          disabled={visible.length === 0}
          title={`Download ${visible.length} ${
            visible.length === 1 ? "person" : "people"
          } as an Excel sheet`}
          className="shrink-0 whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-brand shadow-sm transition hover:bg-canvas disabled:pointer-events-none disabled:opacity-40"
        >
          Download Excel
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-6 text-center text-sm text-muted-fg">
          {`No one matches “${query.trim()}”.`}
        </p>
      ) : (
        <>
          {/* Phone: one card per person. Nine columns can't be squeezed into a
              phone's width, and forcing a 58rem table through a 20rem viewport
              means dragging sideways through every field of every row. */}
          <ul className="flex flex-col gap-3 md:hidden">
            {visible.map((r) => (
              <li
                key={r.id}
                className="rounded-2xl border border-line bg-surface p-4 shadow-sm"
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-base ${r.bg}`}
                    aria-hidden="true"
                  >
                    {r.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">
                      {r.name}
                      {r.isYou && (
                        <span className="ml-1.5 text-xs font-normal text-muted-fg">
                          (you)
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-fg">
                      {r.department}
                    </span>
                  </span>
                  {r.lead && <RoleChip />}
                </div>
                <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                  {r.email && (
                    <Field label="Email">
                      <EmailLink email={r.email} />
                    </Field>
                  )}
                  {r.workPhone && (
                    <Field label="Phone">
                      <PhoneLink phone={r.workPhone} />
                    </Field>
                  )}
                  {r.telegram && (
                    <Field label="Telegram">
                      <TelegramLink handle={r.telegram} />
                    </Field>
                  )}
                  {r.linkedin && (
                    <Field label="LinkedIn">
                      <LinkedinLink value={r.linkedin} />
                    </Field>
                  )}
                  {r.instagram && (
                    <Field label="Instagram">
                      <InstagramLink handle={r.instagram} />
                    </Field>
                  )}
                  {r.birthdayLabel && (
                    <Field label="Birthday">{r.birthdayLabel}</Field>
                  )}
                </dl>
              </li>
            ))}
          </ul>

          {/* Tablet and up: one row per person so the whole directory reads
              down a column at a time. Still wider than a small tablet, so the
              table scrolls sideways inside this box — and the name column pins
              itself so it stays visible while it does. */}
          <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm md:block">
            <table className="w-full min-w-[58rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-muted-fg">
                  <th
                    scope="col"
                    className="sticky left-0 bg-surface px-4 py-3 shadow-[inset_-1px_0_0_0_var(--color-line)]"
                  >
                    Person
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Department
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Role
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Phone
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Telegram
                  </th>
                  <th scope="col" className="px-4 py-3">
                    LinkedIn
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Instagram
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Birthday
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.id}
                    className="group border-b border-line/60 transition last:border-0 hover:bg-canvas"
                  >
                    {/* The pinned cell needs the row's hover colour of its own —
                        sitting above the others, it can't inherit it. Its right
                        edge, which the scrolling columns slide behind, is an
                        inset shadow rather than a border: `border-collapse:
                        collapse` hands borders to the table to paint, and the
                        table doesn't move with the sticky cell, so a border-r
                        here never shows up. */}
                    <th
                      scope="row"
                      className="sticky left-0 bg-surface px-4 py-3 font-normal shadow-[inset_-1px_0_0_0_var(--color-line)] transition group-hover:bg-canvas"
                    >
                      <span className="flex items-center gap-2.5">
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line text-base ${r.bg}`}
                          aria-hidden="true"
                        >
                          {r.emoji}
                        </span>
                        <span className="font-semibold whitespace-nowrap text-ink">
                          {r.name}
                          {r.isYou && (
                            <span className="ml-1.5 text-xs font-normal text-muted-fg">
                              (you)
                            </span>
                          )}
                        </span>
                      </span>
                    </th>
                    <Cell>{r.department}</Cell>
                    <Cell>
                      {/* The label the whole expectations system keys off:
                          leads owe meetings and weekly/monthly goals, members
                          don't — so leads get the chip, members stay quiet. */}
                      {r.lead ? (
                        <RoleChip />
                      ) : (
                        <span className="text-muted-fg">{ROLE_LABEL.MEMBER}</span>
                      )}
                    </Cell>
                    <Cell>{r.email && <EmailLink email={r.email} />}</Cell>
                    <Cell>
                      {r.workPhone && <PhoneLink phone={r.workPhone} />}
                    </Cell>
                    <Cell>
                      {r.telegram && <TelegramLink handle={r.telegram} />}
                    </Cell>
                    <Cell>
                      {r.linkedin && <LinkedinLink value={r.linkedin} />}
                    </Cell>
                    <Cell>
                      {r.instagram && <InstagramLink handle={r.instagram} />}
                    </Cell>
                    <Cell>{r.birthdayLabel}</Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/**
 * One table cell. Anything falsy — a field nobody filled in — reads as a dash
 * instead of leaving a blank that looks like a rendering fault.
 */
function Cell({ children }: { children?: React.ReactNode }) {
  return (
    <td className="px-4 py-3 whitespace-nowrap text-ink">
      {children || <span className="text-muted-fg">—</span>}
    </td>
  );
}

/** The lead badge — the one role the expectations system keys off. */
function RoleChip() {
  return (
    <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
      {ROLE_LABEL.LEAD}
    </span>
  );
}

/** One labelled line inside a phone card. Only rendered for filled-in fields. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-20 shrink-0 text-xs text-muted-fg">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink">{children}</dd>
    </div>
  );
}

const LINK_CLASS = "text-ink hover:text-brand";

function EmailLink({ email }: { email: string }) {
  return (
    <a href={`mailto:${email}`} className={LINK_CLASS}>
      {email}
    </a>
  );
}

function PhoneLink({ phone }: { phone: string }) {
  return (
    <a href={`tel:${phone}`} className={LINK_CLASS}>
      {phone}
    </a>
  );
}

function TelegramLink({ handle }: { handle: string }) {
  return (
    <a
      href={`https://t.me/${handle}`}
      target="_blank"
      rel="noreferrer"
      className={LINK_CLASS}
    >
      {`@${handle}`}
    </a>
  );
}

function LinkedinLink({ value }: { value: string }) {
  return (
    <a
      href={linkedinUrl(value)}
      target="_blank"
      rel="noreferrer"
      className={LINK_CLASS}
    >
      {value}
    </a>
  );
}

function InstagramLink({ handle }: { handle: string }) {
  return (
    <a
      href={`https://instagram.com/${handle}`}
      target="_blank"
      rel="noreferrer"
      className={LINK_CLASS}
    >
      {`@${handle}`}
    </a>
  );
}
