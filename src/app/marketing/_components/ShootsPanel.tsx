"use client";

import { useState } from "react";
import {
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "../../dashboard/_components/icons";
import {
  MAX_LINK,
  MAX_LOCATION,
  MAX_SHOOT_TITLE,
  SHOOT_STATE,
  type ShootState,
} from "@/lib/marketing";
import { deleteShoot, fileShootReport, planShoot, updateShoot } from "../actions";
import {
  addBtn,
  Archive,
  assigneeOptions,
  ClampedNote,
  byDay,
  ConfirmBar,
  dangerIconBtn,
  EmptyState,
  ErrorText,
  Field,
  ghostBtn,
  GroupLabel,
  iconBtn,
  inputCls,
  linkCls,
  type Member,
  MemberChip,
  PanelHeader,
  primaryBtn,
  RowClock,
  RowList,
  secondaryBtn,
  StatePill,
  useAction,
} from "./ui";

export type ShootRow = {
  id: string;
  title: string;
  location: string;
  note: string | null;
  dateYmd: string;
  timeHm: string;
  /** "10:00 AM" — the row's clock. */
  timeLabel: string;
  /** "Today" / "Tomorrow" / "Wed, 1 Oct" — the day heading it groups under. */
  dayLabel: string;
  state: ShootState;
  assignee: Member | null;
  finishedUrl: string | null;
  rawUrl: string | null;
  reportedLabel: string | null;
  postCount: number;
};

type ShootValues = {
  title: string;
  date: string;
  time: string;
  location: string;
  assigneeId: string | null;
  note: string | null;
};

/** The shoot's editable fields — shared by the composer and the row editor. */
export function ShootForm({
  members,
  initial,
  defaultDate,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  members: Member[];
  initial?: ShootRow;
  defaultDate: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (v: ShootValues) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [date, setDate] = useState(initial?.dateYmd ?? defaultDate);
  const [time, setTime] = useState(initial?.timeHm ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [assigneeId, setAssigneeId] = useState(initial?.assignee?.id ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const ready =
    title.trim() !== "" && date !== "" && time !== "" && location.trim() !== "";
  const options = assigneeOptions(members, initial?.assignee ?? null);

  return (
    <form
      className="rise-in flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || pending) return;
        onSubmit({
          title,
          date,
          time,
          location,
          assigneeId: assigneeId || null,
          note: note.trim() || null,
        });
      }}
    >
      <Field label="What are we shooting?">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Student story — Aziza, reel"
          maxLength={MAX_SHOOT_TITLE}
          autoFocus
          required
          className={inputCls}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className={inputCls}
          />
        </Field>
        <Field label="Time">
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            required
            className={inputCls}
          />
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Location">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Campus studio, room 204"
            maxLength={MAX_LOCATION}
            required
            className={inputCls}
          />
        </Field>
        <Field label="Who's filming">
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className={inputCls}
          >
            <option value="">Nobody yet</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Brief for the creator" optional>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Shot list, who to bring, what to wear…"
          rows={2}
          className={`${inputCls} resize-y`}
        />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-fg">
          {assigneeId
            ? "They’ll be notified now and reminded 24h before."
            : "Assign someone to send them a reminder 24h before."}
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          <button type="button" onClick={onCancel} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" disabled={pending || !ready} className={primaryBtn}>
            {pending ? "Saving…" : submitLabel}
          </button>
        </span>
      </div>
    </form>
  );
}

/** The Drive-link report form, unfolded inside a shoot row. */
function ReportForm({
  shoot,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  shoot: ShootRow;
  pending: boolean;
  error: string | null;
  onSubmit: (v: { finishedUrl: string | null; rawUrl: string | null }) => void;
  onCancel: () => void;
}) {
  const [finished, setFinished] = useState(shoot.finishedUrl ?? "");
  const [raw, setRaw] = useState(shoot.rawUrl ?? "");
  const ready = finished.trim() !== "" || raw.trim() !== "";
  return (
    <form
      className="rise-in mt-2.5 flex flex-col gap-2.5 rounded-lg border border-line bg-canvas p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || pending) return;
        onSubmit({ finishedUrl: finished.trim() || null, rawUrl: raw.trim() || null });
      }}
    >
      <p className="text-xs text-muted-fg">
        Paste the Google Drive links. One is enough to file — add the other when
        it’s ready.
      </p>
      <Field label="Finished content">
        <input
          type="url"
          value={finished}
          onChange={(e) => setFinished(e.target.value)}
          placeholder="https://drive.google.com/…"
          maxLength={MAX_LINK}
          autoFocus
          className={inputCls}
        />
      </Field>
      <Field label="Raw materials">
        <input
          type="url"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="https://drive.google.com/…"
          maxLength={MAX_LINK}
          className={inputCls}
        />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={ghostBtn}>
          Cancel
        </button>
        <button type="submit" disabled={pending || !ready} className={primaryBtn}>
          {pending ? "Saving…" : shoot.state === "reported" ? "Save links" : "File report"}
        </button>
      </div>
    </form>
  );
}

