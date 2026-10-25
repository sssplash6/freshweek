import path from "node:path";

// The internal guides published on /guidelines. Content mirrors each PDF's own
// cover block (title, purpose line, version, owner, approver) and its numbered
// section list, so the page reads as a shelf of the real documents rather than a
// list of download links.
//
// Adding a guide: drop the PDF in private/guidelines (NOT public/ — see below),
// add an entry here with its section list, and pick a tone that isn't already
// taken in its group.

/** Which accent identifies the document — see the guide tokens in globals.css. */
export type GuideTone = "indigo" | "teal" | "plum" | "cyan" | "olive";

export type Guide = {
  /** Anchor id and jump-chip key. */
  slug: string;
  title: string;
  /** The document's own kicker, e.g. "Internal guide · For all employees". */
  kicker: string;
  /** The purpose line from the cover. */
  purpose: string;
  /** Two or three letters for the banner stamp. */
  monogram: string;
  tone: GuideTone;
  /** Null for the guides that carry no version block. */
  version: string | null;
  dated: string;
  owner: { name: string; role: string } | null;
  approvedBy: { name: string; role: string } | null;
  pages: number;
  /** File name inside private/guidelines — never a URL, see `guideHref`. */
  pdf: string;
  /**
   * Departments allowed to open it, or null for everyone. The first entry is the
   * canonical name shown on the badge; the rest are accepted spellings, so a
   * guide keeps unlocking even if an admin renames the Department row slightly.
   * Matching is case-insensitive and apostrophe-insensitive — see `canReadGuide`.
   */
  departments: readonly string[] | null;
  /** Numbered sections, in the order the document lists them. */
  sections: string[];
};

export type GuideGroup = {
  title: string;
  blurb: string;
  guides: Guide[];
};

const GOAL_SETTING: Guide = {
  slug: "goal-setting",
  title: "Goal Setting Guidelines",
  kicker: "Internal guide · For all employees",
  purpose:
    "How to write effective, accurate, and actionable goals — with examples from Freshman Academy.",
  monogram: "GS",
  tone: "indigo",
  version: "v1.1",
  dated: "May 2026",
  // Owner is Valera by decision, overriding the PDF's cover block (which lists
  // Safina as owner and Valera as approver). With one person in both roles the
  // approver line would just repeat the owner, so it's dropped here.
  owner: { name: "Valera Arakelyan", role: "CEO, Freshman Academy" },
  approvedBy: null,
  pages: 7,
  pdf: "goal-setting-guidelines.pdf",
  departments: null,
  sections: [
    "Why Goals Matter",
    "The SMART Checklist",
    "The Goal Formula",
    "Goals and Tasks Are Not the Same Thing",
    "Examples by Department · Vague vs Specific",
    "Useful Verbs to Start With",
    "Rules We Follow",
    "Mistakes We See and How to Fix Them",
  ],
};

