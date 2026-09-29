"use client";

import { useState } from "react";
import {
  CheckCircleIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "../../dashboard/_components/icons";
import {
  MAX_LINK,
  MAX_POST_CAPTION,
  MAX_POST_TITLE,
  POST_PLATFORM_LABEL,
  POST_PLATFORMS,
  POST_STATE,
  type PostPlatform,
  type PostState,
} from "@/lib/marketing";
import {
  deletePost,
  markPostPublished,
  schedulePost,
  unpublishPost,
  updatePost,
} from "../actions";
import {
  addBtn,
  Archive,
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
  PanelHeader,
  primaryBtn,
  RowClock,
  RowList,
  secondaryBtn,
  StatePill,
  useAction,
} from "./ui";

export type PostRow = {
  id: string;
  title: string;
  dateYmd: string;
  timeHm: string;
  timeLabel: string;
  dayLabel: string;
  state: PostState;
  platforms: PostPlatform[];
  caption: string | null;
  postUrl: string | null;
  shoot: { id: string; title: string; finishedUrl: string | null } | null;
  publishedLabel: string | null;
};

export type ShootOption = { id: string; label: string };

type PostValues = {
  title: string;
  date: string;
  time: string;
  platforms: PostPlatform[];
  caption: string | null;
  shootId: string | null;
};

function PostForm({
  shootOptions,
  initial,
  defaultDate,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  shootOptions: ShootOption[];
  initial?: PostRow;
  defaultDate: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (v: PostValues) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [date, setDate] = useState(initial?.dateYmd ?? defaultDate);
  const [time, setTime] = useState(initial?.timeHm ?? "");
  const [platforms, setPlatforms] = useState<PostPlatform[]>(initial?.platforms ?? []);
  const [caption, setCaption] = useState(initial?.caption ?? "");
  const [shootId, setShootId] = useState(initial?.shoot?.id ?? "");
  const ready = title.trim() !== "" && date !== "" && time !== "";

  // The linked shoot may have aged out of the picker's window — keep it
  // selectable so saving an unrelated edit doesn't silently unlink it.
  const options =
    initial?.shoot && !shootOptions.some((o) => o.id === initial.shoot!.id)
      ? [{ id: initial.shoot.id, label: initial.shoot.title }, ...shootOptions]
      : shootOptions;

  const toggle = (p: PostPlatform) =>
    setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

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
          platforms,
          caption: caption.trim() || null,
          shootId: shootId || null,
        });
      }}
    >
      <Field label="What's going out?">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Open day reel"
          maxLength={MAX_POST_TITLE}
          autoFocus
          required
          className={inputCls}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Publish date">
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
      <fieldset className="min-w-0">
        <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
          Channels
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {POST_PLATFORMS.map((p) => {
            const on = platforms.includes(p);
            return (
              <button
                key={p}
                type="button"
                onClick={() => toggle(p)}
                aria-pressed={on}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  on
                    ? "border-brand bg-brand-soft text-brand"
                    : "border-line text-muted-fg hover:border-brand hover:text-ink"
                }`}
              >
                {POST_PLATFORM_LABEL[p]}
              </button>
            );
          })}
        </div>
      </fieldset>
      <Field label="From which shoot" optional>
        <select
          value={shootId}
          onChange={(e) => setShootId(e.target.value)}
          className={inputCls}
        >
          <option value="">Not from a shoot</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Caption / brief" optional>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="The caption, hashtags, or what whoever posts it needs to know"
          maxLength={MAX_POST_CAPTION}
          rows={3}
          className={`${inputCls} resize-y`}
        />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={ghostBtn}>
          Cancel
        </button>
        <button type="submit" disabled={pending || !ready} className={primaryBtn}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Mark it published — with the live link if there is one to hand. */
function PublishForm({
  post,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  post: PostRow;
  pending: boolean;
  error: string | null;
  onSubmit: (url: string | null) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(post.postUrl ?? "");
  const out = post.state === "out";
  return (
    <form
      className="rise-in mt-2.5 flex flex-col gap-2.5 rounded-lg border border-line bg-canvas p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending) onSubmit(url.trim() || null);
      }}
    >
      <Field label="Link to the live post" optional>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://instagram.com/p/…"
          maxLength={MAX_LINK}
          autoFocus
          className={inputCls}
        />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={ghostBtn}>
          Cancel
        </button>
        <button type="submit" disabled={pending} className={primaryBtn}>
          {pending ? "Saving…" : out ? "Save link" : "Mark published"}
        </button>
      </div>
    </form>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked (insecure origin / permissions) — the caption is
          // still on screen to select by hand.
        }
      }}
      className={linkCls}
    >
      {copied ? "Copied" : "Copy caption"}
    </button>
  );
}

function PostItem({
  post,
  shootOptions,
  clock,
}: {
  post: PostRow;
  shootOptions: ShootOption[];
  clock: "time" | "when";
}) {
  const [mode, setMode] = useState<"view" | "edit" | "publish" | "delete">("view");
  const [showCaption, setShowCaption] = useState(false);
  const { pending, error, setError, run } = useAction();
  const out = post.state === "out";
  const toggle = (m: typeof mode) => {
    setError(null);
    setMode(mode === m ? "view" : m);
  };
  const done = () => setMode("view");

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <RowClock clock={clock} dayLabel={post.dayLabel} timeLabel={post.timeLabel} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-words text-sm font-semibold text-ink">{post.title}</span>
            {post.state !== "scheduled" && <StatePill {...POST_STATE[post.state]} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {post.platforms.length > 0 ? (
              post.platforms.map((p) => (
                <span
                  key={p}
                  className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-medium text-ink"
                >
                  {POST_PLATFORM_LABEL[p]}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-fg">No channel picked</span>
            )}
          </div>
          {(post.shoot || post.postUrl || post.caption) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-fg">
              {post.shoot && (
                <span className="min-w-0 break-words">
                  From “{post.shoot.title}”
                  {post.shoot.finishedUrl && (
                    <>
                      {" · "}
                      <a href={post.shoot.finishedUrl} target="_blank" rel="noreferrer" className={linkCls}>
                        Finished content ↗
                      </a>
                    </>
                  )}
                </span>
              )}
              {post.postUrl && (
                <a href={post.postUrl} target="_blank" rel="noreferrer" className={linkCls}>
                  View live post ↗
                </a>
              )}
              {post.caption && (
                <button
                  type="button"
                  onClick={() => setShowCaption((v) => !v)}
                  aria-expanded={showCaption}
                  className={linkCls}
                >
                  {showCaption ? "Hide caption" : "Caption"}
                </button>
              )}
            </div>
          )}
          {post.caption && showCaption && (
            <div className="rise-in mt-1.5 rounded-lg bg-canvas p-2.5 text-xs">
              <p className="whitespace-pre-wrap break-words text-ink">{post.caption}</p>
              <div className="mt-1.5">
                <CopyButton text={post.caption} />
              </div>
            </div>
          )}
          {post.publishedLabel && (
            <p className="mt-1 text-[11px] text-muted-fg">{post.publishedLabel}</p>
          )}
          {!out && mode === "view" && (
            <button
              type="button"
              onClick={() => toggle("publish")}
              className={`${post.state === "overdue" ? primaryBtn : secondaryBtn} mt-2`}
            >
              <CheckCircleIcon className="h-3.5 w-3.5" />
              Mark published
            </button>
          )}
        </div>
        <span className="flex shrink-0 items-center">
          {out ? (
            <>
              <button
                type="button"
                onClick={() => toggle("publish")}
                className={secondaryBtn}
                aria-expanded={mode === "publish"}
              >
                {post.postUrl ? "Edit link" : "Add link"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => unpublishPost(post.id))}
                title="Not actually out — put it back on the calendar"
                className={ghostBtn}
              >
                Undo
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => toggle("edit")}
                title="Edit post"
                aria-label={`Edit ${post.title}`}
                aria-expanded={mode === "edit"}
                className={`${iconBtn} ${mode === "edit" ? "bg-canvas text-ink" : ""}`}
              >
                <PencilIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => toggle("delete")}
                title="Remove from calendar"
                aria-label={`Remove ${post.title}`}
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
          <PostForm
            shootOptions={shootOptions}
            initial={post}
            defaultDate={post.dateYmd}
            submitLabel="Save changes"
            pending={pending}
            error={error}
            onCancel={done}
            onSubmit={(v) => run(() => updatePost(post.id, v), done)}
          />
        </div>
      )}

      {mode === "publish" && (
        <PublishForm
          post={post}
          pending={pending}
          error={error}
          onCancel={done}
          onSubmit={(url) => run(() => markPostPublished(post.id, { postUrl: url }), done)}
        />
      )}

      {mode === "delete" && (
        <ConfirmBar
          message={`Remove “${post.title}” from the calendar?`}
          confirmLabel="Remove"
          pending={pending}
          onConfirm={() => run(() => deletePost(post.id), done)}
          onCancel={done}
        />
      )}

      {error && mode !== "edit" && mode !== "publish" && (
        <div className="mt-1.5">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </li>
  );
}

export function PostsPanel({
  overdue,
  scheduled,
  published,
  shootOptions,
  todayYmd,
}: {
  overdue: PostRow[];
  scheduled: PostRow[];
  published: PostRow[];
  shootOptions: ShootOption[];
  todayYmd: string;
}) {
  const [composing, setComposing] = useState(false);
  const { pending, error, setError, run } = useAction();
  const empty = overdue.length === 0 && scheduled.length === 0;

  return (
    <section id="posts" className="scroll-mt-6">
      <PanelHeader title="Posting calendar" hint="What goes out, on which channels, and when.">
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
            Schedule a post
          </button>
        )}
      </PanelHeader>

      {composing && (
        <div className="mb-4 rounded-xl border border-line bg-surface p-4 shadow-sm">
          <PostForm
            shootOptions={shootOptions}
            defaultDate={todayYmd}
            submitLabel="Add to calendar"
            pending={pending}
            error={error}
            onCancel={() => setComposing(false)}
            onSubmit={(v) => run(() => schedulePost(v), () => setComposing(false))}
          />
        </div>
      )}

      {overdue.length > 0 && (
        <>
          <GroupLabel tone="bad">Past its time — not marked published</GroupLabel>
          <RowList>
            {overdue.map((p) => (
              <PostItem key={p.id} post={p} shootOptions={shootOptions} clock="when" />
            ))}
          </RowList>
        </>
      )}

      {byDay(scheduled).map((g) => (
        <div key={g.label}>
          <GroupLabel>{g.label}</GroupLabel>
          <RowList>
            {g.rows.map((p) => (
              <PostItem key={p.id} post={p} shootOptions={shootOptions} clock="time" />
            ))}
          </RowList>
        </div>
      ))}

      {empty && !composing && (
        <EmptyState>
          Nothing scheduled.{" "}
          <button type="button" onClick={() => setComposing(true)} className={linkCls}>
            Schedule a post
          </button>
        </EmptyState>
      )}

      <Archive
        label="Published"
        items={published}
        searchText={(p) =>
          `${p.title} ${p.caption ?? ""} ${p.platforms.map((x) => POST_PLATFORM_LABEL[x]).join(" ")}`
        }
        render={(p) => <PostItem key={p.id} post={p} shootOptions={shootOptions} clock="when" />}
      />
    </section>
  );
}
