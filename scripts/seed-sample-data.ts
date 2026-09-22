/**
 * Seed the local database with sample data so every screen renders real UI.
 * Every row carries an id prefixed `seed_` — scripts/cleanup-sample-data.sql
 * removes exactly these rows and nothing else.
 *
 * Usage:  npx tsx scripts/seed-sample-data.ts
 * Remove: psql "$DATABASE_URL" -f scripts/cleanup-sample-data.sql
 */
import { prisma } from "@/lib/prisma";

const TASH = 5 * 3_600_000; // UTC+5, no DST
const DAY = 86_400_000;

// Asia/Tashkent wall-clock → UTC instant.
function tash(y: number, m: number, d: number, h = 0, min = 0) {
  return new Date(Date.UTC(y, m - 1, d, h, min) - TASH);
}
// Monday-00:00-UTC week bounds, matching lib/weeks.ts getWeekBounds.
function weekBounds(mondayYmd: string) {
  const [y, m, d] = mondayYmd.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(start.getTime() + 7 * DAY - 1);
  return { start, end };
}
// Mirrors lib/payroll.ts periodBoundsForMonth — duplicated inline so this
// script doesn't import the payroll module (which pulls email/notifications).
function periodBoundsForMonth(year: number, month: number) {
  const m0 = month - 1;
  const lastDay = new Date(Date.UTC(year, m0 + 1, 0)).getUTCDate();
  return {
    year,
    month,
    startsAt: new Date(Date.UTC(year, m0, 1) - TASH),
    endsAt: new Date(Date.UTC(year, m0 + 1, 1) - TASH),
    filingOpensAt: new Date(Date.UTC(year, m0, lastDay - 2) - TASH),
    filingClosesAt: new Date(Date.UTC(year, m0 + 1, 2) - TASH - 1_000),
    remindAt: new Date(Date.UTC(year, m0, lastDay - 2, 9) - TASH),
  };
}

// ----- People ---------------------------------------------------------------

// Unique per user — User.avatar is a unique column. (🪲 is taken by the
// dev-login account, so it's excluded here.)
const AVATARS = [
  "🦊", "🐼", "🦉", "🐯", "🦁", "🐸", "🐙", "🦋", "🐝", "🦄",
  "🐳", "🦜", "🐢", "🦔", "🐿", "🦩", "🐬", "🦓", "🐘", "🦒",
  "🐆", "🦘", "🐨", "🐧", "🦥", "🦡", "🦣", "🐇",
];

type Person = { key: string; name: string; email: string; phone?: string; tg?: string; bday?: [number, number]; li?: boolean };

const PEOPLE: Person[] = [
  // Admissions Program (matches the real roster the owner showed)
  { key: "sega", name: "Sega Arakelyan", email: "sega@freshman.academy", phone: "+998901112233", tg: "sega_ara", bday: [3, 14], li: true },
  { key: "amirbek", name: "Amirbek Bakhshilloev", email: "amirbek@freshman.academy", tg: "amirbek_b", bday: [7, 2] },
  { key: "banu", name: "Banu", email: "banu@freshman.academy", tg: "banu_fw" },
  { key: "imona", name: "Imona Bustonbayeva", email: "imona@freshman.academy", bday: [11, 30] },
  { key: "madina", name: "Madina Abdurashidova", email: "madina@freshman.academy", tg: "madina_a", li: true },
  { key: "shabnam", name: "Shabnam Qunishova", email: "shabnam@freshman.academy" },
  { key: "shahrioda", name: "Shahrioda Yusupova", email: "shahrioda@freshman.academy", tg: "shahrioda_y", bday: [1, 19] },
  { key: "shokh", name: "Shokhjakhonboy Urazbaev", email: "shokh@freshman.academy" },
  { key: "sunnat", name: "Sunnatillo Khujaev", email: "sunnat@freshman.academy", tg: "sunnatillo_k" },
  { key: "kamila", name: "Kamila Rahimova", email: "kamila@freshman.academy", bday: [9, 25] },
  { key: "timur", name: "Timur Nazarov", email: "timur@freshman.academy", tg: "timur_nz" },
  // Master's Program
  { key: "sardor", name: "Sardor Ikromov", email: "sardor@freshman.academy", phone: "+998933334455", tg: "sardor_i", bday: [5, 8], li: true },
  { key: "dilnoza", name: "Dilnoza Yusupova", email: "dilnoza@freshman.academy" },
  { key: "bekzod", name: "Bekzod Alimov", email: "bekzod@freshman.academy", tg: "bekzod_al" },
  { key: "otabek", name: "Otabek Karimov", email: "otabek@freshman.academy", bday: [12, 3] },
  { key: "malika", name: "Malika Saidova", email: "malika@freshman.academy", tg: "malika_s" },
  // Sales
  { key: "jasmina", name: "Jasmina Ergasheva", email: "jasmina@freshman.academy", tg: "jasmina_e", bday: [4, 11], li: true },
  { key: "aziz", name: "Aziz Rakhmonov", email: "aziz@freshman.academy" },
  { key: "nilufar", name: "Nilufar Tosheva", email: "nilufar@freshman.academy", tg: "nilufar_t" },
  // Tech
  { key: "javohir", name: "Javohir Mahmudov", email: "javohir@freshman.academy", tg: "javohir_m", bday: [2, 27] },
  { key: "sarvar", name: "Sarvar Nazarov", email: "sarvar@freshman.academy" },
  // Marketing
  { key: "nigora", name: "Nigora Karimova", email: "nigora@freshman.academy", tg: "nigora_k", bday: [8, 16] },
  { key: "farruh", name: "Farruh Yusupov", email: "farruh@freshman.academy" },
  // People
  { key: "gulbahor", name: "Gulbahor Azimova", email: "gulbahor@freshman.academy", tg: "gulbahor_a", bday: [6, 21] },
  { key: "oybek", name: "Oybek Sattarov", email: "oybek@freshman.academy" },
  // Alumni Council (mini)
  { key: "akmal", name: "Akmal Rashidov", email: "akmal@freshman.academy", tg: "akmal_r", bday: [10, 9] },
  { key: "zarina", name: "Zarina Umarova", email: "zarina@freshman.academy" },
  { key: "bobur", name: "Bobur Erkinov", email: "bobur@freshman.academy", tg: "bobur_e" },
];

