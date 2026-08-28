// md_to_docx.js — rebuild the official Word document from docs/MASTER_BLUEPRINT.md
// (same validated layout as v1.0: R1 cover RTL + MC-1, 3 sections, real TOC)
"use strict";

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, PageNumber, NumberFormat, AlignmentType, HeadingLevel,
  WidthType, BorderStyle, ShadingType, SectionType, TableOfContents,
  PageBreak, TableLayoutType,
} = require("docx");
const fs = require("fs");
const path = require("path");
const { parseBlueprint } = require("./mdparse.js");

const MD = [path.resolve(__dirname, "../../aqlan-center-mini/docs/MASTER_BLUEPRINT.md"),
  path.resolve(__dirname, "../../docs/MASTER_BLUEPRINT.md")].find((p) => fs.existsSync(p));
const OUT_DIR = ["../../download", "../.."].map((d) => path.resolve(__dirname, d)).find((d) => fs.existsSync(path.join(d, "download")) || fs.existsSync(path.join(d, "docs"))) || path.resolve(__dirname, "../..");
const OUT = path.join(OUT_DIR, (fs.existsSync(path.join(OUT_DIR, "download")) ? "download/" : "") + "AQLAN_DENTAL_OS_MASTER_BLUEPRINT_v1.0.docx");

const P = {
  bg: "F5F8FC", primary: "1A5276", accent: "2E86C1",
  cover: { titleColor: "1A5276", subtitleColor: "606060", metaColor: "707070", footerColor: "A0A0A0" },
  table: { headerBg: "2E86C1", headerText: "FFFFFF", accentLine: "1A5276", innerLine: "D0DDE8", surface: "EDF3F8" },
  body: "000000",
};
const F_AR = "Sakkal Majalla";
const F_LAT = "Times New Roman";
const F_MONO = "Consolas";
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

function safeText(v, ph) { return (v === undefined || v === null || v === "" || String(v) === "NaN") ? (ph || "【يرجى التعبئة】") : String(v); }
function arRun(text, o = {}) {
  const size = o.size || 26;
  return new TextRun({ text: safeText(text), rightToLeft: true, font: { ascii: F_LAT, hAnsi: F_LAT, cs: F_AR },
    size, sizeComplexScript: size, bold: !!o.bold, boldComplexScript: !!o.bold, italics: !!o.italics, color: o.color || P.body });
}
function latRun(text, o = {}) {
  const size = o.size || 26;
  return new TextRun({ text: safeText(text), font: { ascii: o.mono ? F_MONO : F_LAT, hAnsi: o.mono ? F_MONO : F_LAT, cs: o.mono ? F_MONO : F_AR },
    size, sizeComplexScript: size, bold: !!o.bold, boldComplexScript: !!o.bold, color: o.color || P.body });
}
function pAr(children, o = {}) {
  return new Paragraph({ bidirectional: true, alignment: o.alignment || AlignmentType.JUSTIFIED,
    spacing: Object.assign({ line: 312 }, o.spacing || {}), indent: o.indent, keepNext: !!o.keepNext, heading: o.heading, children });
}
function bodyP(text, o = {}) { return pAr([arRun(text, { size: o.size || 26 })], { spacing: { after: 140, line: 312 } }); }

