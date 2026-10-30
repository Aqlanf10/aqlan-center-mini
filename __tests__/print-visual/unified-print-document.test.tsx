import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { PrintDocumentWatermark, PrintMetadata, PrintTableFrame } from "../../components/PrintDocument";
import { PrintHeader, PrintFooter } from "../../components/PrintHeader";
import { SETTING_DEFAULTS } from "../../lib/settings";
import { formatMoney } from "../../lib/money";

const reset = "*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid}body,p,h1,h2,h3{margin:0}html{line-height:1.5}img{display:block;max-width:100%;height:auto}.object-contain{object-fit:contain}";
const settings = { ...SETTING_DEFAULTS, "clinic.name": "مركز عرض صناعي", "clinic.lead_doctor": "طبيب اختبار", "clinic.lead_doctor_title": "اختبار", "clinic.lead_doctor_credentials": "", "clinic.phone": "000-000000", "clinic.address": "عنوان اختبار" };
const output = resolve(".settings-ui-artifacts/unified-print");

// Real Chromium/PDF witness for the shared renderer. Actual route data/privacy
// tests remain separate; synthetic fixtures never read a clinic database.
describe("unified document shared renderer: hosted browser/PDF", () => {
  it.each([{ name: "short", rows: 4, logo: true }, { name: "long", rows: 100, logo: true }, { name: "missing-logo", rows: 4, logo: false }])("$name preserves RTL, readable money and all pages", async ({ name, rows, logo }) => {
    const body = renderToStaticMarkup(<><PrintDocumentWatermark src={logo ? "/logo.png" : ""} /><div className="print-root"><div className="sheet sheet-a4" dir="rtl">
      <PrintHeader settings={settings} title="كشف صناعي متعدد العملات" />
      <PrintMetadata><div className="line"><span>المريض</span><strong>اسم صناعي طويل لاختبار التفاف الهوية</strong></div><div className="line"><span>رقم الملف</span><bdi>SYN-9001</bdi></div><div className="line"><span>الفترة</span><bdi>2031-01-01</bdi></div></PrintMetadata>
      <PrintTableFrame><table className="items"><thead><tr><th>ROW-ID</th><th>البيان</th><th className="num">AMOUNT</th></tr></thead><tbody>
        {Array.from({ length: rows }, (_, i) => <tr key={i}><td><bdi>ROW-{String(i + 1).padStart(3, "0")}</bdi></td><td>بيان صناعي طويل مع mixed-reference-12345</td><td className="num">{formatMoney(123456 + i, (["YER", "SAR", "USD"] as const)[i % 3])}</td></tr>)}
      </tbody><tfoot><tr><td colSpan={3}>END-OF-RESULT</td></tr></tfoot></table></PrintTableFrame><PrintFooter settings={settings} />
    </div></div></>);
    const image = logo ? `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}` : "data:image/png;base64,";
    const html = `<!doctype html><html lang="ar" dir="rtl"><style>${reset}${readFileSync(resolve("components/print-document.css"), "utf8")}${readFileSync(resolve("app/print/print.css"), "utf8")}</style><body>${body.replaceAll('src="/logo.png"', `src="${image}"`)}</body></html>`;
    mkdirSync(output, { recursive: true }); const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 794, height: 1123 }, locale: "ar-YE", serviceWorkers: "block" });
      await context.route("**/*", route => route.abort()); const page = await context.newPage(); await page.setContent(html);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => undefined))); });
      await page.emulateMedia({ media: "print" });
      const geometry = await page.evaluate(() => {
        const fields = [...document.querySelectorAll<HTMLElement>(".print-metadata > div")];
        const table = document.querySelector<HTMLElement>(".print-table-frame table")!;
        const mark = document.querySelector<HTMLElement>("body > .print-document-watermark")!;
        return { first: fields[0].getBoundingClientRect().x, second: fields[1].getBoundingClientRect().x,
          opacity: getComputedStyle(mark).opacity, markPosition: getComputedStyle(mark).position,
          watermarkRoots: document.querySelectorAll(".print-document-watermark").length,
          oldTableMarksHidden: [...document.querySelectorAll(".print-table-watermark")].every(node => getComputedStyle(node).display === "none"),
          headers: getComputedStyle(table.querySelector("thead")!).display,
          totals: getComputedStyle(table.querySelector("tfoot")!).display,
          horizontalOverflow: [...table.querySelectorAll<HTMLElement>("th,td")].some(cell => cell.scrollWidth > cell.clientWidth + 1) };
      });
      expect(geometry.first).toBeGreaterThan(geometry.second); expect(geometry.opacity).toBe("0.15");
      expect(geometry.markPosition).toBe("fixed"); expect(geometry.watermarkRoots).toBe(1); expect(geometry.oldTableMarksHidden).toBe(true);
      expect(await page.locator(".print-document-watermark img").count()).toBe(logo ? 1 : 0);
      expect(geometry.headers).toBe("table-header-group"); expect(geometry.totals).toBe("table-row-group");
      expect(geometry.horizontalOverflow).toBe(false); expect(await page.locator("tbody tr").count()).toBe(rows);
      await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
      const pdf = resolve(output, `${name}.pdf`); await page.pdf({ path: pdf, format: "A4", printBackground: false });
      const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
      for (let i = 1; i <= rows; i++) expect(text.match(new RegExp(`ROW-${String(i).padStart(3, "0")}\\b`, "g"))).toHaveLength(1);
      expect(text.match(/END-OF-RESULT/g)).toHaveLength(1);
      const pages = Number(execFileSync("pdfinfo", [pdf], { encoding: "utf8" }).match(/^Pages:\s+(\d+)/m)?.[1]);
      expect(pages).toBeGreaterThanOrEqual(rows > 50 ? 2 : 1); if (rows < 50) expect(pages).toBe(1);
      if (rows > 50) expect(text.match(/ROW-ID/g)?.length).toBe(pages);
      // A CSS fixed declaration alone is not PDF proof: count the real logo
      // image paints on every physical page (header once + one watermark/page).
      const imageList = execFileSync("pdfimages", ["-list", pdf], { encoding: "utf8" });
      const paintedLogoPages = [...imageList.matchAll(/^\s*(\d+)\s+\d+\s+image\s+1000\s+846\s/gm)].map(match => Number(match[1]));
      for (let physicalPage = 1; physicalPage <= pages; physicalPage++) {
        expect(paintedLogoPages.filter(pageNumber => pageNumber === physicalPage)).toHaveLength(logo ? (physicalPage === 1 ? 2 : 1) : 0);
      }
    } finally { await browser.close(); }
  });
});
