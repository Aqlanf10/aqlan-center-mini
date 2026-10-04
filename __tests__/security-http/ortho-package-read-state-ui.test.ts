import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// Mandatory built-app CI browser gate. Only the isolated security harness is
// used. Synthetic patients, cases, plans and installments are seeded before
// browsing. The plans GET is held or failed to exercise read states; successful
// funded/empty recovery is always the real backend response, never a mock.
// Every browser write and external request is blocked. No financial or clinical
// submit is clicked, and full fixture/ledger snapshots must remain unchanged.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId = 0;
let emptyPatientId = 0;
let planId = 0;
const stamp = Date.now();
const planTitle = "اتفاق تقويم سابق تجريبي بأقساط";
const loadingText = "جارٍ التحقق من اتفاق التقويم";
const unavailableText = "تعذّر تحميل اتفاق التقويم؛ هذا لا يعني عدم وجود اتفاق أو أقساط.";
const deniedText = "تعذّر عرض اتفاق التقويم بصلاحية الجلسة الحالية؛ لا يمكن تأكيد تغطية الشدّات هنا.";
const missingText = "تعذّر العثور على الخطة المربوطة ضمن القراءة الحالية؛ لا يمكن تأكيد تغطية الشدّات هنا.";
const retryText = "أعد تحميل اتفاق التقويم";

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(
    "SELECT party_id FROM users WHERE username = 'secdoctora'");
  for (const linked of [true, false]) {
    const id = (await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`ORTHO-READ-${linked ? "LINKED" : "EMPTY"}-${stamp}`,
        linked ? "مريض تقويم سابق بأقساط تجريبية" : "مريض تقويم سابق بلا اتفاق تجريبي", doctor.party_id])).rows[0].id;
    if (linked) {
      patientId = id;
      planId = (await db.query<{ id: number }>(
        `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency)
         VALUES ($1, $2, 60000, 'SAR') RETURNING id`, [id, planTitle])).rows[0].id;
      await db.query(
        `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
         VALUES ($1, 1, CURRENT_DATE, 30000), ($1, 2, CURRENT_DATE + 30, 30000)`, [planId]);
    } else emptyPatientId = id;
    await db.query(
      `INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at,
         legacy_financial_mode, start_date, phase, responsible_doctor_id, plan_id)
       VALUES ($1, 'secadmin', 'legacy', NOW(), 'installments', CURRENT_DATE - 365,
         'working', $2, $3)`, [id, doctor.party_id, linked ? planId : null]);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

// Compare complete rows, not just counts: an accidental update to an existing
// amount, status or case link must fail as well as an inserted document.
async function financialState() {
  return (await db.query(
    `SELECT
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
          FROM treatment_plans p WHERE p.patient_id = ANY($1::int[])) AS plans,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM plan_installments i JOIN treatment_plans p ON p.id = i.plan_id
          WHERE p.patient_id = ANY($1::int[])) AS installments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
          FROM payments p WHERE p.patient_id = ANY($1::int[])) AS payments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM invoices i WHERE i.patient_id = ANY($1::int[])) AS invoices,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
          WHERE v.patient_id = ANY($1::int[])) AS invoice_items,
       (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.patient_id, o.currency), '[]'::jsonb)
          FROM patient_opening_balances o WHERE o.patient_id = ANY($1::int[])) AS opening,
       (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)
          FROM ortho_cases c WHERE c.patient_id = ANY($1::int[])) AS cases,
       (SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb)
          FROM journal_manual j) AS journal,
       (SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.id), '[]'::jsonb)
          FROM journal_manual_lines j) AS journal_lines`, [[patientId, emptyPatientId]])).rows;
}

async function open(width: number, targetPatientId = patientId) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block",
  });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const pending: Route[] = [];
  const writes: string[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  const matchesPlanRead = (url: URL) => url.origin === baseUrl
    && url.pathname === "/api/plans" && url.searchParams.get("patientId") === String(targetPatientId);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseUrl) {
      external.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort();
    } else if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Synthetic UI writes blocked" }) });
    } else if (request.method() === "GET" && matchesPlanRead(url)) pending.push(route);
    else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const nextRead = () => {
    const route = pending.shift();
    if (!route) throw new Error("No same-patient plans GET is pending");
    return route;
  };
  try {
    await page.goto(`${baseUrl}/patients/${targetPatientId}?tab=ortho`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => pending.length).toBe(1);
    const panel = page.getByRole("region", { name: "اتفاق التقويم", exact: true });
    await panel.waitFor();
    return {
      context, page, panel, pending,
      respond: async (body: unknown, status = 200) => nextRead().fulfill({
        status, contentType: "application/json", body: JSON.stringify(body),
      }),
      malformedJson: async () => nextRead().fulfill({ status: 200, contentType: "application/json", body: "{invalid" }),
      realRead: async () => {
        const responsePromise = page.waitForResponse((response) =>
          response.request().method() === "GET" && matchesPlanRead(new URL(response.url())));
        await nextRead().continue();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        return response.json() as Promise<{ plans: Array<{ id: number; patientId: number; title: string; installments: Array<{ number: number; amountMinor: number }> }> }>;
      },
      assertIsolated: () => {
        expect(writes).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
      },
    };
  } catch (error) { await context.close(); throw error; }
}

