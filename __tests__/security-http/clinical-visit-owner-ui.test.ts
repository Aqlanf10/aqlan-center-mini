import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Dialog, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

// Remote CI acceptance only. The real built patient/Today composition is used;
// no fixture component, React hook replacement, Production URL or real patient.
// Every browser API response and every write (including non-API writes) is
// intercepted. Synthetic POST success proves the UI transport/owner contract,
// not backend transactions, signing integrity, rollback or persisted records.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const patientId = 98301;
const visitA = 98302;
const visitB = 98303;
const doctorId = 98304;
const clinicalPath = (id: number) => `/api/visits/${id}/clinical`;
const patientPath = `/api/patients/${patientId}`;
const fields = [
  ["chiefComplaint", "① الشكوى الرئيسية"],
  ["examination", "② الفحص"],
  ["diagnosis", "② التشخيص"],
  ["treatmentDone", "③ ما نُفّذ"],
  ["nextPlan", "الخطة القادمة"],
] as const;
type Notes = Record<typeof fields[number][0], string>;
const notes = (prefix: string): Notes => ({
  chiefComplaint: `${prefix} complaint`, examination: `${prefix} examination`,
  diagnosis: `${prefix} diagnosis`, treatmentDone: `${prefix} treatment`, nextPlan: `${prefix} plan`,
});
const services = [
  { id: 98305, name: "Synthetic procedure A", category: "filling", priceMinor: 100, priceConfigured: true },
  { id: 98306, name: "Synthetic procedure B", category: "cleaning", priceMinor: 200, priceConfigured: true },
];
const procedure = (id: number) => ({
  serviceId: id === visitA ? services[0].id : services[1].id,
  toothCode: id === visitA ? 11 : 21, surfaces: null,
  quantity: id === visitA ? 1 : 2, unitPriceMinor: id === visitA ? 100 : 200,
  doctorId, planItemId: null, priceReason: null,
});
const ownerName = (id: number) => id === visitA ? "A" : "B";
const clinicalVisit = (id: number) => ({
  id, patientId, patientName: "مريض ملكية تجريبي — ليس حقيقياً",
  ...notes(`Synthetic saved ${ownerName(id)}`), doctorId,
  status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null,
  procedures: [procedure(id)], totalMinor: id === visitA ? 100 : 400,
  planItemsMatched: 0, planTitle: null, planWarning: null, ortho: null,
  plannedVisit: null, previousVisit: null, latestDiagnosis: null, activeCases: [],
  outstanding: [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
});
const patient = {
  id: patientId, patientNumber: "SYNTHETIC-OWNER-98301", fullName: "مريض ملكية تجريبي — ليس حقيقياً",
  phone: null, altPhone: null, gender: "unknown", birthYear: null, birthDate: null,
  address: null, medicalAlert: null, note: null, createdAt: "2026-01-02T09:00:00.000Z",
  photoDocumentId: null, flags: [], email: null, preferredChannel: null,
};
const financial = {
  balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0, agreedMinor: 0,
  treatmentDoneMinor: 0, remainingTreatmentMinor: 0, byCurrency: {},
};
const workflow = (id: number) => ({
  openVisit: {
    id, status: "in_chair", chair: 1,
    // B deliberately represents an older unsigned visit returned after A.
    arrivedAt: id === visitA ? "2026-01-02T10:00:00.000Z" : "2026-01-01T10:00:00.000Z",
    plannedTitle: `Synthetic visit ${ownerName(id)}`,
  },
  lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [],
  counts: { visits: 2, openLabOrders: 0, documents: 0, orthoCase: false },
  financial, alerts: [], canSeeFinancial: true,
});
const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(body),
});
function noteField(page: Page, label: string) {
  // A wrapping label's accessible name also includes its controlled textarea value.
  return page.locator(`#visit-notes label:has(> span:text-is("${label}")) > textarea`);
}
async function readNotes(page: Page): Promise<Notes> {
  return Object.fromEntries(await Promise.all(fields.map(async ([key, label]) =>
    [key, await noteField(page, label).inputValue()]))) as Notes;
}
async function fillNotes(page: Page, value: Notes) {
  for (const [key, label] of fields) await noteField(page, label).fill(value[key]);
}
async function selected(page: Page, tab: "today" | "summary") {
  await expect.poll(() => page.getByTestId(`patient-tab-${tab}`).getAttribute("aria-current")).toBe("page");
}