export const GUIDE_GROUPS: GuideGroup[] = [
  {
    title: "Leading a department",
    blurb:
      "For anyone who owns a department's numbers, its team, and its weekly commitments.",
    guides: [
      {
        slug: "department-leadership",
        title: "Department Leadership Guidelines",
        kicker: "Internal guide · For department leaders",
        purpose:
          "How to lead a department at Freshman Academy: positioning, finances, team management, and the mindset required to deliver results.",
        monogram: "DL",
        tone: "teal",
        version: "v1.0",
        dated: "June 2026",
        owner: { name: "Niyozbek Komilov", role: "AP Department Leader" },
        approvedBy: {
          name: "Valera Arakelyan",
          role: "Founder, Freshman Academy",
        },
        pages: 5,
        pdf: "department-leadership-guidelines.pdf",
        // Scoped by role, not department: a leader in any department needs it.
        departments: null,
        sections: [
          "Positioning vs. Marketing",
          "Competitive Advantage",
          "Finances and Incentive Systems",
          "Team Management",
          "Leadership Qualities Required",
          "Goals, Deadlines, and Accountability",
        ],
      },
      {
        slug: "admissions-program",
        title: "Admissions Program — Leadership Guide",
        kicker: "Internal · 2026 · For the Head of Admissions Program",
        purpose:
          "The program's goal and tracks, keeping students close, and what the department leader owns week to week.",
        monogram: "AP",
        tone: "plum",
        version: null,
        dated: "2026",
        owner: null,
        approvedBy: null,
        pages: 5,
        pdf: "admissions-program-leadership-guide.pdf",
        departments: ["Admissions Program", "Admissions", "AP"],
        sections: [
          "Program Goal & Tracks",
          "Keeping the Connection With Students",
          "Identifying & Supporting Strong Students",
          "Program Narrative",
          "Department Leader Responsibilities",
        ],
      },
    ],
  },
  {
    title: "Running a program, running the office",
    blurb:
      "Role guides for the people keeping students on pace and the space in shape.",
    guides: [
      {
        slug: "masters-mentors",
        title: "Master's Program Mentor Guidelines",
        kicker: "Internal guide · For mentors & the program coordinator",
        purpose:
          "How to run weekly sessions, track hours, coordinate the team, and keep every student on pace toward their Master's application deadlines.",
        monogram: "MP",
        tone: "cyan",
        version: "v1.0",
        dated: "June 2026",
        // The COO who owned this guide has left the company. Owner falls to
        // Valera, who approved it — and as in GOAL_SETTING above, one person
        // in both roles makes the approver line a repeat, so it is dropped.
        owner: { name: "Valera Arakelyan", role: "CEO, Freshman Academy" },
        approvedBy: null,
        pages: 8,
        pdf: "masters-program-mentor-guidelines.pdf",
        departments: [
          "Master's Program",
          "Masters Program",
          "Master's",
          "Masters",
        ],
        sections: [
          "The Role of the Program Coordinator",
          "The Weekly Monday Message",
          "Sample Monday Message",
          "Session Agenda Format",
          "Hours Tracking",
          "Driving the Program, Not Just Managing It",
          "Interviews and Candidate Assessment",
          "What We Can and Cannot Guarantee",
          "Contracts and Payment Deadlines",
        ],
      },
      {
        slug: "office-management",
        title: "Office Management Guidelines",
        kicker: "Internal guide · For office staff",
        purpose:
          "How to manage, maintain, and take ownership of the Freshman Academy office space.",
        monogram: "OM",
        tone: "olive",
        version: "v1.0",
        dated: "June 2026",
        owner: {
          name: "Nurmuhammad Mirzaahmadov",
          role: "Office Manager",
        },
        approvedBy: {
          name: "Valera Arakelyan",
          role: "CEO, Freshman Academy",
        },
        pages: 6,
        pdf: "office-management-guidelines.pdf",
        departments: null,
        sections: [
          "The Role of the Office Manager",
          "Core Character Traits Required",
          "Direct Responsibilities",
          "Space Standards & Photo Reference",
          "End of Day Checklist",
        ],
      },
      {
        slug: "office-health",
        title: "Office Health & Sickness Regulations",
        kicker: "Internal policy · For all Tashkent office staff",
        purpose:
          "What’s stocked in the office, when to work from home, how to report an absence, and who owns what.",
        monogram: "OH",
        tone: "plum",
        // No version block on the cover — just issued / approved / owner.
        version: null,
        dated: "August 2026",
        owner: { name: "Sofina", role: "Office Manager" },
        approvedBy: {
          name: "Valera Arakelyan",
          role: "CEO, Freshman Academy",
        },
        pages: 2,
        pdf: "office-health-sickness-regulations.pdf",
        // Open to everyone: it sets out what every person in the office does
        // when they're ill, not just what one department owns.
        departments: null,
        sections: [
          "Purpose",
          "Supplies",
          "When to Stay Home or Work Remotely",
          "Reporting an Absence",
          "Common Area Hygiene",
          "Ownership",
        ],
      },
    ],
  },
  {
    title: "Bringing students in",
    blurb:
      "How an inquiry becomes a student: which program fits whom, and what each one asks of them.",
    guides: [
      {
        slug: "program-routing-tree",
        title: "Program Routing Tree",
        kicker: "Internal guide · For the sales team",
        purpose:
          "Which program a new student inquiry belongs in, decided one question at a time: how far along they already are, what they are aiming at, and how close their profile sits to the ideal applicant.",
        monogram: "PRT",
        tone: "teal",
        // A routing diagram rather than a written guide — no version or
        // owner/approver block on the cover, so none is claimed here.
        version: null,
        dated: "August 2026",
        owner: null,
        approvedBy: null,
        pages: 3,
        pdf: "program-routing-tree.pdf",
        // Left open: it maps which program suits whom, which anyone fielding a
        // question about the programs benefits from, not just Sales.
        departments: null,
        sections: ["The Routing Tree", "Where Each Route Lands"],
      },
    ],
  },
  {
    title: "Tools we run",
    blurb:
      "How the bots and systems behind the programs work, and what to do when one looks broken.",
    guides: [
      {
        slug: "alumni-bot",
        title: "Freshman Alumni Bot",
        kicker: "Internal guide · For alumni group leaders",
        purpose:
          "How to switch on the bot in your group, walk members through onboarding, and handle the people who fall outside the usual checks.",
        monogram: "AB",
        tone: "plum",
        version: "v1.0",
        dated: "August 2026",
        // The cover carries no owner/approver block, just the bot's handle.
        owner: null,
        approvedBy: null,
        pages: 4,
        pdf: "freshman-alumni-bot-guide.pdf",
        // Open to everyone: the group-leader steps are only part of it, and the
        // rest is what any member is walked through, so nobody needs shielding
        // from it.
        departments: null,
        sections: [
          "How to Set It Up",
          "Why Administrator Matters",
          "What the Bot Puts in Your Group",
          "What a Member Goes Through",
          "If Something Looks Wrong",
          "Commands for Department Leads",
        ],
      },
      {
        slug: "google-calendar",
        title: "Guidelines for Using Google Calendar",
        kicker: "Internal guide · For all employees",
        purpose:
          "Color meanings, event notes, and rescheduling rules for Freshman Academy.",
        monogram: "GC",
        tone: "cyan",
        version: "v1.0",
        dated: "October 2026",
        owner: { name: "Sofina Karimova", role: "Marketing Assistant" },
        approvedBy: {
          name: "Valera Arakelyan",
          role: "CEO, Freshman Academy",
        },
        pages: 3,
        pdf: "google-calendar-guidelines.pdf",
        departments: null,
        sections: [
          "Who Can Add Meetings, Classes and Other Events",
          "What Each Color Means",
          "Rules: Who to Approve With",
          "How to Add Notes When Hosting an Event",
          "How to Make an Appointment Through the Calendar",
          "How to Create Your Own Booking Page",
        ],
      },
    ],
  },
];

