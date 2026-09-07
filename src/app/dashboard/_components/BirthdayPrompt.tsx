"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "@/lib/useModalFocus";
import { saveBirthday } from "../actions";

/**
 * Asks the people whose birthday we never got.
 *
 * It used to be impossible to be here: a missing birthday held the dashboard
 * shut (see lib/profile.ts), so the accounts that predate the field sat at
 * /onboarding instead of being asked. Now they're let in and asked once, where
 * everyone already lands.
 *
 * It opens by itself, once. Dismissing is allowed — a nice-to-have field is no
 * reason to wall someone out of their own dashboard — but is deliberately not
 * remembered anywhere but this tab, so the ask comes back on the next visit
 * and stops for good the moment the date lands.
 *
 * Same shape as the payroll PaymentDetailsPrompt, deliberately: one modal that
 * shows itself, falling back to a banner that stays put once waved away.
 */
// Nothing to subscribe to: the value is read once per mount, and every change
// to it is made by this component, which re-renders on its own state anyway.
const NEVER_CHANGES = () => () => {};

const KEY = "birthday-prompt";

export function BirthdayPrompt({ maxYmd }: { maxYmd: string }) {
  // "Have they already waved this away in this tab?" — read through
  // useSyncExternalStore rather than an effect, so the server render (which
  // has no sessionStorage) says "yes, stay shut" and hydration matches the
  // HTML instead of flashing a modal into it.
  const waved = useSyncExternalStore(
    NEVER_CHANGES,
    () => {
      try {
        return sessionStorage.getItem(KEY) === "1";
      } catch {
        // Private mode and the like — worst case the prompt asks again.
        return false;
      }
    },
    () => true,
  );

  const [closed, setClosed] = useState(false);
  const [reopened, setReopened] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);

  const open = !done && (reopened || (!waved && !closed));
  useModalFocus(open, boxRef);

  function close() {
    try {
      sessionStorage.setItem(KEY, "1");
    } catch {
      // As above — a failed write only costs another ask.
    }
    setReopened(false);
    setClosed(true);
  }

  function submit() {
    if (!value) {
      setError("Pick a date first.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveBirthday(value);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setDone(true);
      } catch {
        setError("Couldn't save that — try again.");
      }
    });
  }

  // The banner stays after a dismissal, so the ask is never fully gone — it
  // just stops being a wall. It disappears for good once the date is in.
  const banner = done ? null : (
    <button
      type="button"
      onClick={() => setReopened(true)}
      className="rise-in mb-5 flex w-full items-center gap-3 rounded-xl border border-line bg-brand-soft px-4 py-3 text-left transition hover:brightness-[0.98]"
    >
      <span className="text-lg" aria-hidden="true">
        🎂
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">
          We don&rsquo;t have your birthday yet
        </span>
        <span className="block text-xs text-muted-fg">
          Add it so the team knows when to celebrate.
        </span>
      </span>
      <span className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">
        Add it
      </span>
    </button>
  );

  return (
    <>
      {banner}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
            onClick={() => !isPending && close()}
            role="dialog"
            aria-modal="true"
            aria-label="Add your birthday"
          >
            <div
              ref={boxRef}
              className="modal-in flex max-h-[85vh] w-full max-w-sm flex-col overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-2xl" aria-hidden="true">
                🎂
              </div>
              <h2 className="mt-2 text-base font-bold text-ink">
                When&rsquo;s your birthday?
              </h2>
              <p className="mt-1 text-sm text-muted-fg">
                Yours is the one missing from the team directory. It&rsquo;s
                only so your teammates know when to celebrate — nothing else
                reads it.
              </p>

              <label className="mt-4 flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-fg">
                  Birthday
                </span>
                <input
                  type="date"
                  value={value}
                  max={maxYmd}
                  onChange={(e) => setValue(e.target.value)}
                  className="rounded-lg border border-line px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
                />
              </label>

              {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={close}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-muted-fg transition hover:bg-line"
                >
                  Not now
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={submit}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
                >
                  {isPending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
