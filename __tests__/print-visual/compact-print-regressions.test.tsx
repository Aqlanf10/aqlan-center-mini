import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { beforeAll, describe, expect, it, vi } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import tailwindConfig from "../../tailwind.config";
import { SETTING_DEFAULTS } from "../../lib/settings";
import { dispatchOrder } from "../fixtures/lab-dispatch";
import { assertLabDispatchPdfFields } from "../helpers/lab-dispatch-pdf-fields";

vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin" }) }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null, ReprintMark: () => null }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", printCount: async () => 0,
  getSettingsSafe: async () => SETTING_DEFAULTS,
  getLabOrderById: async () => dispatchOrder({ labName: "SYNTHETIC-DISPATCH-LAB-A-1234567890123", labPhone: "777123456", serviceName: "SYNTHETIC-DISPATCH-SERVICE-1234567890123", workType: "SYNTHETIC-DISPATCH-SERVICE-1234567890123" }),
  getPayment: async () => ({ id: 1, receiptNumber: "SYN-PROV-ORIGINAL-BHGFBCDEFABCD", patientName: "SYNTHETIC-RECEIPT-PROVENANCE", invoiceId: 1, kind: "payment", amountMinor: 50000, currency: "YER", method: "cash", createdBy: "SYNTHETIC-SIGNER", createdAt: "2000-03-02T22:00:00.000Z" }),
}));
vi.mock("@/lib/receipt-provenance-db", () => ({ readReceiptProvenance: async () => ({ 1: {
  status: "available", reversal: { state: "full", reversedMinor: 50000, remainingMinor: 0 },
  correction: { mode: "correct", reversal: { id: 2, receiptNumber: "SYN-REV-00002" }, replacement: { id: 3, receiptNumber: "SYN-REP-00003" } },
} }) }));
import LabPage from "../../app/print/lab/[id]/page";
import ReceiptPage from "../../app/print/receipt/[id]/page";
import labStyles from "../../app/print/lab/[id]/lab-dispatch.module.css";
import { PrintDocumentWatermark } from "../../components/PrintDocument";
// Use the real root CSS cascade, including Tailwind preflight list/typography
// rules. A minimal hand-written reset can falsely claim native A6 fit.
let globalCss: string;
beforeAll(async () => {
  globalCss = (await postcss([tailwindcss(tailwindConfig), autoprefixer()])
    .process(readFileSync(resolve("app/globals.css"), "utf8"), { from: resolve("app/globals.css") })).css;
});
function labCss() {
  let css = readFileSync(resolve("app/print/lab/[id]/lab-dispatch.module.css"), "utf8");
  for (const name of Object.keys(labStyles)) css = css.replace(new RegExp(`\\.${name}(?![\\w-])`, "g"), `.${labStyles[name]}`);
  return css;
}
describe("native compact print regression witnesses", () => {
  it.each(["receipt", "lab"] as const)("preserves %s paper and field integrity", async kind => {
    const node = await (kind === "receipt" ? ReceiptPage : LabPage)({ params: Promise.resolve({ id: "1" }) });
    const body = renderToStaticMarkup(<><PrintDocumentWatermark /><div className="print-root">{node}</div></>);
    const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
    const css = globalCss + readFileSync(resolve("components/print-document.css"), "utf8") + readFileSync(resolve("app/print/print.css"), "utf8") + (kind === "lab" ? labCss() : "");
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => route.abort());
      await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><style>${css}</style><body>${body.replaceAll('src="/logo.png"', `src="${logo}"`)}</body></html>`);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
      const pdf = await page.pdf({ format: kind === "receipt" ? "A6" : "A4", printBackground: true, displayHeaderFooter: false });
      const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", "-", "-"], { input: pdf, encoding: "utf8" });
      const pages = await page.evaluate(raw => {
        const doc = new DOMParser().parseFromString(raw, "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid compact PDF bbox XML");
        const box = (node: Element) => ({ xMin: Number(node.getAttribute("xMin")), xMax: Number(node.getAttribute("xMax")), yMin: Number(node.getAttribute("yMin")), yMax: Number(node.getAttribute("yMax")) });
        return [...doc.getElementsByTagName("page")].map(node => ({ width: Number(node.getAttribute("width")), height: Number(node.getAttribute("height")),
          words: [...node.getElementsByTagName("word")].map(word => ({ ...box(word), text: word.textContent ?? "" })),
          blocks: [...node.getElementsByTagName("block")].map(block => ({ ...box(block), lines: [...block.getElementsByTagName("line")].map(line => [...line.getElementsByTagName("word")].map(word => ({ ...box(word), text: word.textContent ?? "" }))) })),
        }));
      }, xml);
      if (kind === "lab") {
        expect(pages.length).toBeGreaterThan(0);
        assertLabDispatchPdfFields(pages, { service: "SYNTHETIC-DISPATCH-SERVICE-1234567890123", lab: "SYNTHETIC-DISPATCH-LAB-A-1234567890123", labPhone: "777123456" });
      } else {
        expect(pages).toHaveLength(1);
        expect(Math.abs(pages[0].width - 105 * 72 / 25.4)).toBeLessThan(1);
        expect(Math.abs(pages[0].height - 148 * 72 / 25.4)).toBeLessThan(1);
        for (const word of pages[0].words) {
          expect([word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)).toBe(true);
          expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
          expect(word.xMax).toBeLessThanOrEqual(pages[0].width); expect(word.yMax).toBeLessThanOrEqual(pages[0].height);
        }
        const text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" });
        for (const reference of ["SYN-PROV-ORIGINAL-BHGFBCDEFABCD", "SYN-REV-00002", "SYN-REP-00003"]) expect(text).toContain(reference);
      }
    } finally { await browser.close(); }
  });
});