// Pending sign-ups (non-company emails, waiting on /pending)
const PENDING: Person[] = [
  { key: "pdiyora", name: "Diyora Tulkinova", email: "diyora.tulkin@gmail.com" },
  { key: "prustam", name: "Rustam Valiyev", email: "rustam.valiyev@gmail.com" },
];

// [key, name, mini?, leadKey, memberKeys]
const DEPTS: [string, string, boolean, string, string[]][] = [
  ["adm", "Admissions Program", false, "sega", ["amirbek", "banu", "imona", "madina", "shabnam", "shahrioda", "shokh", "sunnat", "kamila", "timur"]],
  ["masters", "Master's Program", false, "sardor", ["dilnoza", "bekzod", "otabek", "malika"]],
  ["sales", "Sales", false, "jasmina", ["aziz", "nilufar"]],
  ["tech", "Tech", false, "dev", ["javohir", "sarvar"]],
  ["marketing", "Marketing", false, "nigora", ["farruh", "shahrioda"]],
  ["people", "People", false, "gulbahor", ["oybek", "imona"]],
  ["alumni", "Alumni Council", true, "akmal", ["zarina", "bobur", "dev"]],
];

// Goal title pools per department — [goal, subtasks[]]
const GOAL_POOL: Record<string, [string, string[]][]> = {
  adm: [
    ["Interview 12 new applicants", ["Shortlist from application form", "Run Zoom interviews", "Score rubrics", "Send decisions"]],
    ["Follow up with August leads", ["Pull stale lead list", "Message each on Telegram", "Log outcomes in CRM"]],
    ["Prepare October intake presentation", ["Draft slides", "Review with lead", "Rehearse talk track"]],
    ["Update admissions FAQ doc", ["Collect repeated questions", "Rewrite top 10 answers"]],
  ],
  masters: [
    ["Review 8 master's applications", ["Read SOPs", "Check transcripts", "Score and rank"]],
    ["Prep curriculum committee notes", ["Summarize feedback", "Draft agenda"]],
    ["Call waitlisted candidates", ["Prepare call script", "Complete calls", "Update statuses"]],
    ["Sync with partner university", ["Draft update email", "Schedule call"]],
  ],
  sales: [
    ["Close 5 enrollment contracts", ["Call warm leads", "Send proposals", "Handle objections", "Collect signatures"]],
    ["Pipeline review with lead", ["Update CRM stages", "Flag stalled deals"]],
    ["Run 2 school outreach visits", ["Confirm appointments", "Deliver pitch", "Collect contacts"]],
  ],
  tech: [
    ["Ship onboarding flow v2", ["Implement department picker", "Wire approval emails", "QA on staging"]],
    ["Fix payroll PDF layout", ["Reproduce overflow", "Patch template", "Regenerate samples"]],
    ["Database backup drill", ["Snapshot prod", "Test restore locally", "Document runbook"]],
    ["Weekly dependency updates", ["Audit outdated packages", "Bump and test"]],
  ],
  marketing: [
    ["Launch autumn campaign", ["Finalize creatives", "Schedule posts", "Set up tracking"]],
    ["Grow Instagram to 12k", ["Post 4 reels", "Engage comments daily", "Analyze reach"]],
    ["Design open-day banners", ["Brief designer", "Approve drafts"]],
  ],
  people: [
    ["Onboard 2 new mentors", ["Prepare accounts", "Walk through the app", "Assign first students"]],
    ["Quarterly 1:1s round", ["Schedule meetings", "Hold 6 conversations", "Log action items"]],
    ["Update sick-leave policy", ["Draft revision", "Get sign-off"]],
  ],
  alumni: [
    ["Plan October alumni meetup", ["Book venue", "Send invitations", "Confirm headcount"]],
    ["Alumni newsletter draft", ["Collect stories", "Write copy"]],
  ],
};