// content-aware column widths (chars → percentage)
function computeWidths(headers, rows, isMatrix) {
  if (isMatrix) { const first = 22, rest = Math.floor((100 - first) / (headers.length - 1)); const w = headers.map((_, i) => (i === 0 ? first : rest)); w[w.length - 1] += 100 - w.reduce((a, b) => a + b, 0); return w; }
  const lens = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || "").length)));
  const weights = lens.map((L) => Math.max(5, Math.min(42, L)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = weights.map((x) => Math.max(5, Math.round(x / sum * 100)));
  w[w.length - 1] += 100 - w.reduce((a, b) => a + b, 0);
  return w;
}

// cover title layout (design-system calcTitleLayout, width-aware)
function charWidthTw(ch, pt) { const c = ch.codePointAt(0); if (c >= 0x0600 && c <= 0x06FF) return pt * 13; if (ch === " ") return pt * 7; return pt * 11; }
function estW(text, pt) { let w = 0; for (const ch of text) w += charWidthTw(ch, pt); return w; }
function splitLines(title, maxW, pt) {
  const words = title.split(" "); const lines = []; let cur = "";
  for (const wd of words) { const cand = cur ? cur + " " + wd : wd; if (estW(cand, pt) <= maxW || !cur) cur = cand; else { lines.push(cur); cur = wd; } }
  if (cur) lines.push(cur);
  if (lines.length > 1 && [...lines[lines.length - 1]].length <= 2) { const last = lines.pop(); lines[lines.length - 1] += " " + last; }
  return lines;
}
function calcTitleLayout(title, maxW, pref = 40, min = 24) {
  let pt = pref, lines;
  while (pt >= min) { lines = splitLines(title, maxW, pt); if (lines.length <= 3 && lines.every((l) => estW(l, pt) <= maxW)) break; pt -= 2; }
  if (!lines || lines.length > 3) { lines = splitLines(title, maxW, min); pt = min; }
  return { titlePt: pt, titleLines: lines };
}
function calcCoverSpacing(p) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false, metaLineCount = 0, fixedHeight = 800, pageHeight = 16838 } = p;
  const usable = pageHeight - 1200;
  const content = titleLineCount * (titlePt * 23 + 200) + (hasSubtitle ? 876 : 0) + (hasEnglishLabel ? 807 : 0) + metaLineCount * 330 + fixedHeight + 900;
  const rem = Math.max(usable - content, 400);
  const bottom = Math.max(Math.floor(rem * 0.45), 800);
  const top = Math.max(Math.floor(rem * 0.45) - Math.max(0, 800 - Math.floor(rem * 0.45)), 400);
  return { topSpacing: top, bottomSpacing: bottom };
}

function buildCoverR1RTL(config) {
  const padL = 1200, padR = 800;
  const { titlePt, titleLines } = calcTitleLayout(config.title, 11906 - padL - padR - 300, 40, 24);
  const sp = calcCoverSpacing({ titleLineCount: titleLines.length, titlePt, hasSubtitle: true, hasEnglishLabel: true, metaLineCount: (config.metaLines || []).length, fixedHeight: 400 });
  const children = [];
  children.push(new Paragraph({ spacing: { before: sp.topSpacing } }));
  children.push(new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, indent: { left: padL, right: padR }, spacing: { after: 500, line: 312 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
    children: [new TextRun({ text: config.englishLabel, size: 18, sizeComplexScript: 18, characterSpacing: 60, color: P.accent, font: { ascii: "Calibri", hAnsi: "Calibri", cs: F_AR } })] }));
  for (let i = 0; i < titleLines.length; i++) {
    children.push(pAr([arRun(titleLines[i], { size: titlePt * 2, bold: true, color: P.cover.titleColor })], { alignment: AlignmentType.RIGHT,
      indent: { left: padL, right: padR }, spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" } }));
  }
  children.push(pAr([arRun(config.subtitle, { size: 26, color: P.cover.subtitleColor })], { alignment: AlignmentType.RIGHT, indent: { left: padL, right: padR }, spacing: { after: 800, line: 360, lineRule: "atLeast" } }));
  for (const line of (config.metaLines || [])) {
    children.push(pAr([latRun("— ", { size: 24, color: P.accent, bold: true }), arRun(line, { size: 24, color: P.cover.metaColor })],
      { alignment: AlignmentType.RIGHT, indent: { left: padL, right: padR }, spacing: { after: 80, line: 312 } }));
  }
  children.push(new Paragraph({ spacing: { before: sp.bottomSpacing } }));
  children.push(new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, indent: { left: padL, right: padR }, spacing: { before: 200, line: 312 },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    children: [arRun(config.footerLeft || "", { size: 16, color: P.cover.footerColor }), latRun("        ", { size: 16 }), latRun(config.footerRight || "", { size: 16, color: P.cover.footerColor })] }));
  return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED, borders: allNoBorders, visuallyRightToLeft: true,
    rows: [new TableRow({ height: { value: 16838, rule: "exact" }, children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders, verticalAlign: "top", children })] })] })];
}

