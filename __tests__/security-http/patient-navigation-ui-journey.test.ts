import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Dialog, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

// Runs only against the existing built-app security harness and its isolated test database.
// No Production URL, credentials, or patient data are accepted by this test.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId: number;
let visitId: number;
let caseId: number;
let endoTreatmentId: number;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username = 'secdoctora'")).rows[0].party_id;
  patientId = (await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض اختبار التنقل — ليس حقيقياً', $2) RETURNING id",
    [`NAV-${stamp}`, doctor])).rows[0].id;
  visitId = (await db.query<{ id: number }>(
    "INSERT INTO visits (patient_name, patient_id, doctor_id, status) VALUES ('مريض اختبار التنقل', $1, $2, 'in_chair') RETURNING id",
    [patientId, doctor])).rows[0].id;
  caseId = (await db.query<{ id: number }>(
    "INSERT INTO clinical_cases (patient_id, specialty, title, responsible_party_id, created_by) VALUES ($1, 'endodontics', 'حالة اختبار التنقل', $2, 'secdoctora') RETURNING id",
    [patientId, doctor])).rows[0].id;
  endoTreatmentId = (await db.query<{ id: number }>("INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'secdoctora') RETURNING id", [patientId, caseId])).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(search: string, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.doctorA.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}${search}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("patient-tab-summary").waitFor();
  return { context, page };
}
async function selected(page: Page, testId: string) {
  await expect.poll(() => page.getByTestId(testId).getAttribute("aria-current")).toBe("page");
}
async function withDiscard(page: Page, accept: boolean, action: () => Promise<unknown>) {
  let count = 0;
  const handler = async (dialog: Dialog) => { count += 1; await (accept ? dialog.accept() : dialog.dismiss()); };
  page.on("dialog", handler);
  try { await action(); await expect.poll(() => count).toBe(1); }
  finally { page.off("dialog", handler); }
  expect(count).toBe(1);
}
async function chooseTreatment(page: Page, section: string) {
  const select = page.getByTestId("patient-treatment-section");
  if (await select.isVisible()) await select.selectOption(section);
  else await page.getByTestId(`patient-subtab-${section}`).click();
}
async function draft(page: Page) {
  await page.getByTestId("endo-record").click();
  await page.getByTestId("endo-note").fill("مسودة اختبار محمية");
}