const uid = (key: string) => `seed_user_${key}`;

async function main() {
  const dev = await prisma.user.findUniqueOrThrow({
    where: { email: "dev@freshman.academy" },
  });
  // Give the login account a real name so the UI reads like production.
  await prisma.user.update({
    where: { id: dev.id },
    data: { name: "Doston Rajabov", telegramUsername: "doston_rj" },
  });

  // --- Users ---------------------------------------------------------------
  const adminId = dev.id;
  const avatarFor = new Map<string, string>();
  PEOPLE.forEach((p, i) => avatarFor.set(p.key, AVATARS[i % AVATARS.length]));
  avatarFor.set("dev", "🐺");

  for (const [i, p] of PEOPLE.entries()) {
    await prisma.user.create({
      data: {
        id: uid(p.key),
        name: p.name,
        email: p.email,
        approvedAt: tash(2026, 6, 15 + (i % 30), 9),
        approvedById: adminId,
        workPhone: p.phone ?? `+99890${String(1000000 + i * 137).slice(0, 7)}`,
        telegramUsername: p.tg ?? p.name.split(" ")[0].toLowerCase(),
        birthday: p.bday ? new Date(Date.UTC(2000, p.bday[0] - 1, p.bday[1])) : null,
        linkedin: p.li ? `https://linkedin.com/in/${p.name.toLowerCase().replace(/ /g, "-")}` : null,
        avatar: avatarFor.get(p.key),
      },
    });
  }
  for (const p of PENDING) {
    await prisma.user.create({
      data: { id: uid(p.key), name: p.name, email: p.email },
    });
  }

  const allKeys = [...PEOPLE.map((p) => p.key), "dev"];
  const userIdOf = (k: string) => (k === "dev" ? dev.id : uid(k));

  // --- Departments + memberships -------------------------------------------
  const deptId: Record<string, string> = {};
  const leadOf = new Map<string, string>(); // deptKey → userKey
  const memberDept = new Map<string, string>(); // userKey → primary deptKey
  for (const [key, name, mini, lead, members] of DEPTS) {
    // Upsert by name: the app lazily creates some departments itself (e.g. the
    // Alumni Council mini), so a row may already exist without a seed_ id.
    const dept = await prisma.department.upsert({
      where: { name },
      update: { mini },
      create: { id: `seed_dept_${key}`, name, mini, createdAt: tash(2026, 6, 10) },
    });
    deptId[key] = dept.id;
    leadOf.set(key, lead);
    const seats: [string, "LEAD" | "MEMBER"][] = [
      [lead, "LEAD"],
      ...members.map((m): [string, "MEMBER"] => [m, "MEMBER"]),
    ];
    for (const [seat, [uKey, role]] of seats.entries()) {
      if (!memberDept.has(uKey)) memberDept.set(uKey, key);
      // The app may have seated someone already (first-seater mini lead) —
      // keep that row and its role rather than failing on the unique pair.
      await prisma.departmentMembership.upsert({
        where: { userId_departmentId: { userId: userIdOf(uKey), departmentId: deptId[key] } },
        update: {},
        create: {
          id: `seed_dm_${key}_${uKey}`,
          userId: userIdOf(uKey),
          departmentId: deptId[key],
          role,
          createdAt: new Date(tash(2026, 6, 15).getTime() + seat * DAY),
        },
      });
    }
  }
  // Pending sign-ups name a department but hold no seat yet.
  await prisma.user.update({ where: { id: uid("pdiyora") }, data: { requestedDepartmentId: deptId.adm } });
  await prisma.user.update({ where: { id: uid("prustam") }, data: { requestedDepartmentId: deptId.tech } });

  // --- Weeks + goals ---------------------------------------------------------
  // Current week: Mon 2026-09-21 UTC. Three archived weeks before it.
  const MONDAYS = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"];
  const CURRENT = "2026-09-21";
  // Sunday-12:00-Tashkent deadline = Sunday 07:00 UTC of that week.
  const deadlineFor = (monday: string) => weekBounds(monday).start.getTime() + 6 * DAY + 7 * 3_600_000;

  let gi = 0;
  for (const key of allKeys) {
    const deptKey = memberDept.get(key) ?? "tech";
    const pool = GOAL_POOL[deptKey] ?? GOAL_POOL.tech;
    for (const [wi, monday] of MONDAYS.entries()) {
      const isCurrent = monday === CURRENT;
      const { start, end } = weekBounds(monday);
      const weekId = `seed_week_${key}_${wi}`;
      // Submitted: every past week; current week for ~70% of people.
      const submitted = !isCurrent || (key.charCodeAt(0) + key.length) % 10 < 7;
      const late = !isCurrent && (key === "shokh" || key === "aziz") && wi === 2;
      await prisma.week.create({
        data: {
          id: weekId,
          userId: userIdOf(key),
          startDate: start,
          endDate: end,
          isCurrent,
          goalsLocked: submitted,
          submittedLate: late,
          submittedAt: submitted
            ? new Date(deadlineFor(monday) + (late ? 2 : -(8 + (gi % 20))) * 3_600_000)
            : null,
          createdAt: start,
        },
      });
      const nGoals = 2 + ((gi + wi) % 3); // 2–4 goals
      for (let g = 0; g < nGoals; g++) {
        const [title, subs] = pool[(g + wi) % pool.length];
        const goalId = `seed_goal_${gi}`;
        const done = !isCurrent && (g + wi + key.length) % 4 !== 0;
        await prisma.goal.create({
          data: {
            id: goalId,
            weekId,
            title,
            position: g + 1,
            completedAt: done ? new Date(end.getTime() - (g + 2) * DAY) : null,
            incompleteReason: !isCurrent && !done ? "Ran out of time — carried into next week" : null,
            priority: g === 0 ? "HIGH" : g === 1 ? "MEDIUM" : null,
            deadline: g === 0 ? new Date(end.getTime() - 2 * DAY) : null,
          },
        });
        for (let s = 0; s < subs.length; s++) {
          await prisma.subtask.create({
            data: {
              id: `seed_sub_${gi}_${s}`,
              goalId,
              title: subs[s],
              position: s + 1,
              isDone: done || (!isCurrent ? s === 0 : s < (key.length + g) % subs.length),
            },
          });
        }
        gi++;
      }
    }
    // Months: August (closed) + September (current)
    for (const mon of [8, 9]) {
      const monthId = `seed_month_${key}_${mon}`;
      const isCurrent = mon === 9;
      await prisma.month.create({
        data: {
          id: monthId,
          userId: userIdOf(key),
          startDate: tash(2026, mon, 1),
          endDate: new Date(tash(2026, mon + 1, 1).getTime() - 1),
          isCurrent,
          goalsLocked: true,
          submittedAt: tash(2026, mon, 2, 14),
          createdAt: tash(2026, mon, 1),
        },
      });
      const monthly: [string, string[]][] = [
        [`Hit department's ${mon === 8 ? "August" : "September"} target`, ["Break down weekly", "Mid-month check-in"]],
        ["One process improvement", ["Pick a bottleneck", "Propose fix to lead"]],
      ];
      for (let g = 0; g < monthly.length; g++) {
        const goalId = `seed_mgoal_${key}_${mon}_${g}`;
        const done = !isCurrent && g === 0;
        await prisma.goal.create({
          data: {
            id: goalId,
            monthId,
            title: monthly[g][0],
            position: g + 1,
            completedAt: done ? tash(2026, mon, 28, 17) : null,
          },
        });
        for (let s = 0; s < monthly[g][1].length; s++) {
          await prisma.subtask.create({
            data: {
              id: `seed_msub_${key}_${mon}_${g}_${s}`,
              goalId,
              title: monthly[g][1][s],
              position: s + 1,
              isDone: done || (!isCurrent && s === 0),
            },
          });
        }
      }
    }
  }

  // --- Day tasks (today = 2026-09-22) ----------------------------------------
  const today = new Date(Date.UTC(2026, 8, 22));
  const dayTasks: [string, string, boolean][] = [
    ["dev", "Review payroll queue before the window opens", false],
    ["dev", "Deploy the attendance fix to prod", true],
    ["sega", "Prep Monday sync agenda", false],
    ["jasmina", "Call the three warm leads from Friday", false],
    ["javohir", "Pair with Sarvar on the PDF bug", true],
    ["gulbahor", "Finish onboarding notes for new mentors", false],
  ];
  for (const [i, [key, title, done]] of dayTasks.entries()) {
    await prisma.dayTask.create({
      data: {
        id: `seed_day_${i}`,
        userId: userIdOf(key),
        date: today,
        title,
        position: i + 1,
        isDone: done,
      },
    });
  }

  // --- Meetings + attendance (leads are the expected attendees) ---------------
  // Monday sync: 11:00 Tashkent before 2026-09-14, 10:00 after (lib/meetings).
  const MEETINGS: [string, number][] = [
    ["2026-08-31", 11],
    ["2026-09-07", 11],
    ["2026-09-14", 10],
    ["2026-09-21", 10],
  ];
  const leads = [...leadOf.entries()].filter(([d]) => d !== "alumni"); // mini leads owe nothing
  const meetingIds: string[] = [];
  for (const [mi, [ymd, hour]] of MEETINGS.entries()) {
    const [y, m, d] = ymd.split("-").map(Number);
    const mid = `seed_meeting_${mi}`;
    meetingIds.push(mid);
    await prisma.meeting.create({
      data: { id: mid, scheduledAt: tash(y, m, d, hour) },
    });
    for (const [, lead] of leads) {
      let status: "ATTENDED" | "LATE" | "SKIPPED" | "EXCUSED" = "ATTENDED";
      if (lead === "sardor" && (mi === 2 || mi === 3)) status = "SKIPPED"; // two consecutive skips
      if (lead === "nigora" && mi === 3) status = "LATE";
      if (lead === "gulbahor" && mi === 2) status = "EXCUSED";
      await prisma.attendance.create({
        data: {
          id: `seed_att_${mi}_${lead}`,
          meetingId: mid,
          userId: userIdOf(lead),
          status,
        },
      });
    }
  }

  // --- Penalties --------------------------------------------------------------
  let pi = 0;
  const penalty = async (data: {
    user: string;
    type: "MEETING_SKIPPED" | "MEETING_LATE" | "LATE_SUBMISSION" | "LATE_DAILY_REPORT" | "OTHER";
    amount: number;
    note?: string;
    weekId?: string;
    meetingId?: string;
    reportDay?: Date;
    paid?: "full" | "partial" | "none";
    when?: Date;
  }) => {
    const id = `seed_pen_${pi++}`;
    const paidAmount = data.paid === "full" ? data.amount : data.paid === "partial" ? Math.floor(data.amount / 2) : 0;
    await prisma.penalty.create({
      data: {
        id,
        userId: userIdOf(data.user),
        type: data.type,
        amount: data.amount,
        note: data.note ?? null,
        weekId: data.weekId ?? null,
        meetingId: data.meetingId ?? null,
        reportDay: data.reportDay ?? null,
        issuedById: adminId,
        createdAt: data.when ?? tash(2026, 9, 15, 12),
        paidAmount,
        paidAt: data.paid === "full" ? tash(2026, 9, 18, 10) : null,
        settledById: data.paid === "full" ? adminId : null,
      },
    });
    if (paidAmount > 0) {
      await prisma.finePayment.create({
        data: {
          id: `seed_fp_${pi}`,
          penaltyId: id,
          amount: paidAmount,
          batchId: `seed_batch_${pi}`,
          source: "MANUAL",
          recordedById: adminId,
          createdAt: tash(2026, 9, 18, 10),
        },
      });
    }
    return id;
  };

  // Sardor's two consecutive skips: $40 then $60 (escalating).
  await penalty({ user: "sardor", type: "MEETING_SKIPPED", amount: 40, meetingId: meetingIds[2], paid: "full", when: tash(2026, 9, 14, 15) });
  await penalty({ user: "sardor", type: "MEETING_SKIPPED", amount: 60, meetingId: meetingIds[3], paid: "none", when: tash(2026, 9, 21, 15) });
  await penalty({ user: "nigora", type: "MEETING_LATE", amount: 10, meetingId: meetingIds[3], paid: "none", when: tash(2026, 9, 21, 15) });
  // Late submissions for the two submittedLate weeks.
  await penalty({ user: "shokh", type: "LATE_SUBMISSION", amount: 20, weekId: "seed_week_shokh_2", paid: "partial", when: tash(2026, 9, 15, 9) });
  await penalty({ user: "aziz", type: "LATE_SUBMISSION", amount: 20, weekId: "seed_week_aziz_2", paid: "none", when: tash(2026, 9, 15, 9) });
  // Daily-report fines.
  await penalty({ user: "timur", type: "LATE_DAILY_REPORT", amount: 5, reportDay: new Date(Date.UTC(2026, 8, 18)), paid: "none", when: tash(2026, 9, 19, 6) });
  await penalty({ user: "otabek", type: "LATE_DAILY_REPORT", amount: 5, reportDay: new Date(Date.UTC(2026, 8, 21)), paid: "none", when: tash(2026, 9, 22, 6) });
  // Manual fines.
  await penalty({ user: "farruh", type: "OTHER", amount: 20, note: "Left the office without logging the visitor laptop", paid: "full", when: tash(2026, 9, 10, 16) });
  await penalty({ user: "bekzod", type: "OTHER", amount: 15, note: "Missed the partner call without warning", paid: "none", when: tash(2026, 9, 17, 11) });

  // One waiver: Gulbahor's excused absence was pre-approved.
  await prisma.fineWaiver.create({
    data: {
      id: "seed_waiver_0",
      userId: uid("gulbahor"),
      meetingId: meetingIds[2],
      waivedById: adminId,
      createdAt: tash(2026, 9, 14, 18),
    },
  });

  // --- Bonuses ----------------------------------------------------------------
  const bonuses: [string, number, string][] = [
    ["sega", 100, "September intake beat target by 20%"],
    ["javohir", 50, "Shipped the attendance fix ahead of schedule"],
    ["jasmina", 75, "Closed the group enrolment deal"],
    ["dilnoza", 40, "Weekend applicant-support coverage"],
  ];
  const bonusIds: string[] = [];
  for (const [bi, [key, amount, note]] of bonuses.entries()) {
    const id = `seed_bonus_${bi}`;
    bonusIds.push(id);
    await prisma.bonus.create({
      data: {
        id,
        userId: userIdOf(key),
        amount,
        note,
        issuedById: adminId,
        createdAt: tash(2026, 9, 5 + bi * 4, 13),
      },
    });
  }

  // --- Assigned tasks ----------------------------------------------------------
  const tasks: [string, string, string, "WEEKLY" | "MONTHLY", boolean][] = [
    ["dev", "kamila", "Verify the new intake form end-to-end", "WEEKLY", false],
    ["dev", "sarvar", "Write the restore-drill runbook", "MONTHLY", false],
    ["sega", "amirbek", "Re-score the borderline applicants", "WEEKLY", true],
    ["dev", "otabek", "Draft the October curriculum proposal", "MONTHLY", false],
    ["jasmina", "aziz", "Update the CRM pipeline stages", "WEEKLY", true],
  ];
  for (const [ti, [by, to, title, scope, done]] of tasks.entries()) {
    await prisma.assignedTask.create({
      data: {
        id: `seed_task_${ti}`,
        userId: userIdOf(to),
        assignedById: userIdOf(by),
        title,
        scope,
        deadline: new Date(today.getTime() + (ti + 3) * DAY),
        completedAt: done ? tash(2026, 9, 20, 15) : null,
        createdAt: tash(2026, 9, 16, 9),
      },
    });
  }

  // --- Daily reports -------------------------------------------------------------
  const reportDays = [
    new Date(Date.UTC(2026, 8, 18)), // Fri
    new Date(Date.UTC(2026, 8, 21)), // Mon
    new Date(Date.UTC(2026, 8, 22)), // today
  ];
  const reportText: Record<string, string[]> = {
    sega: ["Ran Monday sync; assigned interview slots for the week.", "Reviewed 6 applications; shortlisted 3 for interviews."],
    jasmina: ["Closed the contract with the Nukus group — $4,800.", "Pipeline review: 3 deals stalled, re-engagement planned."],
    javohir: ["Fixed the payroll PDF overflow; tested on staging.", "Paired on the attendance bug; root cause found."],
    madina: ["Called 8 applicants; 5 confirmed for Saturday's open day.", "Updated the FAQ doc with new visa questions."],
    dev: ["Reviewed two PRs; deployed the notifications fix.", "Set up the staging database refresh."],
    sarvar: ["Wrote tests for the weekly-report job.", "Investigated slow /team query — added an index."],
    nigora: ["Autumn campaign creatives approved; scheduled for Thursday.", "Reels posted: 12.4k reach."],
    gulbahor: ["Held 3 onboarding 1:1s; notes logged.", "Drafted the sick-leave policy revision."],
  };
  let ri = 0;
  for (const [key, texts] of Object.entries(reportText)) {
    for (const [di, day] of reportDays.entries()) {
      const text = texts[di % texts.length];
      if (!text) continue;
      const sentAt = new Date(day.getTime() + 16 * 3_600_000);
      await prisma.dailyReport.create({
        data: {
          id: `seed_report_${ri++}`,
          userId: userIdOf(key),
          day,
          content: text,
          submittedAt: sentAt,
          lastSentAt: sentAt,
        },
      });
    }
  }

  // --- Notifications (a few unread for the bell badge) --------------------------
  const notifs: [string, "FINE" | "BONUS" | "TASK_ASSIGNED" | "REPORT" | "PAYROLL" | "OTHER", string, boolean][] = [
    ["dev", "REPORT", "Sardor Ikromov filed a colleague report about Bekzod Alimov.", false],
    ["dev", "PAYROLL", "3 pay requests are waiting in the September queue.", false],
    ["dev", "TASK_ASSIGNED", "You assigned Verify the new intake form end-to-end to Kamila Rahimova.", true],
    ["dev", "OTHER", "2 new sign-ups are waiting for approval.", false],
    ["sardor", "FINE", "You were fined $60: skipped the Monday meeting.", false],
    ["sega", "BONUS", "You received a $100 bonus: September intake beat target by 20%.", false],
    ["nigora", "FINE", "You were fined $10: late to the Monday meeting.", true],
    ["kamila", "TASK_ASSIGNED", "Doston Rajabov assigned you: Verify the new intake form end-to-end.", false],
    ["jasmina", "BONUS", "You received a $75 bonus: Closed the group enrolment deal.", false],
    ["aziz", "FINE", "You were fined $20: late submission for week of Sep 14.", false],
  ];
  for (const [ni, [key, type, message, read]] of notifs.entries()) {
    await prisma.notification.create({
      data: {
        id: `seed_notif_${ni}`,
        userId: userIdOf(key),
        type,
        message,
        createdAt: tash(2026, 9, 21, 9 + ni),
        readAt: read ? tash(2026, 9, 21, 20) : null,
      },
    });
  }

  // --- Colleague reports ----------------------------------------------------------
  const rep1 = await prisma.colleagueReport.create({
    data: {
      id: "seed_crep_0",
      reporterId: uid("sardor"),
      reason: "Repeatedly joins client calls unprepared; had to cover for him twice this week.",
      status: "OPEN",
      createdAt: tash(2026, 9, 21, 14),
    },
  });
  await prisma.colleagueReportSubject.create({
    data: { reportId: rep1.id, userId: uid("bekzod") },
  });
  const rep2 = await prisma.colleagueReport.create({
    data: {
      id: "seed_crep_1",
      reporterId: uid("nigora"),
      reason: "Shared internal pricing screenshots in a public Telegram group.",
      status: "ACTIONED",
      closedById: adminId,
      closedAt: tash(2026, 9, 18, 12),
      resolution: "Spoken to; $20 fine issued and post removed.",
      createdAt: tash(2026, 9, 16, 10),
    },
  });
  await prisma.colleagueReportSubject.create({
    data: { reportId: rep2.id, userId: uid("farruh") },
  });

  // --- Feedback ---------------------------------------------------------------------
  await prisma.feedback.create({
    data: {
      id: "seed_fb_0",
      userId: uid("shabnam"),
      userEmail: "shabnam@freshman.academy",
      message: "Could the week view show my fines inline? I keep missing them until payday.",
      createdAt: tash(2026, 9, 19, 11),
    },
  });
  await prisma.feedback.create({
    data: {
      id: "seed_fb_1",
      userId: uid("oybek"),
      userEmail: "oybek@freshman.academy",
      message: "Telegram reminders for daily reports would help — I forget after 9pm.",
      createdAt: tash(2026, 9, 20, 22),
    },
  });

  // --- Payroll -----------------------------------------------------------------------
  // August: a fully settled month — most people PROCESSED with UZS payouts.
  const aug = periodBoundsForMonth(2026, 8);
  const sep = periodBoundsForMonth(2026, 9);
  // The app creates the current period on first touch, so it may already exist
  // with a non-seed id — upsert on (year, month) and reuse whatever's there.
  const augPeriod = await prisma.payrollPeriod.upsert({
    where: { year_month: { year: aug.year, month: aug.month } },
    update: {},
    create: { id: "seed_period_2026_8", ...aug, reminderSentAt: aug.remindAt },
  });
  const sepPeriod = await prisma.payrollPeriod.upsert({
    where: { year_month: { year: sep.year, month: sep.month } },
    update: {},
    create: { id: "seed_period_2026_9", ...sep },
  });
  const augId = augPeriod.id;
  const sepId = sepPeriod.id;

  const SALARY: Record<string, number> = {
    sega: 1200, amirbek: 700, banu: 550, imona: 600, madina: 650, shabnam: 500,
    shahrioda: 500, shokh: 550, sunnat: 500, kamila: 600, timur: 450,
    sardor: 1100, dilnoza: 600, bekzod: 650, otabek: 600, malika: 550,
    jasmina: 900, aziz: 500, nilufar: 450,
    dev: 1400, javohir: 800, sarvar: 700,
    nigora: 800, farruh: 550, gulbahor: 850, oybek: 500,
  };
  const METHOD: Record<string, ["CASH_UZBEKISTAN" | "PAYME" | "UZBEK_COMPANY" | "WISE_USD" | "UZS_CARD", object]> = {
    sega: ["UZBEK_COMPANY", { account: "LLC Freshman Academy" }],
    jasmina: ["PAYME", { card: "8600 12** **** 3456", holder: "Jasmina Ergasheva" }],
    dev: ["WISE_USD", { email: "dostonbps@gmail.com" }],
    sardor: ["UZS_CARD", { card: "9860 03** **** 7788", holder: "Sardor Ikromov" }],
  };
  const methodFor = (k: string) => METHOD[k] ?? (["CASH_UZBEKISTAN", {}] as const);

  let si = 0;
  for (const key of Object.keys(SALARY)) {
    const subId = `seed_psub_${si++}`;
    const base = SALARY[key];
    const bi = ["sega", "javohir", "jasmina", "dilnoza"].indexOf(key);
    const bonusesTotal = bi >= 0 ? [100, 50, 75, 40][bi] : 0;
    const expenses = key === "nigora"
      ? [{ label: "Figma Pro seat", cents: 1500 }, { label: "Stock photo pack", cents: 2900 }]
      : key === "dev" ? [{ label: "Cursor Pro", cents: 2000 }] : [];
    const expTotal = expenses.reduce((s, e) => s + e.cents, 0);
    const net = Math.round(base + bonusesTotal + expTotal / 100);
    await prisma.payrollSubmission.create({
      data: {
        id: subId,
        userId: userIdOf(key),
        periodId: augId,
        status: "PROCESSED",
        baseSalary: base,
        bonusesTotal,
        expensesTotalCents: expTotal,
        netTotal: net,
        paymentMethod: methodFor(key)[0],
        paymentDetails: methodFor(key)[1],
        amountUzs: net * 12_530,
        submittedAt: tash(2026, 8, 29, 10),
        lastSubmittedAt: tash(2026, 8, 29, 10),
        processedAt: tash(2026, 9, 2, 14),
        createdAt: tash(2026, 8, 29, 10),
      },
    });
    if (bi >= 0) {
      await prisma.payrollBonusLine.create({
        data: {
          id: `seed_pbl_${si}`,
          submissionId: subId,
          bonusId: bonusIds[bi],
          amount: bonuses[bi][1],
          note: bonuses[bi][2],
          awardedAt: tash(2026, 9, 5 + bi * 4, 13),
        },
      });
      await prisma.bonus.update({
        where: { id: bonusIds[bi] },
        data: { payrollSubmissionId: subId },
      });
    }
    for (const [ei, e] of expenses.entries()) {
      await prisma.payrollExpense.create({
        data: {
          id: `seed_pex_${si}_${ei}`,
          submissionId: subId,
          label: e.label,
          amountCents: e.cents,
          position: ei + 1,
        },
      });
    }
    const trail: ["DRAFT" | "SUBMITTED" | "PROCESSED" | "WITH_LEAD" | null, "DRAFT" | "SUBMITTED" | "PROCESSED" | "WITH_LEAD"][] =
      memberDept.get(key) === "masters" || key === "amirbek"
        ? [[null, "DRAFT"], ["DRAFT", "WITH_LEAD"], ["WITH_LEAD", "SUBMITTED"], ["SUBMITTED", "PROCESSED"]]
        : [[null, "DRAFT"], ["DRAFT", "SUBMITTED"], ["SUBMITTED", "PROCESSED"]];
    for (const [ev, [from, to]] of trail.entries()) {
      await prisma.payrollEvent.create({
        data: {
          id: `seed_pev_${si}_${ev}`,
          submissionId: subId,
          actorId: adminId,
          fromStatus: from,
          toStatus: to,
          createdAt: new Date(tash(2026, 8, 29, 10).getTime() + ev * 2 * DAY),
        },
      });
    }
  }

  // September: live queue — one WITH_LEAD (waiting on Sega), one SUBMITTED
  // (a lead files straight to finance), one DRAFT still being written.
  const live: [string, "WITH_LEAD" | "SUBMITTED" | "DRAFT"][] = [
    ["amirbek", "WITH_LEAD"],
    ["gulbahor", "SUBMITTED"],
    ["malika", "DRAFT"],
  ];
  for (const [key, status] of live) {
    const subId = `seed_psub_${si++}`;
    const base = SALARY[key] ?? 500;
    await prisma.payrollSubmission.create({
      data: {
        id: subId,
        userId: userIdOf(key),
        periodId: sepId,
        status,
        baseSalary: base,
        netTotal: base,
        paymentMethod: methodFor(key)[0],
        paymentDetails: methodFor(key)[1],
        submittedAt: status === "DRAFT" ? null : tash(2026, 9, 21, 16),
        lastSubmittedAt: status === "DRAFT" ? null : tash(2026, 9, 21, 16),
        createdAt: tash(2026, 9, 21, 12),
      },
    });
    await prisma.payrollEvent.create({
      data: {
        id: `seed_pev_${si}_0`,
        submissionId: subId,
        actorId: userIdOf(key),
        fromStatus: null,
        toStatus: status,
        createdAt: tash(2026, 9, 21, 12),
      },
    });
  }

  console.log("Seeded sample data: departments, people, weeks, goals, meetings,");
  console.log("fines, bonuses, tasks, reports, notifications and payroll (Aug + Sep).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