function heading1(text) { return pAr([arRun(text, { size: 34, bold: true, color: P.primary })], { heading: HeadingLevel.HEADING_1, alignment: AlignmentType.RIGHT, spacing: { before: 400, after: 180, line: 400, lineRule: "atLeast" }, keepNext: true }); }
function heading2(text) { return pAr([arRun(text, { size: 29, bold: true, color: P.primary })], { heading: HeadingLevel.HEADING_2, alignment: AlignmentType.RIGHT, spacing: { before: 280, after: 130, line: 350, lineRule: "atLeast" }, keepNext: true }); }
function heading3(text) { return pAr([arRun(text, { size: 26, bold: true, color: "1F5E86" })], { heading: HeadingLevel.HEADING_3, alignment: AlignmentType.RIGHT, spacing: { before: 220, after: 110, line: 312 }, keepNext: true }); }
function bulletP(text) { return pAr([arRun("•  ", { size: 26, color: P.accent, bold: true }), arRun(text, { size: 26 })], { alignment: AlignmentType.JUSTIFIED, indent: { left: 340, hanging: 220 }, spacing: { after: 90, line: 312 } }); }
function captionP(text) { return pAr([arRun(text, { size: 21, bold: true, color: P.primary })], { alignment: AlignmentType.RIGHT, spacing: { before: 160, after: 90, line: 312 }, keepNext: true }); }
function calloutBlock(title, text) {
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED, visuallyRightToLeft: true,
    borders: { top: { style: BorderStyle.SINGLE, size: 6, color: P.accent }, bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent }, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB },
    rows: [new TableRow({ cantSplit: true, children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill: P.table.surface }, margins: { top: 120, bottom: 120, left: 200, right: 200 },
      children: [pAr([arRun(title, { size: 24, bold: true, color: P.primary })], { alignment: AlignmentType.RIGHT, spacing: { after: 60, line: 312 } }),
                 pAr([arRun(text, { size: 24 })], { alignment: AlignmentType.JUSTIFIED, spacing: { line: 312 } })] })] })] });
}
function treeBlock(lines) {
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED,
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: P.table.innerLine }, bottom: { style: BorderStyle.SINGLE, size: 4, color: P.table.innerLine }, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB },
    rows: [new TableRow({ cantSplit: true, children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill: "F7FAFD" }, margins: { top: 120, bottom: 120, left: 260, right: 260 },
      children: lines.map((ln, i) => new Paragraph({ alignment: AlignmentType.LEFT, spacing: { line: 276, lineRule: "atLeast", after: i === lines.length - 1 ? 0 : 10 }, children: [latRun(ln, { size: 19, mono: true, color: "1E2E40" })] })) })] })] });
}
function stepsBlock(items) {
  return items.map((s, i) => pAr([latRun(String(i + 1).padStart(2, "0") + "  ", { size: 24, bold: true, color: P.accent }), arRun(s, { size: 25 })],
    { alignment: AlignmentType.RIGHT, indent: { left: 360, hanging: 360 }, spacing: { after: 50, line: 312 } }));
}
function dataTable(b) {
  const isMatrix = !!b.matrix;
  const small = !!b.small || isMatrix;
  const headSize = isMatrix ? 15 : 20;
  const cellSize = isMatrix ? 16 : (small ? 19 : 21);
  const widths = b.widths;
  const headerRow = new TableRow({ tableHeader: true, cantSplit: true, children: b.headers.map((h, i) => new TableCell({
    width: { size: widths[i], type: WidthType.PERCENTAGE }, shading: { type: ShadingType.CLEAR, fill: P.table.headerBg },
    margins: { top: isMatrix ? 40 : 70, bottom: isMatrix ? 40 : 70, left: 80, right: 80 },
    children: [pAr(isMatrix ? [latRun(h, { size: headSize, bold: true, color: P.table.headerText })] : [arRun(h, { size: headSize, bold: true, color: P.table.headerText })],
      { alignment: isMatrix ? AlignmentType.CENTER : AlignmentType.RIGHT, spacing: { line: 240, lineRule: "atLeast" } })] })) });
  const zebra = b.rows.length > 6;
  const dataRows = b.rows.map((row, ri) => new TableRow({ cantSplit: true, children: row.map((cell, ci) => {
    const isMark = isMatrix && ci > 0;
    const hasLatin = /[A-Za-z0-9]/.test(cell) && !/[\u0600-\u06FF]/.test(cell);
    const runs = isMark ? [latRun(cell, { size: cellSize, bold: cell !== "—", color: cell === "—" ? "9AA6B2" : (cell === "◐" ? P.primary : "1A7A4A") })]
      : (hasLatin ? [latRun(cell, { size: cellSize })] : [arRun(cell, { size: cellSize })]);
    return new TableCell({ width: { size: widths[ci], type: WidthType.PERCENTAGE },
      shading: (zebra && ri % 2 === 1) ? { type: ShadingType.CLEAR, fill: P.table.surface } : undefined,
      margins: { top: isMatrix ? 30 : 55, bottom: isMatrix ? 30 : 55, left: 80, right: 80 },
      children: [pAr(runs, { alignment: isMark ? AlignmentType.CENTER : AlignmentType.RIGHT, spacing: { line: isMatrix ? 230 : 260, lineRule: "atLeast" } })] });
  }) }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED, visuallyRightToLeft: true,
    borders: { top: { style: BorderStyle.SINGLE, size: 6, color: P.table.accentLine }, bottom: { style: BorderStyle.SINGLE, size: 6, color: P.table.accentLine }, left: NB, right: NB,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: P.table.innerLine }, insideVertical: isMatrix ? { style: BorderStyle.SINGLE, size: 2, color: P.table.innerLine } : NB },
    rows: [headerRow, ...dataRows] });
}
function renderBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.t === "p") out.push(bodyP(b.text));
    else if (b.t === "h2") out.push(heading2(b.text));
    else if (b.t === "h3") out.push(heading3(b.text));
    else if (b.t === "bullets") b.items.forEach((it) => out.push(bulletP(it)));
    else if (b.t === "callout") { out.push(calloutBlock(b.title, b.text)); out.push(new Paragraph({ spacing: { after: 60 } })); }
    else if (b.t === "tree") { out.push(treeBlock(b.lines)); out.push(new Paragraph({ spacing: { after: 60 } })); }
    else if (b.t === "steps") stepsBlock(b.items).forEach((x) => out.push(x));
    else if (b.t === "table") {
      const t = Object.assign({}, b, { widths: computeWidths(b.headers, b.rows, !!b.matrix) });
      if (t.caption) out.push(captionP(t.caption));
      out.push(dataTable(t));
      out.push(new Paragraph({ spacing: { after: 80 } }));
    }
  }
  return out;
}

