import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Dialog, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

// NEW RECONSTRUCTION: authored acceptance, not execution evidence.
// Runs only against the existing built-app security harness and its isolated test database.
// Explicit navigation uses replaceState; native Back/Forward dirty-draft protection
// is not implemented by that controller and is not established by this suite.
// No Production URL, credentials, or patient data are accepted by this test.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId: number;
let visitId: number;
let treatmentId: number;
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
  treatmentId = (await db.query<{ id: number }>(
    "INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'secdoctora') RETURNING id",
    [patientId, caseId])).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(search: string, options: { width?: number; role?: "doctorA" | "admin" } = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: 1100 }, locale: "ar-YE", reducedMotion: "reduce" });
  const [name, ...value] = h.sessions[options.role ?? "doctorA"].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/patients/${patientId}${search}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("patient-workspace").waitFor();
    return { context, page };
  } catch (error) { await context.close(); throw error; }
}
async function selected(page: Page, section: string) {
  await expect.poll(() => page.getByTestId(`workspace-nav-${section}`).getAttribute("aria-current")).toBe("page");
  await expect.poll(() => page.getByTestId("workspace-mobile-navigation").inputValue()).toBe(section);
  await page.locator(`[data-workspace-section="${section}"]`).waitFor({ state: "visible" });
  expect(await page.locator('[data-testid^="workspace-nav-"][aria-current="page"]').count()).toBe(1);
  expect(await page.locator("[data-workspace-section]:visible").count()).toBe(1);
}
async function navigate(page: Page, section: string) {
  if ((page.viewportSize()?.width ?? 1280) <= 800) await page.getByTestId("workspace-mobile-navigation").selectOption(section);
  else await page.getByTestId(`workspace-nav-${section}`).click();
}
function locationIs(page: Page, tab: string, sub: string | null) {
  const url = new URL(page.url());
  expect(url.pathname).toBe(`/patients/${patientId}`);
  expect(url.searchParams.get("tab")).toBe(tab);
  expect(url.searchParams.get("sub")).toBe(sub);
  expect(url.searchParams.get("review")).toBe("1");
  expect(url.hash).toBe("#acceptance");
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
async function capture(page: Page, name: string) {
  await mkdir(".settings-ui-artifacts", { recursive: true });
  await page.screenshot({ path: `.settings-ui-artifacts/${name}.png`, fullPage: true, animations: "disabled" });
}
async function tabTo(page: Page, target: Locator) {
  await target.waitFor({ state: "visible" });
  // Test actual keyboard reachability; do not substitute element.focus().
  for (let step = 0; step < 100; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Workspace control was not reachable within 100 Tab presses.");
}
async function keyboardFocused(target: Locator) {
  await expect.poll(() => target.evaluate((element) => element === document.activeElement && element.matches(":focus-visible"))).toBe(true);
  const appearance = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), height: element.getBoundingClientRect().height };
  });
  expect(appearance.outline).toBe("solid");
  expect(appearance.width).toBeGreaterThanOrEqual(3);
  expect(appearance.height).toBeGreaterThanOrEqual(44);
}
async function shellFitsViewport(page: Page) {
  const bounds = await page.getByTestId("patient-workspace-header").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewport + 1);
}