export function ShootItem({
  shoot,
  members,
  clock,
  id,
  highlighted = false,
}: {
  shoot: ShootRow;
  members: Member[];
  /** What the left column shows: the time (under a day heading) or the full date. */
  clock: "time" | "when";
  /** DOM id so the calendar's day card can scroll this row into view. */
  id?: string;
  /** Tinted when its chip was the one clicked on the grid. */
  highlighted?: boolean;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "report" | "delete">("view");
  const { pending, error, setError, run } = useAction();
  const meta = SHOOT_STATE[shoot.state];
  const reported = shoot.state === "reported";
  const toggle = (m: typeof mode) => {
    setError(null);
    setMode(mode === m ? "view" : m);
  };
  const done = () => setMode("view");

  return (
    <li id={id} className={`px-4 py-3${highlighted ? " bg-brand-soft/40" : ""}`}>
      <div className="flex items-start gap-3">
        <RowClock clock={clock} dayLabel={shoot.dayLabel} timeLabel={shoot.timeLabel} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-words text-sm font-semibold text-ink">
              {shoot.title}
            </span>
            {shoot.state !== "upcoming" && <StatePill {...meta} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-fg">
            <span className="break-words">{shoot.location}</span>
            {shoot.assignee ? (
              <MemberChip m={shoot.assignee} />
            ) : (
              <span className="font-medium text-chart-warn">Nobody filming yet</span>
            )}
            {shoot.postCount > 0 && (
              <span>
                {shoot.postCount === 1 ? "1 post planned" : `${shoot.postCount} posts planned`}
              </span>
            )}
          </div>
          {shoot.note && mode !== "edit" && (
            <ClampedNote>{shoot.note}</ClampedNote>
          )}
          {mode !== "report" && (shoot.finishedUrl || shoot.rawUrl || reported) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {shoot.finishedUrl ? (
                <a href={shoot.finishedUrl} target="_blank" rel="noreferrer" className={linkCls}>
                  Finished content ↗
                </a>
              ) : (
                <span className="text-muted-fg">Finished content: not in yet</span>
              )}
              {shoot.rawUrl ? (
                <a href={shoot.rawUrl} target="_blank" rel="noreferrer" className={linkCls}>
                  Raw materials ↗
                </a>
              ) : (
                <span className="text-muted-fg">Raw materials: not in yet</span>
              )}
            </div>
          )}
          {shoot.reportedLabel && (
            <p className="mt-1 text-[11px] text-muted-fg">{shoot.reportedLabel}</p>
          )}
          {shoot.state === "awaiting-report" && mode === "view" && (
            <button type="button" onClick={() => toggle("report")} className={`${primaryBtn} mt-2`}>
              File report
            </button>
          )}
        </div>
        <span className="flex shrink-0 items-center">
          {reported ? (
            <button
              type="button"
              onClick={() => toggle("report")}
              className={`ro:hidden ${secondaryBtn}`}
              aria-expanded={mode === "report"}
            >
              Edit links
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => toggle("edit")}
                title="Edit shoot"
                aria-label={`Edit ${shoot.title}`}
                aria-expanded={mode === "edit"}
                className={`ro:hidden ${iconBtn} ${mode === "edit" ? "bg-canvas text-ink" : ""}`}
              >
                <PencilIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => toggle("delete")}
                title="Call off"
                aria-label={`Call off ${shoot.title}`}
                className={dangerIconBtn}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </>
          )}
        </span>
      </div>

      {mode === "edit" && (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
          <ShootForm
            members={members}
            initial={shoot}
            defaultDate={shoot.dateYmd}
            submitLabel="Save changes"
            pending={pending}
            error={error}
            onCancel={done}
            onSubmit={(v) => run(() => updateShoot(shoot.id, v), done)}
          />
        </div>
      )}

      {mode === "report" && (
        <ReportForm
          shoot={shoot}
          pending={pending}
          error={error}
          onCancel={done}
          onSubmit={(v) => run(() => fileShootReport(shoot.id, v), done)}
        />
      )}

      {mode === "delete" && (
        <>
          <ConfirmBar
            message={`Call off “${shoot.title}”?`}
            detail={
              shoot.postCount > 0
                ? `${shoot.postCount === 1 ? "Its planned post stays" : `Its ${shoot.postCount} planned posts stay`} on the posting calendar, just no longer tied to this shoot.`
                : shoot.assignee
                  ? `${shoot.assignee.name} will be told.`
                  : null
            }
            confirmLabel="Call off"
            pending={pending}
            onConfirm={() => run(() => deleteShoot(shoot.id), done)}
            onCancel={done}
          />
          {error && <div className="mt-1.5"><ErrorText>{error}</ErrorText></div>}
        </>
      )}
    </li>
  );
}

