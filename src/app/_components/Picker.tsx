"use client";

import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "../dashboard/_components/icons";

/**
 * A button that opens a little searchable menu — replaces the bare <select>
 * so picking from 40 people or 7 departments is a two-keystroke job. Closes
 * on Escape, on outside click, and after a pick.
 */
export function Picker({
  buttonLabel,
  searchPlaceholder,
  items,
  onPick,
  disabled,
  align = "left",
  side = "up",
}: {
  buttonLabel: string;
  searchPlaceholder: string;
  items: { id: string; label: string }[];
  onPick: (id: string) => void;
  disabled?: boolean;
  align?: "left" | "right";
  /** `down` for pickers inside the scrollable roster — up would clip. */
  side?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = items.filter((i) =>
    i.label.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v);
          setQ("");
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-xs font-semibold text-muted-fg transition hover:border-brand hover:text-brand disabled:opacity-50"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {buttonLabel}
      </button>
      {open && (
        <div
          className={`pop-in absolute z-20 w-64 rounded-xl border border-line bg-surface p-2 shadow-lg ${
            side === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          } ${align === "right" ? "right-0" : "left-0"}`}
          style={{
            ["--pop-origin" as string]:
              side === "up" ? "bottom left" : "top left",
          }}
          role="listbox"
        >
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            autoFocus
            className="mb-1.5 w-full rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink placeholder:text-muted-fg focus:border-brand focus:outline-none"
          />
          <ul className="max-h-56 overflow-y-auto">
            {shown.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    setOpen(false);
                    onPick(i.id);
                  }}
                  className="w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink transition hover:bg-canvas"
                >
                  {i.label}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-2.5 py-2 text-xs text-muted-fg">
                No matches.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
