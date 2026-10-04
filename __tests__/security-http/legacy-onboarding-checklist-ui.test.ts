import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// Remote CI only. Actual parent/package/checklist rendering and canonical GETs.
// Only the two explicit link/unlink PATCHes to this owned synthetic case may
// write. Agreement, receipt, invoice, opening, arrangement and manual-journal
// snapshots must remain unchanged; every other browser write is blocked.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0;
let caseId = 0;
let planId = 0;
const stamp = Date.now();
const included = "الشدّة اليوم مشمولة باتفاق الأقساط — بلا فاتورة مستقلة.";
const unavailable = "تعذّر تحديث تهيئة الحالة السابقة؛ لا يمكن تأكيد تغطية الشدّة من هذه القراءة.";
const retry = "أعد تحميل تهيئة الحالة السابقة";
const checklistPath = () => `/api/patients/${patientId}/legacy-onboarding`;

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username = 'secdoctora'");
  patientId = (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
     VALUES ($1, 'مريض تحقق تهيئة التقويم التجريبي', $2) RETURNING id`,
    [`CHECKLIST-${stamp}`, doctor.party_id])).rows[0].id;
  planId = (await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency)
     VALUES ($1, 'اتفاق تهيئة تجريبي بأقساط', 60000, 'SAR') RETURNING id`, [patientId])).rows[0].id;
  await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, CURRENT_DATE, 30000), ($1, 2, CURRENT_DATE + 30, 30000)`, [planId]);
  caseId = (await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at,
       legacy_financial_mode, start_date, phase, responsible_doctor_id, plan_id)
     VALUES ($1, 'secadmin', 'legacy', NOW(), 'installments', CURRENT_DATE - 365,
       'working', $2, $3) RETURNING id`, [patientId, doctor.party_id, planId])).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function moneySnapshot() {
  return (await db.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
       FROM treatment_plans p WHERE p.patient_id = $1) AS plans,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
       FROM plan_installments i JOIN treatment_plans p ON p.id = i.plan_id WHERE p.patient_id = $1) AS installments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
       FROM plan_items i JOIN treatment_plans p ON p.id = i.plan_id WHERE p.patient_id = $1) AS plan_items,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
       FROM payments p WHERE p.patient_id = $1) AS payments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
       FROM invoices i WHERE i.patient_id = $1) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
       FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id WHERE v.patient_id = $1) AS invoice_items,
    (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.currency), '[]'::jsonb)
       FROM patient_opening_balances o WHERE o.patient_id = $1) AS opening,
    (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]'::jsonb)
       FROM patient_opening_balance_history o WHERE o.patient_id = $1) AS opening_history,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.currency), '[]'::jsonb)
       FROM legacy_balance_arrangements a WHERE a.patient_id = $1) AS arrangements,
    (SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb) FROM journal_manual j) AS journal,
    (SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb) FROM journal_manual_lines j) AS journal_lines`, [patientId])).rows;
}

async function capture(panel: Locator, path: string) {
  await panel.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await expect.poll(() => panel.evaluate((element) => {
    if (document.documentElement.dir !== "rtl" || document.documentElement.scrollWidth > innerWidth + 1) return false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
    }
    return rects.length > 0 && rects.every((rect) => rect.left >= 0 && rect.top >= 0
      && rect.right <= innerWidth && rect.bottom <= innerHeight
      && [rect.left + 1, rect.left + rect.width / 2, rect.right - 1].every((x) =>
        [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1].every((y) => {
          const hit = document.elementFromPoint(x, y); return hit !== null && element.contains(hit);
        })));
  })).toBe(true);
  await panel.screenshot({ path });
}

async function open(width: number, failPlans: boolean) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  let mode: "live" | "error" | "hold" = "live";
  const held: Array<{ route: Route; body: string }> = [];
  const writes: Array<{ planId: number | null }> = [];
  const blocked: string[] = []; const external: string[] = []; const errors: string[] = [];
  await context.route("**/*", async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin !== baseUrl) { external.push(url.origin); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
      const body: unknown = req.postDataJSON();
      if (!failPlans && req.method() === "PATCH" && url.pathname === `/api/ortho/${caseId}`
        && body !== null && typeof body === "object" && Object.keys(body).join() === "planId"
        && ((body as { planId?: unknown }).planId === null || (body as { planId?: unknown }).planId === planId)) {
        writes.push(body as { planId: number | null }); await route.continue(); return;
      }
      blocked.push(`${req.method()} ${url.pathname}`); await route.abort(); return;
    }
    if (failPlans && url.pathname === "/api/plans" && url.searchParams.get("patientId") === String(patientId)) {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); return;
    }
    if (url.pathname === checklistPath()) {
      if (mode === "error") { await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); return; }
      if (mode === "hold") {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        const body = await response.text();
        expect(JSON.parse(body)).toMatchObject({ onboarding: { caseId, adjustmentClass: "OUTSIDE_CONTRACT" } });
        held.push({ route, body }); return;
      }
    }
    await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=ortho`, { waitUntil: "domcontentloaded" });
    const checklist = page.getByRole("region", { name: "تهيئة الحالة السابقة", exact: true });
    const agreement = page.getByRole("region", { name: "اتفاق التقويم", exact: true });
    await checklist.getByText(included, { exact: true }).waitFor();
    return { context, page, checklist, agreement, held, writes,
      setMode: (next: typeof mode) => { mode = next; },
      isolated: () => { expect(blocked).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]); },
    };
  } catch (error) { await context.close(); throw error; }
}

