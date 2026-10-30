import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import tailwindConfig from "../../tailwind.config";
import { SETTING_DEFAULTS } from "../../lib/settings";

const fixture = vi.hoisted(() => {
  const createdAt = "2026-10-29T23:31:00Z";
  return {
    invoice: { id: 1, invoiceNumber: "SYN-INV-DATE", patientId: 17, patientName: "مريض اصطناعي", status: "open",
      totalMinor: 3000, discountMinor: 0, baseCurrency: "YER", note: null, createdAt,
      items: [{ id: 1, description: "علاج اصطناعي", quantity: 1, unitPriceMinor: 3000, totalMinor: 3000 }] },
    payment: { id: 20, receiptNumber: "SYN-R-00021", patientId: 17, patientName: "مريض اصطناعي", invoiceId: 1,
      kind: "payment", amountMinor: 2000, currency: "YER", exchangeRate: 1, baseAmountMinor: 2000,
      method: "cash", note: null, createdBy: "SYN-OWNER", createdAt },
  };
});
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "SYN-OWNER" }) }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null, ReprintMark: () => null }));
vi.mock("@/lib/receipt-provenance-db", () => ({ readReceiptProvenance: async () => ({}) }));
vi.mock("@/lib/db", async original => ({ ...await original<typeof import("../../lib/db")>(),
  CLINIC_TIME_ZONE: "Asia/Aden", getSettingsSafe: async () => SETTING_DEFAULTS, printCount: async () => 0,
  getPatient: async () => ({ id: 17, fullName: "مريض اصطناعي", patientNumber: "SYN-17" }),
  getPayment: async () => fixture.payment,
  patientStatementSnapshot: async () => ({ ledger: { invoices: [fixture.invoice], payments: [fixture.payment], openings: [] },
    planCurrencies: new Map(), plans: [], historicalAgreements: [] }),
}));
import StatementPage from "../../app/print/statement/[id]/page";
import ReceiptPage from "../../app/print/receipt/[id]/page";

it("prints the same clinic day on statement and native A6 receipt without clipping", async () => {
  const css = (await postcss([tailwindcss(tailwindConfig), autoprefixer()])
    .process(readFileSync(resolve("app/globals.css"), "utf8"), { from: resolve("app/globals.css") })).css
    + readFileSync(resolve("components/print-document.css"), "utf8") + readFileSync(resolve("app/print/print.css"), "utf8");
  const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
  const output = resolve(".settings-ui-artifacts/unified-print"); mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    for (const kind of ["statement", "receipt"] as const) {
      const node = await (kind === "statement" ? StatementPage : ReceiptPage)({ params: Promise.resolve({ id: "17" }) });
      const body = renderToStaticMarkup(node);
      expect(body).toContain("الجمعة 30/10/2026");
      expect(body).not.toContain("الخميس 29/10/2026");
      if (kind === "receipt") expect(body).toContain("2:31 صباحًا");
      const page = await browser.newPage();
      await page.route("**/*", route => route.abort());
      await page.setContent(`<html dir="rtl" lang="ar"><style>${css}</style><body><div class="print-root">${body.replaceAll('src="/logo.png"', `src="${logo}"`)}</div></body></html>`);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
      await page.emulateMedia({ media: "print" });
      expect(await page.getByText("الجمعة 30/10/2026", { exact: false }).count()).toBe(kind === "statement" ? 2 : 1);
      await page.screenshot({ path: resolve(output, `financial-date-${kind}.png`), fullPage: true });
      const pdf = await page.pdf({ path: resolve(output, `financial-date-${kind}.pdf`), format: kind === "receipt" ? "A6" : "A4", printBackground: true });
      const xml = execFileSync("pdftotext", ["-bbox-layout", "-", "-"], { input: pdf, encoding: "utf8" });
      const pages = await page.evaluate(raw => {
        const doc = new DOMParser().parseFromString(raw, "application/xml");
        return [...doc.getElementsByTagName("page")].map(p => ({ width: Number(p.getAttribute("width")), height: Number(p.getAttribute("height")),
          words: [...p.getElementsByTagName("word")].map(w => ({ text: w.textContent, xMin: Number(w.getAttribute("xMin")), xMax: Number(w.getAttribute("xMax")), yMin: Number(w.getAttribute("yMin")), yMax: Number(w.getAttribute("yMax")) })) }));
      }, xml);
      expect(pages).toHaveLength(1);
      expect(pages[0].words.some(w => w.text?.includes("SYN-R-00021"))).toBe(true);
      expect(pages[0].words.some(w => w.text?.includes("30/10/2026"))).toBe(true);
      for (const word of pages[0].words) {
        expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
        expect(word.xMax).toBeLessThanOrEqual(pages[0].width); expect(word.yMax).toBeLessThanOrEqual(pages[0].height);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