export function ShootsPanel({
  awaiting,
  upcoming,
  reported,
  members,
  todayYmd,
}: {
  awaiting: ShootRow[];
  upcoming: ShootRow[];
  reported: ShootRow[];
  members: Member[];
  todayYmd: string;
}) {
  const [composing, setComposing] = useState(false);
  const { pending, error, setError, run } = useAction();
  const empty = awaiting.length === 0 && upcoming.length === 0;

  return (
    <section id="shoots" className="scroll-mt-6">
      <PanelHeader
        title="Production calendar"
        hint="What gets filmed, when, where and by whom."
      >
        {!composing && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setComposing(true);
            }}
            className={addBtn}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Plan a shoot
          </button>
        )}
      </PanelHeader>

      {composing && (
        <div className="mb-4 rounded-xl border border-line bg-surface p-4 shadow-sm">
          <ShootForm
            members={members}
            defaultDate={todayYmd}
            submitLabel="Add to calendar"
            pending={pending}
            error={error}
            onCancel={() => setComposing(false)}
            onSubmit={(v) => run(() => planShoot(v), () => setComposing(false))}
          />
        </div>
      )}

      {awaiting.length > 0 && (
        <>
          <GroupLabel tone="warn">Filmed — waiting for Drive links</GroupLabel>
          <RowList>
            {awaiting.map((s) => (
              <ShootItem key={s.id} shoot={s} members={members} clock="when" />
            ))}
          </RowList>
        </>
      )}

      {byDay(upcoming).map((g) => (
        <div key={g.label}>
          <GroupLabel>{g.label}</GroupLabel>
          <RowList>
            {g.rows.map((s) => (
              <ShootItem key={s.id} shoot={s} members={members} clock="time" />
            ))}
          </RowList>
        </div>
      ))}

      {empty && !composing && (
        <EmptyState>
          No shoots coming up.{" "}
          <button type="button" onClick={() => setComposing(true)} className={`ro:hidden ${linkCls}`}>
            Plan the next one
          </button>
        </EmptyState>
      )}

      <Archive
        label="Reported shoots"
        items={reported}
        searchText={(s) => `${s.title} ${s.location} ${s.assignee?.name ?? ""}`}
        render={(s) => <ShootItem key={s.id} shoot={s} members={members} clock="when" />}
      />
    </section>
  );
}
