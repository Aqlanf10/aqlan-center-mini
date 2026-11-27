import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import tailwindConfig from "../../tailwind.config";
import { SETTING_DEFAULTS } from "../../lib/settings";
import { PrintDocumentWatermark } from "../../components/PrintDocument";
import { CURRENCIES, formatMoney } from "../../lib/money";
import { moneyTotalsByCurrency } from "../../lib/report-view";

// Always use the repo's fresh in-memory synthetic database. The report builder,
// route filters, and official print route are real; only auth inputs and the
// identity/contact settings are supplied from the fixture.
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
const printSettings = {
  ...SETTING_DEFAULTS, "clinic.name": "مركز الطباعة الاصطناعي",
  "clinic.lead_doctor": "طبيب الاختبار الاصطناعي", "clinic.lead_doctor_title": "ترويسة اختبار",
  "clinic.lead_doctor_credentials": "", "clinic.address": "SYN-CENTER-FOOTER", "clinic.phone": "000-000000",
};
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "SYN-PRINT-OPERATOR" }) }));
vi.mock("@/lib/db", async (load) => ({ ...await load<typeof import("../../lib/db")>(), getSettingsSafe: async () => printSettings }));
const { ensureSchema, getPool, resetPoolForTesting } = await import("../../lib/db");
const { buildReport, parseFilters } = await import("../../lib/reports");
const { default: OfficialReportPrintPage } = await import("../../app/print/report/page");
const q = (text: string, values: unknown[] = []) => getPool().query(text, values);
const ROOT = resolve(".settings-ui-artifacts/unified-print/debt-width");
const count = 54;
let globalCss: string;
let browser: Browser;
let standalonePatient: number;

beforeAll(async () => {
  globalCss = (await postcss([tailwindcss(tailwindConfig), autoprefixer()])
    .process(readFileSync(resolve("app/globals.css"), "utf8"), { from: resolve("app/globals.css") })).css;
  mkdirSync(ROOT, { recursive: true });
  await ensureSchema();
  await q("SET TIME ZONE 'Asia/Aden'");
  const shift = (await q("INSERT INTO cashier_shifts(opened_by) VALUES ('SYN-PRINT') RETURNING id")).rows[0].id;
  for (let index = 1; index <= count; index++) {
    const code = String(index).padStart(3, "0");
    const currency = CURRENCIES[(index - 1) % CURRENCIES.length];
    const id = Number((await q("INSERT INTO patients(patient_number,full_name,phone) VALUES ($1,$2,$3) RETURNING id",
      ["DW-" + code, "عبد الرحمن محمد صالح الاختبار الاصطناعي", "000-000000000"])).rows[0].id);
    if (index === 1) standalonePatient = id;
    const amount = 1_234_567 + index * 1009;
    const plan = (await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,status,start_date) VALUES ($1,$2,$3,$4,'active','2031-01-14') RETURNING id",
      [id, "خطة علاج التقويم للأسنان الأمامية والخلفية", amount * 2, currency])).rows[0].id;
    const invoice = (await q("INSERT INTO invoices(invoice_number,patient_id,plan_id,total_minor,discount_minor,base_currency,status,created_at) VALUES ($1,$2,$3,$4,0,$5,'open','2031-01-15T12:00:00+03:00') RETURNING id",
      ["SYN-DW-I" + code, id, plan, amount, currency])).rows[0].id;
    await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_at,note) VALUES ($1,$2,$3,$4,'payment',$5,$6,1,$5,$6,'cash','2031-01-24T12:00:00+03:00',$7)",
      ["SYN-DW-P" + code, id, invoice, shift, 127_561 + index * 11, currency, "RC-" + code]);
  }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--disable-gpu"] });
});
afterAll(async () => {
  await browser?.close();
  await resetPoolForTesting();
  vi.unstubAllEnvs();
});

const params = (report: "debt" | "collections" | "daily", extra: Record<string, string> = {}) => ({
  report, from: "2031-01-01", to: "2031-01-31", preset: "custom", ...extra,
});
const cssText = () => globalCss + readFileSync("components/print-document.css", "utf8") + readFileSync("app/print/print.css", "utf8");
const normalize = (text: string) => text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").normalize("NFKC");

