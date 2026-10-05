import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { toWhatsAppNumber } from "../../lib/reminders";
import { PROCEDURE_TEMPLATES } from "../../lib/prescription-procedure-templates";
import { baseUrl, harness } from "./_server";

// Exercise the real built /visits/[id] page and its persistently mounted Rx
// modal. Authentication uses the isolated HTTP harness; every browser API read
// and every mutation is intercepted, except the explicitly allowlisted seeded
// patient GET in the read-only HTTP contract case. The patient, visit, medicine and safety
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

function clinicalVisit(diagnosis: string, contextPatientId = patientId) {
  return {
    id: visitId, patientId: contextPatientId, patientName: "مريض وصفة تجريبي",
    chiefComplaint: "", examination: "", diagnosis, treatmentDone: "", nextPlan: "", addendum: null,
    doctorId: 98104, status: "open", signedAt: null, signedBy: null, invoiceId: null,
    procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null, plannedVisit: null, previousVisit: null, latestDiagnosis: null,
    activeCases: [], outstanding: [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
  };
}

async function fixture(initialDiagnosis = "", patientRead: { id?: number; real?: boolean; body?: unknown; status?: number } = {}, width = 1280) {
  const contextPatientId = patientRead.id ?? patientId;
  let patientPayload: unknown = patientRead.body ?? { patient: { id: contextPatientId, medicalAlert: null, phone: null }, visits: [], appointments: [] };
  let patientStatus = patientRead.status ?? 200;
  let holdPatient = false;
  const pendingPatients: Route[] = [];
  const context = await browser.newContext({
    viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block",
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
    if (path === `/api/visits/${visitId}/clinical`) await json(route, clinicalVisit(initialDiagnosis, contextPatientId));
    else if (path === `/api/visits/${visitId}/materials`) await json(route, { lines: [], patientId: contextPatientId });
    else if (path === `/api/patients/${contextPatientId}`) {
      if (patientRead.real) await route.continue();
      else if (holdPatient) pendingPatients.push(route);
      else await json(route, patientPayload, patientStatus);
    }
    else if (path === `/api/patients/${contextPatientId}/prescriptions`) await json(route, { prescriptions: [], suggestions: [] });
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
    // Match the static label span, not the wrapping label's textContent:
    // React mirrors a controlled textarea value into its text child, which
    // makes an exact getByLabel match change after entering a diagnosis.
    const visitDiagnosis = page.locator('#visit-notes label:has(> span:text-is("② التشخيص")) > textarea');
    await expect.poll(() => visitDiagnosis.count()).toBe(1);
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
      setPatientResponse: (body: unknown, status = 200) => { patientPayload = body; patientStatus = status; },
      holdPatientRead: () => { holdPatient = true; },
      pendingPatientReads: () => pendingPatients.length,
      releasePatientRead: async () => {
        const pending = pendingPatients.shift();
        if (!pending) throw new Error("No patient context read is pending");
        holdPatient = false;
        await json(pending, patientPayload, patientStatus);
      },
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


/** Capture actual RTL viewport geometry and native hit targets, never fullPage. */
async function capturePatientContext(page: Page, width: number, contextState: "warning" | "unavailable") {
  const heading = page.getByRole("heading", { name: "إصدار وصفة طبية (روشتة)", exact: true });
  // The unchanged modal panel owns its header, scrolling content, and footer.
  const panel = heading.locator("../../../..");
  const warning = contextState === "warning"
    ? panel.getByText("Penicillin allergy", { exact: true }).locator("../..")
    : panel.getByRole("status").filter({ hasText: "حالة الحساسية والمخاطر غير معروفة هنا" });
  await warning.waitFor();
  await page.evaluate(async () => { await document.fonts.ready; });
  await warning.evaluate((element) => element.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const targets: Array<{ label: string; locator: Locator }> = [
    { label: `${contextState} patient-context notice`, locator: warning },
    { label: "cancel", locator: panel.getByRole("button", { name: "إلغاء", exact: true }) },
    { label: "print", locator: panel.getByRole("button", { name: "طباعة الروشتة (A5)", exact: true }) },
    ...(contextState === "warning" ? [{ label: "synthetic phone action", locator: panel.getByRole("button", { name: /إرسال واتساب/ }) }] : []),
  ];
  const bounds = [];
  for (const { label, locator } of targets) {
    // Inspect every target at this one capture position. Scrolling individual
    // controls into different viewports would not prove the screenshot's UI.
    const geometry = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const insetX = Math.min(12, rect.width / 4); const insetY = Math.min(12, rect.height / 4);
      const points = [[rect.left + insetX, rect.top + insetY], [rect.right - insetX, rect.top + insetY],
        [rect.left + insetX, rect.bottom - insetY], [rect.right - insetX, rect.bottom - insetY],
        [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        viewport: { width: innerWidth, height: innerHeight }, direction: getComputedStyle(element).direction,
        contentFits: element.scrollWidth <= element.clientWidth + 1,
        hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }) };
    });
    expect(geometry.width).toBeGreaterThan(20); expect(geometry.height).toBeGreaterThan(20);
    expect(geometry.viewport).toEqual({ width, height: 1000 }); expect(geometry.direction).toBe("rtl");
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.contentFits).toBe(true); expect(geometry.hits).toEqual([true, true, true, true, true]);
    bounds.push({ label, ...geometry });
  }
  const containment = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
      panelFits: element.scrollWidth <= element.clientWidth + 1,
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      viewport: { width: innerWidth, height: innerHeight } };
  });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(containment.documentFits).toBe(true); expect(containment.panelFits).toBe(true);
  expect(containment.left).toBeGreaterThanOrEqual(0); expect(containment.top).toBeGreaterThanOrEqual(0);
  expect(containment.right).toBeLessThanOrEqual(width); expect(containment.bottom).toBeLessThanOrEqual(1000);
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const name = `prescription-patient-context-${contextState}-${width}`;
  await writeFile(`.settings-ui-artifacts/${name}-bounds.json`, JSON.stringify({ contextState, containment, bounds }, null, 2));
  await page.screenshot({ path: `.settings-ui-artifacts/${name}.png` });
}

