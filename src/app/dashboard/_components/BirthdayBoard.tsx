/**
 * The sidebar's birthday day.
 *
 * On any day a teammate is having a birthday, this appears in the dashboard's
 * right sidebar — and only then, because a birthday reduced to a quiet line in
 * a list is a birthday nobody notices. It comes with the one thing the moment
 * actually needs: a way to say it, straight through to their Telegram.
 *
 * No ages. The stored birthday is a whole date, so a year is sitting right
 * there, and publishing someone's age to the company is not what they filled
 * the field in for.
 */
export type BirthdayPerson = {
  id: string;
  /** Falls back to the email local-part upstream; never empty. */
  name: string;
  emoji: string;
  /** The avatar's tint class, from lib/avatar.ts. */
  bg: string;
  /** Telegram handle without the "@", when they've given one. */
  telegram: string | null;
  isYou: boolean;
};

/**
 * Confetti, hand-placed. Deterministic on purpose: random offsets would differ
 * between the server and client renders, and the fix (place them after mount)
 * costs a visible pop for decoration nobody is waiting on.
 *
 * Mid-tone palette colours rather than theme tokens — every token in this app
 * means something (navy acts, orange progresses, the guide hues name a
 * document) and confetti means nothing. These sit fine on both the light and
 * dark card, which is all decoration has to do.
 */
const CONFETTI: { left: string; top: string; rotate: string; className: string }[] = [
  { left: "8%", top: "14%", rotate: "-18deg", className: "h-2 w-1 bg-accent" },
  { left: "22%", top: "6%", rotate: "24deg", className: "h-1.5 w-1.5 rounded-full bg-pink-400" },
  { left: "37%", top: "17%", rotate: "8deg", className: "h-2 w-1 bg-brand" },
  { left: "62%", top: "8%", rotate: "-32deg", className: "h-2 w-1 bg-emerald-400" },
  { left: "78%", top: "16%", rotate: "14deg", className: "h-1.5 w-1.5 rounded-full bg-accent" },
  { left: "89%", top: "7%", rotate: "-8deg", className: "h-2 w-1 bg-sky-400" },
  { left: "14%", top: "34%", rotate: "40deg", className: "h-1.5 w-1.5 rounded-full bg-violet-400" },
  { left: "84%", top: "36%", rotate: "-24deg", className: "h-2 w-1 bg-pink-400" },
];

function Confetti() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {CONFETTI.map((c, i) => (
        <span
          key={i}
          className={`absolute opacity-70 ${c.className}`}
          style={{ left: c.left, top: c.top, rotate: c.rotate }}
        />
      ))}
    </div>
  );
}

/** The navy pill that opens a Telegram chat — the one action the card offers. */
function WishButton({
  handle,
  size = "md",
}: {
  handle: string;
  size?: "md" | "sm";
}) {
  return (
    <a
      href={`https://t.me/${handle}`}
      target="_blank"
      rel="noreferrer"
      className={
        size === "md"
          ? "mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-brand-dark"
          : "shrink-0 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-brand-dark"
      }
    >
      {size === "md" ? "🎉 Wish them" : "Wish"}
    </a>
  );
}

export function BirthdayBoard({ people }: { people: BirthdayPerson[] }) {
  if (people.length === 0) return null;
  const single = people.length === 1;

  return (
    <div>
      <h2 className="px-1 text-xs font-semibold uppercase tracking-widest text-muted-fg">
        {single ? "Birthday" : "Birthdays"}
      </h2>

      <div className="relative mt-3 overflow-hidden rounded-xl border border-line bg-surface">
        {/* A warm wash fading into the card, rather than a tinted slab: the
            festive part stays at the top where the cake is, and the text below
            keeps the plain surface it needs to stay readable in both themes.
            It fades to `surface` (the card's own colour) rather than to
            transparent — a gradient interpolating to transparent picks up a
            grey haze on the way in some engines. */}
        <div
          aria-hidden="true"
          className={`absolute inset-x-0 top-0 bg-gradient-to-b from-accent-soft to-surface ${
            single ? "h-28" : "h-16"
          }`}
        />
        <Confetti />

        {single ? (
          <div className="relative px-4 pb-4 pt-5 text-center">
            <div className="relative inline-block">
              <span
                aria-hidden="true"
                className={`grid h-16 w-16 place-items-center rounded-full text-3xl shadow-sm ring-2 ring-surface ${people[0].bg}`}
              >
                {people[0].emoji}
              </span>
              <span
                aria-hidden="true"
                className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full bg-surface text-base shadow-sm ring-1 ring-line"
              >
                🎂
              </span>
            </div>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-accent-ink">
              Happy birthday
            </p>
            <p className="mt-1 break-words text-[15px] font-bold leading-snug text-ink">
              {people[0].isYou ? "You" : people[0].name}
            </p>
            <p className="mt-1.5 text-xs text-muted-fg">
              {people[0].isYou
                ? "Hope it’s a good one."
                : "It’s their day — say something."}
            </p>
            {!people[0].isYou && people[0].telegram && (
              <WishButton handle={people[0].telegram} />
            )}
          </div>
        ) : (
          <div className="relative px-3.5 pb-3 pt-4">
            <p className="text-center text-[11px] font-semibold uppercase tracking-widest text-accent-ink">
              {`${people.length} birthdays today`}
            </p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {people.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2.5 rounded-lg bg-canvas px-2 py-1.5"
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-lg ring-1 ring-surface ${p.bg}`}
                  >
                    {p.emoji}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                    {p.isYou ? "You" : p.name}
                  </span>
                  {!p.isYou && p.telegram && (
                    <WishButton handle={p.telegram} size="sm" />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