describe("patient context navigation on the built application", () => {
  it.each([1280, 390])("restores the full Summary header and visible editors while keeping safety, drafts and More dismissal at %ipx", async width => {
    const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
    try {
      const [name, ...value] = h.sessions.doctorA.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const unexpected: string[] = [], errors: string[] = [];
      const warning = "تنبيه سلامة اصطناعي يبقى ظاهرًا عند طي بيانات التواصل";
      const clinicalWarnings = ["تحذير سريري أول", "تحذير سريري ثانٍ", "تحذير سريري ثالث يبقى ظاهرًا في الملخص الكامل"];
      const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
          unexpected.push(`${request.method()} ${url.pathname}`); await route.abort(); return;
        }
        if (url.pathname === `/api/patients/${patientId}`) {
          const response = await route.fetch(); const payload = await response.json();
          expect(response.ok()).toBe(true); expect(payload.patient.id).toBe(patientId);
          payload.patient.medicalAlert = warning;
          await route.fulfill({ response, json: payload }); return;
        }
        if (url.pathname === "/api/visits/readiness" && url.searchParams.get("patientId") === String(patientId)) {
          const response = await route.fetch(), payload = await response.json();
          expect(response.ok()).toBe(true); expect(payload.visit?.patientId).toBe(patientId);
          payload.visit.alerts = clinicalWarnings; payload.visit.historyAlerts = clinicalWarnings;
          await route.fulfill({ response, json: payload }); return;
        }
        await route.continue();
      });
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      await routes.run(async () => {
        await page.goto(`${baseUrl}/patients/${patientId}?tab=summary`, { waitUntil: "domcontentloaded" });
        const tasks = page.getByTestId("summary-current-work"); await tasks.waitFor();
        expect(await page.getByTestId("patient-workspace").getAttribute("data-compact")).toBe("false");
        const header = page.getByTestId("patient-details-panel");
        expect(await header.isVisible()).toBe(true);
        expect(await page.getByTestId("patient-details-toggle").count()).toBe(0);
        expect(await page.locator("h1:visible").count()).toBe(1);
        expect(await header.getByRole("button", { name: /^🪑/ }).count()).toBe(1);
        expect(await page.getByTestId("patient-medical-alert-banner").innerText()).toContain(warning);
        for (const alert of clinicalWarnings) {
          await expect.poll(() => page.getByTestId("patient-context-strip").innerText()).toContain(alert);
        }
        expect(await header.getByRole("button", { name: "🩺 + تسجيل العلامات الحيوية وفصيلة الدم", exact: true }).isVisible()).toBe(true);
        expect(await page.getByRole("button", { name: "🩺 العلامات الحيوية", exact: true }).isVisible()).toBe(true);
        await page.getByRole("region", { name: "التاريخ الطبي", exact: true }).waitFor();
        expect(await page.getByRole("region", { name: "ما قاله المريض عن صحته", exact: true }).isVisible()).toBe(true);
        const contact = page.getByRole("region", { name: "الهوية والتواصل", exact: true });
        expect(await contact.isVisible()).toBe(true);
        expect(await page.getByTestId("summary-administrative-details").count()).toBe(0);
        const order = await page.evaluate(() => {
          const contact = document.querySelector('[aria-label="الهوية والتواصل"]')!;
          const tasks = document.querySelector('[data-testid="summary-current-work"]')!;
          return Boolean(contact.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        expect(order).toBe(true);
        const email = contact.locator('input[type="email"]');
        await expect.poll(() => email.isEnabled()).toBe(true);
        await email.fill("unsaved-synthetic@example.test");
        const more = page.getByTestId("patient-more-actions");
        const toggle = more.locator(":scope > summary");
        expect(await page.getByTestId("patient-workspace").getByRole("button", { name: "المزيد", exact: true }).count()).toBe(0);
        for (const direction of ["rtl", "ltr"]) {
          await page.evaluate(dir => { document.documentElement.dir = dir; }, direction);
          await toggle.click();
          await expect.poll(() => more.getAttribute("open")).not.toBeNull();
          // Pointer/focus outside closes only the menu, never the full header
          // or the visible unsaved contact editor.
          await email.click();
          await expect.poll(() => more.getAttribute("open")).toBeNull();
          expect(await email.isVisible()).toBe(true);
          expect(await email.inputValue()).toBe("unsaved-synthetic@example.test");
          await toggle.focus(); await page.keyboard.press("Enter");
          await expect.poll(() => more.getAttribute("open")).not.toBeNull();
          await page.keyboard.press("Escape");
          await expect.poll(() => more.getAttribute("open")).toBeNull();
          expect(await header.isVisible()).toBe(true);
          expect(await page.locator("h1:visible").count()).toBe(1);
          expect(await page.getByTestId("patient-medical-alert-banner").isVisible()).toBe(true);
          expect(await email.inputValue()).toBe("unsaved-synthetic@example.test");
          const layout = await page.evaluate(() => ({
            viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            overflowing: Array.from(document.querySelectorAll("body *")).flatMap(element => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1)
                ? [{ tag: element.tagName, testId: element.getAttribute("data-testid"),
                    className: element.getAttribute("class"), left: rect.left, right: rect.right }]
                : [];
            }).slice(0, 20),
          }));
          expect(layout.scrollWidth <= layout.viewport + 1,
            `Restored Summary overflow at ${width}px ${direction}: ${JSON.stringify(layout)}`).toBe(true);
        }
        expect(unexpected).toEqual([]); expect(errors).toEqual([]);
      }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
    } finally { await context.close(); }
  });

  it("opens Summary's Ortho shortcut atomically, persists URL/reload, and accepts legacy aliases", async () => {
    const { context, page } = await open("?tab=summary&review=1");
    try {
      const length = await page.evaluate(() => history.length);
      await page.getByTestId("summary-open-ortho").click();
      await selected(page, "patient-subtab-ortho");
      expect(new URL(page.url()).searchParams.get("sub")).toBe("ortho");
      expect(new URL(page.url()).searchParams.get("review")).toBe("1");
      expect(await page.evaluate(() => history.length)).toBe(length);
      await page.reload(); await selected(page, "patient-subtab-ortho");
      await page.goto(`${baseUrl}/patients/${patientId}?tab=ceph`);
      await selected(page, "patient-subtab-ortho");
    } finally { await context.close(); }
  });

describe("confirmed patient alert freshness beside an unchanged ENDO draft", () => {
  it.each([1280, 390])("keeps add/replace/remove visible through failed canonical GETs at %ipx", async width => {
    const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.doctorA.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    let failRefresh = false;
    const history = "تحذير تاريخ طبي مستقل لا يُزال مع تنبيه الملف";
    const writes: string[] = [], unexpected: string[] = [], errors: string[] = [];
    let failedGets = 0;
    const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}`); await route.abort(); return; }
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        if (method === "PATCH" && url.pathname === `/api/patients/${patientId}`) {
          const body = request.postDataJSON();
          writes.push(body.medicalAlert); failRefresh = true;
          await route.fulfill({ status: 200, contentType: "application/json",
            body: JSON.stringify({ id: patientId, medicalAlert: body.medicalAlert.trim() || null }) });
        } else { unexpected.push(`${method} ${url.pathname}`); await route.abort(); }
        return;
      }
      const patientGet = url.pathname === `/api/patients/${patientId}`;
      const readinessGet = url.pathname === "/api/visits/readiness" && url.searchParams.get("patientId") === String(patientId);
      if ((patientGet || readinessGet) && failRefresh) {
        failedGets += 1;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّر تحديث تجريبي" }) }); return;
      }
      if (patientGet || readinessGet) {
        const response = await route.fetch(), payload = await response.json(); expect(response.ok()).toBe(true);
        if (patientGet) { expect(payload.patient.id).toBe(patientId); payload.patient.medicalAlert = null; }
        else {
          expect(payload.visit.patientId).toBe(patientId);
          payload.visit.alerts = [history]; payload.visit.historyAlerts = [history]; payload.visit.editableAlert = null;
        }
        await route.fulfill({ response, json: payload }); return;
      }
      await route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await routes.run(async () => {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
      const cockpit = page.getByTestId("patient-context-strip");
      await expect.poll(() => cockpit.textContent()).toContain(history);
      await draft(page); const url = page.url();
      for (const [index, alert] of ["تحذير جديد مؤكد", "تحذير بديل مؤكد", ""].entries()) {
        await page.getByTestId("patient-details-toggle").click();
        const more = page.getByTestId("patient-more-actions");
        await more.locator("summary").click();
        await more.getByRole("button", { name: "✏️ تعديل بيانات الملف", exact: true }).click();
        await expect.poll(() => more.getAttribute("open")).toBeNull();
        const editor = page.getByRole("region", { name: "تعديل البيانات", exact: true });
        await editor.getByRole("textbox", { name: /تنبيه طبي/ }).fill(alert);
        await editor.getByRole("button", { name: "حفظ التغييرات", exact: true }).click();
        await editor.waitFor({ state: "hidden" });
        await page.getByTestId("patient-details-toggle").click();
        await expect.poll(() => failedGets).toBeGreaterThan(0);
        await expect.poll(() => cockpit.textContent()).toContain(history);
        if (alert) await expect.poll(() => cockpit.textContent()).toContain(alert);
        if (index > 0) expect(await cockpit.textContent()).not.toContain("تحذير جديد مؤكد");
        if (index === 2) expect(await cockpit.textContent()).not.toContain("تحذير بديل مؤكد");
        expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
        expect(page.url()).toBe(url); expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
        expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        if (index === 1) {
          await mkdir(".settings-ui-artifacts", { recursive: true });
          // A full-page stitched image can move fixed navigation over the warning.
          // Capture the settled native viewport and prove both sources are unobscured.
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const combined = cockpit.locator("span[title]").filter({ hasText: history });
          expect(await combined.count()).toBe(1);
          expect(await combined.innerText()).toContain(alert);
          const geometry = await combined.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const points = [[rect.x + rect.width / 2, rect.y + 3], [rect.x + rect.width / 2, rect.bottom - 3],
              [rect.x + 5, rect.y + rect.height / 2], [rect.right - 5, rect.y + rect.height / 2],
              [rect.x + rect.width / 2, rect.y + rect.height / 2]];
            return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
              viewportWidth: innerWidth, viewportHeight: innerHeight,
              unobscured: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }) };
          });
          expect(geometry.width).toBeGreaterThan(0); expect(geometry.height).toBeGreaterThan(0);
          expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.y).toBeGreaterThanOrEqual(0);
          expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
          expect(geometry.unobscured).toEqual([true, true, true, true, true]);
          await page.screenshot({ path: `.settings-ui-artifacts/patient-alert-freshness-${width}.png`, fullPage: false });
        }
      }
      expect(writes).toEqual(["تحذير جديد مؤكد", "تحذير بديل مؤكد", ""]);
      expect(unexpected).toEqual([]); expect(errors).toEqual([]);
    }, () => {
      expect(writes).toEqual(["تحذير جديد مؤكد", "تحذير بديل مؤكد", ""]);
      expect(unexpected).toEqual([]); expect(errors).toEqual([]);
    });
  });
});

  it("refuses fabricated mixed-specialty context instead of opening an unrelated Endo editor", async () => {
    const { context, page } = await open("?tab=treatment&sub=endo&orthoCaseId=2147483647&visitId=2147483647#record");
    try {
      const blocked = page.getByTestId("clinical-context-state");
      await expect.poll(() => blocked.getAttribute("role")).toBe("alert");
      expect(await page.getByTestId("endo-record").count()).toBe(0);
      expect(new URL(page.url()).searchParams.get("orthoCaseId")).toBe("2147483647");
      expect(new URL(page.url()).searchParams.get("visitId")).toBe("2147483647");
      // A refused reference is retained for explicit correction, never silently
      // replaced with this patient's latest available episode.
      expect(await blocked.getByRole("button", { name: "اختيار حالة من ملف المريض", exact: true }).count()).toBe(1);
    } finally { await context.close(); }
  });

  it.each([1280, 390])("explicit tab and specialty cancellation preserve the selected workspace and draft at %ipx", async width => {
    const { context, page } = await open(`?tab=treatment&sub=endo&clinicalCaseId=${caseId}&endoTreatmentId=${endoTreatmentId}#record`, width);
    try {
      await draft(page);
      const url = page.url(); const length = await page.evaluate(() => history.length);
      await withDiscard(page, false, () => page.getByTestId("patient-tab-account").click());
      expect(page.url()).toBe(url); expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
      await withDiscard(page, false, () => chooseTreatment(page, "ortho"));
      expect(page.url()).toBe(url); expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
      expect(await page.evaluate(() => history.length)).toBe(length);
      await selected(page, "patient-subtab-endo");
      if (width === 390) expect(await page.getByTestId("patient-treatment-section").inputValue()).toBe("endo");
      expect(new URL(page.url()).searchParams.get("clinicalCaseId")).toBe(String(caseId));
      expect(new URL(page.url()).searchParams.get("endoTreatmentId")).toBe(String(endoTreatmentId));
      expect(new URL(page.url()).hash).toBe("#record");
      await mkdir(".settings-ui-artifacts", { recursive: true });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.screenshot({ path: `.settings-ui-artifacts/patient-navigation-draft-${width}.png`, fullPage: true });
      }
      await withDiscard(page, true, () => page.getByTestId("endo-open-today").click());
      await selected(page, "patient-tab-today");
      expect(new URL(page.url()).searchParams.get("tab")).toBe("today");
      expect(await page.evaluate(() => history.length)).toBe(length);
    } finally { await context.close(); }
  });

  it.each([1280, 390])("the child's synchronous save guard blocks repeated tab and specialty requests at %ipx", async width => {
    const { context, page } = await open("?tab=summary", width);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    let prompts = 0;
    page.on("dialog", async (dialog) => { prompts += 1; await dialog.dismiss(); });
    try {
      await page.getByTestId("patient-tab-treatment").click();
      await chooseTreatment(page, "endo"); await draft(page);
      await page.route(`**/api/patients/${patientId}/endo/*/visits`, async (route) => {
        reached(); await paused;
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "رفض حفظ تجريبي" }) });
      });
      await page.getByTestId("endo-save").click(); await started;
      const url = page.url();
      await page.getByTestId("patient-tab-today").click();
      expect(page.url()).toBe(url);
      await page.getByTestId("patient-tab-files").click();
      await chooseTreatment(page, "plans");
      if (width === 390) expect(await page.getByTestId("patient-treatment-section").inputValue()).toBe("endo");
      expect(page.url()).toBe(url);
      expect(prompts).toBe(0);
      expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
      release(); await page.getByTestId("endo-error").filter({ hasText: "رفض حفظ تجريبي" }).waitFor();
      expect((await db.query("SELECT id FROM endo_visits WHERE visit_id = $1", [visitId])).rows).toHaveLength(0);
    } finally { release(); await context.close(); }
  });

  it("legacy visit links reach the existing page while login and patient API authorization remain intact", async () => {
    const { context, page } = await open("?tab=summary");
    try {
      await page.goto(`${baseUrl}/visits/${visitId}/clinical`);
      await page.waitForURL(`${baseUrl}/visits/${visitId}`);
      const denied = await fetch(`${baseUrl}/api/visits/${visitId}/clinical`, { headers: { Cookie: h.sessions.doctorB.cookie } });
      expect(denied.status).toBe(403);
    } finally { await context.close(); }
    const anonymous = await browser.newContext();
    try {
      const page = await anonymous.newPage();
      await page.goto(`${baseUrl}/visits/${visitId}/clinical`);
      await page.waitForURL(`${baseUrl}/login`);
    } finally { await anonymous.close(); }
  });
});

