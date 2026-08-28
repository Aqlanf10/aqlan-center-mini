// mdparse.js — parse docs/MASTER_BLUEPRINT.md (our own regular MD subset) into the
// block model consumed by md_to_docx.js / md_to_html.js. Single durable source = repo.
"use strict";
const fs = require("fs");

function parseBlueprint(mdPath) {
  const raw = fs.readFileSync(mdPath, "utf8").split(/\r?\n/);
  // skip everything before the first "## " (title, subtitle, meta table)
  let i = 0;
  while (i < raw.length && !raw[i].startsWith("## ")) i++;

  const sections = [];
  let cur = null;
  let para = [];
  let listB = [];      // "- " bullets
  let listN = [];      // "1. " numbered (steps)
  let inFence = false;
  let fence = [];
  let pendingCaption = null;
  let tableBuf = [];

  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    para = [];
    if (/^\*\*(.+)\*\*$/.test(text)) { pendingCaption = text.replace(/^\*\*|\*\*$/g, ""); return; }
    cur.blocks.push({ t: "p", text });
  };
  const flushLists = () => {
    if (listB.length) { cur.blocks.push({ t: "bullets", items: listB.splice(0) }); }
    if (listN.length) { cur.blocks.push({ t: "steps", items: listN.splice(0) }); }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.splice(0).filter((r) => !/^\|[\s:|-]+\|$/.test(r));
    const cells = rows.map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const headers = cells.shift();
    const n = headers.length;
    const first = Math.max(10, Math.round(100 / n * 1.6));
    const widths = headers.map((h, idx) => (idx === 0 ? first : Math.floor((100 - first) / (n - 1))));
    const drift = 100 - widths.reduce((a, b) => a + b, 0);
    widths[widths.length - 1] += drift;
    cur.blocks.push({ t: "table", caption: pendingCaption || "", headers, widths, rows: cells, small: n >= 5, matrix: n >= 8 });
    pendingCaption = null;
  };

  for (; i < raw.length; i++) {
    const line = raw[i];

    if (inFence) {
      if (line.trim() === "```") { inFence = false; cur.blocks.push({ t: "tree", lines: fence.splice(0) }); }
      else fence.push(line);
      continue;
    }
    if (line.trim() === "```") { flushPara(); flushLists(); flushTable(); inFence = true; continue; }

    if (line.startsWith("## ")) {
      flushPara(); flushLists(); flushTable();
      const title = line.slice(3).trim();
      const mAppendix = title.match(/^ملحق ([أ-ي]):\s*(.*)$/);
      const mNum = title.match(/^(\d+)\.\s*(.*)$/);
      cur = mAppendix
        ? { appendix: mAppendix[1], title: mAppendix[2], blocks: [] }
        : { num: mNum ? mNum[1] : "", title: mNum ? mNum[2] : title, blocks: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("### ")) { flushPara(); flushLists(); flushTable(); cur.blocks.push({ t: "h2", text: line.slice(4).trim() }); continue; }
    if (line.startsWith("#### ")) { flushPara(); flushLists(); flushTable(); cur.blocks.push({ t: "h3", text: line.slice(5).trim() }); continue; }
    if (line.startsWith("> ")) {
      flushPara(); flushLists(); flushTable();
      const m = line.slice(2).match(/^\*\*(.+?):\*\*\s*(.*)$/);
      cur.blocks.push(m ? { t: "callout", title: m[1], text: m[2] } : { t: "callout", title: "قاعدة", text: line.slice(2) });
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(line)) { continue; } // table separator
    if (line.startsWith("|")) { flushPara(); flushLists(); tableBuf.push(line.trim()); continue; }
    if (tableBuf.length) { flushTable(); }

    if (/^- /.test(line)) {
      flushPara();
      if (listN.length) flushLists();
      listB.push(line.slice(2).trim());
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      flushPara();
      if (listB.length) flushLists();
      listN.push(line.replace(/^\d+\.\s/, "").trim());
      continue;
    }
    if (line.trim() === "") { flushPara(); flushLists(); continue; }
    if (listB.length || listN.length) flushLists();
    para.push(line.trim());
  }
  flushPara(); flushLists(); flushTable();
  return sections;
}

module.exports = { parseBlueprint };