async function expectUnknown(panel: Locator) {
  const text = await panel.innerText();
  expect(text).not.toContain("الخطة بلا أقساط");
  expect(text).not.toContain("لا اتفاق مالي مربوط بالحالة");
  expect(text).not.toContain("الشدّات مشمولة بالأقساط");
  expect(await panel.getByRole("button", { name: /^(فكّ الربط|اربط)$/ }).count()).toBe(0);
  expect(await panel.getByRole("combobox", { name: "اختر اتفاق الأقساط", exact: true }).count()).toBe(0);
  expect(await panel.getByRole("link", { name: "أنشئ اتفاق تقويم من تبويب الخطط", exact: true }).count()).toBe(0);
}

async function captureReadablePanel(page: Page, panel: Locator, path: string) {
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await panel.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  // Keep real sticky controls in place. Every text line, including retry, must
  // fit and hit the agreement panel rather than a fixed cockpit overlay.
  await expect.poll(() => panel.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
    }
    return rects.length > 0 && rects.every((rect) => {
      if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) return false;
      return [rect.left + 1, rect.left + rect.width / 2, rect.right - 1].every((x) =>
        [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1].every((y) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && element.contains(hit);
        }));
    });
  })).toBe(true);
  await page.screenshot({ path });
}

async function expectFunded(f: Awaited<ReturnType<typeof open>>) {
  const payload = await f.realRead();
  const actual = payload.plans.find((plan) => plan.id === planId);
  expect(actual).toMatchObject({ id: planId, patientId, title: planTitle });
  expect(actual?.installments.map(({ number, amountMinor }) => ({ number, amountMinor }))).toEqual([
    { number: 1, amountMinor: 30000 }, { number: 2, amountMinor: 30000 },
  ]);
  await f.panel.getByText(`✓ باقة تقويم: ${planTitle}`, { exact: true }).waitFor();
  expect(await f.panel.innerText()).toContain("الشدّات مشمولة بالأقساط");
  expect(await f.panel.innerText()).not.toContain("الخطة بلا أقساط");
  expect(await f.panel.getByRole("button", { name: "فكّ الربط", exact: true }).isEnabled()).toBe(true);
}

describe("orthodontic agreement read state in the real RTL UI", () => {
  it.each([1280, 390])("keeps a linked legacy installment case unknown through delay/500/retry, then confirms the real agreement at %ipx", async (width) => {
    const before = await financialState();
    const f = await open(width);
    try {
      await f.panel.getByText(loadingText, { exact: false }).waitFor();
      await expectUnknown(f.panel);
      await f.respond({ message: "Synthetic plans read unavailable" }, 500);
      await f.panel.getByText(unavailableText, { exact: false }).waitFor();
      await expectUnknown(f.panel);
      await captureReadablePanel(f.page, f.panel, `.settings-ui-artifacts/ortho-package-unavailable-${width}.png`);
      const retry = f.panel.getByRole("button", { name: retryText, exact: true });
      await retry.focus();
      await f.page.keyboard.press("Enter");
      await expect.poll(() => f.pending.length).toBe(1);
      await f.panel.getByText(loadingText, { exact: false }).waitFor();
      await expectUnknown(f.panel);
      await expectFunded(f);
      await captureReadablePanel(f.page, f.panel, `.settings-ui-artifacts/ortho-package-funded-${width}.png`);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it.each([401, 403])("withholds coverage and editing after a denied %i read without offering retry", async (status) => {
    const before = await financialState();
    const f = await open(390);
    try {
      await f.respond({ message: "Synthetic permission denied" }, status);
      await f.panel.getByText(deniedText, { exact: true }).waitFor();
      await expectUnknown(f.panel);
      expect(await f.panel.getByRole("button", { name: retryText, exact: true }).count()).toBe(0);
      expect(f.pending).toHaveLength(0);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it.each(["malformed-json", "malformed-plans", "foreign-patient"] as const)("keeps %s reads unknown and recovers only after a real successful retry", async (mode) => {
    const before = await financialState();
    const f = await open(390);
    try {
      if (mode === "malformed-json") await f.malformedJson();
      else await f.respond({ plans: [{ id: planId, patientId: mode === "foreign-patient" ? emptyPatientId : patientId,
        title: planTitle, status: "active", installments: mode === "foreign-patient" ? [{ id: 1 }] : null }] });
      await f.panel.getByText(unavailableText, { exact: false }).waitFor();
      await expectUnknown(f.panel);
      await f.panel.getByRole("button", { name: retryText, exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      await expectUnknown(f.panel);
      await expectFunded(f);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it("does not call a linked plan unfunded when a successful response omits it", async () => {
    const before = await financialState();
    const f = await open(390);
    try {
      await f.respond({ plans: [] });
      await f.panel.getByText(missingText, { exact: true }).waitFor();
      await f.panel.getByRole("button", { name: retryText, exact: true }).waitFor();
      await expectUnknown(f.panel);
      await f.panel.getByRole("button", { name: retryText, exact: true }).click();
      await expect.poll(() => f.pending.length).toBe(1);
      await expectFunded(f);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it("shows an empty unlinked state only after the real backend confirms an empty list", async () => {
    const before = await financialState();
    const f = await open(390, emptyPatientId);
    try {
      await f.panel.getByText(loadingText, { exact: false }).waitFor();
      await expectUnknown(f.panel);
      const payload = await f.realRead();
      expect(payload.plans).toEqual([]);
      await f.panel.getByText("لا اتفاق مالي مربوط بالحالة", { exact: true }).waitFor();
      const create = f.panel.getByRole("link", { name: "أنشئ اتفاق تقويم من تبويب الخطط", exact: true });
      expect(await create.getAttribute("href")).toBe(`/patients/${emptyPatientId}?tab=plans`);
      expect(await f.panel.getByRole("button", { name: retryText, exact: true }).count()).toBe(0);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });
});
