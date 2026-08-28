// md_to_html.js — rebuild the official PDF source HTML from docs/MASTER_BLUEPRINT.md
// (same validated design as v1.0: Template 07 Crystal Blue cover + creative-flow body, RTL)
"use strict";
const fs = require("fs");
const path = require("path");
const { parseBlueprint } = require("./mdparse.js");

const MD = [path.resolve(__dirname, "../../aqlan-center-mini/docs/MASTER_BLUEPRINT.md"),
  path.resolve(__dirname, "../../docs/MASTER_BLUEPRINT.md")].find((p) => fs.existsSync(p));
const OUT_DIR = ["../../download", "../.."].map((d) => path.resolve(__dirname, d)).find((d) => fs.existsSync(path.join(d, "download")) || fs.existsSync(path.join(d, "docs"))) || path.resolve(__dirname, "../..");
const OUT = path.join(OUT_DIR, (fs.existsSync(path.join(OUT_DIR, "download")) ? "download/" : "") + "AQLAN_DENTAL_OS_MASTER_BLUEPRINT_v1.0.html");

const sections = parseBlueprint(MD);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function computeWidths(headers, rows, isMatrix) {
  if (isMatrix) { const first = 22, rest = Math.floor((100 - first) / (headers.length - 1)); const w = headers.map((_, i) => (i === 0 ? first : rest)); w[w.length - 1] += 100 - w.reduce((a, b) => a + b, 0); return w; }
  const lens = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || "").length)));
  const weights = lens.map((L) => Math.max(5, Math.min(42, L)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = weights.map((x) => Math.max(5, Math.round(x / sum * 100)));
  w[w.length - 1] += 100 - w.reduce((a, b) => a + b, 0);
  return w;
}
function renderTable(b) {
  const isMatrix = !!b.matrix;
  const keep = b.rows.length <= 8 ? " keep" : "";
  const cls = isMatrix ? "tbl matrix" : (b.small ? "tbl small" : "tbl");
  const widths = computeWidths(b.headers, b.rows, isMatrix);
  const cols = b.headers.map((h, i) => `<col style="width:${widths[i]}%">`).join("");
  const th = b.headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const trs = b.rows.map((r, ri) => "<tr" + (ri % 2 === 1 ? ' class="odd"' : "") + ">" + r.map((c, ci) => {
    if (isMatrix && ci > 0) { const k = c === "●" ? "full" : (c === "◐" ? "part" : "none"); return `<td class="mark ${k}">${esc(c)}</td>`; }
    return `<td>${esc(c)}</td>`;
  }).join("") + "</tr>").join("");
  return `<div class="tbl-wrap${keep}"><div class="tbl-cap">${esc(b.caption || "")}</div><table class="${cls}${keep}"><colgroup>${cols}</colgroup><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}
function renderBlocks(blocks) {
  let html = "";
  for (const b of blocks) {
    if (b.t === "p") html += `<p class="body-text">${esc(b.text)}</p>`;
    else if (b.t === "h2") html += `<h2>${esc(b.text)}</h2>`;
    else if (b.t === "h3") html += `<h3>${esc(b.text)}</h3>`;
    else if (b.t === "bullets") html += `<ul class="blist">${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    else if (b.t === "callout") html += `<div class="callout"><div class="co-title">${esc(b.title)}</div><p class="co-text">${esc(b.text)}</p></div>`;
    else if (b.t === "tree") html += `<pre class="tree" dir="ltr">${b.lines.map(esc).join("\n")}</pre>`;
    else if (b.t === "steps") html += `<ol class="steps">${b.items.map((s, i) => `<li><span class="step-n">${String(i + 1).padStart(2, "0")}</span><span>${esc(s)}</span></li>`).join("")}</ol>`;
    else if (b.t === "table") html += renderTable(b);
  }
  return html;
}

const chapterTags = sections.map((_, i) => String(i + 1).padStart(2, "0"));
let bodyHtml = "";
sections.forEach((s, idx) => {
  const title = s.appendix ? ("ملحق " + s.appendix + ": " + s.title) : (s.num + ". " + s.title);
  bodyHtml += `<div class="chapter-header"><div class="section-tag">${chapterTags[idx]}</div><h1 class="section-title">${esc(title)}</h1></div>`;
  bodyHtml += renderBlocks(s.blocks);
});
const tocItems = sections.map((s, idx) => {
  const title = s.appendix ? ("ملحق " + s.appendix + ": " + s.title) : (s.num + ". " + s.title);
  return `<div class="toc-row"><span class="toc-num">${chapterTags[idx]}</span><span class="toc-title">${esc(title)}</span></div>`;
}).join("");

const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>AQLAN DENTAL OS — MASTER BLUEPRINT v1.0</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Kufi+Arabic:wght@400;500;700;900&family=Noto+Naskh+Arabic:wght@400;500;700&display=swap" rel="stylesheet">
<style>
@page { size: 794px 1123px; margin: 0; }
html, body { margin: 0; padding: 0; width: 794px; background: #0a1628; color: #142840;
  font-family: 'Noto Naskh Arabic', 'DejaVu Sans', serif;
  line-break: strict; word-break: normal; overflow-wrap: break-word; }
.pagedjs_page { background: #f5f8fc; }
@media screen { html { background: #0a1628; display: flex; justify-content: center; } body { zoom: 0.9; margin: 16px auto; box-shadow: 0 4px 30px rgba(0,0,0,.4); } }
h1, h2, h3, .section-tag, .toc-num, .step-n, .tbl-cap, .co-title { font-family: 'Noto Kufi Arabic', 'Noto Sans Arabic', 'DejaVu Sans', sans-serif; }
.cover { position: relative; width: 794px; height: 1123px; background: #0a1628; break-after: page; overflow: hidden; }
.cover .glow-a { position: absolute; top: 40px; right: 30px; width: 420px; height: 420px; border-radius: 50%; background: radial-gradient(circle, rgba(45,122,179,0.10) 0%, rgba(45,122,179,0) 70%); }
.cover .glow-b { position: absolute; bottom: 60px; left: 40px; width: 460px; height: 460px; border-radius: 50%; background: radial-gradient(circle, rgba(77,168,218,0.08) 0%, rgba(77,168,218,0) 70%); }
.cover .frame { position: absolute; top: 80px; bottom: 80px; left: 60px; right: 60px; border: 2px solid #4da8da; }
.cover .kicker { position: absolute; top: 135px; right: 110px; left: 110px; text-align: right; font-family: 'Noto Kufi Arabic', 'DejaVu Sans', sans-serif; font-size: 14px; font-weight: 400; color: #4da8da; letter-spacing: 5px; direction: ltr; }
.cover .hero { position: absolute; top: 236px; right: 110px; max-width: 566px; text-align: right; font-family: 'Noto Kufi Arabic', 'DejaVu Sans', sans-serif; font-size: 44px; font-weight: 900; line-height: 1.22; color: #e8f0f8; text-shadow: 0 0 24px rgba(77,168,218,0.25); }
.cover .summary { position: absolute; top: 545px; right: 110px; max-width: 520px; text-align: right; font-size: 15.5px; line-height: 1.75; color: #7a9bb8; }
.cover .org { position: absolute; top: 745px; right: 110px; text-align: right; font-family: 'Noto Kufi Arabic', 'DejaVu Sans', sans-serif; font-size: 19px; font-weight: 700; color: #e8f0f8; }
.cover .meta { position: absolute; top: 786px; right: 110px; text-align: right; font-size: 13.5px; line-height: 1.9; color: #7a9bb8; }
.cover .meta b { color: #a9c3d8; font-weight: 500; }
.cover .docline { position: absolute; top: 960px; right: 110px; left: 110px; text-align: left; font-family: 'Noto Kufi Arabic', 'DejaVu Sans', sans-serif; font-size: 10.5px; letter-spacing: 3px; color: #7a9bb8; direction: ltr; }
.main-content { padding: 52px 58px 44px 58px; background: #f5f8fc; }
.toc-block { break-inside: avoid; margin-bottom: 26px; }
.toc-heading { font-size: 26px; font-weight: 900; color: #1a4a7a; margin: 6px 0 6px 0; }
.toc-sub { font-size: 12.5px; color: #5a7a96; margin-bottom: 14px; }
.toc-row { display: flex; align-items: baseline; gap: 10px; padding: 4.5px 0; border-bottom: 1px solid #dbe6f1; }
.toc-num { min-width: 30px; color: #2d7ab3; font-size: 12px; font-weight: 700; }
.toc-title { font-size: 13.5px; color: #142840; font-weight: 500; }
.chapter-header { break-after: avoid; break-inside: avoid; margin-top: 26px; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 2px solid rgba(45,122,179,0.45); }
.chapter-header:first-child { margin-top: 0; }
.section-tag { display: inline-block; font-size: 11px; font-weight: 700; color: #2d7ab3; border: 1px solid #9dc3dd; border-radius: 3px; padding: 2px 8px; margin-bottom: 7px; letter-spacing: 1px; direction: ltr; }
.section-title { font-size: 23px; font-weight: 900; color: #1a4a7a; margin: 0 0 6px 0; line-height: 1.35; }
h2 { font-size: 17px; font-weight: 700; color: #2d7ab3; margin: 20px 0 8px 0; break-after: avoid; }
h3 { font-size: 14.5px; font-weight: 700; color: #1a4a7a; margin: 14px 0 6px 0; break-after: avoid; }
.body-text { font-size: 13.5px; line-height: 1.85; text-align: justify; margin: 0 0 10px 0; color: #142840; }
ul.blist { margin: 2px 0 12px 0; padding-right: 20px; padding-left: 0; }
ul.blist li { font-size: 13.5px; line-height: 1.8; margin-bottom: 5px; text-align: right; break-inside: avoid; }
ul.blist li::marker { color: #2d7ab3; }
.callout { background: #e4ecf5; border-right: 4px solid #2d7ab3; border-radius: 4px; padding: 12px 16px; margin: 12px 0 14px 0; break-inside: avoid; }
.co-title { font-size: 13.5px; font-weight: 700; color: #1a4a7a; margin-bottom: 4px; }
.co-text { font-size: 13px; line-height: 1.8; margin: 0; text-align: justify; }
pre.tree { direction: ltr; text-align: left; background: #eef3fa; border: 1px solid #dbe6f1; border-radius: 4px; font-family: 'DejaVu Sans Mono', 'Consolas', monospace; font-size: 11.5px; line-height: 1.5; padding: 12px 16px; margin: 10px 0 14px 0; break-inside: avoid; color: #142840; }
ol.steps { list-style: none; margin: 4px 0 14px 0; padding: 0; }
ol.steps li { display: flex; align-items: baseline; gap: 10px; padding: 4px 0; break-inside: avoid; border-bottom: 1px dashed #dbe6f1; font-size: 13.5px; }
.step-n { min-width: 28px; color: #2d7ab3; font-weight: 700; font-size: 12px; }
.tbl-wrap { margin: 12px 0 16px 0; }
.tbl-cap { font-size: 12px; font-weight: 700; color: #1a4a7a; margin-bottom: 6px; break-after: avoid; }
table.tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.tbl thead { display: table-header-group; }
table.tbl tr { break-inside: avoid; }
table.tbl th { background: #1a4a7a; color: #ffffff; font-family: 'Noto Kufi Arabic', sans-serif; font-size: 11.5px; font-weight: 700; padding: 7px 7px; text-align: right; border: 1px solid #1a4a7a; }
table.tbl td { font-size: 12px; line-height: 1.65; padding: 6px 7px; text-align: right; border: 1px solid #c0d0e2; vertical-align: top; overflow-wrap: break-word; }
table.tbl tbody tr.odd td { background: #eef3fa; }
table.tbl.small th { font-size: 10.5px; padding: 5px 5px; }
table.tbl.small td { font-size: 11px; padding: 4.5px 5px; }
table.tbl.keep { break-inside: avoid; }
table.tbl.matrix th { font-size: 10px; padding: 4px 2px; text-align: center; }
table.tbl.matrix td { font-size: 11px; padding: 3px 2px; }
table.tbl.matrix td:first-child { font-size: 10.5px; font-weight: 500; }
td.mark { text-align: center !important; font-weight: 700; }
td.mark.full { color: #1a7a4a; }
td.mark.part { color: #2d7ab3; }
td.mark.none { color: #9aa9b8; }
.ending { position: relative; width: 794px; height: 1123px; background: #0a1628; break-before: page; overflow: hidden; }
.ending .frame { position: absolute; top: 80px; bottom: 80px; left: 60px; right: 60px; border: 2px solid #4da8da; }
.ending .glow-a { position: absolute; bottom: 80px; right: 60px; width: 440px; height: 440px; border-radius: 50%; background: radial-gradient(circle, rgba(45,122,179,0.10) 0%, rgba(45,122,179,0) 70%); }
.ending .inner { position: absolute; top: 200px; right: 110px; left: 110px; }
.ending .etitle { font-family: 'Noto Kufi Arabic', sans-serif; font-size: 30px; font-weight: 900; color: #e8f0f8; text-align: right; margin-bottom: 10px; }
.ending .esub { font-size: 14px; color: #7a9bb8; text-align: right; line-height: 1.8; margin-bottom: 30px; }
.principle { display: flex; align-items: baseline; gap: 12px; padding: 11px 0; border-bottom: 1px solid rgba(122,155,184,0.25); }
.principle .pn { min-width: 34px; font-family: 'Noto Kufi Arabic', sans-serif; font-size: 13px; font-weight: 700; color: #4da8da; direction: ltr; text-align: left; }
.principle .pt { font-family: 'Noto Kufi Arabic', sans-serif; font-size: 15.5px; font-weight: 700; color: #e8f0f8; }
.principle .pd { font-size: 12px; color: #7a9bb8; margin-right: auto; text-align: left; direction: ltr; }
.ending .efoot { position: absolute; top: 960px; right: 110px; left: 110px; text-align: center; font-family: 'Noto Kufi Arabic', sans-serif; font-size: 11px; letter-spacing: 3px; color: #7a9bb8; direction: ltr; }
</style>
</head>
<body>
<div class="cover">
  <div class="glow-a"></div><div class="glow-b"></div><div class="frame"></div>
  <div class="kicker">AQLAN DENTAL OS — MASTER BLUEPRINT</div>
  <div class="hero">الخطة المرجعية الشاملة لبناء نظام مركز الدكتور عقلان الكامل</div>
  <div class="summary">وثيقة PRD / Master Plan رسمية تثبت الرؤية والمبادئ الحاكمة والوحدات التسع والأربعين ونموذج البيانات وخارطة البناء من أربع عشرة مرحلة ومصفوفة الصلاحيات — الدستور الهندسي الملزم لمشروع aqlan-center-mini، مبنية على مراجعة النظام السابق ومقارنة الأنظمة العالمية.</div>
  <div class="org">مركز الدكتور عقلان لطب الأسنان</div>
  <div class="meta"><div><b>الإصدار:</b> 1.0 — معتمدة كمرجع نهائي</div><div><b>التاريخ:</b> 28 أغسطس 2026م</div><div><b>النطاق:</b> التشغيل، السريري، المالية، المعامل، الإدارة</div></div>
  <div class="docline">ONE PATIENT RECORD · ONE WORKFLOW · ONE SOURCE OF TRUTH</div>
</div>
<div class="main-content">
  <div class="toc-block">
    <div class="toc-heading">المحتويات</div>
    <div class="toc-sub">أربعة عشر قسمًا وأربعة ملاحق — تُدار أي إضافة عبر حوكمة الوثيقة (القسم 11)</div>
    ${tocItems}
  </div>
  ${bodyHtml}
</div>
<div class="ending">
  <div class="glow-a"></div><div class="frame"></div>
  <div class="inner">
    <div class="etitle">الخلاصة الحاكمة</div>
    <div class="esub">خمسة مبادئ تُحكم بها كل قرارات البرمجة: ما خدمها يُقبل، وما خالفها يُرفض.</div>
    <div class="principle"><span class="pn">P1</span><span class="pt">سجل مريض واحد</span><span class="pd">One Patient Record</span></div>
    <div class="principle"><span class="pn">P2</span><span class="pt">مسار سريري واحد</span><span class="pd">One Clinical Workflow</span></div>
    <div class="principle"><span class="pn">P3</span><span class="pt">مصدر حقيقة مالي واحد</span><span class="pd">One Financial Source of Truth</span></div>
    <div class="principle"><span class="pn">P4</span><span class="pt">قواعد أعمال مركزية</span><span class="pd">Central Business Rules</span></div>
    <div class="principle"><span class="pn">P5</span><span class="pt">تاريخ واحد قابل للتدقيق</span><span class="pd">One Auditable History</span></div>
  </div>
  <div class="efoot">AQLAN DENTAL OS · MASTER BLUEPRINT · V1.0 · 2026</div>
</div>
</body>
</html>`;

fs.writeFileSync(OUT, html, "utf8");
console.log("HTML written:", OUT, html.length, "chars");