// Presentation-only synthetic overrides atop the existing isolated navigation
// fixture. Every write is blocked except one explicitly armed Vitals response;
// that response proves notice visibility, not medical persistence/freshness.
describe.runIf(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true")(
  "compact patient context on the actual built RTL workspace", () => {
    it.each([1280, 390])("keeps identity, complete warnings and actions reachable at %ipx without duplicate controls", async width => {
      const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
      const [name, ...value] = h.sessions.doctorA.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const warnings = ["حساسية دواء اصطناعية تحتاج مراجعة", "تحذير تاريخ طبي مستقل لا يُختصر", "تحذير ثالث طويل " + "يجب مراجعة التاريخ الطبي قبل الإجراء. ".repeat(8) + "تحذيرمتصل".repeat(30)];
      let long = false;
      let readinessUnavailable = false;
      let allowVitals = false;
      const writes: string[] = [], unexpected: string[] = [], errors: string[] = [];
      const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return; }
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          if (allowVitals && method === "PATCH" && url.pathname === `/api/patients/${patientId}`) {
            allowVitals = false; writes.push(`${method} ${url.pathname}`);
            const body = request.postDataJSON();
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: patientId, medicalAlert: body.medicalAlert.trim() || null }) });
          } else { unexpected.push(`${method} ${url.pathname}`); await route.abort(); }
          return;
        }
        if (url.pathname === `/api/patients/${patientId}`) {
          const response = await route.fetch(); const payload = await response.json();
          expect(response.ok()).toBe(true);
          payload.patient.medicalAlert = long ? `[VITALS: BP=165/100] تنبيه ملف اصطناعي ${warnings[2]}` : null;
          payload.patient.flags = long ? ["تنبيه متابعة اصطناعي"] : [];
          await route.fulfill({ response, json: payload }); return;
        }
        if (url.pathname === "/api/visits/readiness" && url.searchParams.get("patientId") === String(patientId)) {
          if (readinessUnavailable) {
            await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّر تحقق اصطناعي" }) }); return;
          }
          const response = await route.fetch(); const payload = await response.json();
          expect(response.ok()).toBe(true); expect(payload.visit?.patientId).toBe(patientId);
          payload.visit.alerts = long ? warnings : [];
          payload.visit.historyAlerts = long ? warnings : [];
          payload.visit.editableAlert = long ? `[VITALS: BP=165/100] تنبيه ملف اصطناعي ${warnings[2]}` : null;
          await route.fulfill({ response, json: payload }); return;
        }
        await route.continue();
      });
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      const cockpit = page.getByTestId("patient-context-strip");
      const details = page.getByTestId("patient-details-toggle");
      const noOverflow = async () => {
        const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
      };
      await routes.run(async () => {
        await mkdir(".settings-ui-artifacts", { recursive: true });
        long = true; readinessUnavailable = true;
        await page.goto(`${baseUrl}/patients/${patientId}?tab=today`, { waitUntil: "domcontentloaded" });
        await selected(page, "patient-tab-today");
        await expect.poll(() => page.getByTestId("patient-cockpit-read-state").innerText()).toContain("تعذّر التحقق");
        // The page already owns an authorized patient warning independently of
        // readiness. Collapsing details must not conceal it or bypass hook gates.
        expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
        const medicalBanner = page.getByTestId("patient-medical-alert-banner");
        expect(await medicalBanner.isVisible()).toBe(true);
        expect(await medicalBanner.innerText()).toContain(warnings[2]);
        expect(await medicalBanner.count()).toBe(1);
        expect(await cockpit.innerText()).not.toContain(warnings[2]);
        expect(writes).toEqual([]); expect(unexpected).toEqual([]);
        readinessUnavailable = false;
        for (const variant of ["ordinary", "long"] as const) {
          long = variant === "long";
          await page.goto(`${baseUrl}/patients/${patientId}?tab=today&sub=endo&caseProbe=retained&visitId=${visitId}#record`, { waitUntil: "domcontentloaded" });
          await selected(page, "patient-tab-today");
          await cockpit.waitFor();
          await expect.poll(() => page.getByTestId("patient-cockpit-read-state").count()).toBe(0);
          expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
          expect(await details.getAttribute("aria-expanded")).toBe("false");
          expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
          expect(await page.locator("h1:visible").count()).toBe(1);
          expect(await page.getByTestId("patient-compact-identity").innerText()).toContain(`NAV-${stamp}`);
          expect(await page.getByTestId("patient-primary-action").count()).toBe(1);
          expect(await cockpit.evaluate(element => getComputedStyle(element).position)).toBe("static");
          if (long) {
            for (const warning of warnings) await expect.poll(() => cockpit.innerText()).toContain(warning);
            expect(await page.getByTestId("patient-compact-pressure-alert").innerText()).toContain("165/100");
            expect(await cockpit.innerText()).toContain("تنبيه متابعة اصطناعي");
          }
          const save = page.getByRole("button", { name: "احفظ بلا توقيع", exact: true });
          await save.click({ trial: true });
          await page.evaluate(() => window.scrollTo(0, 0));
          await noOverflow();
          await page.screenshot({ path: `.settings-ui-artifacts/patient-compact-today-${variant}-${width}.png`, fullPage: true });
          await page.getByTestId("patient-tab-treatment").click();
          await selected(page, "patient-subtab-endo");
          // A patient visit alone does not select the latest Endo episode.
          await page.getByTestId("endo-context-selection").waitFor();
          expect(await page.getByTestId("endo-record").count()).toBe(0);
          expect(new URL(page.url()).searchParams.get("visitId")).toBe(String(visitId));
          await page.getByTestId("endo-tooth-36").click();
          await page.getByTestId("endo-record").waitFor();
          expect(new URL(page.url()).searchParams.get("clinicalCaseId")).toBe(String(caseId));
          expect(new URL(page.url()).searchParams.get("endoTreatmentId")).toBe(String(endoTreatmentId));
          expect(new URL(page.url()).searchParams.has("visitId")).toBe(false);
          expect(new URL(page.url()).searchParams.get("caseProbe")).toBe("retained");
          expect(new URL(page.url()).hash).toBe("#record");
          if (width === 390) {
            const selector = page.getByTestId("patient-treatment-section");
            expect(await selector.isVisible()).toBe(true);
            expect(await selector.locator("option").count()).toBe(8);
            expect(await selector.inputValue()).toBe("endo");
          } else expect(await page.getByTestId("patient-subtab-endo").isVisible()).toBe(true);
          await noOverflow();
          await page.screenshot({ path: `.settings-ui-artifacts/patient-compact-treatment-${variant}-${width}.png`, fullPage: true });
          expect(writes).toEqual([]); expect(unexpected).toEqual([]);
        }
        // Keyboard disclosure leaves compact safety context visible. Hiding it
        // dismisses More so it cannot intercept later workspace controls.
        await details.focus(); await page.keyboard.press("Enter");
        await page.getByTestId("patient-details-panel").waitFor({ state: "visible" });
        await page.getByTestId("patient-more-actions").locator("summary").click();
        await expect.poll(() => page.getByTestId("patient-more-actions").getAttribute("open")).not.toBeNull();
        await details.click();
        expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
        await details.click();
        expect(await page.getByTestId("patient-more-actions").getAttribute("open")).toBeNull();
        await details.click();
        // Existing five canonical destinations and eight treatment owners stay reachable.
        for (const target of ["summary", "account", "files", "today", "treatment"]) {
          await page.getByTestId(`patient-tab-${target}`).click();
          await selected(page, `patient-tab-${target}`);
          expect(new URL(page.url()).searchParams.get("caseProbe")).toBe("retained");
        }
        for (const sub of ["chart", "plans", "cases", "ortho", "lab", "referrals", "materials", "endo"]) {
          await chooseTreatment(page, sub); await selected(page, `patient-subtab-${sub}`);
          if (width === 390) expect(await page.getByTestId("patient-treatment-section").inputValue()).toBe(sub);
        }
        expect(writes).toEqual([]); expect(unexpected).toEqual([]);
        // Trigger an existing onSaved notice while the details are subsequently hidden.
        long = false; await page.reload(); await selected(page, "patient-subtab-endo");
        await details.click();
        await page.getByRole("button", { name: "🩺 العلامات الحيوية", exact: true }).click();
        const modal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "محطة العلامات الحيوية والمخاطر الطبية", exact: true }) });
        allowVitals = true;
        await modal.getByRole("button", { name: "حفظ العلامات في ملف المريض", exact: true }).click();
        await modal.waitFor({ state: "hidden" });
        await details.click();
        await page.getByTestId("patient-success-notice").waitFor({ state: "visible" });
        expect(await page.getByTestId("patient-success-notice").count()).toBe(1);
        expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
        expect(writes).toEqual([`PATCH /api/patients/${patientId}`]);
        expect(unexpected).toEqual([]); expect(errors).toEqual([]);
        await noOverflow();
      }, () => {
        expect(writes).toEqual([`PATCH /api/patients/${patientId}`]);
        expect(unexpected).toEqual([]); expect(errors).toEqual([]);
      });
    });
  });

