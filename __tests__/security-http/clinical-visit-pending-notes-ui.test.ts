import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

// The real built visit page, authenticated only by the isolated HTTP harness.
// Every browser API read and every write (including non-API writes) is
// intercepted. All visit/patient/procedure data below is synthetic. No clinical
// save, signing, relinking, inventory or financial request reaches the server.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const patientId = 98201;
const visitId = 98202;
const doctorId = 98203;
const clinicalPath = `/api/visits/${visitId}/clinical`;
const fields = [
  ["chiefComplaint", "① الشكوى الرئيسية"],
  ["examination", "② الفحص"],
  ["diagnosis", "② التشخيص"],
  ["treatmentDone", "③ ما نُفّذ"],
  ["nextPlan", "الخطة القادمة"],
] as const;
type NoteKey = typeof fields[number][0];
type Notes = Record<NoteKey, string>;
const makeNotes = (prefix: string): Notes => ({
  chiefComplaint: `${prefix} complaint`, examination: `${prefix} examination`,
  diagnosis: `${prefix} diagnosis`, treatmentDone: `${prefix} treatment`, nextPlan: `${prefix} plan`,
});
const services = [
  { id: 98204, name: "Synthetic filling", category: "filling", priceMinor: 100, priceConfigured: true },
  { id: 98205, name: "Synthetic cleaning", category: "cleaning", priceMinor: 200, priceConfigured: true },
];
const procedure = {
  serviceId: services[0].id, toothCode: 11, surfaces: null, quantity: 1,
  unitPriceMinor: 100, doctorId, planItemId: null, priceReason: null,
};
function clinicalVisit(automaticTreatment: boolean) {
  return {
    id: visitId, patientId, patientName: "مريض ملاحظات تجريبي",
    ...makeNotes("Synthetic saved"), ...(automaticTreatment ? { treatmentDone: "" } : {}),
    doctorId, status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null,
    procedures: [procedure], totalMinor: 100, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null, plannedVisit: null, previousVisit: null, latestDiagnosis: null, activeCases: [],
    outstanding: [{
      planItemId: 98206, serviceId: services[1].id, planTitle: "Synthetic plan", serviceName: services[1].name,
      toothCode: 21, billingRule: "per_session", sessionCount: 1, doneSessions: 0,
      unitPriceMinor: 200, quantity: 1, status: "pending", planCurrency: "YER",
    }],
    billingCurrency: "YER", sessionPricing: [], labOrders: [],
  };
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(body),
});

function noteField(page: Page, label: string) {
  // PR187's stable locator: React mirrors controlled textarea values into text
  // children, so the wrapping label's full accessible name changes on editing.
  return page.locator(`#visit-notes label:has(> span:text-is("${label}")) > textarea`);
}
async function readNotes(page: Page): Promise<Notes> {
  const values = await Promise.all(fields.map(async ([key, label]) => [key, await noteField(page, label).inputValue()]));
  return Object.fromEntries(values) as Notes;
}
async function fillNotes(page: Page, notes: Notes) {
  for (const [key, label] of fields) await noteField(page, label).fill(notes[key]);
}

