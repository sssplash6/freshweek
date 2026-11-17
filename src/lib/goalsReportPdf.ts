// Server-only: the weekly goals report admins download from /admin. Every
// person's previous week and new week (the two admin tabs, same split), with
// everything a goal carries: priority, deadline, progress, completion,
// subtasks and their state, who delegated it in or out, and the reflection
// written at close. Built on read, never stored. Fonts and line wrapping come
// from the payroll invoice (lib/payrollPdf.ts), so Cyrillic renders.

import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadAssets, wrap } from "@/lib/payrollPdf";

export type ReportSubtask = {
  title: string;
  isDone: boolean;
  from: string | null;
  sharedTo: string[];
};

export type ReportGoal = {
  title: string;
  percent: number;
  completed: boolean;
  priority: string | null;
  deadline: string | null;
  from: string | null;
  sharedTo: string[];
  incompleteReason: string | null;
  subtasks: ReportSubtask[];
};

export type ReportWeek = {
  heading: string;
  /** Null when the person has no week in this slot. */
  range: string | null;
  percent: number;
  /** "Submitted Mon, Nov 16, 02:10 PM", or null if never submitted. */
  status: string | null;
  /** Red markers such as "Late" or "Didn't close". */
  flags: string[];
  goals: ReportGoal[];
};

export type ReportPerson = {
  name: string;
  department: string;
  weeks: ReportWeek[];
};

export type GoalsReport = {
  generatedLabel: string;
  previousLabel: string;
  newLabel: string;
  people: ReportPerson[];
};

// ----- Page geometry (US Letter, like the invoice) -----

const PAGE_W = 612;
const PAGE_H = 792;
const LEFT = 48;
const RIGHT = PAGE_W - 48;
const TOP = PAGE_H - 48;
const BOTTOM = 56;

const INK = rgb(0.13, 0.14, 0.16);
const GRAY = rgb(0.45, 0.46, 0.48);
const LINE = rgb(0.86, 0.86, 0.88);
const BRAND = rgb(0.12, 0.2, 0.45);
const GREEN = rgb(0.1, 0.5, 0.28);
const RED = rgb(0.75, 0.15, 0.15);

type Style = { font: PDFFont; size: number; color: ReturnType<typeof rgb> };