async function renderReport(input: Record<string, string>, name: string) {
  const node = await OfficialReportPrintPage({ searchParams: Promise.resolve(input) });
  const logo = "data:image/png;base64," + readFileSync("public/logo.png").toString("base64");
  const markup = renderToStaticMarkup(<><PrintDocumentWatermark /><div className="print-root">{node}</div></>)
    .replaceAll('src="/logo.png"', 'src="' + logo + '"');
  const page = await browser.newPage({ viewport: { width: 1062, height: 794 }, locale: "ar-YE" });
  await page.route("**/*", route => route.abort());
  await page.setContent('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><style>' + cssText() + "</style><body>" + markup + "</body></html>");
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
  const preview = await page.locator(".sheet-report").evaluate(sheet => {
    const paper = sheet.getBoundingClientRect();
    const table = sheet.querySelector(".report-table")?.getBoundingClientRect();
    return { paperLeft: paper.left, paperRight: paper.right, tableLeft: table?.left, tableRight: table?.right, paperWidth: paper.width, tableWidth: table?.width };
  });
  await page.emulateMedia({ media: "print" });
  const path = resolve(ROOT, name + ".pdf");
  const pdf = await page.pdf({ path, format: "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  const text = normalize(execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" }));
  const pages = text.split("\f").filter(part => part.trim());
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-", "-"], { input: pdf, encoding: "utf8" });
  const boxes = await page.evaluate(raw => [...new DOMParser().parseFromString(raw, "application/xml").getElementsByTagName("page")].map(sheet => ({
    width: Number(sheet.getAttribute("width")), height: Number(sheet.getAttribute("height")),
    words: [...sheet.getElementsByTagName("word")].map(word => ({
      left: Number(word.getAttribute("xMin")), right: Number(word.getAttribute("xMax")),
      top: Number(word.getAttribute("yMin")), bottom: Number(word.getAttribute("yMax")),
    })),
  })), xml);
  return { page, text, pages, boxes, preview };
}