async function fixture(automaticTreatment = false) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 }, locale: "ar-YE", serviceWorkers: "block",
  });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const writes: { route: Route; body: Record<string, unknown> }[] = [];
  const refreshes: Route[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let clinicalReads = 0;
  let holdRefresh = false;
  let stored: Record<string, unknown> = clinicalVisit(automaticTreatment);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== baseUrl) {
      // Record only method/origin/path, never content, cookies or query strings.
      unexpected.push(`${method} ${url.origin}${path}`);
      await route.abort();
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (path === clinicalPath && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (!("action" in body)) {
          writes.push({ route, body });
          return;
        }
      }
      unexpected.push(`${method} ${path}`);
      await json(route, { message: "Unexpected write blocked by synthetic visit fixture" }, 409);
      return;
    }
    if (path === clinicalPath) {
      clinicalReads += 1;
      if (holdRefresh) refreshes.push(route);
      else await json(route, stored);
    } else if (path === `/api/visits/${visitId}/materials`) await json(route, { lines: [], patientId });
    else if (path === `/api/patients/${patientId}`) await json(route, { id: patientId, medicalAlert: null, phone: null });
    else if (path === `/api/patients/${patientId}/prescriptions`) await json(route, { prescriptions: [], suggestions: [] });
    else if (path === "/api/services") await json(route, services);
    else if (path === "/api/parties") await json(route, [{ id: doctorId, name: "طبيب تجريبي" }]);
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: "secadmin", role: "admin" });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}`);
      await json(route, { message: "Unexpected read blocked by synthetic visit fixture" }, 404);
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/visits/${visitId}`);
    await expect.poll(() => page.locator("#visit-notes textarea").count()).toBe(5);
    await expect.poll(() => noteField(page, "② التشخيص").inputValue()).toBe("Synthetic saved diagnosis");
    await expect.poll(() => page.getByRole("button", { name: "أضف إجراءً", exact: true }).count()).toBe(1);
    await expect.poll(() => noteField(page, "③ ما نُفّذ").inputValue())
      .toBe(automaticTreatment ? "Synthetic filling — سن 11" : "Synthetic saved treatment");
    const save = page.getByRole("button", { name: "احفظ بلا توقيع", exact: true });
    await save.waitFor();
    return {
      context, page, save, writes, refreshes, unexpected, errors,
      // Next.js also renders a global role=alert route announcer. Assertions
      // here concern only errors inside this ClinicalVisit workspace.
      alerts: page.locator("#visit-notes").locator("..").getByRole("alert"),
      clinicalReads: () => clinicalReads,
      holdReadWithNotes: (notes: Notes) => {
        stored = { ...stored, ...notes, procedures: [procedure] };
        holdRefresh = true;
      },
      succeedWrite: async (index = 0) => {
        const pending = writes[index];
        if (!pending) throw new Error("No synthetic clinical write is pending");
        stored = { ...stored, ...pending.body };
        holdRefresh = true;
        await json(pending.route, { ok: true });
      },
      finishRefresh: async (status = 200) => {
        const pending = refreshes.shift();
        if (!pending) throw new Error("No synthetic clinical reload is pending");
        holdRefresh = false;
        await json(pending, status === 200 ? stored : { message: "Synthetic reload failure" }, status);
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectLock(f: Fixture, locked: boolean) {
  for (const [, label] of fields) {
    expect(await noteField(f.page, label).isDisabled(), label).toBe(locked);
    expect(await noteField(f.page, label).isEditable(), label).toBe(!locked);
  }
  // Check every phrase group, not just one button or a Field prop.
  const groups = f.page.locator('#visit-notes [aria-label^="عبارات سريعة"]');
  expect(await groups.count()).toBe(4);
  for (const group of await groups.all()) {
    const buttons = group.getByRole("button");
    expect(await buttons.count()).toBeGreaterThan(0);
    expect(await buttons.evaluateAll((nodes, disabled) => nodes.every((node) => node.matches(":disabled") === disabled), locked)).toBe(true);
  }
  const controls = f.page.locator('#visit-procedures button, #visit-procedures input, #visit-procedures select');
  expect(await controls.count()).toBeGreaterThan(8);
  // :disabled detects native fieldset inheritance, including nested pickers.
  expect(await controls.evaluateAll((nodes, disabled) => nodes.every((node) => node.matches(":disabled") === disabled), locked)).toBe(true);
  expect(await f.save.isDisabled()).toBe(locked);
}

async function attemptPendingEdits(f: Fixture, expected: Notes) {
  for (const [, label] of fields) {
    await expect(noteField(f.page, label).fill("Must not replace the submitted note", { timeout: 150 })).rejects.toThrow();
  }
  await expect(f.page.getByRole("button", { name: "أضف إجراءً", exact: true })
    .click({ timeout: 150 })).rejects.toThrow();
  await expect(f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).fill("9", { timeout: 150 })).rejects.toThrow();
  // Native activation must also respect the lock: no phrase append, procedure
  // addition/removal, currency change or second save can alter the draft.
  await f.page.locator('#visit-notes [aria-label^="عبارات سريعة"] button, #visit-procedures button')
    .evaluateAll((buttons) => buttons.forEach((button) => (button as HTMLButtonElement).click()));
  await f.save.evaluate((button) => (button as HTMLButtonElement).click());
  expect(await readNotes(f.page)).toEqual(expected);
  expect(await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).count()).toBe(1);
  expect(await f.page.getByRole("radio", { name: "ريال يمني", exact: true }).getAttribute("aria-checked")).toBe("true");
  expect(await f.page.getByRole("dialog", { name: "أضف إجراءً للزيارة", exact: true }).count()).toBe(0);
}

