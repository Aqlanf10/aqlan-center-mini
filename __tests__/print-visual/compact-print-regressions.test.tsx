vi.mock("@/lib/prescription-prescriber", () => ({ prescriptionPrescriberOptions: async () => ({ issuerId: 5, canChooseAnyDoctor: false, doctors: [{ id: 5, name: "SYN-DRAFT-CLINICIAN" }] }) }));
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "SYN-DRAFT-CLINICIAN" }) }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null, ReprintMark: () => null }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", printCount: async () => 0,
  getSettingsSafe: async () => SETTING_DEFAULTS, getPrescriptionPrintSettings: async () => SETTING_DEFAULTS,
  patientAppointmentsFrom: async () => [{ id: 1, patientId: 2, scheduledDate: "2031-01-04", scheduledTime: "09:30", status: "booked" }],
  getPatient: async (id: number) => id === 2 ? ({ id: 2, fullName: "SYN-PRINT-1234567890123", patientNumber: "SYN-PRINT-1234567890123", phone: null, createdAt: "2031-01-04T09:00:00Z" }) : ({ id: 1, fullName: "SYN-RX-PATIENT", patientNumber: "SYN-RX-001", birthYear: 1990, gender: "male", medicalAlert: null }),
  getPrescription: async () => ({ id: 11, patientId: 1, prescribingDoctorName: "SYN-SAVED-CLINICIAN", createdBy: "SYN-ACTOR", createdAt: "2031-01-15T10:00:00.000Z", instructionsLang: "both", diagnosis: "SYN-SAVED-DIAGNOSIS", notes: "", items: [{ name: "SYNTHETIC-RX-MEDICATION", dose: "SYN-DOSE", form: "Tablets", frequency: "SYN-FREQUENCY", duration: "SYN-DURATION", instructions: "تعليمات اصطناعية للاختبار", instructionsEn: "SYN-INSTRUCTIONS" }] }),
  getLabOrderById: async () => dispatchOrder({ labName: "SYNTHETIC-DISPATCH-LAB-A-1234567890123", labPhone: "777123456", serviceName: "SYNTHETIC-DISPATCH-SERVICE-1234567890123", workType: "SYNTHETIC-DISPATCH-SERVICE-1234567890123" }),
  getPayment: async () => ({ id: 1, receiptNumber: "SYN-PROV-ORIGINAL-BHGFBCDEFABCD", patientName: "SYNTHETIC-RECEIPT-PROVENANCE", invoiceId: 1, kind: "payment", amountMinor: 50000, currency: "YER", method: "cash", createdBy: "SYNTHETIC-SIGNER", createdAt: "2000-03-02T22:00:00.000Z" }),
}));
vi.mock("@/lib/receipt-provenance-db", () => ({ readReceiptProvenance: async () => ({ 1: {
  status: "available", reversal: { state: "full", reversedMinor: 50000, remainingMinor: 0 },
  correction: { mode: "correct", reversal: { id: 2, receiptNumber: "SYN-REV-00002" }, replacement: { id: 3, receiptNumber: "SYN-REP-00003" } },
} }) }));
import LabPage from "../../app/print/lab/[id]/page";
import PrescriptionPage from "../../app/print/prescription/[id]/page";
import PatientCardPage from "../../app/print/patient-card/[id]/page";
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
  const css = postcss.parse(readFileSync(resolve("app/print/lab/[id]/lab-dispatch.module.css"), "utf8"));
  // Vitest's CSS-module proxy resolves property access but has no enumerable
  // keys. Remap the actual selectors, or the SSR fixture silently omits every
  // scoped route rule even though its rendered class names are hashed.
  css.walkRules(rule => {
    rule.selector = rule.selector.replace(/\.([_a-zA-Z][\w-]*)/g, (_, name: string) => `.${labStyles[name]}`);
  });
  return css.toString();
}
describe("native compact print regression witnesses", () => {
  it.each(["receipt", "lab", "prescription-saved", "prescription-draft", "patient-card"] as const)("preserves %s paper and field integrity", async kind => {
    const prescription = kind.startsWith("prescription-");
    const node = kind === "patient-card" ? await PatientCardPage({ params: Promise.resolve({ id: "2" }) }) : prescription
      ? await PrescriptionPage({ params: Promise.resolve({ id: "1" }), searchParams: Promise.resolve(kind === "prescription-saved"
        ? { rx: "11", diagnosis: "SYN-URL-TAMPER" }
        : { draft: "1", doctorPartyId: "5", lang: "both", diagnosis: "SYN-DRAFT-DIAGNOSIS", items: JSON.stringify([{ name: "SYNTHETIC-RX-MEDICATION", dose: "SYN-DOSE", form: "Tablets", frequency: "SYN-FREQUENCY", duration: "SYN-DURATION", instructions: "تعليمات اصطناعية للاختبار", instructionsEn: "SYN-INSTRUCTIONS" }]) }) })
      : await (kind === "receipt" ? ReceiptPage : LabPage)({ params: Promise.resolve({ id: "1" }) });
    const body = renderToStaticMarkup(<><PrintDocumentWatermark /><div className="print-root">{node}</div></>);
    const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
    const css = globalCss + readFileSync(resolve("components/print-document.css"), "utf8") + readFileSync(resolve("app/print/print.css"), "utf8") + (kind === "lab" ? labCss() : "");
    if (kind === "lab") expect(css).toContain(`.${labStyles.sheet} .${labStyles.labIdentity} { display: block; line-height: 1.35; }`);
    const output = resolve(".settings-ui-artifacts/unified-print");
    mkdirSync(output, { recursive: true });
    const html = `<!doctype html><html lang="ar" dir="rtl"><style>${css}</style><body>${body.replaceAll('src="/logo.png"', `src="${logo}"`)}</body></html>`;
    writeFileSync(resolve(output, `${kind}-compact-source.json`), JSON.stringify({ syntheticOnly: true, cssModuleKeys: Object.keys(labStyles), sheetClass: labStyles.sheet, labIdentityClass: labStyles.labIdentity, html }, null, 2));
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => route.abort());
      await page.setContent(html);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
      await page.emulateMedia({ media: "print" });
      await page.screenshot({ path: resolve(output, `${kind}-compact.png`), fullPage: true });
      const pdf = await page.pdf({ path: resolve(output, `${kind}-compact.pdf`), format: ["receipt", "patient-card"].includes(kind) ? "A6" : prescription ? "A5" : "A4", printBackground: true, displayHeaderFooter: false });
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
      writeFileSync(resolve(output, `${kind}-compact-geometry.json`), JSON.stringify({ syntheticOnly: true, pages }, null, 2));
      if (kind === "lab") {
        const layout = await page.locator(`.${labStyles.labIdentity}`).evaluate(node => ({ display: getComputedStyle(node).display, parentDisplay: getComputedStyle(node.parentElement!).display, labelWeight: getComputedStyle(node.querySelector("span")!).fontWeight, identifierSize: getComputedStyle(node.querySelector("strong")!).fontSize }));
        writeFileSync(resolve(output, "lab-compact-layout.json"), JSON.stringify({ syntheticOnly: true, layout }, null, 2));
        expect(layout).toEqual({ display: "block", parentDisplay: "grid", labelWeight: "700", identifierSize: "14px" });
        expect(pages.length).toBeGreaterThan(0);
        assertLabDispatchPdfFields(pages, { service: "SYNTHETIC-DISPATCH-SERVICE-1234567890123", lab: "SYNTHETIC-DISPATCH-LAB-A-1234567890123", labPhone: "777123456" });
      } else {
        expect(pages).toHaveLength(1);
        expect(Math.abs(pages[0].width - (prescription ? 148 : 105) * 72 / 25.4)).toBeLessThan(1);
        expect(Math.abs(pages[0].height - (prescription ? 210 : 148) * 72 / 25.4)).toBeLessThan(1);
        for (const word of pages[0].words) {
          expect([word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)).toBe(true);
          expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
          expect(word.xMax).toBeLessThanOrEqual(pages[0].width); expect(word.yMax).toBeLessThanOrEqual(pages[0].height);
        }
        const text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" });
        const references = kind === "patient-card" ? ["SYN-PRINT-1234567890123", "04/01/2031", "9:30", SETTING_DEFAULTS["clinic.phone"]] : prescription
          ? ["SYN-RX-PATIENT", "SYN-RX-001", "SYNTHETIC-RX-MEDICATION", "SYN-DOSE", "SYN-FREQUENCY", "SYN-DURATION", "SYN-INSTRUCTIONS", kind === "prescription-saved" ? "SYN-SAVED-CLINICIAN" : "SYN-DRAFT-CLINICIAN", kind === "prescription-saved" ? "SYN-SAVED-DIAGNOSIS" : "SYN-DRAFT-DIAGNOSIS"]
          : ["SYN-PROV-ORIGINAL-BHGFBCDEFABCD", "SYN-REV-00002", "SYN-REP-00003"];
        for (const reference of references) expect(text).toContain(reference);
        if (kind === "patient-card") {
          expect(body).not.toContain('class="print-metadata');
          expect(text.replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")).toContain(SETTING_DEFAULTS["clinic.phone"]);
        }
        if (prescription) {
          expect(text).not.toContain("SYN-URL-TAMPER");
          expect(text.includes("UNAPPROVED DRAFT")).toBe(false);
        }
      }
    } finally { await browser.close(); }
  });
});
