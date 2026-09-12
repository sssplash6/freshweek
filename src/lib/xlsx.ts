// A single-sheet .xlsx writer, in about two hundred lines and no dependency.
//
// CSV was the obvious first answer — the payroll panel already hands finance
// one — but a roster is mostly phone numbers and handles, and those are
// exactly what a spreadsheet ruins on the way in: Excel reads "+998900000000"
// as a formula, and "0071" as the number 71. An .xlsx says "this cell is
// text" in the file itself, so what you exported is what opens.
//
// The format is a ZIP of XML parts. The only awkward piece is the ZIP, and
// only because compression usually means shipping a DEFLATE implementation —
// so these entries are *stored* (method 0), which the spec allows and Excel
// reads happily. A roster of a few hundred people lands in tens of kilobytes,
// and the alternative costs a megabyte of library to save a few of them.

/** One column of the sheet: its heading, and how wide to open it. */
export type XlsxColumn = {
  header: string;
  /** Width in characters. Left to Excel's default when omitted. */
  width?: number;
};

const TEXT = new TextEncoder();

// ---------------------------------------------------------------- XML pieces

/** The five characters that must become entities between XML tags. */
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Tab, newline and carriage return — the only control codes XML 1.0 allows. */
const LEGAL_CONTROL = new Set([9, 10, 13]);

/**
 * One string, safe to drop between XML tags. Anything below a space that isn't
 * one of those three is not legal in XML 1.0 at all — no escape for it exists —
 * and a single stray one pasted into a profile field would make the whole
 * workbook unopenable, so those are dropped rather than escaped. Stripping is
 * written as a loop over code points rather than a regex of control-character
 * escapes, which tools along the way have a habit of turning into the raw
 * bytes they stand for.
 */
function esc(value: string): string {
  let cleaned = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 || LEGAL_CONTROL.has(code)) cleaned += ch;
  }
  return cleaned.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** 0 → "A", 25 → "Z", 26 → "AA" — the letter half of a cell reference. */
function columnName(index: number): string {
  let name = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    name = String.fromCharCode(65 + (n % 26)) + name;
  }
  return name;
}

/**
 * One cell, always as an inline string. Inline rather than the usual shared
 * string table because a table is a second part to keep in sync for a saving
 * that only shows up when the same text repeats thousands of times; a string
 * rather than a number because every column here is an identifier — a phone,
 * a handle, an email — that means nothing arithmetic.
 */