describe("patient context navigation on the built application", () => {
  it("opens canonical Ortho through Overview's specialty directory and Files, preserving query/hash and reload", async () => {
    const { context, page } = await open("?tab=summary&review=1#acceptance");
    try {
      await selected(page, "summary");
      const length = await page.evaluate(() => history.length);
      // Overview now offers the directory; the old direct Ortho shortcut was removed.
      await page.getByTestId("workspace-overview").getByRole("button", { name: "التخصصات والحالات", exact: true }).click();
      await selected(page, "specialties");
      locationIs(page, "specialties", null);
      expect(await page.evaluate(() => history.length)).toBe(length);
      const directory = page.getByTestId("patient-specialty-directory");
      const directoryUrl = page.url();
      await directory.getByTestId("specialty-card-orthodontics").click();
      expect(await directory.getByTestId("specialty-card-orthodontics").getAttribute("aria-pressed")).toBe("true");
      expect(page.url()).toBe(directoryUrl);
      await directory.getByRole("button", { name: "افتح مساحة التخصص", exact: true }).click();
      await selected(page, "ortho");
      locationIs(page, "treatment", "ortho");
      expect(await page.evaluate(() => history.length)).toBe(length);
      await page.reload();
      await selected(page, "ortho");
      locationIs(page, "treatment", "ortho");
      expect(await page.evaluate(() => history.length)).toBe(length);
      await navigate(page, "files");
      await selected(page, "files");
      await page.locator('[data-workspace-section="files"]').getByRole("button", { name: "افتح التقويم والسيفالو", exact: true }).click();
      await selected(page, "ortho");
      locationIs(page, "treatment", "ortho");
      expect(await page.evaluate(() => history.length)).toBe(length);
    } finally { await context.close(); }
  });

  it.each([
    ["tab=overview", "summary"], ["tab=appointments", "summary"], ["tab=ledger", "account"],
    ["tab=documents", "files"], ["tab=visits", "today"], ["tab=endo", "endo"],
    ["tab=ceph", "ortho"], ["tab=treatment&sub=ceph", "ortho"],
  ])("reads legacy %s as %s without rewriting its incoming link", async (query, section) => {
    // The ledger alias needs a legitimately account-visible authority.
    const { context, page } = await open(`?${query}&review=1#acceptance`, { role: "admin" });
    try {
      await selected(page, section);
      const original = page.url();
      expect(new URL(original).search).toBe(`?${query}&review=1`);
      expect(new URL(original).hash).toBe("#acceptance");
      await page.reload();
      await selected(page, section);
      expect(page.url()).toBe(original);
    } finally { await context.close(); }
  });

  it.each([1280, 390])("at %ipx preserves cancelled Endo drafts and accepts exactly one Today shortcut", async (width) => {
    // Doctor financial access is withheld by default. Keep Account coverage as admin.
    const { context, page } = await open("?tab=treatment&sub=endo&review=1#acceptance", { width, role: "admin" });
    try {
      await selected(page, "endo");
      await draft(page);
      const url = page.url(); const length = await page.evaluate(() => history.length);
      for (const target of ["account", "ortho", "account"]) {
        await withDiscard(page, false, () => navigate(page, target));
        await selected(page, "endo");
        expect(page.url()).toBe(url);
        expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
        expect(await page.evaluate(() => history.length)).toBe(length);
      }
      await capture(page, `patient-navigation-draft-${width}`);
      await withDiscard(page, true, () => page.getByTestId("endo-open-today").click());
      await selected(page, "today");
      locationIs(page, "today", "endo");
      expect(await page.evaluate(() => history.length)).toBe(length);
      expect(await page.getByTestId("endo-note").count()).toBe(0);
      await navigate(page, "endo");
      await selected(page, "endo");
      await page.getByTestId("endo-record").waitFor();
      expect(await page.getByTestId("endo-note").count()).toBe(0);
      expect(await page.evaluate(() => history.length)).toBe(length);
    } finally { await context.close(); }
  });

  it.each([1280, 390])("at %ipx blocks repeated explicit navigation during an Endo write without prompting", async (width) => {
    const { context, page } = await open("?tab=summary&review=1#acceptance", { width });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const requests: Array<{ method: string; body: unknown }> = [];
    let prompts = 0;
    page.on("dialog", async (dialog) => { prompts += 1; await dialog.dismiss(); });
    try {
      await navigate(page, "endo");
      await selected(page, "endo"); await draft(page);
      await page.route(`**/api/patients/${patientId}/endo/${treatmentId}/visits`, async (route) => {
        requests.push({ method: route.request().method(), body: route.request().postDataJSON() });
        await paused;
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "رفض حفظ تجريبي" }) });
      });
      await page.getByTestId("endo-save").click();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toMatchObject({ method: "PUT", body: { visitId, note: "مسودة اختبار محمية" } });
      expect(await page.getByTestId("endo-save").isDisabled()).toBe(true);
      const url = page.url(); const length = await page.evaluate(() => history.length);
      for (const target of ["today", "files", "plans", "today"]) {
        await navigate(page, target);
        await selected(page, "endo");
        expect(page.url()).toBe(url);
        expect(await page.evaluate(() => history.length)).toBe(length);
        expect(prompts).toBe(0);
        expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
      }
      release(); await page.getByTestId("endo-error").filter({ hasText: "رفض حفظ تجريبي" }).waitFor();
      await expect.poll(() => page.getByTestId("endo-save").isDisabled()).toBe(false);
      expect(page.url()).toBe(url);
      expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار محمية");
      expect(prompts).toBe(0); expect(requests).toHaveLength(1);
      expect((await db.query("SELECT id FROM endo_visits WHERE treatment_id = $1 AND visit_id = $2", [treatmentId, visitId])).rows).toHaveLength(0);
    } finally { release(); await context.close(); }
  });

  it.each([1280, 390])("at %ipx keeps RTL layout, keyboard navigation and shell-dialog focus without clinical writes", async (width) => {
    const { context, page } = await open("?tab=summary&review=1#acceptance", { width });
    const writes: string[] = [];
    const pageErrors: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(`${baseUrl}/api/`) && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await selected(page, "summary");
      await page.getByTestId("workspace-overview").waitFor();
      const header = page.getByTestId("patient-workspace-header");
      expect(await page.getByTestId("patient-workspace").getAttribute("dir")).toBe("rtl");
      expect(await page.getByTestId("patient-workspace").getAttribute("data-patient-id")).toBe(String(patientId));
      expect(await header.getByRole("heading", { level: 1 }).textContent()).toBe("مريض اختبار التنقل — ليس حقيقياً");
      expect(await header.textContent()).toContain(`NAV-${stamp}`);
      expect(await page.getByTestId("workspace-overview").textContent()).toContain("البيانات المالية غير متاحة لهذه القراءة");
      expect(await page.getByTestId("workspace-nav-account").count()).toBe(0);
      expect(await page.getByTestId("workspace-mobile-navigation").locator('option[value="account"]').count()).toBe(0);
      const mobile = page.getByRole("combobox", { name: "انتقل إلى قسم", exact: true });
      expect(await mobile.isVisible()).toBe(width === 390);
      expect(await page.getByRole("navigation", { name: "أقسام ملف المريض", exact: true }).isVisible()).toBe(width === 1280);
      await shellFitsViewport(page);
      await capture(page, `patient-workspace-summary-${width}`);
      const length = await page.evaluate(() => history.length);
      if (width === 390) {
        await tabTo(page, mobile); await keyboardFocused(mobile);
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await selected(page, "today"); await keyboardFocused(mobile);
      } else {
        await tabTo(page, page.getByTestId("workspace-nav-summary"));
        await keyboardFocused(page.getByTestId("workspace-nav-summary"));
        await page.keyboard.press("Tab");
        await keyboardFocused(page.getByTestId("workspace-nav-today"));
        await page.keyboard.press("Enter");
        await selected(page, "today"); await keyboardFocused(page.getByTestId("workspace-nav-today"));
      }
      locationIs(page, "today", null);
      expect(await page.evaluate(() => history.length)).toBe(length);
      const tablet = page.locator('[data-workspace-section="today"]').getByRole("button", { name: /شاشة الكرسي والتابلت/ });
      await tabTo(page, tablet); await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "أكمل العمل في زيارة اليوم", exact: true });
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.getAttribute("aria-modal")).toBe("true");
      const close = dialog.getByRole("button", { name: "العودة إلى زيارة اليوم", exact: true });
      await keyboardFocused(close);
      // This explanatory shell dialog has one focusable control. Canonical
      // multi-control editors still require their own composed browser review.
      await page.keyboard.press("Tab"); await keyboardFocused(close);
      await page.keyboard.press("Shift+Tab"); await keyboardFocused(close);
      await page.keyboard.press("Escape");
      expect(await dialog.isVisible()).toBe(true);
      await capture(page, `patient-workspace-tablet-dialog-${width}`);
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "hidden" }); await keyboardFocused(tablet);
      await selected(page, "today"); locationIs(page, "today", null);
      expect(await page.evaluate(() => history.length)).toBe(length);
      await shellFitsViewport(page);
      expect(writes).toEqual([]); expect(pageErrors).toEqual([]);
    } finally { await context.close(); }
  });

  it("legacy visit links reach the existing page while login and patient API authorization remain intact", async () => {
    const { context, page } = await open("?tab=summary");
    try {
      await page.goto(`${baseUrl}/visits/${visitId}/clinical`);
      await page.waitForURL(`${baseUrl}/visits/${visitId}`);
      for (const path of [`/api/visits/${visitId}/clinical`, `/api/patients/${patientId}`, `/api/patients/${patientId}/workflow`]) {
        const denied = await fetch(`${baseUrl}${path}`, { headers: { Cookie: h.sessions.doctorB.cookie } });
        expect(denied.status, path).toBe(403);
      }
    } finally { await context.close(); }
    const anonymous = await browser.newContext();
    try {
      const page = await anonymous.newPage();
      await page.goto(`${baseUrl}/visits/${visitId}/clinical`);
      await page.waitForURL(`${baseUrl}/login`);
      await page.goto(`${baseUrl}/patients/${patientId}?tab=ceph`);
      await page.waitForURL(`${baseUrl}/login`);
      expect((await fetch(`${baseUrl}/api/patients/${patientId}`)).status).toBe(401);
    } finally { await anonymous.close(); }
  });
});