function expectSafe(f: Fixture) {
  expect(f.unexpected).toEqual([]);
  expect(f.errors).toEqual([]);
}

describe("pending clinical note containment in the built visit page", () => {
  it("locks all five notes, phrases and procedure controls through both POST and reload GET, then accepts fresh edits", async () => {
    const f = await fixture();
    try {
      await expectLock(f, false);
      await fillNotes(f.page, makeNotes("Synthetic submitted"));
      const groups = f.page.locator('#visit-notes [aria-label^="عبارات سريعة"]');
      for (const group of await groups.all()) {
        await group.getByRole("button", { name: "اختر عبارة محفوظة", exact: true }).click();
        const search = group.getByRole("combobox");
        await search.press("ArrowDown"); await search.press("Enter");
      }
      await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).fill("2");
      await f.page.getByRole("textbox", { name: "الأسطح", exact: true }).fill("MO");
      const submitted = await readNotes(f.page);
      const expectedPayload = {
        ...submitted, doctorId, billingCurrency: "YER",
        procedures: [{ ...procedure, quantity: 2, surfaces: "MO" }],
      };
      await f.save.click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].body).toEqual(expectedPayload);
      await expectLock(f, true);
      await attemptPendingEdits(f, submitted);
      expect(f.clinicalReads()).toBe(1);
      expect(f.writes).toHaveLength(1);

      // One explicitly allowlisted artifact; only the synthetic visit surface.
      await mkdir(".settings-ui-artifacts", { recursive: true });
      // Start at the top so the fixed application header does not cover the
      // middle of an element-only screenshot after the save button scrolls.
      await f.page.evaluate(() => window.scrollTo(0, 0));
      await f.page.screenshot({ path: ".settings-ui-artifacts/clinical-visit-pending-notes.png", fullPage: true });

      await f.succeedWrite();
      await expect.poll(() => f.refreshes.length).toBe(1);
      await expectLock(f, true);
      await attemptPendingEdits(f, submitted);
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0].body).toEqual(expectedPayload);
      await f.finishRefresh();
      await expect.poll(() => f.save.isEnabled()).toBe(true);
      await expectLock(f, false);
      expect(await readNotes(f.page)).toEqual(submitted);

      const nextNotes = makeNotes("Synthetic edit after success");
      await fillNotes(f.page, nextNotes);
      for (const [key, label] of fields.filter(([key]) => key !== "treatmentDone")) {
        const phrase = f.page.locator(`[aria-label="عبارات سريعة — ${label}"]`).getByRole("button").first();
        await phrase.click();
        const search = f.page.getByRole("combobox", { name: `بحث في العبارات — ${label}`, exact: true });
        await search.press("ArrowDown"); await search.press("Enter");
        expect(await noteField(f.page, label).inputValue()).toContain(`${nextNotes[key]}، `);
      }
      await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).fill("3");
      await f.page.getByRole("button", { name: "أضف إجراءً", exact: true }).click();
      const picker = f.page.getByRole("dialog", { name: "أضف إجراءً للزيارة", exact: true });
      await picker.getByRole("textbox", { name: "بحث في الخدمات" }).fill(services[1].name);
      await picker.getByRole("button").filter({ hasText: services[1].name }).click();
      expect(await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).count()).toBe(2);
      expect(await noteField(f.page, "③ ما نُفّذ").inputValue()).toBe(nextNotes.treatmentDone);
      expect(f.writes).toHaveLength(1);
      expectSafe(f);
    } finally { await f.context.close(); }
  });

  it.each(["rejection", "network failure"] as const)("retains notes and unlocks after a POST %s, allowing a corrected retry", async (failure) => {
    const f = await fixture();
    try {
      const submitted = makeNotes("Synthetic failed attempt");
      await fillNotes(f.page, submitted);
      await f.save.click();
      await expect.poll(() => f.writes.length).toBe(1);
      await expectLock(f, true);
      if (failure === "rejection") await json(f.writes[0].route, { message: "Synthetic save rejection" }, 409);
      else await f.writes[0].route.abort("failed");
      await expect.poll(() => f.save.isEnabled()).toBe(true);
      await expectLock(f, false);
      expect(await readNotes(f.page)).toEqual(submitted);
      expect(await f.alerts.count()).toBe(1);
      expect(await f.alerts.textContent()).toContain(failure === "rejection" ? "Synthetic save rejection" : "تعذّر الاتصال بالخادم.");
      expect(f.clinicalReads()).toBe(1);
      expect(f.refreshes).toHaveLength(0);

      const corrected = makeNotes("Synthetic corrected retry");
      await fillNotes(f.page, corrected);
      await f.save.click();
      await expect.poll(() => f.writes.length).toBe(2);
      expect(f.writes[1].body).toMatchObject(corrected);
      await expectLock(f, true);
      await f.succeedWrite(1);
      await expect.poll(() => f.refreshes.length).toBe(1);
      await expectLock(f, true);
      await f.finishRefresh();
      await expect.poll(() => f.save.isEnabled()).toBe(true);
      await expectLock(f, false);
      expect(await readNotes(f.page)).toEqual(corrected);
      expect(await f.alerts.count()).toBe(0);
      expect(f.writes).toHaveLength(2);
      expectSafe(f);
    } finally { await f.context.close(); }
  });

  it("hides editing after a failed post-save reload and restores the exact draft only after an authorized retry", async () => {
    const f = await fixture();
    try {
      const submitted = makeNotes("Synthetic reload failure draft");
      await fillNotes(f.page, submitted);
      await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).fill("2");
      await f.page.getByRole("textbox", { name: "الأسطح", exact: true }).fill("MO");
      await f.save.click();
      await expect.poll(() => f.writes.length).toBe(1);
      await f.succeedWrite();
      await expect.poll(() => f.refreshes.length).toBe(1);
      await expectLock(f, true);
      await f.finishRefresh(503);
      const unavailable = f.page.getByRole("alert").filter({ hasText: "تعذّر تحميل الزيارة الحالية" });
      await unavailable.waitFor();
      expect(await f.page.locator("#visit-notes textarea").count()).toBe(0);
      expect(await f.save.count()).toBe(0);
      expect(await f.page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).count()).toBe(0);
      expect(await f.page.getByText("احتُفظ بمسودة الزيارة لهذه الجلسة؛ التعديل والحفظ متوقفان حتى نجاح إعادة التحميل.", { exact: true }).count()).toBe(1);
      expect(await f.page.getByText("Synthetic reload failure", { exact: true }).count()).toBe(0);
      expect(f.clinicalReads()).toBe(2);
      expect(f.writes).toHaveLength(1);

      // A fresh successful read restores authority, but a stale persisted
      // snapshot must not replace any of the five notes or procedure edits.
      f.holdReadWithNotes(makeNotes("Synthetic stale persisted"));
      await f.page.getByRole("button", { name: "أعد تحميل الزيارة", exact: true }).click();
      await expect.poll(() => f.refreshes.length).toBe(1);
      expect(await f.page.locator("#visit-notes textarea").count()).toBe(0);
      expect(await f.save.count()).toBe(0);
      expect(f.writes).toHaveLength(1);
      await f.finishRefresh();
      await expect.poll(() => f.save.isEnabled()).toBe(true);
      await expectLock(f, false);
      expect(await readNotes(f.page)).toEqual(submitted);
      expect(await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).inputValue()).toBe("2");
      expect(await f.page.getByRole("textbox", { name: "الأسطح", exact: true }).inputValue()).toBe("MO");
      expect(await f.alerts.count()).toBe(0);
      expect(f.clinicalReads()).toBe(3);
      const later = makeNotes("Synthetic correction after authorized recovery");
      await fillNotes(f.page, later);
      await f.save.click();
      await expect.poll(() => f.writes.length).toBe(2);
      expect(f.writes[1].body).toEqual({ ...later, doctorId, billingCurrency: "YER",
        procedures: [{ ...procedure, quantity: 2, surfaces: "MO" }] });
      await expectLock(f, true);
      await f.succeedWrite(1);
      await expect.poll(() => f.refreshes.length).toBe(1);
      await expectLock(f, true);
      await f.finishRefresh();
      await expect.poll(() => f.save.isEnabled()).toBe(true);
      await expectLock(f, false);
      expect(await readNotes(f.page)).toEqual(later);
      expect(f.writes).toHaveLength(2);
      expectSafe(f);
    } finally { await f.context.close(); }
  });

  it("keeps automatically generated treatment text stable while procedures and an already-open tooth picker are frozen", async () => {
    const f = await fixture(true);
    try {
      await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).fill("2");
      await expect.poll(() => noteField(f.page, "③ ما نُفّذ").inputValue()).toBe("Synthetic filling — سن 11 ×2");
      await f.page.getByRole("button", { name: "رقم السن", exact: true }).click();
      const tooth = f.page.getByRole("group", { name: "الفك العلوي", exact: true }).getByRole("button", { name: /^12 —/ });
      expect(await tooth.isEnabled()).toBe(true);
      const submitted = await readNotes(f.page);
      await f.save.click();
      await expect.poll(() => f.writes.length).toBe(1);
      await expectLock(f, true);
      await attemptPendingEdits(f, submitted);
      expect(await tooth.isDisabled()).toBe(true);
      await f.succeedWrite();
      await expect.poll(() => f.refreshes.length).toBe(1);
      await expectLock(f, true);
      await attemptPendingEdits(f, submitted);
      await f.finishRefresh();
      await expect.poll(() => f.save.isEnabled()).toBe(true);
      await expectLock(f, false);
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0].body).toMatchObject({ treatmentDone: submitted.treatmentDone, procedures: [{ ...procedure, quantity: 2 }] });

      await tooth.click();
      await expect.poll(() => noteField(f.page, "③ ما نُفّذ").inputValue()).toBe("Synthetic filling — سن 12 ×2");
      await f.page.getByRole("button", { name: "+ نفّذ اليوم", exact: true }).click();
      await expect.poll(() => noteField(f.page, "③ ما نُفّذ").inputValue()).toBe("Synthetic filling — سن 12 ×2؛ Synthetic cleaning — سن 21");
      await f.page.locator("#visit-procedures").getByRole("button", { name: "احذف", exact: true }).first().click();
      await expect.poll(() => noteField(f.page, "③ ما نُفّذ").inputValue()).toBe("Synthetic cleaning — سن 21");
      expect(f.writes).toHaveLength(1);
      expectSafe(f);
    } finally { await f.context.close(); }
  });
});