function cell(ref: string, value: string, styleId: number): string {
  const style = styleId > 0 ? ` s="${styleId}"` : "";
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/** Excel rejects these in a sheet name outright, and stops reading past 31. */
function sheetTitle(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim();
  return (cleaned || "Sheet1").slice(0, 31);
}

// -------------------------------------------------------------------- the ZIP

/** CRC-32 (IEEE) — the checksum every ZIP entry carries. Table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A growable little-endian byte buffer — the whole ZIP is written into one. */
class Bytes {
  private chunks: Uint8Array[] = [];
  length = 0;

  raw(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(n: number): void {
    this.raw(new Uint8Array([n & 0xff, (n >>> 8) & 0xff]));
  }

  u32(n: number): void {
    this.raw(
      new Uint8Array([
        n & 0xff,
        (n >>> 8) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 24) & 0xff,
      ]),
    );
  }

  join(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/** The clock a ZIP entry is stamped with: MS-DOS date and time, 2s resolution. */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

type Entry = { name: string; data: Uint8Array };

/** The named parts, packed into one stored (uncompressed) ZIP archive. */
function zip(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const out = new Bytes();
  const { time, date } = dosStamp(new Date());
  const directory: {
    name: Uint8Array;
    crc: number;
    size: number;
    at: number;
  }[] = [];

  for (const entry of entries) {
    const name = TEXT.encode(entry.name);
    const crc = crc32(entry.data);
    directory.push({ name, crc, size: entry.data.length, at: out.length });

    out.u32(0x04034b50); // local file header
    out.u16(20); // version needed
    out.u16(0x0800); // flags: names are UTF-8
    out.u16(0); // method: stored
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(entry.data.length); // compressed size == uncompressed, stored
    out.u32(entry.data.length);
    out.u16(name.length);
    out.u16(0); // no extra field
    out.raw(name);
    out.raw(entry.data);
  }

  const directoryAt = out.length;
  for (const item of directory) {
    out.u32(0x02014b50); // central directory header
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(0x0800);
    out.u16(0);
    out.u16(time);
    out.u16(date);
    out.u32(item.crc);
    out.u32(item.size);
    out.u32(item.size);
    out.u16(item.name.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk number
    out.u16(0); // internal attrs
    out.u32(0); // external attrs
    out.u32(item.at);
    out.raw(item.name);
  }

  // Measured before the trailer below goes in — the trailer is not part of the
  // directory it describes, and counting it corrupts the archive by 12 bytes.
  const directorySize = out.length - directoryAt;

  out.u32(0x06054b50); // end of central directory
  out.u16(0);
  out.u16(0);
  out.u16(directory.length);
  out.u16(directory.length);
  out.u32(directorySize);
  out.u32(directoryAt);
  out.u16(0); // no archive comment
  return out.join();
}

// -------------------------------------------------------------- the workbook

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/**
 * Two cell formats: plain, and the bold one the header row wears. Excel is
 * strict about this part even when it's nearly empty — the fills list has to
 * start with `none` then `gray125` in that order, and the fonts and borders
 * have to exist to be referenced, or it declares the file corrupt.
 */
const STYLES = `${XML_HEAD}
<styleSheet xmlns="${MAIN}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * One sheet of text, as an .xlsx file. The header row is bold, frozen and
 * carries the filter dropdowns, so a long roster stays readable the moment it
 * opens rather than after the reader sets that up by hand.
 */
export function buildXlsx(opts: {
  sheetName: string;
  columns: XlsxColumn[];
  rows: string[][];
}): Blob {
  const { columns, rows } = opts;

  const cols = columns
    .map((c, i) =>
      c.width
        ? `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`
        : "",
    )
    .join("");

  const header = `<row r="1">${columns
    .map((c, i) => cell(`${columnName(i)}1`, c.header, 1))
    .join("")}</row>`;

  const body = rows
    .map((row, r) => {
      const n = r + 2; // 1-based, and the header holds row 1
      const cells = columns
        .map((_, i) => cell(`${columnName(i)}${n}`, row[i] ?? "", 0))
        .join("");
      return `<row r="${n}">${cells}</row>`;
    })
    .join("");

  const span = `A1:${columnName(columns.length - 1)}${rows.length + 1}`;
  // Order matters to the schema here: cols before sheetData, autoFilter after.
  const sheet = `${XML_HEAD}
<worksheet xmlns="${MAIN}">
<dimension ref="${span}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ""}
<sheetData>${header}${body}</sheetData>
<autoFilter ref="${span}"/>
</worksheet>`;

  const workbook = `${XML_HEAD}
<workbook xmlns="${MAIN}" xmlns:r="${REL}">
<sheets><sheet name="${esc(sheetTitle(opts.sheetName))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const parts: Entry[] = [
    {
      name: "[Content_Types].xml",
      data: TEXT.encode(`${XML_HEAD}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    },
    {
      name: "_rels/.rels",
      data: TEXT.encode(`${XML_HEAD}
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    { name: "xl/workbook.xml", data: TEXT.encode(workbook) },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: TEXT.encode(`${XML_HEAD}
<Relationships xmlns="${PKG_REL}">
<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>
</Relationships>`),
    },
    { name: "xl/styles.xml", data: TEXT.encode(STYLES) },
    { name: "xl/worksheets/sheet1.xml", data: TEXT.encode(sheet) },
  ];

  return new Blob([zip(parts)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** Hand a built workbook to the browser as a download. */
export function downloadXlsx(blob: Blob, filename: string): void {
  // An object URL rather than a data: URL — a full roster comfortably outruns
  // the length ceiling a data: URL has to live under.
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