describe("patient-file context in the built prescription consumer", () => {
  it.each([1280, 390])("shows nested allergy and phone, refreshes on reopen, and keeps Rx/visit drafts through pending and failed reads at %ipx", async (width) => {
    const f = await fixture("Visit draft diagnosis", { body: {
      patient: { id: patientId, medicalAlert: "Penicillin allergy", phone: "777100099" }, visits: [], appointments: [],
    } }, width);
    try {
      await f.open();
      await f.page.getByText("Penicillin allergy", { exact: true }).waitFor();
      await f.page.getByRole("button", { name: /إرسال واتساب/ }).waitFor();
      await f.diagnosis.fill("Independent Rx draft");
      await f.notes.fill(draftNotes);
      await fillMedicine(f.page);
      const drugName = f.page.getByPlaceholder("Drug name (e.g. Augmentin / Brufen)", { exact: true });
      await drugName.fill("Amoxicillin");
      await f.page.getByText("خطر تحسسي حرج (Penicillin Allergy)", { exact: true }).waitFor();
      await capturePatientContext(f.page, width, "warning");
      await f.page.getByRole("button", { name: /إرسال واتساب/ }).click();
      expect(await prints(f.page)).toEqual([expect.stringContaining("https://wa.me/967777100099?")]);
      await f.close();
      await f.visitDiagnosis.fill("Unsubmitted visit draft");
      f.holdPatientRead(); await f.open();
      await expect.poll(f.pendingPatientReads).toBe(1);
      await f.page.getByText(/جارٍ تحميل التنبيهات الطبية وبيانات التواصل/).waitFor();
      expect(await f.page.getByText("Penicillin allergy", { exact: true }).count()).toBe(0);
      expect(await f.page.getByRole("button", { name: /إرسال واتساب/ }).count()).toBe(0);
      expect(await f.diagnosis.inputValue()).toBe("Independent Rx draft");
      expect(await f.notes.inputValue()).toBe(draftNotes);
      expect(await drugName.inputValue()).toBe("Amoxicillin");
      f.setPatientResponse({ patient: { id: patientId, medicalAlert: null, phone: null }, visits: [], appointments: [] });
      await f.releasePatientRead();
      await f.page.getByText(/جارٍ تحميل التنبيهات الطبية وبيانات التواصل/).waitFor({ state: "detached" });
      expect(await f.page.getByText("خطر تحسسي حرج (Penicillin Allergy)", { exact: true }).count()).toBe(0);
      await f.close();
      f.setPatientResponse({ message: "Synthetic unavailable read" }, 503); await f.open();
      await f.page.getByText(/حالة الحساسية والمخاطر غير معروفة هنا/).waitFor();
      expect(await f.diagnosis.inputValue()).toBe("Independent Rx draft");
      expect(await drugName.inputValue()).toBe("Amoxicillin");
      expect(await f.visitDiagnosis.inputValue()).toBe("Unsubmitted visit draft");
      await capturePatientContext(f.page, width, "unavailable");
      expect(f.requests).toEqual([]); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("reads the isolated seeded patient's actual HTTP GET envelope into the built consumer without flattening it", async () => {
    // The global harness owns this disposable synthetic database. This case
    // allows exactly its patient GET; all other browser API reads and writes
    // remain intercepted. No Production patient or clinical mutation is used.
    const id = h.seeded.patientAId;
    const before = await fetch(`${baseUrl}/api/patients/${id}`, { headers: { Cookie: h.sessions.admin.cookie } });
    expect(before.status).toBe(200);
    const payload = await before.json() as { patient: { id: number; medicalAlert: string | null; phone: string | null }; visits: unknown[]; appointments: unknown[] };
    expect(payload.patient.id).toBe(id);
    expect(Array.isArray(payload.visits)).toBe(true); expect(Array.isArray(payload.appointments)).toBe(true);
    expect(payload.patient.phone).toBeTruthy();
    const f = await fixture("Synthetic real-GET contract", { id, real: true });
    try {
      await f.open();
      await f.page.getByRole("button", { name: /إرسال واتساب/ }).waitFor();
      expect(await f.page.getByText(/تعذّر التحقق من التنبيهات الطبية/).count()).toBe(0);
      if (payload.patient.medicalAlert) await f.page.getByText(payload.patient.medicalAlert, { exact: true }).waitFor();
      await f.page.getByRole("button", { name: /إرسال واتساب/ }).click();
      const opened = await prints(f.page);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain(`https://wa.me/${toWhatsAppNumber(payload.patient.phone!)}?`);
      expect(f.requests).toEqual([]); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
