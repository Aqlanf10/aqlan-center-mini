import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

/** Real built patient -> TodayVisitTab -> ClinicalVisit DOM, without hook mocks.
 * The isolated security harness provides authentication. All browser API reads
 * below are synthetic transport fixtures adapted from clinical-visit-owner-ui;
 * every write and unknown origin/endpoint is blocked. These tests establish UI
 * ownership/draft behavior only, never persisted save/signature correctness.
 */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const patientId = 98671, foreignPatientId = 98672, visitId = 98673, doctorId = 98674;
const patientPath = `/api/patients/${patientId}`;
const workflowPath = `${patientPath}/workflow`;
const clinicalPath = `/api/visits/${visitId}/clinical`;
const FOREIGN_TITLE = "عنوان حالة مريض آخر يجب ألا يظهر";
const fields = [
  ["chiefComplaint", "① الشكوى الرئيسية"], ["examination", "② الفحص"],
  ["diagnosis", "② التشخيص"], ["treatmentDone", "③ ما نُفّذ"], ["nextPlan", "الخطة القادمة"],
] as const;
type Notes = Record<typeof fields[number][0], string>;
const notes = (prefix: string): Notes => ({ chiefComplaint: `${prefix} complaint`, examination: `${prefix} examination`,
  diagnosis: `${prefix} diagnosis`, treatmentDone: `${prefix} treatment`, nextPlan: `${prefix} plan` });
const patient = { id: patientId, patientNumber: "SYNTHETIC-WORKFLOW-DRAFT-98671", fullName: "مريض مسودة اصطناعي",
  phone: null, altPhone: null, gender: "unknown", birthYear: null, birthDate: null, address: null,
  medicalAlert: null, note: null, createdAt: "2026-10-07T08:00:00.000Z", photoDocumentId: null,
  flags: [], email: null, preferredChannel: null };
const workflow = () => ({ patient,
  openVisit: { id: visitId, status: "in_chair", chair: 1, arrivedAt: "2026-10-07T09:00:00.000Z", plannedTitle: null },
  lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [],
  counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false },
  financial: null, alerts: [], canSeeFinancial: false,
  assessmentCases: [{ id: 98675, patientId, kind: "specialty", orthoCaseId: null,
    specialty: "endodontics", title: "حالة تقييم تخص المريض الحالي", needsAssessment: true }], legacyCases: [],
});
const clinical = () => ({ id: visitId, patientId, patientName: patient.fullName, ...notes("Synthetic saved"), doctorId,
  status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null,
  procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
  ortho: null, plannedVisit: null, previousVisit: null, latestDiagnosis: null, activeCases: [],
  outstanding: [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
});
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status,
  contentType: "application/json", body: JSON.stringify(body) });
const noteField = (page: Page, label: string) =>
  page.locator(`#visit-notes label:has(> span:text-is("${label}")) > textarea`);
const readNotes = async (page: Page): Promise<Notes> => Object.fromEntries(await Promise.all(
  fields.map(async ([key, label]) => [key, await noteField(page, label).inputValue()]))) as Notes;
