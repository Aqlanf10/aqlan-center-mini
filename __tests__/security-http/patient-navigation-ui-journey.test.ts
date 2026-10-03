import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Dialog, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

// Runs only against the existing built-app security harness and its isolated test database.
// No Production URL, credentials, or patient data are accepted by this test.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId: number;
let visitId: number;
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
  const caseId = (await db.query<{ id: number }>(
    "INSERT INTO clinical_cases (patient_id, specialty, title, responsible_party_id, created_by) VALUES ($1, 'endodontics', 'حالة اختبار التنقل', $2, 'secdoctora') RETURNING id",
    [patientId, doctor])).rows[0].id;
  await db.query("INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'secdoctora')", [patientId, caseId]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(search: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
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
async function draft(page: Page) {
  await page.getByTestId("endo-record").click();
  await page.getByTestId("endo-note").fill("مسودة اختبار محمية");
}

describe("patient context navigation on the built application", () => {
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

  it("explicit tab cancellation keeps URL and draft, while an accepted shortcut changes once", async () => {
    const { context, page } = await open("?tab=treatment&sub=endo");
    try {
      await draft(page);
      const url = page.url(); const length = await page.evaluate(() => history.length);
      await withDiscard(page, false, () => page.getByTestId("patient-tab-account").click());
      expect(page.url()).toBe(url); expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
      await withDiscard(page, false, () => page.getByTestId("patient-subtab-ortho").click());
      expect(page.url()).toBe(url); expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
      expect(await page.evaluate(() => history.length)).toBe(length);
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

  it("the child's synchronous save guard blocks repeated explicit tab requests without a discard prompt", async () => {
    const { context, page } = await open("?tab=summary");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    let prompts = 0;
    page.on("dialog", async (dialog) => { prompts += 1; await dialog.dismiss(); });
    try {
      await page.getByTestId("patient-tab-treatment").click();
      await page.getByTestId("patient-subtab-endo").click(); await draft(page);
      await page.route(`**/api/patients/${patientId}/endo/*/visits`, async (route) => {
        reached(); await paused;
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "رفض حفظ تجريبي" }) });
      });
      await page.getByTestId("endo-save").click(); await started;
      const url = page.url();
      await page.getByTestId("patient-tab-today").click();
      expect(page.url()).toBe(url);
      await page.getByTestId("patient-tab-files").click();
      await page.getByTestId("patient-subtab-plans").click();
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
