"use client";

import { useRef, useState, useTransition } from "react";
import {
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "../../dashboard/_components/icons";
import { Picker } from "@/app/_components/Picker";
import {
  addMembership,
  createDepartment,
  deleteDepartment,
  removeMembership,
  renameDepartment,
  setDepartmentMini,
  setMembershipRole,
} from "../actions";

export type Person = {
  id: string;
  name: string;
  email: string | null;
  emoji: string;
  bg: string;
  /** The hat worn in THIS department — the same person can lead elsewhere. */
  lead: boolean;
};

export type DepartmentView = {
  id: string;
  name: string;
  /** A mini department: its head owes nothing, and is whoever joined first. */
  mini: boolean;
  people: Person[];
};

/** The pseudo-entry in the rail for people holding no seat anywhere. */
const UNASSIGNED = "__unassigned__";

/**
 * The org board: a department rail on the left, the selected department's
 * roster on the right. The company fits in the rail, so switching costs a
 * click — no scrolling past forty strangers to reach the department you came
 * to edit. Searching narrows the rail by department AND member name.
 */
export function DepartmentManager({
  departments,
  unassigned,
  allPeople,
  currentUserId,
}: {
  departments: DepartmentView[];
  unassigned: Person[];
  allPeople: { id: string; name: string }[];
  currentUserId: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>(
    departments[0]?.id ?? UNASSIGNED,
  );
  // After creating a department, jump to it once the revalidated list lands —
  // resolved during render below, and cleared by the next manual selection.
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const select = (id: string) => {
    setSelected(id);
    setPendingSelect(null);
  };

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (d: DepartmentView) =>
    terms.every(
      (t) =>
        d.name.toLowerCase().includes(t) ||
        d.people.some((p) => p.name.toLowerCase().includes(t)),
    );
  const visible = departments.filter(matches);

  // If the selected department vanished (deleted), land on the first one —
  // and if a search hides it, still show it: selection beats filtering.
  const selectedDept = departments.find((d) => d.id === selected);
  const pendingDept = pendingSelect
    ? departments.find(
        (d) => d.name.toLowerCase() === pendingSelect.toLowerCase(),
      )
    : undefined;
  const activeId =
    selected === UNASSIGNED && !pendingDept
      ? UNASSIGNED
      : (pendingDept ?? selectedDept ?? departments[0])?.id ?? UNASSIGNED;

  const leadSeats = departments.reduce(
    (s, d) => s + d.people.filter((p) => p.lead).length,
    0,
  );
  const seats = departments.reduce((s, d) => s + d.people.length, 0);

  // ↑/↓ walk the rail like a listbox — the selection (and DOM focus) move.
  const railIds = [
    ...visible.map((d) => d.id),
    ...(unassigned.length > 0 ? [UNASSIGNED] : []),
  ];
  const railRef = useRef<HTMLElement>(null);
  function onRailKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // Only when focus is on a rail item — not the composer or search inputs.
    if (
      !(e.target instanceof HTMLElement) ||
      !e.target.hasAttribute("data-rail-id")
    ) {
      return;
    }
    e.preventDefault();
    const i = railIds.indexOf(activeId);
    const next =
      railIds[
        (i + (e.key === "ArrowDown" ? 1 : -1) + railIds.length) %
          railIds.length
      ];
    if (!next) return;
    select(next);
    railRef.current
      ?.querySelector<HTMLElement>(`[data-rail-id="${next}"]`)
      ?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: search over everything + the shape of the org at a glance. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-fg" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter jumps to the first match — search becomes a switcher.
              if (e.key === "Enter" && visible[0]) {
                select(visible[0].id);
                e.currentTarget.select();
              }
            }}
            placeholder="Search departments or people…"
            aria-label="Search departments and people"
            className="w-full rounded-xl border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-fg">
          <StatChip value={departments.length} label="departments" />
          <StatChip value={leadSeats} label="lead seats" />
          <StatChip value={seats} label="seats" />
          {unassigned.length > 0 && (
            <button
              type="button"
              onClick={() => select(UNASSIGNED)}
              className="rounded-full bg-accent-soft px-2.5 py-1 text-accent-ink transition hover:bg-accent-soft/70"
            >
              {unassigned.length} unassigned
            </button>
          )}
        </div>
      </div>

      <div className="grid items-start gap-4 md:grid-cols-[19rem_minmax(0,1fr)]">
        {/* The rail — every department at a glance. On phones it collapses to
            a horizontal strip of chips rather than eating the page. */}
        <aside
          ref={railRef}
          onKeyDown={onRailKeyDown}
          className="rounded-2xl border border-line bg-surface shadow-sm md:sticky md:top-6"
        >
          <NewDepartmentComposer onCreated={setPendingSelect} />
          <ul className="flex gap-1 overflow-x-auto p-2 md:max-h-[32rem] md:flex-col md:overflow-y-auto md:overflow-x-hidden">
            {visible.map((d) => (
              <RailItem
                key={d.id}
                dept={d}
                active={d.id === activeId}
                onSelect={() => select(d.id)}
              />
            ))}
            {visible.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-muted-fg">
                {`Nothing matches “${query.trim()}”.`}
              </li>
            )}
          </ul>
          {unassigned.length > 0 && (
            <div className="border-t border-line p-2">
              <button
                type="button"
                data-rail-id={UNASSIGNED}
                onClick={() => select(UNASSIGNED)}
                className={`flex w-full shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition ${
                  activeId === UNASSIGNED
                    ? "bg-accent-soft"
                    : "hover:bg-canvas"
                }`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-accent-ink/40 text-xs text-accent-ink">
                  ?
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    No department
                  </span>
                  <span className="block truncate text-xs text-muted-fg">
                    waiting to be placed
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold tabular-nums text-accent-ink">
                  {unassigned.length}
                </span>
              </button>
            </div>
          )}
        </aside>

        {/* The focused department — keyed so switching re-enters with rise-in. */}
        <section
          key={activeId}
          className="rise-in flex min-h-80 flex-col rounded-2xl border border-line bg-surface shadow-sm"
        >
          {activeId === UNASSIGNED ? (
            <UnassignedPanel people={unassigned} departments={departments} />
          ) : (
            <DepartmentPanel
              department={departments.find((d) => d.id === activeId)!}
              allPeople={allPeople}
              currentUserId={currentUserId}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function StatChip({ value, label }: { value: number; label: string }) {
  return (
    <span className="whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-1">
      <span className="tabular-nums text-ink">{value}</span> {label}
    </span>
  );
}

/** Three overlapping avatar emojis — the dept's composition at a glance. */
function AvatarStack({ people }: { people: Person[] }) {
  const shown = people.slice(0, 3);
  if (shown.length === 0) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-line text-[10px] text-muted-fg">
        ·
      </span>
    );
  }
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {shown.map((p) => (
        <span
          key={p.id}
          className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface text-xs ${p.bg}`}
          aria-hidden="true"
        >
          {p.emoji}
        </span>
      ))}
    </span>
  );
}

/** One department in the rail. */
function RailItem({
  dept: d,
  active,
  onSelect,
}: {
  dept: DepartmentView;
  active: boolean;
  onSelect: () => void;
}) {
  const leads = d.people.filter((p) => p.lead);
  return (
    <li className="shrink-0 md:shrink">
      <button
        type="button"
        data-rail-id={d.id}
        onClick={onSelect}
        aria-current={active}
        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition ${
          active
            ? "bg-brand-soft shadow-[inset_2px_0_0_0_var(--color-brand)]"
            : "hover:bg-canvas"
        }`}
      >
        <AvatarStack people={d.people} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={`truncate text-sm font-semibold ${active ? "text-brand" : "text-ink"}`}
            >
              {d.name}
            </span>
            {d.mini && <MiniBadge />}
          </span>
          <span className="block truncate text-xs text-muted-fg">
            {leads.length > 0
              ? `${d.mini ? "Head" : "Lead"}: ${leads.map((l) => l.name.split(" ")[0]).join(", ")}`
              : d.mini
                ? "Runs itself"
                : "No lead yet"}
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-fg">
          {d.people.length}
        </span>
      </button>
    </li>
  );
}

function MiniBadge() {
  return (
    <span
      className="shrink-0 rounded-full bg-canvas px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-fg"
      title="Mini department — its head owes no meeting and no weekly submission, so no fines, and the first person to join a headless one leads it."
    >
      Mini
    </span>
  );
}

/** The rail's top row: a button that unfolds into the create form. */
function NewDepartmentComposer({
  onCreated,
}: {
  onCreated: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const value = name.trim();
    if (!value) return;
    setError(null);
    startTransition(async () => {
      try {
        await createDepartment(value);
        setName("");
        setOpen(false);
        onCreated(value);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't add it.");
      }
    });
  }

  return (
    <div className="border-b border-line p-2">
      {open ? (
        <div className="rise-in">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder="e.g. Design"
              maxLength={60}
              autoFocus
              className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
            />
            <button
              type="button"
              disabled={isPending || name.trim() === ""}
              onClick={submit}
              className="shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Cancel"
              className="shrink-0 rounded-lg p-1.5 text-muted-fg transition hover:bg-canvas hover:text-ink"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {error && <p className="mt-1.5 px-1 text-xs text-red-600">{error}</p>}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-xs font-semibold text-muted-fg transition hover:border-brand hover:text-brand"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New department
        </button>
      )}
    </div>
  );
}

/** The selected department: header actions, roster, add-person picker. */
function DepartmentPanel({
  department: d,
  allPeople,
  currentUserId,
}: {
  department: DepartmentView;
  allPeople: { id: string; name: string }[];
  currentUserId: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(d.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const leads = d.people.filter((p) => p.lead);
  const seated = new Set(d.people.map((p) => p.id));
  const addable = allPeople.filter((p) => !seated.has(p.id));

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn't work.");
      }
    });
  }

  function saveRename() {
    const value = name.trim();
    if (!value || value === d.name) {
      setRenaming(false);
      setName(d.name);
      return;
    }
    run(async () => {
      await renameDepartment(d.id, value);
      setRenaming(false);
    });
  }

  return (
    <>
      {/* Header: name (click the pencil to rename in place), the meta line,
          and the three department verbs tucked into quiet controls. */}
      <header className="shrink-0 border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {renaming ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveRename();
                  if (e.key === "Escape") {
                    setRenaming(false);
                    setName(d.name);
                  }
                }}
                onBlur={saveRename}
                maxLength={60}
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1 text-base font-bold text-ink focus:border-brand focus:outline-none"
              />
            </span>
          ) : (
            <h2 className="flex min-w-0 items-center gap-2 text-base font-bold text-ink">
              <span className="truncate">{d.name}</span>
              {d.mini && <MiniBadge />}
            </h2>
          )}
          <span className="text-xs tabular-nums text-muted-fg">
            {d.people.length} {d.people.length === 1 ? "seat" : "seats"}
          </span>
          <span className="ms-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setRenaming(true)}
              aria-label={`Rename ${d.name}`}
              title="Rename"
              className="rounded-lg p-1.5 text-muted-fg transition hover:bg-canvas hover:text-ink"
            >
              <PencilIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => setDepartmentMini(d.id, !d.mini))}
              title={
                d.mini
                  ? "Make it a full department — its lead takes on the Monday meeting and the weekly deadline."
                  : "Make it a mini department — its lead stops owing the Monday meeting and the weekly deadline."
              }
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${
                d.mini
                  ? "border-line text-muted-fg hover:bg-canvas hover:text-ink"
                  : "border-line text-muted-fg hover:bg-canvas hover:text-ink"
              }`}
            >
              {d.mini ? "Make full" : "Make mini"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              aria-label={`Delete ${d.name}`}
              title="Delete department"
              className="rounded-lg p-1.5 text-muted-fg transition hover:bg-red-500/10 hover:text-red-600"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-fg">
          {leads.length > 0 ? (
            `${d.mini ? "Head" : "Lead"}: ${leads.map((l) => l.name).join(", ")}`
          ) : d.mini ? (
            "No head yet — the first to join becomes it"
          ) : (
            <span className="font-medium text-accent-ink">No lead yet</span>
          )}
          {d.mini && leads.length > 0 && " · owes nothing"}
        </p>

        {/* Inline delete confirm — no modal, the context stays visible. */}
        {confirmingDelete && (
          <div className="rise-in mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
            <span className="font-medium text-red-600">
              {d.people.length > 0
                ? `Delete ${d.name}? ${d.people.length} ${d.people.length === 1 ? "seat goes" : "seats go"} away — the people keep their accounts and other departments.`
                : `Delete ${d.name}?`}
            </span>
            <span className="ms-auto flex items-center gap-1.5">
              <button
                type="button"
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => void (await deleteDepartment(d.id)))
                }
                className="rounded-lg bg-red-500 px-2.5 py-1 font-semibold text-white transition hover:bg-red-600 disabled:opacity-50"
              >
                {isPending ? "Deleting…" : "Delete"}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => setConfirmingDelete(false)}
                className="rounded-lg px-2 py-1 font-medium text-muted-fg transition hover:bg-canvas"
              >
                Cancel
              </button>
            </span>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </header>

      {/* Roster. Member verbs stay hidden until the row is hovered (always
          shown on touch, where there's no hover). */}
      <div className="flex-1 overflow-y-auto">
        {d.people.length > 0 ? (
          <ul className="flex flex-col py-1.5">
            {d.people.map((p) => (
              <MemberRow
                key={p.id}
                person={p}
                departmentId={d.id}
                mini={d.mini}
                isSelf={p.id === currentUserId}
              />
            ))}
          </ul>
        ) : (
          <p className="m-5 rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted-fg">
            Nobody here yet — add people below, or let new joiners pick it at
            onboarding.
          </p>
        )}
      </div>

      {addable.length > 0 && (
        <footer className="shrink-0 border-t border-line px-5 py-3">
          <Picker
            buttonLabel={`Add someone to ${d.name}`}
            searchPlaceholder="Type a name…"
            items={addable.map((p) => ({ id: p.id, label: p.name }))}
            onPick={(id) => run(() => addMembership(id, d.id))}
            disabled={isPending}
          />
        </footer>
      )}
    </>
  );
}

/** One seat in the roster — hover (or touch) reveals the per-seat verbs. */
function MemberRow({
  person: p,
  departmentId,
  mini,
  isSelf,
}: {
  person: Person;
  departmentId: string;
  mini: boolean;
  isSelf: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn't work.");
      }
    });
  }

  return (
    <li className="group flex items-center gap-3 px-5 py-2 transition hover:bg-canvas">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line text-base ${p.bg}`}
        aria-hidden="true"
      >
        {p.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          <span className="truncate" title={p.email ?? undefined}>
            {p.name}
          </span>
          {isSelf && (
            <span className="shrink-0 text-xs font-normal text-muted-fg">
              (you)
            </span>
          )}
          {p.lead && (
            <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">
              {mini ? "Head" : "Dep. lead"}
            </span>
          )}
        </span>
        {error && <span className="block text-xs text-red-600">{error}</span>}
      </span>

      <span className="flex shrink-0 items-center gap-1 transition md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
        {/* Flip the hat worn in THIS department only. */}
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            run(() =>
              setMembershipRole(p.id, departmentId, p.lead ? "MEMBER" : "LEAD"),
            )
          }
          title={
            p.lead
              ? "Member here: no expectations from this seat"
              : "Lead here: expected at Monday meetings and to submit weekly/monthly goals"
          }
          className="whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-1 text-[11px] font-semibold text-muted-fg transition hover:border-brand hover:text-brand disabled:opacity-50"
        >
          {p.lead ? "Make member" : "Make lead"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(() => removeMembership(p.id, departmentId))}
          title="Remove from this department (their other departments stay)"
          aria-label={`Remove ${p.name} from this department`}
          className="rounded-lg p-1.5 text-muted-fg transition hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </span>
    </li>
  );
}