/** The guide everyone is measured against — shown first, on its own. */
export const FEATURED_GUIDE = GOAL_SETTING;

/** Every guide, featured first, in page order. */
export const ALL_GUIDES: Guide[] = [
  FEATURED_GUIDE,
  ...GUIDE_GROUPS.flatMap((g) => g.guides),
];

/**
 * Where the PDFs live, relative to the project root. Deliberately NOT under
 * public/: anything in public/ is served as a static asset with no session
 * check, so these internal documents would have been downloadable by anyone who
 * knew (or guessed) the URL, signed in or not. Every read now goes through the
 * authenticated handler at /guidelines/file/[slug].
 */
export const GUIDELINES_DIR = ["private", "guidelines"] as const;

/**
 * Absolute path to one guide's PDF. The directory segments are written out as
 * string literals rather than spread from GUIDELINES_DIR so Next's build-time
 * file tracer can see where the reads land; given only a spread it can't tell,
 * and warns that the entire project may need bundling into the server trace.
 * next.config.ts names the same directory in outputFileTracingIncludes.
 */
export function guidePdfPath(pdf: string): string {
  return path.join(process.cwd(), "private", "guidelines", pdf);
}

/** Look a guide up by slug — the allowlist the download route resolves against. */
export function guideBySlug(slug: string): Guide | undefined {
  return ALL_GUIDES.find((g) => g.slug === slug);
}

/**
 * The in-app URL for a guide. `download` asks the handler for an attachment
 * disposition instead of opening the PDF in the browser's viewer.
 */
export function guideHref(guide: Guide, download = false): string {
  return `/guidelines/file/${guide.slug}${download ? "?dl=1" : ""}`;
}

/**
 * Fold a typed department name down to something comparable: trimmed, lowercased,
 * inner whitespace collapsed, and apostrophes dropped so "Master's Program",
 * "Masters Program" and "master’s  program" all land on the same key.
 */
function normalizeDepartment(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The department name shown on a restricted guide's badge. */
export function guideDepartmentLabel(guide: Guide): string | null {
  return guide.departments?.[0] ?? null;
}

/**
 * Whether this person may open the guide. Unrestricted guides are open to
 * everyone signed in; restricted ones need a matching department — any of the
 * viewer's memberships will do. Admins always pass — they publish these
 * documents and answer for them.
 *
 * Enforced in the download route, not just used to dim a card: hiding the button
 * while leaving the URL open would be no protection at all.
 */
export function canReadGuide(
  guide: Guide,
  viewer: { departments?: readonly string[]; isAdmin?: boolean },
): boolean {
  if (guide.departments == null) return true;
  if (viewer.isAdmin) return true;
  if (!viewer.departments || viewer.departments.length === 0) return false;
  const mine = new Set(viewer.departments.map(normalizeDepartment));
  return guide.departments.some((d) => mine.has(normalizeDepartment(d)));
}