describe("official debt and collections print: landscape geometry and intact PDF records", () => {
  it.each([["debt", "outstanding", 17], ["debt", "accrued", 13], ["collections", "outstanding", 10]] as const)(
    "keeps all %s/%s fields readable and all records across physical pages", async (report, mode, columns) => {
      const input = params(report, { debtMode: mode });
      const expected = await buildReport(report, parseFilters(new URLSearchParams(input)));
      const witness = await renderReport(input, report + "-" + mode);
      const { page, preview, text, pages, boxes } = witness;
      try {
        const table = page.locator(".report-table");
        const geometry = await table.evaluate(element => {
          const table = element.getBoundingClientRect();
          const sheet = element.closest(".sheet-report")!.getBoundingClientRect();
          const title = document.querySelector(".doc-title")!.getBoundingClientRect();
          const logo = document.querySelector(".print-brand-identity img")!.getBoundingClientRect();
          const footer = document.querySelector(".print-contact-footer")!.getBoundingClientRect();
          const textBox = (cell: Element) => {
            const range = document.createRange(); range.selectNodeContents(cell);
            const box = cell.getBoundingClientRect();
            return [...range.getClientRects()].map(span => ({ left: span.left - box.left, right: box.right - span.right, top: span.top }));
          };
          const wrappedWords = [...element.querySelectorAll('tbody td:is([data-report-column="patientName"], [data-report-column="planTitle"])')]
            .flatMap(cell => {
              const node = cell.firstChild;
              if (node?.nodeType !== Node.TEXT_NODE) return [];
              return [...(node.textContent ?? "").matchAll(/\S+/g)].flatMap(word => {
                const range = document.createRange();
                range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
                return new Set([...range.getClientRects()].map(rect => rect.top)).size === 1 ? [] : [word[0]];
              });
            });
          return {
            wrappedWords, tableWidth: table.width, left: table.left - sheet.left, right: sheet.right - table.right,
            centerTitle: (title.left + title.right - sheet.left - sheet.right) / 2,
            centerLogo: (logo.left + logo.right - sheet.left - sheet.right) / 2,
            centerFooter: (footer.left + footer.right - sheet.left - sheet.right) / 2,
            rtl: getComputedStyle(element).direction, repeatHeading: getComputedStyle(element.querySelector("thead")!).display,
            overflow: [...element.querySelectorAll("th,td")].flatMap(textBox).filter(span => span.left < -1 || span.right < -1),
            dateLines: [...element.querySelectorAll('tbody td[data-report-column="planStart"],tbody td[data-report-column="lastPaymentDate"],tbody td[data-report-column="date"]')]
              .map(cell => new Set(textBox(cell).map(span => span.top)).size),
          };
        });
        writeFileSync(resolve(ROOT, report + "-" + mode + "-metrics.json"), JSON.stringify({ preview, geometry, pageCount: pages.length }, null, 2));
        expect(await table.locator("thead th").count()).toBe(columns);
        expect(await table.locator("tbody tr").count()).toBe(count);
        expect(preview.tableLeft).toBeGreaterThan(preview.paperLeft);
        expect(preview.tableRight).toBeLessThan(preview.paperRight);
        expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
        expect(geometry.right).toBeGreaterThanOrEqual(-0.5);
        expect(geometry.overflow).toEqual([]);
        expect(geometry.wrappedWords).toEqual([]);
        expect(geometry.dateLines.every(lines => lines === 1)).toBe(true);
        expect(geometry.rtl).toBe("rtl");
        expect(geometry.repeatHeading).toBe("table-header-group");
        for (const delta of [geometry.centerTitle, geometry.centerLogo, geometry.centerFooter]) expect(Math.abs(delta)).toBeLessThan(1);
        expect(pages.length).toBeGreaterThan(1);
        expect(boxes).toHaveLength(pages.length);
        for (const box of boxes) {
          expect(Math.abs(box.width - 297 * 72 / 25.4)).toBeLessThan(2);
          expect(Math.abs(box.height - 210 * 72 / 25.4)).toBeLessThan(2);
          for (const word of box.words) {
            expect(word.left).toBeGreaterThanOrEqual(21);
            expect(word.right).toBeLessThanOrEqual(box.width - 21);
            expect(word.top).toBeGreaterThanOrEqual(20);
            expect(word.bottom).toBeLessThanOrEqual(box.height - 20);
          }
        }
        const rowPages = pages.filter(part => /DW-\d{3}/.test(part));
        expect(rowPages.length).toBeGreaterThan(1);
        for (const printed of rowPages) expect(printed).toMatch(/المريض|ضيرملا/);
        for (let index = 1; index <= count; index++) {
          expect(text.match(new RegExp("DW-" + String(index).padStart(3, "0"), "g"))).toHaveLength(1);
        }
        expect(text.match(/SYN-CENTER-FOOTER/g)).toHaveLength(1);
        expect(pages.at(-1)).toContain("SYN-CENTER-FOOTER");
        expect(pages.at(-1)).toContain("000-000000");
        const key = report === "collections" ? "nativeMinor" : "balanceMinor";
        const money = expected.columns!.find(column => column.key === key)!;
        const totals = moneyTotalsByCurrency(expected.rows!, money, expected.baseCurrency);
        const totalCell = table.locator("tfoot td").nth(expected.columns!.indexOf(money));
        const lines = totalCell.locator("[data-report-currency-total]");
        expect(await lines.allTextContents()).toEqual(CURRENCIES.map(cur => formatMoney(totals[cur]!, cur)));
        const spans = await lines.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
        expect(spans).toHaveLength(3);
        for (let index = 1; index < spans.length; index++) expect(spans[index].top).toBeGreaterThanOrEqual(spans[index - 1].bottom - 0.2);
      } finally { await page.close(); }
    },
  );

  it("preserves compact Collections and Debt Movement and scoped customized debt totals", async () => {
    const entries = [
      { name: "collections-short", args: params("collections", { patientId: String(standalonePatient) }), cols: 10, detail: false },
      { name: "debt-movement-short", args: params("debt", { debtMode: "movement", patientId: String(standalonePatient) }), cols: 7, detail: false },
      { name: "debt-custom", args: params("debt", { patientId: String(standalonePatient), columns: "balanceMinor,planTitle,patientName,planStart", group: "statusLabel" }), cols: 4, detail: true },
      { name: "debt-money-only", args: params("debt", { patientId: String(standalonePatient), columns: "balanceMinor" }), cols: 1, detail: true },
    ];
    for (const entry of entries) {
      const { page, pages } = await renderReport(entry.args, entry.name);
      try {
        expect(pages).toHaveLength(1);
        const table = page.locator(".report-table:not(.report-bars-table)");
        expect(await table.locator("thead th").count()).toBe(entry.cols);
        expect(await table.getAttribute("data-report-debt-detail") !== null).toBe(entry.detail);
        if (entry.detail) {
          expect(await table.locator("tfoot td").first().innerText()).toContain("1,108,004 ر.ي");
        }
      } finally { await page.close(); }
    }
  });
});
