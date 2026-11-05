import { DOSE_REFERENCE_VERSION } from "../../lib/medication-dose-profiles";
import { createCalculatedDoseProvenance, calculatedDoseFields } from "../../lib/medication-dose-provenance";
const rxFixture = vi.hoisted(() => ({ long: false, longIdentity: false, calculated: false, ibuprofen: false, historicalIbuprofen: false }));
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

function calculatedRxItem() {
 const baseInput={profileId:'amoxicillin-child-aapd-q8',referenceVersion:DOSE_REFERENCE_VERSION,indication:'Synthetic reviewed indication',ageMonths:60,ageVerified:true,weightKg:20,currentWeightVerified:true,selectedDose:30,administrationsPer24h:3,scheduleKind:'fixed-interval' as const,intervalHours:8,durationDays:5,reviewPlan:'SYN-CALCULATED-PLAN '+('Review synthetic instructions and follow-up. '.repeat(7))+'SYN-CALCULATED-END',product:{name:'SYN-LONG-PRODUCT '+('synthetic '.repeat(12)),ingredientId:'amoxicillin' as const,formulation:'single-ingredient' as const,labelUrl:'https://synthetic.invalid/label',kind:'oral-liquid' as const,strengthMg:250,perMl:5,measurementIncrementMl:0.1,minimumAgeMonths:4,labelVerified:true},otherSameIngredientMg24h:0,specialPopulationOrInteraction:false,antibioticIndicationReviewed:true};
 const input=rxFixture.ibuprofen?{...baseInput,profileId:'ibuprofen-child-sdcep',selectedDose:150,scheduleKind:'times-per-day' as const,product:{...baseInput.product,ingredientId:'ibuprofen' as const,strengthMg:100,minimumAgeMonths:6,minimumIntervalHours:6,maxAdministrationsPer24h:3}}:baseInput;
 const doseReview=createCalculatedDoseProvenance(input);if(!doseReview)throw Error('Invalid calculated print fixture');
 const {amount,...fields}=calculatedDoseFields(doseReview)!;return {...fields,selection:{id:rxFixture.ibuprofen?'ibuprofen':'amoxicillin',amount,confirmed:true,doseReview}};
}

// Frozen saved v2-era text from the exact 1414 hosted two-page regression.
// Never regenerate this snapshot using the newer patient-facing projection.
const historicalIbuprofenItem = {
  name: "Ibuprofen", dose: "100 mg/5 mL", form: "Oral suspension", duration: "5 days",
  frequency: "3 times daily; at least 8 hours apart",
  instructions: "لا تستبدل سقف30 بسقف40 من مرجع آخر. إذا تجاوزت جرعة الفئة سقف الوزن تُحال للمراجعة ولا تخفض صامتًا. خطة المراجعة: Synthetic review and stop plan يفضل تناوله بعد الطعام.",
  instructionsEn: "Review plan: Synthetic review and stop plan Preferably after food.",
  selection: { id: "ibuprofen", amount: "7.5 mL (150 mg)", confirmed: true },
};

vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "SYN-DRAFT-CLINICIAN" }) }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null, ReprintMark: () => null }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", printCount: async () => 0,
  getSettingsSafe: async () => SETTING_DEFAULTS, getPrescriptionPrintSettings: async () => SETTING_DEFAULTS,
  patientAppointmentsFrom: async () => [{ id: 1, patientId: 2, scheduledDate: "2031-01-04", scheduledTime: "09:30", status: "booked" }],
  getPatient: async (id: number) => id === 2 ? ({ id: 2, fullName: "SYN-PRINT-1234567890123", patientNumber: "SYN-PRINT-1234567890123", phone: null, createdAt: "2031-01-04T09:00:00Z" }) : ({ id: 1, fullName: rxFixture.historicalIbuprofen ? "مريض جرعة اصطناعي" : rxFixture.longIdentity ? "SYN-RX-PATIENT SYNTHETIC EXTENDED PATIENT IDENTITY FOR WRAPPING SYN-PATIENT-LAST" : "SYN-RX-PATIENT", patientNumber: rxFixture.historicalIbuprofen ? "DOSE-RX-1793731221737" : "SYN-RX-001", birthYear: rxFixture.historicalIbuprofen ? null : 1990, gender: rxFixture.historicalIbuprofen ? null : "male", medicalAlert: null }),
  getPrescription: async () => ({ id: 11, patientId: 1, prescribingDoctorName: rxFixture.historicalIbuprofen ? "طبيب الأمن أ" : rxFixture.longIdentity ? "SYN-SAVED-CLINICIAN SYNTHETIC EXTENDED DOCTOR IDENTITY FOR WRAPPING SYN-DOCTOR-LAST" : "SYN-SAVED-CLINICIAN", createdBy: "SYN-ACTOR", createdAt: rxFixture.historicalIbuprofen ? "2026-11-03T18:40:21.737Z" : "2031-01-15T10:00:00.000Z", instructionsLang: "both", diagnosis: rxFixture.historicalIbuprofen ? "Synthetic dose review" : "SYN-SAVED-DIAGNOSIS", notes: "", items: rxFixture.historicalIbuprofen ? [structuredClone(historicalIbuprofenItem)] : rxFixture.calculated ? [calculatedRxItem()] : Array.from({ length: rxFixture.long ? 20 : 1 }, (_, index) => ({ selection: { id: "manual", amount: rxFixture.long ? `SYN-AMOUNT-${String(index + 1).padStart(2, "0")}` : "SYN-AMOUNT", confirmed: true }, name: rxFixture.long ? `SYN-MED-${String(index + 1).padStart(2, "0")}` : "SYNTHETIC-RX-MEDICATION", dose: rxFixture.long ? `SYN-DOSE-${String(index + 1).padStart(2, "0")}` : "SYN-DOSE", form: "Tablets", frequency: rxFixture.long ? `SYN-FREQUENCY-${String(index + 1).padStart(2, "0")}` : "SYN-FREQUENCY", duration: rxFixture.long ? `SYN-DURATION-${String(index + 1).padStart(2, "0")}` : "SYN-DURATION", instructions: `تعليمات اصطناعية للاختبار ${index + 1}`, instructionsEn: rxFixture.long ? `SYN-INSTRUCTIONS-${String(index + 1).padStart(2, "0")}` : "SYN-INSTRUCTIONS" })) }),
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
  it.each([
    { draft: "1", items: "SYN-PRIVATE-DRAFT" },
    { rx: "11", draft: "1", items: "SYN-PRIVATE-DRAFT" },
    { rx: "11", diagnosis: "SYN-PRIVATE-DIAGNOSIS" },
    { rx: "11", notes: "SYN-PRIVATE-NOTES" },
  ])("rejects retired draft or mixed clinical query as 404", async query => {
    await expect(PrescriptionPage({ params: Promise.resolve({ id: "1" }), searchParams: Promise.resolve(query) }))
      .rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
  it.each(["receipt", "lab", "prescription-saved", "prescription-long", "prescription-long-identity", "prescription-calculated", "prescription-ibuprofen-calculated", "prescription-historical-ibuprofen-short", "patient-card"] as const)("preserves %s paper and field integrity", async kind => {
    const prescription = kind.startsWith("prescription-");
    rxFixture.long = kind.startsWith("prescription-long");
    rxFixture.longIdentity = kind === "prescription-long-identity";
    rxFixture.calculated = kind === "prescription-calculated" || kind === "prescription-ibuprofen-calculated";
    rxFixture.ibuprofen = kind === "prescription-ibuprofen-calculated";
    rxFixture.historicalIbuprofen = kind === "prescription-historical-ibuprofen-short";
    const node = kind === "patient-card" ? await PatientCardPage({ params: Promise.resolve({ id: "2" }) }) : prescription
      ? await PrescriptionPage({ params: Promise.resolve({ id: "1" }), searchParams: Promise.resolve({ rx: "11" }) })
      : await (kind === "receipt" ? ReceiptPage : LabPage)({ params: Promise.resolve({ id: "1" }) });
    const body = renderToStaticMarkup(<><PrintDocumentWatermark /><div className="print-root">{node}</div></>);
    const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
    const css = globalCss + readFileSync(resolve("components/print-document.css"), "utf8") + readFileSync(resolve("app/print/print.css"), "utf8") + (kind === "lab" ? labCss() : "") + (prescription ? readFileSync(resolve("app/print/prescription/[id]/prescription.css"), "utf8") : "");
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
      if (prescription) {
        expect(body).toContain('sheet sheet-a5 prescription-approved-a5');
        expect(body).toContain('℞');
        const screenWidth = await page.locator('.prescription-approved-a5').evaluate(node => node.getBoundingClientRect().width);
        expect(Math.abs(screenWidth - 148 * 96 / 25.4)).toBeLessThan(2);
        await page.screenshot({ path: resolve(output, `${kind}-approved-screen.png`), fullPage: true });
      }
      await page.emulateMedia({ media: "print" });
      await page.screenshot({ path: resolve(output, `${kind}-compact.png`), fullPage: true });
      const pdf = await page.pdf({ path: resolve(output, `${kind}-compact.pdf`), format: prescription ? "A5" : ["receipt", "patient-card"].includes(kind) ? "A6" : "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
      if (prescription && !rxFixture.long && !rxFixture.calculated && !rxFixture.historicalIbuprofen) {
        // Production respects the operator's paper choice rather than forcing A6/A5.
        const a4 = await page.pdf({ path: resolve(output, `${kind}-operator-a4.pdf`), format: "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
        const paperInfo = execFileSync("pdfinfo", ["-"], { input: a4, encoding: "utf8" });
        const size = paperInfo.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
        expect(size).not.toBeNull();
        expect(Math.abs(Number(size![1]) - 210 * 72 / 25.4)).toBeLessThan(1);
        expect(Math.abs(Number(size![2]) - 297 * 72 / 25.4)).toBeLessThan(1);
      }
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
      if (prescription) {
        // Whole-document text and page-bound checks miss a heading-only first page.
        const firstPageText = pages[0]?.words.map(word => word.text).join(" ") ?? "";
        expect(firstPageText).toContain(rxFixture.historicalIbuprofen || rxFixture.ibuprofen ? "Ibuprofen" : rxFixture.calculated ? "Amoxicillin" : rxFixture.long ? "SYN-MED-01" : "SYNTHETIC-RX-MEDICATION");
        const firstMedicationFields = rxFixture.historicalIbuprofen || rxFixture.ibuprofen
          ? ["100 mg/5 mL", "7.5 mL", "150 mg", "3 times daily"]
          : rxFixture.calculated ? ["250 mg/5 mL", "4 mL", "200 mg", "Every 8 hours"]
          : rxFixture.long ? ["SYN-DOSE-01", "SYN-AMOUNT-01", "SYN-FREQUENCY-01"]
          : ["SYN-DOSE", "SYN-AMOUNT", "SYN-FREQUENCY"];
        for (const field of firstMedicationFields) expect(firstPageText).toContain(field);
      }
      if (kind === "lab") {
        const layout = await page.locator(`.${labStyles.labIdentity}`).evaluate(node => ({ display: getComputedStyle(node).display, parentDisplay: getComputedStyle(node.parentElement!).display, labelWeight: getComputedStyle(node.querySelector("span")!).fontWeight, identifierSize: getComputedStyle(node.querySelector("strong")!).fontSize }));
        writeFileSync(resolve(output, "lab-compact-layout.json"), JSON.stringify({ syntheticOnly: true, layout }, null, 2));
        expect(layout).toEqual({ display: "block", parentDisplay: "grid", labelWeight: "700", identifierSize: "14px" });
        expect(pages.length).toBeGreaterThan(0);
        assertLabDispatchPdfFields(pages, { service: "SYNTHETIC-DISPATCH-SERVICE-1234567890123", lab: "SYNTHETIC-DISPATCH-LAB-A-1234567890123", labPhone: "777123456" });
      } else {
        if (rxFixture.long) expect(pages.length).toBeGreaterThan(1);
        else if (rxFixture.calculated) expect(pages.length).toBeGreaterThan(0);
        else expect(pages).toHaveLength(1);
        for (const paper of pages) {
        expect(Math.abs(paper.width - (prescription ? 148 : 105) * 72 / 25.4)).toBeLessThan(1);
        expect(Math.abs(paper.height - (prescription ? 210 : 148) * 72 / 25.4)).toBeLessThan(1);
        for (const word of paper.words) {
          expect([word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)).toBe(true);
          expect(word.xMin).toBeGreaterThanOrEqual(0); expect(word.yMin).toBeGreaterThanOrEqual(0);
          expect(word.xMax).toBeLessThanOrEqual(paper.width); expect(word.yMax).toBeLessThanOrEqual(paper.height);
        }
        if (prescription && !rxFixture.historicalIbuprofen) {
          const pageText = paper.words.map(word => word.text).join(" ");
          for (const identity of ["SYN-RX-PATIENT", "SYN-RX-001", "SYN-SAVED-CLINICIAN", "Rx", "#11"]) expect(pageText).toContain(identity);
          if (rxFixture.longIdentity) {
            const identities = [
              "SYN-RX-PATIENT SYNTHETIC EXTENDED PATIENT IDENTITY FOR WRAPPING SYN-PATIENT-LAST",
              "SYN-SAVED-CLINICIAN SYNTHETIC EXTENDED DOCTOR IDENTITY FOR WRAPPING SYN-DOCTOR-LAST",
            ];
            const identityHeader = await page.locator('.prescription-pages > thead').innerText();
            // These synthetic identities are ASCII. Poppler may split hyphens,
            // interleave the Arabic field label, or insert Rx #11 before the
            // clinician's wrapped suffix. Remove those layout separators;
            // every identity character must still occur in order on every page.
            const extractedIdentity = pageText.replace(/Rx\s*#11/g, "").replace(/[^\x21-\x7e]|:/g, "");
            for (const identity of identities) {
              expect(identityHeader).toContain(identity);
              expect(extractedIdentity).toContain(identity.replace(/\s/g, ""));
            }
          }
        }
        }
        const text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" });
        const references = rxFixture.historicalIbuprofen ? ["Ibuprofen", "100 mg/5 mL", "7.5 mL", "150 mg", "3 times daily; at least 8 hours apart", "5 days", historicalIbuprofenItem.instructionsEn, "Signature & Stamp", "Physician", SETTING_DEFAULTS["clinic.phone"]] : rxFixture.calculated ? [rxFixture.ibuprofen?"Ibuprofen":"Amoxicillin", rxFixture.ibuprofen?"100 mg/5 mL":"250 mg/5 mL", rxFixture.ibuprofen?"7.5 mL (150 mg)":"4 mL (200 mg)", rxFixture.ibuprofen?"3 times daily":"Every 8 hours", ...(rxFixture.ibuprofen?["at least 8 hours apart","Preferably after food."]:[]), "5 days", "SYN-CALCULATED-PLAN", "SYN-CALCULATED-END", "SYN-SAVED-CLINICIAN"] : kind === "patient-card" ? ["SYN-PRINT-1234567890123", "04/01/2031", "9:30", SETTING_DEFAULTS["clinic.phone"]] : prescription
          ? ["SYN-RX-PATIENT", "SYN-RX-001", ...(rxFixture.long ? Array.from({ length: 20 }, (_, index) => `SYN-MED-${String(index + 1).padStart(2, "0")}`) : ["SYNTHETIC-RX-MEDICATION"]), "SYN-AMOUNT", "SYN-DOSE", "SYN-FREQUENCY", "SYN-DURATION", "SYN-INSTRUCTIONS", "SYN-SAVED-CLINICIAN", "SYN-SAVED-DIAGNOSIS"]
          : ["SYN-PROV-ORIGINAL-BHGFBCDEFABCD", "SYN-REV-00002", "SYN-REP-00003"];
        for (const reference of references) expect(rxFixture.calculated || rxFixture.historicalIbuprofen ? text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ") : text).toContain(reference);
        if (rxFixture.historicalIbuprofen) {
          // PDF bidi extraction may move the closing parenthesis before Dose.
          // Preserve the exact complete clinical amount in the rendered source.
          expect(body).toContain(historicalIbuprofenItem.selection.amount);
          expect(body).toContain(historicalIbuprofenItem.instructions);
          expect(body).toContain(historicalIbuprofenItem.instructionsEn);
          expect(body).toContain("طبيب الأمن أ");
          // Every rendered word remains within the single operator-selected A5 sheet (checked above).
          expect(pages).toHaveLength(1);
        }
        if (prescription) {
          const finalPage = pages.at(-1)!.words.map(word => word.text).join(" ");
          if (rxFixture.long) expect(finalPage).toContain("SYN-MED-20");
          expect(finalPage).toContain("Signature"); expect(finalPage).toContain("Stamp");
        }
        if (rxFixture.long) for (let index = 1; index <= 20; index++) {
          for (const field of ["AMOUNT", "DOSE", "FREQUENCY", "DURATION", "INSTRUCTIONS"]) expect(text).toContain(`SYN-${field}-${String(index).padStart(2, "0")}`);
        }
        if (kind === "patient-card") {
          expect(body).not.toContain('class="print-metadata');
          expect(text.replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")).toContain(SETTING_DEFAULTS["clinic.phone"]);
        }
        if (rxFixture.calculated) { expect(body).not.toContain("synthetic.invalid"); expect(body).not.toContain("weightKg"); expect(body).not.toContain("SYN-LONG-PRODUCT"); }
        if (prescription) {
          // Query overrides are rejected by the explicit 404 cases above.
          expect(text.includes("UNAPPROVED DRAFT")).toBe(false);
        }
      }
    } finally { await browser.close(); }
  });
});