async function fillNotes(page: Page, draft: Notes) {
  for (const [key, label] of fields) await noteField(page, label).fill(draft[key]);
}
type Fault = "http500" | "missing_array" | "foreign_case";
function faultReply(fault: Fault) {
  if (fault === "http500") return { status: 500, body: { message: "Synthetic workflow failure" } };
  if (fault === "missing_array") return { status: 200, body: { ...workflow(), assessmentCases: null } };
  return { status: 200, body: { ...workflow(), assessmentCases: [
    { ...workflow().assessmentCases[0], patientId: foreignPatientId, title: FOREIGN_TITLE },
  ] } };
}

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.doctorA.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [], writes: string[] = [], documents: string[] = [];
  const reads = { workflow: 0, patient: 0, clinical: 0, cases: 0 };
  const releases = new Set<() => void>();
  let nextFault: { fault: Fault; hold: Promise<void>; release: () => void } | null = null;
  let held = false;
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      writes.push(`${method} ${path}`); await json(route, { message: "All browser writes are blocked" }, 409); return;
    }
    if (path === workflowPath) {
      reads.workflow++;
      if (nextFault) {
        const fault = nextFault; nextFault = null; held = true;
        await fault.hold; releases.delete(fault.release); held = false;
        const result = faultReply(fault.fault); await json(route, result.body, result.status);
      } else await json(route, workflow());
    } else if (path === patientPath) { reads.patient++; await json(route, { patient, visits: [], appointments: [] }); }
    else if (path === clinicalPath) { reads.clinical++; await json(route, clinical()); }
    else if (path === `${patientPath}/cases`) { reads.cases++; unexpected.push(`${method} ${path}`); await json(route, {}, 404); }
    else if (path === "/api/visits/readiness") await json(route, { visit: { visitId, status: "in_chair", chair: 1,
      signedAt: null, cleared: true, arrivedAt: workflow().openVisit.arrivedAt, seatedAt: null, alerts: [], balances: [] } });
    else if (path === "/api/visits") await json(route, []);
    else if (path === `/api/visits/${visitId}/materials`) await json(route, { lines: [], patientId });
    else if (path === `${patientPath}/prescriptions`) await json(route, { prescriptions: [], suggestions: [] });
    else if (path === "/api/services") await json(route, []);
    else if (path === "/api/parties" && url.search === "?kind=doctor") await json(route, [{ id: doctorId, name: "طبيب اصطناعي" }]);
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: "secdoctora", role: "doctor" });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}`); await json(route, { message: "Unknown synthetic read blocked" }, 404);
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.isNavigationRequest() && request.resourceType() === "document") documents.push(new URL(request.url()).pathname); });
  const verify = () => {
    expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(writes).toEqual([]);
    expect(reads.cases).toBe(0); expect(nextFault).toBeNull(); expect(held).toBe(false);
  };
  return { page, reads, documents,
    holdNext: (fault: Fault) => {
      expect(nextFault).toBeNull(); let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      releases.add(release); nextFault = { fault, hold, release }; return release;
    },
    isHeld: () => held,
    run: (body: () => Promise<void>) => routes.run(async () => {
      try {
        await page.goto(`${baseUrl}/patients/${patientId}?tab=today`, { waitUntil: "domcontentloaded" });
        await page.locator("#visit-notes").waitFor();
        await expect.poll(() => noteField(page, "② التشخيص").inputValue()).toBe(notes("Synthetic saved").diagnosis);
        await page.getByTestId("patient-primary-action").waitFor();
        expect(reads.workflow).toBe(1); expect(reads.clinical).toBe(1);
        await body(); verify();
      } finally { for (const release of releases) release(); }
    }, verify),
  };
}

describe("shared workflow refresh preserves a real ClinicalVisit draft", () => {
  it.each(["http500", "missing_array", "foreign_case"] as const)("contains %s and recovers without remounting or losing notes", async (fault) => {
    const f = await fixture();
    await f.run(async () => {
      const { page } = f;
      const draft = notes(`Unsaved ${fault}`);
      await fillNotes(page, draft);
      const editor = await page.locator("#visit-notes").elementHandle();
      const input = await noteField(page, "② التشخيص").elementHandle();
      expect(editor).not.toBeNull(); expect(input).not.toBeNull();
      const startUrl = page.url();
      const release = f.holdNext(fault);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(f.isHeld).toBe(true);
      const state = page.getByTestId("patient-workflow-read-state");
      await state.filter({ hasText: "جارٍ التحقق" }).waitFor();
      await page.getByTestId("patient-primary-action").waitFor({ state: "detached" });
      expect(await editor!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await input!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await readNotes(page)).toEqual(draft);
      release();
      await state.filter({ hasText: "تعذّر التحقق" }).waitFor();
      expect(await editor!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await input!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await readNotes(page)).toEqual(draft);
      expect(await page.getByText("لا زيارة قائمة اليوم", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "🪑 بدء زيارة اليوم", exact: true }).count()).toBe(0);
      expect(await page.locator("body").innerText()).not.toContain(FOREIGN_TITLE);
      // Clinical documentation keeps its separate accepted read authority; a
      // workflow failure cannot silently reset or destroy unsaved clinical care.
      expect(await noteField(page, "② التشخيص").isEditable()).toBe(true);
      const edited = { ...draft, diagnosis: `${draft.diagnosis} retained edit` };
      await noteField(page, "② التشخيص").fill(edited.diagnosis);
      const dialog = page.waitForEvent("dialog");
      const leave = page.getByTestId("patient-tab-summary").click();
      const confirmation = await dialog;
      expect(confirmation.message()).toContain("توثيق للزيارة غير محفوظ");
      await confirmation.dismiss(); await leave;
      expect(await page.getByTestId("patient-tab-today").getAttribute("aria-current")).toBe("page");
      expect(page.url()).toBe(startUrl);
      await state.getByRole("button", { name: "إعادة التحقق من الملخص", exact: true }).click();
      await state.waitFor({ state: "detached" });
      await page.getByTestId("patient-primary-action").waitFor();
      expect(await editor!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await input!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await readNotes(page)).toEqual(edited);
      expect(f.reads).toEqual({ workflow: 3, patient: 1, clinical: 1, cases: 0 });
      expect(f.documents).toEqual([`/patients/${patientId}`]);
      expect(page.url()).toBe(startUrl);
    });
  }, 120_000);
});
