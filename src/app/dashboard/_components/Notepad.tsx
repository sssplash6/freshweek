"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { NOTEPAD_MAX } from "@/lib/notepad";
import { saveNotepad } from "../actions";

// The card renders twice (right column from xl up, inline below it) with CSS
// picking one, so the text lives here rather than in either copy: resize the
// window mid-note and the other copy shows the same words instead of the
// page-load ones it would then save over them.
let shared: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const setShared = (v: string) => {
  shared = v;
  listeners.forEach((l) => l());
};

type Status = "idle" | "saving" | "saved" | "error";

/** A private notepad that saves itself a moment after typing stops. */
export function Notepad({ initial }: { initial: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => shared ?? initial,
    () => initial,
  );
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedText = useRef(initial);

  async function save(v: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (v === savedText.current) return;
    setStatus("saving");
    try {
      const result = await saveNotepad(v);
      if (result.ok) {
        savedText.current = v;
        setStatus("saved");
        setError(null);
      } else {
        setStatus("error");
        setError(result.error);
      }
    } catch {
      setStatus("error");
      setError("Couldn't save. Check your connection; it will retry as you type.");
    }
  }

  function onChange(v: string) {
    setShared(v);
    setStatus("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(v), 800);
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">Notes</p>
        <span className="text-[11px] font-medium text-muted-fg" aria-live="polite">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => save(e.target.value)}
        maxLength={NOTEPAD_MAX}
        rows={12}
        placeholder="Anything to remember. Only you can see this."
        aria-label="Notes"
        className="mt-2 block w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
      />
      {status === "error" && error && (
        <p className="mt-1.5 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