describe("legacy checklist confirmed-context refresh in the real parent", () => {
  it.each([1280, 390])("preserves a successful independent classifier while plans are unavailable at %ipx", async (width) => {
    const before = await moneySnapshot(); const f = await open(width, true);
    try {
      await f.agreement.getByText("تعذّر تحميل اتفاق التقويم؛ هذا لا يعني عدم وجود اتفاق أو أقساط.", { exact: true }).waitFor();
      expect(await f.checklist.innerText()).toContain("تهيئة الحالة السابقة مكتملة");
      await capture(f.checklist, `.settings-ui-artifacts/legacy-checklist-independent-${width}.png`);
      expect(f.writes).toEqual([]); f.isolated(); expect(await moneySnapshot()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it.each([1280, 390])("retires a confirmed unlink label on error and fences its late read after relink at %ipx", async (width) => {
    const before = await moneySnapshot(); const f = await open(width, false);
    try {
      f.setMode("error");
      await f.agreement.getByRole("button", { name: "فكّ الربط", exact: true }).click();
      await f.checklist.getByText(unavailable, { exact: true }).waitFor();
      expect(await f.checklist.innerText()).not.toContain(included);
      expect(await f.checklist.innerText()).not.toContain("تهيئة الحالة السابقة مكتملة");
      await capture(f.checklist, `.settings-ui-artifacts/legacy-checklist-unavailable-${width}.png`);
      await f.agreement.getByText("لا اتفاق مالي مربوط بالحالة", { exact: true }).waitFor();
      f.setMode("hold");
      await f.checklist.getByRole("button", { name: retry, exact: true }).click();
      await expect.poll(() => f.held.length).toBeGreaterThan(0);
      f.setMode("live");
      await f.agreement.getByRole("combobox", { name: "اختر اتفاق الأقساط", exact: true }).selectOption(String(planId));
      await f.agreement.getByRole("button", { name: "اربط", exact: true }).click();
      await f.checklist.getByText(included, { exact: true }).waitFor();
      for (const old of f.held) await old.route.fulfill({ status: 200, contentType: "application/json", body: old.body }).catch(() => {});
      await f.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await f.checklist.innerText()).toContain(included);
      expect(f.writes).toEqual([{ planId: null }, { planId }]); f.isolated();
      expect((await db.query("SELECT plan_id FROM ortho_cases WHERE id = $1 AND patient_id = $2", [caseId, patientId])).rows).toEqual([{ plan_id: planId }]);
      expect(await moneySnapshot()).toEqual(before);
    } finally { await f.context.close(); }
  }, 90_000);
});