export async function renderGoalsReport(
  report: GoalsReport,
): Promise<Uint8Array<ArrayBuffer>> {
  const assets = await loadAssets();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(assets.regular, { subset: true });
  const bold = await doc.embedFont(assets.bold, { subset: true });
  doc.setTitle("Weekly goals report");

  // Characters the font can't draw (emoji, mostly) are dropped instead of
  // printing as empty boxes. One set per font, built on first use.
  const charsets = new Map<PDFFont, Set<number>>();
  const clean = (f: PDFFont, text: string) => {
    let set = charsets.get(f);
    if (!set) {
      set = new Set(f.getCharacterSet());
      charsets.set(f, set);
    }
    return [...text]
      .filter((ch) => ch === "\n" || set.has(ch.codePointAt(0)!))
      .join("")
      .replace(/[ \t]+/g, " ")
      .trim();
  };

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = TOP;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = TOP;
  };
  /** Start a new page unless `height` more points fit on this one. */
  const ensure = (height: number) => {
    if (y - height < BOTTOM) newPage();
  };

  /** Wrapped text at `x`, advancing the cursor; returns the lines drawn. */
  const text = (
    raw: string,
    x: number,
    style: Style,
    opts: { maxX?: number; gap?: number } = {},
  ) => {
    const s = clean(style.font, raw);
    if (!s) return 0;
    const lineH = style.size * 1.3;
    const lines = s
      .split("\n")
      .flatMap((para) =>
        wrap(style.font, para, style.size, (opts.maxX ?? RIGHT) - x),
      );
    for (const l of lines) {
      ensure(lineH);
      y -= lineH;
      page.drawText(l, { x, y, size: style.size, font: style.font, color: style.color });
    }
    y -= opts.gap ?? 0;
    return lines.length;
  };

  const rule = (color = LINE) => {
    page.drawLine({
      start: { x: LEFT, y },
      end: { x: RIGHT, y },
      thickness: 0.6,
      color,
    });
  };

  // ----- Title block -----
  text("freshman.academy", LEFT, { font: bold, size: 8, color: BRAND });
  text("Weekly goals report", LEFT, { font: bold, size: 18, color: INK }, { gap: 4 });
  text(
    `Previous week: ${report.previousLabel}   ·   New week: ${report.newLabel}`,
    LEFT,
    { font, size: 9, color: GRAY },
  );
  text(`Generated ${report.generatedLabel} (Tashkent)`, LEFT, {
    font,
    size: 9,
    color: GRAY,
  }, { gap: 10 });
  rule(INK);
  y -= 6;

  const meta: Style = { font, size: 8, color: GRAY };

  for (const person of report.people) {
    // Keep a name with at least the first lines of its first week.
    ensure(70);
    y -= 8;
    text(person.name, LEFT, { font: bold, size: 12, color: INK });
    if (person.department) text(person.department, LEFT, meta);
    y -= 2;

    for (const week of person.weeks) {
      ensure(40);
      y -= 6;
      const head = week.range
        ? [week.heading, week.range, `${week.percent}%`, week.status]
            .filter(Boolean)
            .join("  ·  ")
        : `${week.heading}  ·  no week started`;
      const startY = y;
      text(head, LEFT + 10, { font: bold, size: 9.5, color: BRAND });
      if (week.flags.length > 0) {
        // Flags sit right-aligned on the heading's first line.
        const label = week.flags.join("  ·  ");
        const w = bold.widthOfTextAtSize(label, 8);
        page.drawText(label, {
          x: RIGHT - w,
          y: startY - 9.5 * 1.3,
          size: 8,
          font: bold,
          color: RED,
        });
      }
      if (week.range && week.goals.length === 0) {
        text("No goals.", LEFT + 22, meta);
      }

      week.goals.forEach((goal, i) => {
        ensure(30);
        y -= 4;
        const pct = goal.completed ? `Done · ${goal.percent}%` : `${goal.percent}%`;
        const pctW = bold.widthOfTextAtSize(pct, 9);
        const rowTop = y;
        text(`${i + 1}. ${goal.title}`, LEFT + 22, { font: bold, size: 9, color: INK }, {
          maxX: RIGHT - pctW - 12,
        });
        page.drawText(pct, {
          x: RIGHT - pctW,
          y: rowTop - 9 * 1.3,
          size: 9,
          font: bold,
          color: goal.percent === 100 ? GREEN : INK,
        });

        const bits = [
          goal.priority && `${goal.priority} priority`,
          goal.deadline && `Due ${goal.deadline}`,
          goal.from && `From ${goal.from}`,
          goal.sharedTo.length > 0 && `Delegated to ${goal.sharedTo.join(", ")}`,
        ].filter(Boolean);
        if (bits.length > 0) text(bits.join("  ·  "), LEFT + 34, meta);

        for (const s of goal.subtasks) {
          const extra = [
            s.from && `from ${s.from}`,
            s.sharedTo.length > 0 && `delegated to ${s.sharedTo.join(", ")}`,
          ].filter(Boolean);
          text(
            `${s.isDone ? "☑" : "☐"}  ${s.title}${extra.length ? `  (${extra.join("; ")})` : ""}`,
            LEFT + 34,
            { font, size: 8.5, color: s.isDone ? GRAY : INK },
          );
        }
        if (goal.incompleteReason) {
          text(`Reflection: ${goal.incompleteReason}`, LEFT + 34, {
            font,
            size: 8.5,
            color: RED,
          });
        }
      });
    }

    y -= 8;
    ensure(1);
    rule();
  }

  if (report.people.length === 0) {
    y -= 12;
    text("Nobody has a week in either slot yet.", LEFT, meta);
  }

  // ----- Footer: page numbers, once the count is known -----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Weekly goals report  ·  page ${i + 1} of ${pages.length}`;
    const w = font.widthOfTextAtSize(label, 7.5);
    p.drawText(label, { x: (PAGE_W - w) / 2, y: 28, size: 7.5, font, color: GRAY });
  });

  return (await doc.save()) as Uint8Array<ArrayBuffer>;
}
