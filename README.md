# FreshWeek

![commits](https://img.shields.io/github/commit-activity/t/sssplash6/freshweek) · live at [freshweek.org](https://www.freshweek.org)

**The problem.** Freshman Academy's team works in departments toward weekly and monthly goals, owes daily reports, and pays small fines for missed deadlines and skipped meetings. Goals, reports, fines, bonuses and pay had no shared home, so progress was hard to see and every month's pay had to be pieced together.

**The idea.** One place where each person writes their goals down, progress comes from work actually checked off, and the rules (deadlines, fines, bonuses) are applied by the app instead of by memory.

**What it does now.**

- Weekly and monthly goals split into subtasks, with progress computed from what is done. Closing a period asks for a reflection on what was left unfinished.
- Submission deadlines, daily reports to a lead, meetings and attendance, and tasks assigned or delegated between colleagues.
- Fines, waivers and bonuses, applied by the rules and shown plainly.
- Department and team views, colleague reports and feedback, and a planner for marketing content.
- Monthly payroll: each person submits, the lead confirms, and accounting gets a sheet view and PDFs.

**Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Prisma 7 + PostgreSQL, Auth.js v5 (Google), Resend for email. Deployed on Render (`render.yaml`).

## Run it

```bash
npm install
createdb freshman_weekly
cp .env.example .env    # DATABASE_URL, AUTH_SECRET (npx auth secret), AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET
npm run db:migrate
npm run dev             # http://localhost:3000
```

The Google OAuth client needs the redirect URI `http://localhost:3000/api/auth/callback/google`. Product and design rules: [`PRODUCT.md`](PRODUCT.md).
