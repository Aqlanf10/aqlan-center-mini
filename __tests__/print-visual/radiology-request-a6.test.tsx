/** Hosted Chromium witness using the actual async page and real CSS/logo.
 * Synthetic-only presentation evidence; not HTTP/DB authorization acceptance. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { beforeAll, expect, it, vi } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import tailwindConfig from "../../tailwind.config";
const fixture = vi.hoisted(() => ({ long: false }));
const key = "11111111-1111-4111-8111-111111111111";
const markers = Array.from({ length: 24 }, (_, index) => `RADNOTE${String(index + 1).padStart(2, "0")}`);
vi.mock("@/lib/session", () => ({ readSessionPayload: async () => ({ username: "synthetic-doctor", role: "doctor", credentialVersion: "synthetic-version" }) }));
vi.mock("@/components/RadiologyPrintButton", () => ({ RadiologyPrintButton: () => null }));
vi.mock("@/lib/radiology-request-service", () => ({ readRadiologyRequest: async () => ({
  id: "11111111-1111-4111-8111-111111111111", patientId: 7, visitId: 9, createdAt: "2026-11-01T08:30:00Z",
  snapshot: { version: 1, patientId: 7, visitId: 9, doctorId: 5, centerId: "22222222-2222-4222-8222-222222222222",
    patientName: fixture.long ? "RADPATIENT مريض اصطناعي للاختبار ذو اسم عربي طويل متعدد المقاطع والأسماء العائلية" : "RADPATIENT مريض اصطناعي",
    doctorName: fixture.long ? "RADDOCTOR الدكتور الاستشاري الاصطناعي ذو الاسم العربي المطول لاختبار الاستمرار" : "RADDOCTOR طبيب اصطناعي",
    clinicName: "عيادة اصطناعية", clinicAddress: "صنعاء", clinicPhone: "777123456", timeZone: "Asia/Aden",
    centerName: fixture.long ? "RADCENTER مركز الأشعة الاصطناعي المتخصص للتصوير والفحوص التشخيصية" : "RADCENTER مركز اصطناعي",
    centerAddress: fixture.long ? `RADADDRESS ${"عنوان اصطناعي طويل — شارع الاختبار بجوار المبنى الرئيسي في الحي النموذجي. ".repeat(5)} ADDRESSEND` : "RADADDRESS شارع الاختبار",
    examination: "RADEXAM تصوير بانورامي", region: "RADREGION الفكين",
    notes: fixture.long ? Array.from({ length: 24 }, (_, index) => `RADNOTE${String(index + 1).padStart(2, "0")} تعليمات اصطناعية واضحة لمركز الأشعة لاختبار امتداد النص كاملًا.`).join("\n") : "RADSHORT تعليمات اصطناعية قصيرة",
  },
}) }));
import { PrintDocumentWatermark } from "../../components/PrintDocument";
import RadiologyPrint from "../../app/print/radiology-request/[key]/page";
let css: string;
beforeAll(async () => {
  css = (await postcss([tailwindcss(tailwindConfig), autoprefixer()]).process(readFileSync(resolve("app/globals.css"), "utf8"), { from: resolve("app/globals.css") })).css
    + readFileSync(resolve("components/print-document.css"), "utf8") + readFileSync(resolve("app/print/print.css"), "utf8")
    + readFileSync(resolve("app/print/radiology-request/[key]/radiology.css"), "utf8");
});
it.each([false, true])("prints actual A6 paper with intact text and repeated identity (overflow=%s)", async long => {
  fixture.long = long;
  const node = await RadiologyPrint({ params: Promise.resolve({ key }), searchParams: Promise.resolve({ patientId: "7" }) });
  const body = renderToStaticMarkup(node);
  const watermark=renderToStaticMarkup(<PrintDocumentWatermark/>);
  const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
  expect(body).toContain('src="/logo.png"');
  const html = `<!doctype html><html lang="ar" dir="rtl"><style>${css}</style><body>${watermark.replaceAll('src="/logo.png"', `src="${logo}"`)}<div class="print-root">${body.replaceAll('src="/logo.png"', `src="${logo}"`)}</div></body></html>`;
  const output = resolve(".settings-ui-artifacts/radiology-a6"); mkdirSync(output, { recursive: true });
  const kind = long ? "overflow" : "short";
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage(); await page.route("**/*", route => route.abort()); await page.setContent(html);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
    await page.emulateMedia({ media: "print" });
    expect(await page.locator(".radiology-brand .print-logo").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const pdf = await page.pdf({ path: resolve(output, `${kind}.pdf`), preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
    const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", "-", "-"], { input: pdf, encoding: "utf8" });
    const pages = await page.evaluate(raw => {
      const doc = new DOMParser().parseFromString(raw, "application/xml"); if (doc.querySelector("parsererror")) throw new Error("Invalid PDF bbox XML");
      return [...doc.getElementsByTagName("page")].map(p => ({ width: Number(p.getAttribute("width")), height: Number(p.getAttribute("height")),
        words: [...p.getElementsByTagName("word")].map(w => ({ text: w.textContent ?? "", xMin: Number(w.getAttribute("xMin")), xMax: Number(w.getAttribute("xMax")), yMin: Number(w.getAttribute("yMin")), yMax: Number(w.getAttribute("yMax")) })) }));
    }, xml);
    const text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { input: pdf, encoding: "utf8" });
    writeFileSync(resolve(output, `${kind}-geometry.json`), JSON.stringify({ syntheticOnly: true, pages }, null, 2));
    writeFileSync(resolve(output, `${kind}-text.txt`), text);
    if (long) expect(pages.length).toBeGreaterThan(1); else expect(pages).toHaveLength(1);
    for (const p of pages) {
      // PDF page geometry comes from Poppler, not browser viewport/CSS guesses.
      expect(Math.abs(p.width - 105 * 72 / 25.4)).toBeLessThan(1); expect(Math.abs(p.height - 148 * 72 / 25.4)).toBeLessThan(1);
      const pageText = p.words.map(word => word.text).join(" ");
      for (const identity of ["RADPATIENT", "RADDOCTOR", key]) expect(pageText).toContain(identity);
      for (const word of p.words) {
        expect([word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)).toBe(true);
        expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
        expect(word.xMax).toBeLessThanOrEqual(p.width); expect(word.yMax).toBeLessThanOrEqual(p.height);
      }
    }
    for (const marker of ["RADCENTER", "RADADDRESS", "RADEXAM", "RADREGION", ...(long ? ["ADDRESSEND", ...markers] : ["RADSHORT"])]) expect(text).toContain(marker);
    if (long) for (const marker of markers) expect(text.split(marker)).toHaveLength(2);
  } finally { await browser.close(); }
});
