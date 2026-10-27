import { clinicDateString } from "./schedule";
import { CLINIC_ZONE_FALLBACK } from "./clinicZone";
import type { PatientStatementDocument } from "./patient-statement-document";

const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const SCALE = 2;
const MARGIN = 42;
const BOTTOM = 1050;
const encoder = new TextEncoder();

export interface StatementFiles { files: File[]; previews: Blob[] }

/** Browser exports use the shared clinic day, never the browser/UTC calendar day. */
export function statementFileStamp(now: Date): string {
  return clinicDateString(now, CLINIC_ZONE_FALLBACK);
}

/** next/font adds a local Arial fallback to its CSS stack. Loading the entire stack
 * asks FontFaceSet to load that optional local face as well, which rejects on devices
 * without Arial even when the bundled Arabic face loaded. Only load the primary face. */
export async function loadStatementFont(fontFamily: string, fonts: Pick<FontFaceSet, "load" | "check" | "ready"> = document.fonts): Promise<string> {
  const primary = fontFamily.match(/^(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,]+)/)?.[0].trim();
  if (!primary) throw new Error("تعذر تحديد الخط العربي للكشف.");
  try {
    const loaded = await Promise.all([fonts.load(`400 16px ${primary}`, "كشف حساب المريض"), fonts.load(`700 20px ${primary}`, "كشف حساب المريض")]);
    await fonts.ready;
    if (loaded.some(faces => !faces.length) || !fonts.check(`400 16px ${primary}`, "كشف حساب المريض")) throw new Error("Font unavailable");
  } catch {
    throw new Error("تعذر تحميل الخط العربي. أعد المحاولة.");
  }
  return primary;
}

/** PDF 1.4 with an image XObject per A4 page. Arabic shaping is rasterized by the browser
 * with the app's locally hosted font. No server, external converter or public URL is used. */
