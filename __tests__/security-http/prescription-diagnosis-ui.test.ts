import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { PROCEDURE_TEMPLATES } from "../../lib/prescription-procedure-templates";
import { baseUrl, harness } from "./_server";

// Exercise the real built /visits/[id] page and its persistently mounted Rx
// modal. Authentication uses the isolated HTTP harness; every browser API read
// and every mutation is intercepted. The patient, visit, medicine and safety
// response are synthetic. No clinical save or print-page DB read can escape.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const patientId = 98101;
const visitId = 98102;
const prescriptionId = 98103;
const acknowledgementToken = "synthetic-prescription-acknowledgement";
const draftNotes = "تعليمات تجريبية محفوظة في المسودة";
const medicine = {
  name: "SyntheticRx", dose: "fixture dose", form: "Tablets",
  frequency: "fixture frequency", duration: "fixture duration",
  instructions: "تعليمات تجريبية", instructionsEn: "Synthetic instructions",
};

function clinicalVisit(diagnosis: string) {
  return {
    id: visitId, patientId, patientName: "مريض وصفة تجريبي",
    chiefComplaint: "", examination: "", diagnosis, treatmentDone: "", nextPlan: "", addendum: null,
    doctorId: 98104, status: "open", signedAt: null, signedBy: null, invoiceId: null,
    procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null, plannedVisit: null, previousVisit: null, latestDiagnosis: null,
    activeCases: [], outstanding: [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
  };
}

async function fixture(initialDiagnosis = "") {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 }, locale: "ar-YE", serviceWorkers: "block",
  });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const requests: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const pendingPreviews: Route[] = [];
  let holdPreview = false;
  const safetyPreview = {
    requiresAcknowledgement: true, acknowledgementToken,
    safetyWarnings: [{
      id: "synthetic-warning", severity: "warning", medicationName: medicine.name,
      title: "تحذير تجريبي يتطلب المراجعة", message: "إقرار صريح مطلوب في هذا الاختبار",
      contraindicatedRiskId: "synthetic-risk",
    }],
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({
    status, contentType: "application/json", body: JSON.stringify(body),
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== baseUrl) {
      unexpected.push(`${method} ${request.url()}`);
      await route.abort();
      return;
    }
    // Block even unexpected non-API writes rather than falling through to the
    // harness server. Only the synthetic prescription response is successful.
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (path === "/api/prescriptions" && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        requests.push(body);
        if (body.acknowledgedSafetyToken === acknowledgementToken) {
          await json(route, { id: prescriptionId, safetyWarnings: [] }, 201);
        } else if (holdPreview) {
          pendingPreviews.push(route);
        } else {
          await json(route, safetyPreview);
        }
      } else {
        unexpected.push(`${method} ${path}`);
        await json(route, { message: "Unexpected mutation blocked by Rx fixture" }, 409);
      }
      return;
    }
    if (path === `/api/visits/${visitId}/clinical`) await json(route, clinicalVisit(initialDiagnosis));
    else if (path === `/api/visits/${visitId}/materials`) await json(route, { lines: [], patientId });
    else if (path === `/api/patients/${patientId}`) await json(route, { id: patientId, medicalAlert: null, phone: null });
    else if (path === `/api/patients/${patientId}/prescriptions`) await json(route, { prescriptions: [], suggestions: [] });
    else if (path === "/api/services") await json(route, []);
    else if (path === "/api/parties") await json(route, [{ id: 98104, name: "طبيب تجريبي" }]);
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: "secadmin", role: "admin" });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}`);
      await json(route, { message: "Unexpected data read blocked by Rx fixture" }, 404);
    } else await route.continue();
  });
  await context.addInitScript(() => {
    const state = window as typeof window & { prescriptionPrints: string[] };
    state.prescriptionPrints = [];
    // Check the real modal's official-print navigation contract, without
    // opening the server-rendered print route or reading stored patient data.
    window.open = (url) => { state.prescriptionPrints.push(String(url)); return null; };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/visits/${visitId}`);
    const visitDiagnosis = page.getByLabel("② التشخيص", { exact: true });
    await visitDiagnosis.waitFor();
    await expect.poll(() => visitDiagnosis.inputValue()).toBe(initialDiagnosis);
    const diagnosis = page.getByPlaceholder("مثال: Acute Pulpitis / Post-Extraction", { exact: true });
    const notes = page.getByPlaceholder("مثال: الامتناع عن المشروبات الساخنة لمدة 24 ساعة، وضع كمادات باردة...", { exact: true });
    const open = async () => {
      await page.getByRole("button", { name: "روشتة طبية (℞)" }).click();
      await diagnosis.waitFor();
    };
    const close = async () => {
      await page.getByRole("button", { name: "إلغاء", exact: true }).click();
      await diagnosis.waitFor({ state: "detached" });
    };
    return { context, page, visitDiagnosis, diagnosis, notes, open, close, requests, unexpected, errors,
      holdPrescriptionPreview: () => { holdPreview = true; },
      releasePrescriptionPreview: async () => {
        const pending = pendingPreviews.shift();
        if (!pending) throw new Error("No prescription preview is pending");
        holdPreview = false;
        await json(pending, safetyPreview);
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function fillMedicine(page: Page) {
  await page.getByRole("button", { name: "إضافة دواء جديد", exact: true }).click();
  for (const [placeholder, value] of [
    ["Drug name (e.g. Augmentin / Brufen)", medicine.name],
    ["Dose (1g / 500mg)", medicine.dose],
    ["Form (Tablets / Syrup)", medicine.form],
    ["Frequency (every 8 hours)", medicine.frequency],
    ["Duration (5 days)", medicine.duration],
    ["التعليمات بالعربية (بعد الأكل…)", medicine.instructions],
    ["Instructions in English (after meals…)", medicine.instructionsEn],
  ]) await page.getByPlaceholder(placeholder, { exact: true }).fill(value);
}

async function assertMedicine(page: Page) {
  expect(await page.getByPlaceholder("Drug name (e.g. Augmentin / Brufen)", { exact: true }).count()).toBe(1);
  expect(await page.getByPlaceholder("Drug name (e.g. Augmentin / Brufen)", { exact: true }).inputValue()).toBe(medicine.name);
  expect(await page.getByPlaceholder("Dose (1g / 500mg)", { exact: true }).inputValue()).toBe(medicine.dose);
  expect(await page.getByPlaceholder("Frequency (every 8 hours)", { exact: true }).inputValue()).toBe(medicine.frequency);
  expect(await page.getByPlaceholder("Duration (5 days)", { exact: true }).inputValue()).toBe(medicine.duration);
}

async function prints(page: Page) {
  return page.evaluate(() => (window as typeof window & { prescriptionPrints: string[] }).prescriptionPrints);
}

describe("prescription diagnosis draft in the built visit page", () => {
  it("inherits late visit edits before first open and on reopening, then submits the current diagnosis only printing after acknowledgement", async () => {
    const f = await fixture();
    try {
      // The modal is already mounted (but hidden) after the visit loads. This
      // edit must be inherited even though it comes after useState's mount.
      await f.visitDiagnosis.fill("Diagnosis entered after visit load");
      await f.open();
      expect(await f.diagnosis.inputValue()).toBe("Diagnosis entered after visit load");
      await fillMedicine(f.page);
      await f.notes.fill(draftNotes);
      await f.page.getByRole("button", { name: "English", exact: true }).click();
      await f.close();
      await f.visitDiagnosis.fill("Updated diagnosis before prescription print");
      await f.open();
      expect(await f.diagnosis.inputValue()).toBe("Updated diagnosis before prescription print");
      expect(await f.notes.inputValue()).toBe(draftNotes);
      await assertMedicine(f.page);
      expect(f.requests).toEqual([]);
      expect(await prints(f.page)).toEqual([]);

      const expected = {
        patientId, diagnosis: "Updated diagnosis before prescription print", notes: draftNotes,
        instructionsLang: "en", items: [medicine],
      };
      f.holdPrescriptionPreview();
      await f.page.getByRole("button", { name: "طباعة الروشتة (A5)", exact: true }).click();
      await expect.poll(() => f.requests.length).toBe(1);
      expect(f.requests).toEqual([expected]);
      expect(await prints(f.page)).toEqual([]);
      // The same ownership applies while the initial POST is still in flight,
      // before any safety response has returned.
      await f.close();
      await f.visitDiagnosis.fill("Later visit edit while save is pending");
      await f.open();
      expect(await f.diagnosis.inputValue()).toBe(expected.diagnosis);
      expect(await f.notes.inputValue()).toBe(draftNotes);
      await assertMedicine(f.page);
      expect(await f.page.getByRole("button", { name: "جارٍ حفظ الوصفة…", exact: true }).isDisabled()).toBe(true);
      expect(f.requests).toEqual([expected]);
      expect(await prints(f.page)).toEqual([]);
      await f.releasePrescriptionPreview();
      const acknowledge = f.page.getByRole("button", { name: "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا", exact: true });
      await acknowledge.waitFor();
      // Printing now owns the reviewed Rx draft: a later visit edit must not
      // silently change the diagnosis carried by the acknowledgement retry.
      await f.close();
      await f.visitDiagnosis.fill("Later visit edit while acknowledgement is pending");
      await f.open();
      expect(await f.diagnosis.inputValue()).toBe(expected.diagnosis);
      expect(await f.notes.inputValue()).toBe(draftNotes);
      await assertMedicine(f.page);
      await acknowledge.waitFor();
      await f.diagnosis.scrollIntoViewIfNeeded();
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await f.page.screenshot({ path: ".settings-ui-artifacts/prescription-diagnosis-pinned.png" });
      await acknowledge.click();
      await expect.poll(() => prints(f.page)).toEqual([`/print/prescription/${patientId}?rx=${prescriptionId}`]);
      expect(f.requests).toEqual([expected, { ...expected, acknowledgedSafetyToken: acknowledgementToken }]);
      // Pinning a submitted draft must not disable a deliberate later edit.
      await f.diagnosis.fill("Deliberately revised prescription diagnosis");
      expect(await f.diagnosis.inputValue()).toBe("Deliberately revised prescription diagnosis");
      expect(f.unexpected).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it.each(["manual", "cleared", "same-as-inherited", "template"] as const)(
    "keeps deliberate %s diagnosis plus medicine and notes through close/edit/reopen",
    async (kind) => {
      const initialDiagnosis = "Initial visit diagnosis";
      const f = await fixture(initialDiagnosis);
      try {
        await f.open();
        expect(await f.diagnosis.inputValue()).toBe(initialDiagnosis);
        await fillMedicine(f.page);
        let expectedDiagnosis: string;
        let expectedNotes = draftNotes;
        if (kind === "template") {
          const template = PROCEDURE_TEMPLATES[0];
          await f.page.getByRole("button", { name: template.title, exact: true }).click();
          expectedDiagnosis = template.diagnosis;
          expectedNotes = template.notes;
        } else {
          expectedDiagnosis = kind === "cleared" ? "" : kind === "same-as-inherited" ? initialDiagnosis : "Manually chosen prescription diagnosis";
          // A user can deliberately replace text with the inherited value.
          // An equality-based dirty heuristic must not discard that ownership.
          if (kind === "same-as-inherited") await f.diagnosis.fill("Temporary manual diagnosis");
          await f.diagnosis.fill(expectedDiagnosis);
          await f.notes.fill(expectedNotes);
        }
        for (const nextDiagnosis of ["New visit diagnosis after cancellation", ""]) {
          await f.close();
          await f.visitDiagnosis.fill(nextDiagnosis);
          await f.open();
          expect(await f.diagnosis.inputValue()).toBe(expectedDiagnosis);
          expect(await f.notes.inputValue()).toBe(expectedNotes);
          await assertMedicine(f.page);
          if (kind === "template") {
            expect(await f.page.getByText("قبل وصف أي دواء لهذه الحالة — تحقّق سريريًا من:", { exact: true }).isVisible()).toBe(true);
          }
        }
        expect(f.requests).toEqual([]);
        expect(await prints(f.page)).toEqual([]);
        expect(f.unexpected).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally { await f.context.close(); }
    },
  );
});
