// Who gets the private notepad in the dashboard's right column. Asked for by
// valentina@ (2026-11-17); add more (comma-separated) via the NOTEPAD_EMAILS
// env var, which is also how a dev@ session sees it locally.

const BUILT_IN_NOTEPAD = ["valentina@freshman.academy"];

/** Longest note kept. Plenty for running notes, small enough to load with the page. */
export const NOTEPAD_MAX = 20_000;

/** Every email with a notepad, lowercased. */
export function notepadEmails(): string[] {
  const fromEnv = (process.env.NOTEPAD_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILT_IN_NOTEPAD, ...fromEnv])];
}

/** Whether this account has a notepad (case-insensitive). */
export function hasNotepad(email: string | null | undefined): boolean {
  return !!email && notepadEmails().includes(email.toLowerCase());
}
