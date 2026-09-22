// Server-only: which accounts may reach the admin panel. tech@freshman.academy
// is always an admin; add more (comma-separated) via the ADMIN_EMAILS env var.

/**
 * The account that owns anything with no other owner — every sign-up alert
 * goes here alongside the department's own lead (see lib/signupAlerts.ts), so
 * a department with no lead, or one who never signs in, still has someone
 * watching its queue.
 */
export const TECH_ADMIN_EMAIL = "tech@freshman.academy";

const BUILT_IN_ADMINS = [
  TECH_ADMIN_EMAIL,
  "valera@freshman.academy",
  "shakhzod@freshman.academy",
  "valentina@freshman.academy",
  "dostonbps@gmail.com",
];

/** Every admin email: the built-ins plus any from ADMIN_EMAILS, lowercased. */
export function adminEmails(): string[] {
  const fromEnv = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILT_IN_ADMINS, ...fromEnv])];
}

/** Whether the given email is allowed into the admin panel (case-insensitive). */
export function isAdmin(email: string | null | undefined): boolean {
  return !!email && adminEmails().includes(email.toLowerCase());
}