async function fixture(options: { holdInitialA?: boolean; holdB?: boolean } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1100 }, locale: "ar-YE", serviceWorkers: "block",
  });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const writes: { route: Route; visitId: number; body: Record<string, unknown> }[] = [];
  const reads: { route: Route; visitId: number }[] = [];
  const heldReads: { route: Route; visitId: number }[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const snapshots = new Map<number, Record<string, unknown>>([
    [visitA, clinicalVisit(visitA)], [visitB, clinicalVisit(visitB)],
  ]);
  let activeVisit = visitA;
  let nextWorkflowVisit: number | null = null;
  let workflowReads = 0;
  let refreshWrites = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== baseUrl) {
      // Never record bodies, tokens, query strings or cookies in diagnostics.
      unexpected.push(`${method} ${url.origin}${path}`);
      await route.abort();
      return;
    }
    const clinicalOwner = [visitA, visitB].find((id) => path === clinicalPath(id));
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (clinicalOwner !== undefined && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (body && typeof body === "object" && (!("action" in body) || body.action === "sign")) {
          writes.push({ route, visitId: clinicalOwner, body });
          return; // Held for the test; NEVER forwarded to the harness server.
        }
      }
      // One explicitly armed ordinary Vitals form submission triggers the real
      // parent's onSaved/load path. It only changes this fixture's next GET.
      if (method === "PATCH" && path === patientPath && nextWorkflowVisit !== null) {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (Object.keys(body).length === 1 && typeof body.medicalAlert === "string") {
          activeVisit = nextWorkflowVisit;
          nextWorkflowVisit = null;
          refreshWrites += 1;
          await json(route, { ...patient, medicalAlert: body.medicalAlert });
          return;
        }
      }
      unexpected.push(`${method} ${path}`);
      await json(route, { message: "Unexpected write blocked by synthetic owner fixture" }, 409);
      return;
    }
    if (clinicalOwner !== undefined) {
      const read = { route, visitId: clinicalOwner };
      reads.push(read);
      if ((clinicalOwner === visitA && options.holdInitialA && reads.filter((item) => item.visitId === visitA).length === 1)
        || (clinicalOwner === visitB && options.holdB && reads.filter((item) => item.visitId === visitB).length === 1)) heldReads.push(read);
      else await json(route, snapshots.get(clinicalOwner));
    } else if (path === patientPath) await json(route, { patient, visits: [], appointments: [] });
    else if (path === `${patientPath}/workflow`) { workflowReads += 1; await json(route, workflow(activeVisit)); }
    else if (path === "/api/visits/readiness") await json(route, { visit: {
      visitId: activeVisit, status: "in_chair", chair: 1, signedAt: null, cleared: true,
      arrivedAt: workflow(activeVisit).openVisit.arrivedAt, seatedAt: null, alerts: [], balances: [],
    } });
    else if (path === "/api/visits") await json(route, []);
    else if ([visitA, visitB].some((id) => path === `/api/visits/${id}/materials`)) await json(route, { lines: [], patientId });
    else if ([visitA, visitB].some((id) => path === `/api/visits/${id}/billing-preview`)) await json(route, {
      duesByCurrency: { YER: 0 }, mixedCurrencies: false, zeroReason: "Synthetic preview only",
    });
    else if (path === `${patientPath}/prescriptions`) await json(route, { prescriptions: [], suggestions: [] });
    else if (path === `${patientPath}/medical-history`) await json(route, {
      latest: null, versions: [], alerts: [], review: { due: false, months: 12 }, vitals: [],
    });
    else if (path === `${patientPath}/contact`) await json(route, {
      mode: "opt_in", states: { whatsapp: "unknown", sms: "unknown", email: "unknown" }, history: [], canRecord: false,
    });
    else if (path === `${patientPath}/family`) await json(route, { family: null, canEdit: false });
    else if (path === `${patientPath}/intake-history`) await json(route, { forms: [] });
    else if (path === "/api/services") await json(route, services);
    else if (path === "/api/parties") await json(route, [{ id: doctorId, name: "طبيب تجريبي" }]);
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: "secadmin", role: "admin" });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}`);
      await json(route, { message: "Unexpected read blocked by synthetic owner fixture" }, 404);
    } else await route.continue(); // Same-origin built app/assets only; writes already blocked above.
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=today&ownerProbe=1`, { waitUntil: "domcontentloaded" });
    await selected(page, "today");
    await expect.poll(() => reads.filter((item) => item.visitId === visitA).length).toBe(1);
    if (!options.holdInitialA) {
      await expect.poll(() => noteField(page, "② التشخيص").inputValue()).toBe(notes("Synthetic saved A").diagnosis);
    }
    const finish = async (route: Route, body: unknown, status = 200) => {
      // Observe the exact held response, then give its promise continuations and
      // React commits a rendering turn before asserting absence of stale work.
      const response = page.waitForResponse((item) => item.request() === route.request());
      await json(route, body, status);
      await (await response).finished();
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
    };
    return {
      context, page, writes, reads, heldReads, unexpected, errors,
      save: page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }),
      review: page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }),
      today: page.locator('section[aria-label="زيارة اليوم"]'),
      checkout: page.locator('section[aria-label="شبّاك ما بعد الزيارة"]'),
      workflowReads: () => workflowReads,
      refreshWrites: () => refreshWrites,
      refreshTo: async (id: number) => {
        const before = workflowReads;
        const refreshesBefore = refreshWrites;
        nextWorkflowVisit = id;
        // The visible stethoscope is part of the header button's accessible name.
        const openVitals = page.getByRole("button", { name: "🩺 العلامات الحيوية", exact: true });
        await expect.poll(() => openVitals.count()).toBe(1);
        await openVitals.click();
        // VitalsModal has no dialog label; identify it by its exact heading.
        const modal = page.getByRole("dialog").filter({
          has: page.getByRole("heading", { name: "محطة العلامات الحيوية والمخاطر الطبية", exact: true }),
        });
        await expect.poll(() => modal.count()).toBe(1);
        await modal.waitFor({ state: "visible" });
        const saveVitals = modal.getByRole("button", { name: "حفظ العلامات في ملف المريض", exact: true });
        await expect.poll(() => saveVitals.count()).toBe(1);
        expect(await saveVitals.getAttribute("type")).toBe("submit");
        await saveVitals.click();
        await modal.waitFor({ state: "hidden" });
        await expect.poll(() => refreshWrites).toBe(refreshesBefore + 1);
        await expect.poll(() => workflowReads).toBeGreaterThan(before);
        await expect.poll(() => reads.filter((item) => item.visitId === id).length).toBeGreaterThan(0);
        await selected(page, "today");
      },
      finishRead: async (id: number, status = 200) => {
        const index = heldReads.findIndex((item) => item.visitId === id);
        if (index < 0) throw new Error(`No held synthetic read for visit ${id}`);
        const [read] = heldReads.splice(index, 1);
        await finish(read.route, status === 200 ? snapshots.get(id) : { message: "Synthetic retired read failure" }, status);
      },
      finishWrite: async (index: number, body: unknown = { ok: true }, status = 200) => {
        const write = writes[index];
        if (!write) throw new Error("No synthetic clinical command is pending");
        if (status === 200 && !("action" in write.body)) {
          snapshots.set(write.visitId, { ...snapshots.get(write.visitId), ...write.body });
        }
        await finish(write.route, body, status);
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function expectSafe(f: Fixture) {
  expect(f.unexpected).toEqual([]);
  expect(f.errors).toEqual([]);
}
async function expectOwnerB(f: Fixture) {
  await expect.poll(() => readNotes(f.page)).toEqual(notes("Synthetic saved B"));
  await expect.poll(() => f.save.isEnabled()).toBe(true);
  expect(await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).inputValue()).toBe("2");
  expect(await f.page.locator("#visit-procedures").textContent()).toContain("Synthetic procedure B");
  expect(await f.checkout.count()).toBe(0);
  expect(await f.page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true }).count()).toBe(0);
}
async function withDiscard(page: Page, accept: boolean, action: () => Promise<unknown>) {
  const prompts: { type: string; message: string }[] = [];
  const handler = async (dialog: Dialog) => {
    prompts.push({ type: dialog.type(), message: dialog.message() });
    await (accept ? dialog.accept() : dialog.dismiss());
  };
  page.on("dialog", handler);
  try { await action(); await expect.poll(() => prompts.length).toBe(1); }
  finally { page.off("dialog", handler); }
  expect(prompts).toEqual([{ type: "confirm", message: "هناك توثيق للزيارة غير محفوظ. هل تريد تجاهله والانتقال؟" }]);
}