export function statementPdfBytes(images: readonly { bytes: Uint8Array; width: number; height: number }[]): Uint8Array {
  if (!images.length) throw new Error("No statement pages");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let length = 0;
  const append = (value: string | Uint8Array) => { const bytes = typeof value === "string" ? encoder.encode(value) : value; chunks.push(bytes); length += bytes.length; };
  const object = (id: number, body: string) => { offsets[id] = length; append(`${id} 0 obj\n${body}\nendobj\n`); };
  append("%PDF-1.4\n% Aqlan patient statement\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Count ${images.length} /Kids [${images.map((_, index) => `${3 + index * 3} 0 R`).join(" ")}] >>`);
  images.forEach((image, index) => {
    const pageId = 3 + index * 3;
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /PageImage ${pageId + 2} 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    const commands = "q\n595.28 0 0 841.89 0 0 cm\n/PageImage Do\nQ\n";
    object(pageId + 1, `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}endstream`);
    offsets[pageId + 2] = length;
    append(`${pageId + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`);
    append(image.bytes);
    append("\nendstream\nendobj\n");
  });
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach(offset => append(`${String(offset).padStart(10, "0")} 00000 n \n`));
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const result = new Uint8Array(length);
  let cursor = 0;
  chunks.forEach(chunk => { result.set(chunk, cursor); cursor += chunk.length; });
  return result;
}

/** Require an explicitly entered international number; do not guess a country code. */
export function statementRecipient(value: string): string | null {
  const normalized = value.trim().replace(/[\s()-]/g, "").replace(/^00/, "+");
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized.slice(1) : null;
}

export function statementWhatsAppUrl(value: string): string | null {
  const recipient = statementRecipient(value);
  // No account details, patient name, figures or file URL in the URL or draft.
  return recipient ? `https://wa.me/${recipient}` : null;
}

export function supportsStatementFileShare(files: readonly File[], device: Pick<Navigator, "canShare" | "share"> = navigator): boolean {
  try { return typeof device.share === "function" && typeof device.canShare === "function" && device.canShare({ files: [...files] }); }
  catch { return false; }
}

export function downloadStatementFile(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = file.name; anchor.rel = "noopener";
  document.body.append(anchor); anchor.click(); anchor.remove();
  // Revocation must wait until the browser has consumed the download URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function wrapText(context: CanvasRenderingContext2D, value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      line = "";
      for (const letter of Array.from(word)) {
        if (line && context.measureText(line + letter).width > width) { lines.push(line); line = ""; }
        line += letter;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function canvasBytes(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg"): Uint8Array<ArrayBuffer> {
  const data = canvas.toDataURL(type, 0.96);
  if (!data.startsWith(`data:${type};base64,`)) throw new Error("تعذر إنشاء ملف الكشف");
  const binary = atob(data.slice(data.indexOf(",") + 1));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Renders only the allowlisted document fields used by the HTML preview. Each page is
 * 1588×2246px; long rows continue on a fresh page with column headings repeated. */
export async function createStatementFiles(statement: PatientStatementDocument, format: "pdf" | "png", fontFamily: string): Promise<StatementFiles> {
  fontFamily = await loadStatementFont(fontFamily);
  const logo = new Image();
  logo.src = "/logo.png";
  await logo.decode();
  const previews: Blob[] = [];
  const images: { bytes: Uint8Array; width: number; height: number }[] = [];
  const stamp = statementFileStamp(new Date());
  const files: File[] = [];
  let activeCanvas: HTMLCanvasElement | null = null;
  let pageCount = 0;
  const finishPage = () => {
    if (!activeCanvas) return;
    const png = new Blob([canvasBytes(activeCanvas, "image/png")], { type: "image/png" });
    previews.push(png);
    if (format === "png") files.push(new File([png], `statement-${stamp}-${pageCount}.png`, { type: "image/png" }));
    else images.push({ bytes: canvasBytes(activeCanvas, "image/jpeg"), width: activeCanvas.width, height: activeCanvas.height });
    // Keep only encoded bytes, never a pile of 14MB canvas pixel buffers on phones.
    activeCanvas.width = 0; activeCanvas.height = 0;
    activeCanvas = null;
  };
  let context: CanvasRenderingContext2D;
  let y = 0;
  const text = (value: string, x: number, top: number, size = 14, bold = false, align: CanvasTextAlign = "right") => {
    context.font = `${bold ? 700 : 400} ${size}px ${fontFamily}`;
    context.textAlign = align; context.direction = "rtl"; context.textBaseline = "top"; context.fillStyle = "#0d2137";
    context.fillText(value, x, top);
  };
  const paragraph = (value: string, size = 14, bold = false) => {
    context.font = `${bold ? 700 : 400} ${size}px ${fontFamily}`;
    const lines = wrapText(context, value, PAGE_WIDTH - MARGIN * 2);
    for (const line of lines) { if (y + 26 > BOTTOM) page(); text(line, PAGE_WIDTH - MARGIN, y, size, bold); y += 26; }
  };
  const page = () => {
    finishPage();
    if (pageCount >= 150) throw new Error("الكشف طويل جدًا؛ اختر فترة أقصر لتصديره.");
    const canvas = document.createElement("canvas"); canvas.width = PAGE_WIDTH * SCALE; canvas.height = PAGE_HEIGHT * SCALE;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("المتصفح لا يدعم إنشاء صور الكشف");
    context = ctx; context.scale(SCALE, SCALE); context.fillStyle = "#fff"; context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT); activeCanvas = canvas; pageCount++;
    context.drawImage(logo, PAGE_WIDTH / 2 - 28, 22, 56, 47);
    text(statement.clinic.name, PAGE_WIDTH / 2, 76, 21, true, "center");
    text([statement.clinic.doctor, statement.clinic.credentials].filter(Boolean).join(" — "), PAGE_WIDTH / 2, 109, 12, false, "center");
    context.fillStyle = "#f47727"; context.fillRect(MARGIN, 136, PAGE_WIDTH - 2 * MARGIN, 2);
    text(statement.title, PAGE_WIDTH / 2, 149, 20, true, "center");
    y = 183;
    paragraph(`المريض: ${statement.patient.name}    |    رقم الملف: ${statement.patient.number}`, 14, true);
    paragraph(`تاريخ الإصدار: ${statement.generatedAt}`, 12);
    if (statement.subtitle) paragraph(statement.subtitle, 12);
    y += 12;
    text(`${pageCount}`, PAGE_WIDTH / 2, 1087, 12, false, "center");
    text([statement.clinic.address, statement.clinic.phone].filter(Boolean).join(" · "), PAGE_WIDTH / 2, 1064, 11, false, "center");
  };
  const tableRow = (cells: string[], heading = false, repeatHeading?: () => void) => {
    const width = (PAGE_WIDTH - MARGIN * 2) / cells.length;
    context.font = `${heading ? 700 : 400} 14px ${fontFamily}`;
    const lines = cells.map(cell => wrapText(context, cell, width - 18));
    let cursor = 0;
    const count = Math.max(...lines.map(cell => cell.length));
    while (cursor < count) {
      if (y + 36 > BOTTOM) { page(); if (!heading) repeatHeading?.(); }
      const available = Math.max(1, Math.floor((BOTTOM - y - 12) / 24));
      const take = Math.min(available, count - cursor);
      const height = take * 24 + 12;
      cells.forEach((_, index) => {
        const x = PAGE_WIDTH - MARGIN - (index + 1) * width;
        context.fillStyle = heading ? "#f1f5f9" : "#fff"; context.fillRect(x, y, width, height);
        context.strokeStyle = "#cbd5e1"; context.lineWidth = 0.8; context.strokeRect(x, y, width, height);
        lines[index].slice(cursor, cursor + take).forEach((line, i) => text(line, x + width - 9, y + 6 + i * 24, 14, heading));
      });
      cursor += take; y += height;
      if (cursor < count) { page(); if (!heading) repeatHeading?.(); }
    }
  };
  page();
  for (const section of statement.sections) {
    if (!section.columns.length) continue;
    if (y + 110 > BOTTOM) page();
    paragraph(section.title, 17, true); y += 6;
    const heading = () => tableRow(section.columns, true);
    heading();
    const rows = section.rows.length ? section.rows : [section.columns.map((_, index) => index ? "" : "لا توجد حركات")];
    for (const row of rows) tableRow(row, false, heading);
    y += 20;
  }
  for (const notice of statement.notices) { paragraph(notice, 12); y += 8; }
  finishPage();
  if (format === "pdf") files.push(new File([statementPdfBytes(images) as Uint8Array<ArrayBuffer>], `statement-${stamp}.pdf`, { type: "application/pdf" }));
  return { files, previews };
}
