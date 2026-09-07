// Whose birthday it is today.
//
// A birthday is stored as a whole calendar day at UTC midnight (the date-only
// convention in lib/dates.ts), but only its month and day are ever compared
// here: the year is nobody's business, and no age is derived or shown.
//
// "Today" is the company's Tashkent day rather than the viewer's, so the whole
// team celebrates on the same date — a teammate opening the dashboard from
// another timezone sees the day the office is having, not their own.

/** Leap year by the full Gregorian rule (2000 counts, 1900 doesn't). */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Does a birthday stored as `birthdayYmd` fall on the calendar day `todayYmd`?
 * Both are "YYYY-MM-DD".
 *
 * A 29 February birthday has no date to land on in three years out of four, so
 * in the years that skip it we celebrate on 1 March — a leap-day teammate gets
 * a birthday every year like everyone else, rather than one in four.
 */
export function celebratesOn(birthdayYmd: string, todayYmd: string): boolean {
  const born = birthdayYmd.slice(5);
  const today = todayYmd.slice(5);
  if (born === today) return true;
  return (
    born === "02-29" &&
    today === "03-01" &&
    !isLeapYear(Number(todayYmd.slice(0, 4)))
  );
}
