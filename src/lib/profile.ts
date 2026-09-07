// Onboarding profile fields collected after the first Google sign-in. A user
// must have all of these before they're allowed onto the dashboard.

export type ProfileFields = {
  name: string | null;
  workPhone: string | null;
  telegramUsername: string | null;
  // At least one department membership is picked at onboarding (see
  // /onboarding); more can be added later on the profile or by admins.
  memberships: unknown[];
};

/**
 * True once every required onboarding field has a non-empty value.
 *
 * Birthday is deliberately NOT one of them, though /onboarding still asks for
 * it. It used to gate this, which made a missing birthday a locked door: the
 * accounts that predate the field — and anyone who never finished setup —
 * were bounced from the dashboard to /onboarding with no way to be told why,
 * and no way to be reached, since every in-app surface lives past that gate.
 * A birthday is a nice-to-have for the team directory, not a credential, so a
 * missing one now nags instead of blocking (see dashboard BirthdayPrompt).
 */
export function isProfileComplete(u: ProfileFields): boolean {
  const textOk = [u.name, u.workPhone, u.telegramUsername].every(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
  return textOk && u.memberships.length > 0;
}

/** Normalize a Telegram handle: trim and drop a single leading "@". */
export function normalizeTelegram(handle: string): string {
  return handle.trim().replace(/^@+/, "");
}

/** Normalize an Instagram handle: trim and drop a single leading "@". */
export function normalizeInstagram(handle: string): string {
  return handle.trim().replace(/^@+/, "");
}

/** Normalize a LinkedIn value: just trim (users may paste a URL or a handle). */
export function normalizeLinkedin(value: string): string {
  return value.trim();
}