/** People with no seat — place each via a department picker. */
function UnassignedPanel({
  people,
  departments,
}: {
  people: Person[];
  departments: DepartmentView[];
}) {
  return (
    <>
      <header className="shrink-0 border-b border-line px-5 py-4">
        <h2 className="text-base font-bold text-ink">No department</h2>
        <p className="mt-1 text-xs text-muted-fg">
          Mid-onboarding, or their departments were deleted — place them.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto">
        <ul className="flex flex-col py-1.5">
          {people.map((p) => (
            <UnassignedRow key={p.id} person={p} departments={departments} />
          ))}
        </ul>
      </div>
    </>
  );
}

function UnassignedRow({
  person: p,
  departments,
}: {
  person: Person;
  departments: DepartmentView[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <li className="group flex items-center gap-3 px-5 py-2 transition hover:bg-canvas">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line text-base ${p.bg}`}
        aria-hidden="true"
      >
        {p.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {p.name}
        </span>
        {error && <span className="block text-xs text-red-600">{error}</span>}
      </span>
      <Picker
        buttonLabel="Add to department…"
        searchPlaceholder="Type a department…"
        align="right"
        side="down"
        items={departments.map((d) => ({ id: d.id, label: d.name }))}
        disabled={isPending}
        onPick={(deptId) => {
          setError(null);
          startTransition(async () => {
            try {
              await addMembership(p.id, deptId);
            } catch (err) {
              setError(
                err instanceof Error ? err.message : "That didn't work.",
              );
            }
          });
        }}
      />
    </li>
  );
}