const sections = parseBlueprint(MD);
const bodyChildren = [];
for (const s of sections) {
  bodyChildren.push(heading1(s.appendix ? ("ملحق " + s.appendix + ": " + s.title) : (s.num + ". " + s.title)));
  bodyChildren.push(...renderBlocks(s.blocks));
}

const frontChildren = [
  new Paragraph({ bidirectional: true, alignment: AlignmentType.CENTER, spacing: { before: 300, after: 240, line: 480, lineRule: "atLeast" }, children: [arRun("الملخص التنفيذي", { size: 34, bold: true, color: P.primary })] }),
  bodyP("تثبت هذه الوثيقة الخطة المرجعية الشاملة (Master Blueprint) لبناء نظام مركز الدكتور عقلان الكامل، بوصفها الدستور الهندسي الملزم لكل قرار تطوير قادم. تنطلق الوثيقة من رؤية واحدة: منصة تشغيل متكاملة — لا مجرد برنامج مرضى أو حسابات — تعمل بقاعدة بيانات واحدة ومنطق أعمال واحد على كل الواجهات الحالية والمستقبلية. وتقوم على خمسة مبادئ حاكمة: سجل مريض واحد، ومسار سريري واحد، ومصدر حقيقة مالي واحد، وقواعد أعمال مركزية، وتاريخ واحد قابل للتدقيق."),
  bodyP("تنظم الوثيقة النظام في ست مناطق رئيسية تضم 49 وحدة موثقة بالجدول الرسمي، وتفصل مواصفات كل وحدة من التسجيل والجدولة والزيارات السريرية إلى المالية متعددة العملات وجلسات الصندوق والسندات الثابتة والمعامل والموردين والعمولات والمحاسبة والمخزون. كما تثبت نموذج البيانات الأساسي واصطلاحاته وممنوعاته، وخريطة العلاقات الحاكمة بين المجالات الاثني عشر، وقواعد المعاملات والتزامن وعدم التكرار والاختبارات."),
  bodyP("وتنتهي الوثيقة إلى خارطة بناء من أربع عشرة مرحلة مع قاعدة قبول صارمة لكل مرحلة، وقراءة واقعية لما أنجزناه فعلًا في aqlan-center-mini وما تبقى، ثم مصفوفة صلاحيات كاملة بعشرة أدوار، وقوائم التقارير والطباعة. تُعلَّق قائمة «ما لا نفعله» أعلى كل Pull Request، وتُدار أي تعديل على هذه الخطة عبر حوكمة واضحة تحفظها مرجعًا نهائيًا واحدًا."),
  new Paragraph({ bidirectional: true, alignment: AlignmentType.CENTER, spacing: { before: 400, after: 300, line: 400, lineRule: "atLeast" }, children: [arRun("المحتويات", { size: 34, bold: true, color: P.primary })] }),
  new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
  new Paragraph({ bidirectional: true, spacing: { before: 200, line: 312 }, children: [arRun("ملاحظة: هذا الفهرس مولد بحقول تلقائية؛ لضمان دقة أرقام الصفحات بعد أي تعديل، انقر بزر الفأرة الأيمن على الفهرس ثم اختر «تحديث الحقل» ثم «تحديث الجدول بأكمله».", { size: 18, italics: true, color: "888888" })] }),
  new Paragraph({ children: [new PageBreak()] }),
];
function pageNumFooter() {
  return new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { line: 240 }, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080", font: { ascii: F_LAT, hAnsi: F_LAT, cs: F_AR } })] })] });
}
function docHeader() {
  return new Header({ children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.CENTER, spacing: { line: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: P.table.innerLine, space: 4 } }, children: [arRun("AQLAN DENTAL OS — الخطة المرجعية الشاملة (إصدار 1.0)", { size: 18, color: "808080" })] })] });
}
const pgSize = { width: 11906, height: 16838 };
const pgMargin = { top: 1440, bottom: 1440, left: 1417, right: 1701 };
const doc = new Document({
  title: "AQLAN DENTAL OS — MASTER BLUEPRINT v1.0", subject: "الخطة المرجعية الشاملة لبناء نظام مركز الدكتور عقلان",
  creator: "مركز الدكتور عقلان لطب الأسنان", description: "الوثيقة المرجعية الحاكمة لمشروع aqlan-center-mini — مولدة من docs/MASTER_BLUEPRINT.md",
  styles: { default: {
    document: { run: { font: { ascii: F_LAT, hAnsi: F_LAT, cs: F_AR }, size: 26, sizeComplexScript: 26, color: P.body }, paragraph: { spacing: { line: 312 } } },
    heading1: { run: { font: { ascii: F_LAT, hAnsi: F_LAT, cs: F_AR }, size: 34, sizeComplexScript: 34, bold: true, color: P.primary }, paragraph: { spacing: { before: 400, after: 180, line: 400 }, outlineLevel: 0 } },
    heading2: { run: { font: { ascii: F_LAT, hAnsi: F_LAT, cs: F_AR }, size: 29, sizeComplexScript: 29, bold: true, color: P.primary }, paragraph: { spacing: { before: 280, after: 130, line: 350 }, outlineLevel: 1 } },
    heading3: { run: { font: { ascii: F_LAT, hAnsi: F_LAT, cs: F_AR }, size: 26, sizeComplexScript: 26, bold: true, color: "1F5E86" }, paragraph: { spacing: { before: 220, after: 110, line: 312 }, outlineLevel: 2 } },
  } },
  sections: [
    { properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } }, children: buildCoverR1RTL({
      englishLabel: "AQLAN DENTAL OS  ·  MASTER BLUEPRINT",
      title: "الخطة المرجعية الشاملة لبناء نظام مركز الدكتور عقلان الكامل",
      subtitle: "وثيقة PRD / Master Plan — الدستور الهندسي الملزم لمشروع aqlan-center-mini",
      metaLines: ["الإصدار: 1.0 — معتمدة كمرجع نهائي للمشروع", "التاريخ: 28 أغسطس 2026م", "النطاق: منصة التشغيل المتكاملة للمركز — سريريًا وماليًا وإداريًا", "المنهج: مبادئ الأنظمة العالمية مكيّفة لواقع مركز الدكتور عقلان"],
      footerLeft: "مركز الدكتور عقلان لطب الأسنان", footerRight: "AQLAN DENTAL OS · 2026" }) },
    { properties: { type: SectionType.NEXT_PAGE, page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } } }, footers: { default: pageNumFooter() }, children: frontChildren },
    { properties: { type: SectionType.NEXT_PAGE, page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } }, headers: { default: docHeader() }, footers: { default: pageNumFooter() }, children: bodyChildren },
  ],
});
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log("DOCX written:", OUT, buf.length, "bytes"); }).catch((e) => { console.error(e); process.exit(1); });
