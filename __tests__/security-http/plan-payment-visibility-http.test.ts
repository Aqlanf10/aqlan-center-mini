import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../lib/auth";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../../lib/doctor-permissions";
import { authedGet, baseUrl, harness, loginStaff } from "./_server";

// Remote CI only: real built routes, session, proxy and synthetic PostgreSQL
// receipt/refund fixtures. Browser writes and external requests are blocked.
// No Production URL, real account, patient or money is used.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0;
let planId = 0;
let denied: { cookie: string };
let deniedUsername = "";
let granted: { cookie: string };
let originalGlobal: string | undefined;
const installmentIds: number[] = [];
const stamp = Date.now();
const title = "خطة خصوصية المدفوعات التجريبية";
const key = "workflow.doctor_financial_view";
const genericPath = () => `/api/plans?patientId=${patientId}`;
const patientPath = () => `/api/patients/${patientId}/plans`;

async function globalView(value: string) {
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  // The production reader deliberately caches settings for five seconds.
  await new Promise((resolve) => setTimeout(resolve, 5100));
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  originalGlobal = (await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [key])).rows[0]?.value;
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  patientId = (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
     VALUES ($1, 'مريض خصوصية تجريبي فقط', $2) RETURNING id`, [`PPV-${stamp}`, doctor.party_id])).rows[0].id;
  planId = (await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, start_date, created_by, last_reminder_at)
     VALUES ($1, $2, 30000, 'SAR', CURRENT_DATE, 'synthetic', NOW()) RETURNING id`, [patientId, title])).rows[0].id;
  const rows = (await db.query<{ id: number }>(
    `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor, last_reminder_at)
     VALUES ($1, 1, CURRENT_DATE - 1, 15000, NOW()), ($1, 2, CURRENT_DATE + 30, 15000, NULL) RETURNING id`, [planId])).rows;
  installmentIds.push(...rows.map((row) => row.id));
  const shiftId = (await db.query<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd, status, closed_at)
     VALUES ('synthetic-payment-visibility', 0, 0, 0, 'closed', NOW()) RETURNING id`)).rows[0].id;
  for (const [kind, amount] of [["payment", 18000], ["refund", 2000]] as const) {
    await db.query(
      `INSERT INTO payments (receipt_number, patient_id, plan_id, shift_id, kind, amount_minor, currency,
        exchange_rate, base_amount_minor, base_currency, method, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'SAR', 1, $6, 'SAR', 'cash', 'synthetic')`,
      [`PPV-${kind}-${stamp}`, patientId, planId, shiftId, kind, amount]);
  }
  const password = "SyntheticVisibility#Pass1";
  const hash = await hashPassword(password);
  for (const permission of [false, true]) {
    const username = `ppv${permission ? "yes" : "no"}${stamp}`;
    await db.query(`INSERT INTO users (username, display_name, password_hash, role, party_id, permissions)
      VALUES ($1, 'Synthetic visibility doctor', $2, 'doctor', $3, $4)`,
    [username, hash, doctor.party_id, JSON.stringify({ ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: permission })]);
    const session = await loginStaff(username, password);
    if (permission) granted = session;
    else { denied = session; deniedUsername = username; }
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (db) {
    if (originalGlobal === undefined) await db.query(`DELETE FROM settings WHERE key = $1`, [key]);
    else await db.query(`UPDATE settings SET value = $2 WHERE key = $1`, [key, originalGlobal]);
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await db.end();
  }
});

async function response(path: string, session: { cookie: string }) {
  const res = await authedGet(path, session);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return await res.json() as { canSeeFinancial: boolean; plans: Record<string, unknown>[] };
}
function hidden(body: Awaited<ReturnType<typeof response>>, generic: boolean) {
  expect(body.canSeeFinancial).toBe(false);
  const row = body.plans.find((plan) => plan.id === planId)!;
  expect(row).toMatchObject({ paidMinor: null, progress: null, lastReminderAt: null, title, totalMinor: 30000, hasInstallments: true });
  expect(row.installments).toEqual(generic ? installmentIds.map((id) => ({ id })) : []);
  expect(JSON.stringify(row)).not.toMatch(/"paidCount"|"nextDueDate"|"nextDueAmountMinor"|"overdueMinor"|16000|14000/);
}

// Match the established narrow synthetic-card acceptance: confirm every text
// line is onscreen and hit-testable before capturing, so sticky patient controls
// cannot silently cover the mobile evidence.
async function readableCard(card: Locator) {
  await card.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await expect.poll(() => card.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
    }
    return rects.length > 0 && rects.every((rect) => {
      if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return false;
      const xs = [rect.left + 1, rect.left + rect.width / 2, rect.right - 1];
      const ys = [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1];
      return xs.every((x) => ys.every((y) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && element.contains(hit);
      }));
    });
  })).toBe(true);
}

describe("plan receipt visibility over actual authenticated HTTP", () => {
  it.each(["false", "true"])("the global setting %s never overrides an individual payment deny", async (value) => {
    await globalView(value);
    hidden(await response(genericPath(), denied), true);
    hidden(await response(patientPath(), denied), false);
    const general = await response(genericPath(), granted);
    expect(general).toMatchObject({ canSeeFinancial: true, plans: [{ paidMinor: 16000,
      progress: { paidMinor: 16000, remainingMinor: 14000, paidCount: 1, nextDueAmountMinor: 14000 } }] });
    expect((general.plans[0].progress as { nextDueDate: string | null }).nextDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const specific = await response(patientPath(), granted);
    if (value === "true") expect(specific).toMatchObject({ canSeeFinancial: true, plans: [{ paidMinor: 16000 }] });
    else hidden(specific, false);
  }, 30_000);

  it("current stored plan denial takes effect for an already issued doctor session", async () => {
    await db.query(`UPDATE users SET permissions = jsonb_set(permissions::jsonb, '{canViewPlans}', 'false'::jsonb)::text
      WHERE username = $1`, [deniedUsername]);
    try {
      for (const path of [genericPath(), patientPath()]) {
        const res = await authedGet(path, denied);
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain(title);
      }
    } finally {
      await db.query(`UPDATE users SET permissions = jsonb_set(permissions::jsonb, '{canViewPlans}', 'true'::jsonb)::text
        WHERE username = $1`, [deniedUsername]);
    }
    hidden(await response(patientPath(), denied), false);
  });

  it("keeps provider and finance-only clinical boundaries", async () => {
    for (const path of [genericPath(), patientPath()]) expect((await authedGet(path, h.sessions.doctorB)).status).toBe(403);
    for (const who of ["admin", "reception", "cashier", "accountant"] as const) {
      const body = await response(genericPath(), h.sessions[who]);
      expect(body).toMatchObject({ canSeeFinancial: true, plans: [{ paidMinor: 16000 }] });
      if (who === "cashier" || who === "accountant") {
        expect(body.plans[0]).not.toHaveProperty("items");
        expect(body.plans[0]).not.toHaveProperty("consentNote");
        expect((await authedGet(patientPath(), h.sessions[who])).status).toBe(403);
      }
    }
  });

  it.each([1280, 390])("renders the real clinical Plans tab without invented paid zero at %ipx", async (width) => {
    await globalView("false");
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = denied.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const writes: string[] = []; const external: string[] = []; const errors: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseUrl) { external.push(url.origin); await route.abort(); return; }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`, { waitUntil: "domcontentloaded" });
      const card = page.locator("li").filter({ has: page.getByText(title, { exact: true }) });
      await card.waitFor();
      expect(await card.innerText()).toContain("باقي العلاج");
      expect(await card.getByText("المدفوع", { exact: true }).count()).toBe(0);
      expect(await card.getByRole("button", { name: "تحصيل قسط" }).count()).toBe(0);
      expect(await card.locator("summary").filter({ hasText: "جدول الأقساط" }).count()).toBe(0);
      expect(await card.innerText()).not.toContain("متأخر:");
      await page.reload({ waitUntil: "domcontentloaded" });
      await card.waitFor();
      expect(await card.getByText("المدفوع", { exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      const summary = card.getByTestId("plan-amount-summary");
      await readableCard(summary);
      await summary.screenshot({ path: `.settings-ui-artifacts/plan-payment-hidden-${width}.png` });
      expect(writes).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);
  it.each([1280, 390])("retires collections on refresh/denial and rejects a late old read at %ipx", async (width) => {
    await globalView("true");
    const authorized = await response(patientPath(), granted);
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = granted.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    let mode: "live" | "held" | "denied" = "live";
    const held: Route[] = []; const writes: string[] = []; const external: string[] = []; const errors: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseUrl) { external.push(url.origin); await route.abort(); return; }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(`${request.method()} ${url.pathname}`); await route.abort(); return;
      }
      if (url.pathname === patientPath()) {
        if (mode === "held") { held.push(route); return; }
        if (mode === "denied") {
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "Synthetic plan permission revoked" }) }); return;
        }
      }
      await route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`, { waitUntil: "domcontentloaded" });
      const content = page.getByTestId("patient-plans-content");
      await content.getByText("المدفوع", { exact: true }).waitFor();
      await content.getByRole("button", { name: "تحصيل قسط", exact: true }).click();
      await content.getByLabel("مبلغ القسط", { exact: true }).fill("55");
      const reread = page.waitForResponse((res) => new URL(res.url()).pathname === patientPath() && res.request().method() === "GET");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      expect((await reread).status()).toBe(200);
      await expect.poll(() => content.getByLabel("مبلغ القسط", { exact: true }).inputValue()).toBe("55");
      // These actual nested component inputs must survive ordinary same-owner
      // focus revalidation. No submission is made.
      await content.getByLabel("أسطح البند", { exact: true }).fill("MO");
      await content.getByRole("button", { name: "سجّل موافقة المريض — ويُقفل الاتفاق", exact: true }).click();
      await content.getByLabel("كيف وُثّقت الموافقة").fill("Synthetic unsaved consent draft");
      mode = "held";
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => held.length).toBeGreaterThan(0);
      await content.getByText("جارٍ تحديث الخطط…", { exact: true }).waitFor();
      expect(await content.getByText("المدفوع", { exact: true }).count()).toBe(0);
      expect(await content.getByRole("button", { name: "تحصيل قسط", exact: true }).count()).toBe(0);
      expect(await content.getByLabel("أسطح البند", { exact: true }).inputValue()).toBe("MO");
      expect(await content.getByLabel("كيف وُثّقت الموافقة").inputValue()).toBe("Synthetic unsaved consent draft");
      expect(await content.getByRole("button", { name: "⚡ خطة سريعة", exact: true }).isDisabled()).toBe(true);
      expect(await content.innerText()).not.toContain("لا توجد خطط علاج");
      mode = "denied";
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await content.getByRole("alert").waitFor();
      expect(await content.getByRole("alert").innerText()).toContain("غير مصرّح");
      expect(await content.getByLabel("أسطح البند", { exact: true }).count()).toBe(0);
      expect(await content.getByLabel("كيف وُثّقت الموافقة").count()).toBe(0);
      for (const route of held) {
        // The browser may already have canceled this old transport via abort.
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(authorized) }).catch(() => {});
      }
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await content.getByText("المدفوع", { exact: true }).count()).toBe(0);
      expect(await content.innerText()).not.toContain(title);
      expect(await content.innerText()).not.toContain("لا توجد خطط علاج");
      expect(await content.getByRole("button", { name: "⚡ خطة سريعة", exact: true }).isDisabled()).toBe(true);
      await readableCard(content);
      await content.screenshot({ path: `.settings-ui-artifacts/plan-payment-denied-${width}.png` });
      expect(writes).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);

});