// Explicit artifact names are mirrored by the separate workflow patch. No
// directory upload, traces, HAR, storage state, PDFs or browser profile export.
const screenshots = {
  pending: [".settings-ui-artifacts/clinical-visit-owner-pending-1280.png", ".settings-ui-artifacts/clinical-visit-owner-pending-390.png"],
  ready: [".settings-ui-artifacts/clinical-visit-owner-ready-1280.png", ".settings-ui-artifacts/clinical-visit-owner-ready-390.png"],
  stay: [".settings-ui-artifacts/clinical-visit-owner-stay-1280.png", ".settings-ui-artifacts/clinical-visit-owner-stay-390.png"],
} as const;
async function capture(f: Fixture, state: keyof typeof screenshots) {
  await mkdir(".settings-ui-artifacts", { recursive: true });
  for (const [index, width] of [1280, 390].entries()) {
    await f.page.setViewportSize({ width, height: 1100 });
    await f.page.evaluate(() => window.scrollTo(0, 0));
    expect(await f.page.locator("html").getAttribute("dir")).toBe("rtl");
    await f.page.screenshot({ path: screenshots[state][index], fullPage: true });
  }
  await f.page.setViewportSize({ width: 1280, height: 1100 });
}

describe.runIf(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true")(
  "ClinicalVisit owner and shell-navigation acceptance on the built patient/Today page", () => {
    beforeAll(async () => {
      // _server fixes loopback; the existing global setup owns the disposable DB.
      expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
      h = await harness();
      browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    }, 240_000);
    afterAll(async () => { await browser?.close(); });

    it("withholds dirty A controls during same-patient B loading, then sends only B's own notes and procedures", async () => {
      const f = await fixture({ holdB: true });
      try {
        const retainedToday = await f.today.elementHandle();
        if (!retainedToday) throw new Error("The real Today section is missing");
        await fillNotes(f.page, notes("Synthetic dirty A"));
        await f.page.getByRole("spinbutton", { name: "الكمية", exact: true }).fill("7");
        const url = f.page.url();
        await f.refreshTo(visitB);
        await expect.poll(() => f.heldReads.filter((item) => item.visitId === visitB).length).toBe(1);
        expect(await retainedToday.evaluate((node) => node.isConnected)).toBe(true);
        expect(await f.today.evaluate((node, previous) => node === previous, retainedToday)).toBe(true);
        expect(f.page.url()).toBe(url);
        await expect.poll(() => f.page.locator("#visit-notes textarea").count()).toBe(0);
        expect(await f.save.count()).toBe(0);
        expect(await f.review.count()).toBe(0);
        expect(await f.page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true }).count()).toBe(0);
        expect(f.writes).toHaveLength(0);
        await capture(f, "pending");

        await f.finishRead(visitB);
        await expectOwnerB(f);
        await capture(f, "ready");
        await f.save.click();
        await expect.poll(() => f.writes.length).toBe(1);
        expect(f.writes[0].visitId).toBe(visitB);
        expect(f.writes[0].body).toEqual({
          ...notes("Synthetic saved B"), doctorId, billingCurrency: "YER", procedures: [procedure(visitB)],
        });
        await f.finishWrite(0);
        await expectOwnerB(f);
        expect(f.refreshWrites()).toBe(1);
        expectSafe(f);
      } finally { await f.context.close(); }
    });

    it("Stay preserves the draft and URL, while explicit Discard changes the real shell tab once", async () => {
      const f = await fixture();
      try {
        const draft = notes("Synthetic preserved draft A");
        await fillNotes(f.page, draft);
        const url = f.page.url();
        const length = await f.page.evaluate(() => history.length);
        await withDiscard(f.page, false, () => f.page.getByTestId("patient-tab-summary").click());
        await selected(f.page, "today");
        expect(f.page.url()).toBe(url);
        expect(await readNotes(f.page)).toEqual(draft);
        expect(await f.page.evaluate(() => history.length)).toBe(length);
        expect(f.writes).toHaveLength(0);
        await capture(f, "stay");
        await withDiscard(f.page, true, () => f.page.getByTestId("patient-tab-summary").click());
        await selected(f.page, "summary");
        expect(new URL(f.page.url()).searchParams.get("tab")).toBe("summary");
        expect(new URL(f.page.url()).searchParams.get("ownerProbe")).toBe("1");
        expect(await f.page.evaluate(() => history.length)).toBe(length);
        expect(await f.page.locator("#visit-notes").count()).toBe(0);
        await f.page.getByTestId("patient-tab-today").click();
        await selected(f.page, "today");
        await expect.poll(() => readNotes(f.page)).toEqual(notes("Synthetic saved A"));
        expect(f.writes).toHaveLength(0);
        expectSafe(f);
      } finally { await f.context.close(); }
    });

    it("a pending clinical save blocks repeated shell navigation without a discard dialog", async () => {
      const f = await fixture();
      let prompts = 0;
      f.page.on("dialog", async (dialog) => { prompts += 1; await dialog.dismiss(); });
      try {
        const draft = notes("Synthetic pending A");
        await fillNotes(f.page, draft);
        await f.save.click();
        await expect.poll(() => f.writes.length).toBe(1);
        expect(f.writes[0].visitId).toBe(visitA);
        expect(f.writes[0].body).toMatchObject(draft);
        const url = f.page.url();
        for (const tab of ["summary", "files", "account"]) {
          await f.page.getByTestId(`patient-tab-${tab}`).click();
          await selected(f.page, "today");
          expect(f.page.url()).toBe(url);
        }
        expect(prompts).toBe(0);
        expect(await readNotes(f.page)).toEqual(draft);
        expect(await f.save.isDisabled()).toBe(true);
        expect(await f.today.getByRole("alert").textContent()).toContain("هناك طلب حفظ أو توقيع قيد التنفيذ");
        expect(f.writes).toHaveLength(1);
        await f.finishWrite(0, { message: "Synthetic save rejection" }, 409);
        await expect.poll(() => f.save.isEnabled()).toBe(true);
        expect(await readNotes(f.page)).toEqual(draft);
        expectSafe(f);
      } finally { await f.context.close(); }
    });

    it.each([200, 503])("ignores A's late initial read (%s) after the retained Today surface has loaded B", async (status) => {
      const f = await fixture({ holdInitialA: true });
      try {
        expect(await f.save.count()).toBe(0);
        await f.refreshTo(visitB);
        await expectOwnerB(f);
        const before = f.reads.length;
        await f.finishRead(visitA, status);
        await expectOwnerB(f);
        expect(await f.today.getByRole("alert").count()).toBe(0);
        expect(f.reads).toHaveLength(before);
        expect(f.writes).toHaveLength(0);
        expectSafe(f);
      } finally { await f.context.close(); }
    });

    it("retires a sent A save after replacement without reloading A or opening review in B", async () => {
      const f = await fixture();
      try {
        const draft = notes("Synthetic submitted A");
        await fillNotes(f.page, draft);
        // This command would open review after its save continuation if stale.
        await f.review.click();
        await expect.poll(() => f.writes.length).toBe(1);
        expect(f.writes[0].visitId).toBe(visitA);
        expect(f.writes[0].body).toMatchObject(draft);
        await f.refreshTo(visitB);
        await expectOwnerB(f);
        const readsBefore = f.reads.length;
        await f.finishWrite(0);
        await expectOwnerB(f);
        expect(f.reads).toHaveLength(readsBefore);
        expect(f.writes).toHaveLength(1);
        expectSafe(f);
      } finally { await f.context.close(); }
    });

    it("retires A's late sign success without its reload, onSigned checkout, or parent workflow refresh", async () => {
      const f = await fixture();
      try {
        await f.review.click();
        await expect.poll(() => f.writes.length).toBe(1);
        await f.finishWrite(0);
        const review = f.page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
        await review.waitFor();
        await review.getByRole("button", { name: "✓ وقّع الزيارة — دون استحقاق إضافي", exact: true }).click();
        await expect.poll(() => f.writes.length).toBe(2);
        expect(f.writes[1].visitId).toBe(visitA);
        expect(f.writes[1].body).toEqual({
          action: "sign", dependencyOverrideReason: null, outsideContractDecision: null, orthoSession: null,
        });
        // The existing review Back control is usable while a sign is pending.
        // Closing it does not cancel the sent POST; the fixture holds it.
        await review.getByRole("button", { name: "رجوع — أكمل العمل", exact: true }).click();
        await review.waitFor({ state: "hidden" });
        await f.refreshTo(visitB);
        await expectOwnerB(f);
        const readsBefore = f.reads.length;
        const workflowsBefore = f.workflowReads();
        await f.finishWrite(1, {
          ok: true, patientId, invoiceId: 98307, invoiceCurrency: "YER", duesMinor: 123,
          sessionsCompleted: 0, nextPlannedVisit: null, labOrdersCreated: 0, materialsDeducted: 0,
        });
        await expectOwnerB(f);
        expect(f.reads).toHaveLength(readsBefore);
        expect(f.workflowReads()).toBe(workflowsBefore);
        expect(f.writes).toHaveLength(2);
        expectSafe(f);
      } finally { await f.context.close(); }
    });
  },
);
