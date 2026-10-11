import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedMutation, baseUrl, harness } from "./_server";

// Native Chromium, built application and actual HTTP/PG writers. No clinical
// response fixtures. Only synthetic patients in the security harness database.
let browser: Browser, db: Pool, h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Pool({ connectionString: h.seeded.dbUrl, ssl: false });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function counts() { return (await db.query(`SELECT (SELECT count(*)::int FROM invoices) invoices,
  (SELECT count(*)::int FROM payments) payments, (SELECT count(*)::int FROM treatment_plans) plans,
  (SELECT count(*)::int FROM plan_installments) installments`)).rows[0]; }
async function openPresentation(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByLabel("القسم", { exact: true }).selectOption("presentation");
  else await page.getByRole("tab", { name: "عرض الحالة", exact: true }).click();
}
async function saveStudy(page: Page, suffix: string) {
  await openPresentation(page);
  const view = page.getByTestId("ortho-case-study");
  await view.getByLabel("سبب حفظ النسخة", { exact: true }).fill(`Synthetic save ${suffix}`);
  await view.getByLabel("تعليق الدراسة", { exact: true }).fill(`Synthetic retained complaint ${suffix}`);
  const response = page.waitForResponse(r => r.url().includes("/case-study/editor") && r.request().method() === "POST");
  await view.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(201); expect(saved.headers()["cache-control"]).toContain("no-store");
  return view;
}
async function saveStudyWithLostReply(page: Page, suffix: string) {
  await openPresentation(page);
  const view = page.getByTestId("ortho-case-study"), bodies: string[] = [];
  let committed!: () => void, release!: () => void;
  const reachedServer = new Promise<void>(resolve => { committed = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/case-study/editor", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    bodies.push(route.request().postData()!);
    if (bodies.length > 1) { await route.continue(); return; }
    // Actual application transaction commits. Only its network reply is lost.
    const real = await route.fetch();
    expect(real.status()).toBe(201); committed(); await held; await route.abort("failed");
  });
  await view.getByLabel("سبب حفظ النسخة", { exact: true }).fill(`Synthetic save ${suffix}`);
  await view.getByLabel("تعليق الدراسة", { exact: true }).fill(`Synthetic retained complaint ${suffix}`);
  await view.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
  try {
    await reachedServer;
    // Native same-case navigation must not retire a request while its body is pending.
    if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByLabel("القسم", { exact: true }).selectOption("records");
    else await page.getByRole("tab", { name: "السجلات والتشخيص", exact: true }).click();
    expect(await view.isVisible()).toBe(true);
  } finally { release(); }
  const retry = view.getByRole("button", { name: "إعادة التحقق بنفس الطلب", exact: true });
  await retry.waitFor();
  const response = page.waitForResponse(r => r.url().includes("/case-study/editor") && r.request().method() === "POST");
  await retry.click(); expect((await response).status()).toBe(200);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
  await page.unroute("**/case-study/editor");
}
describe("composed ortho workflow with real HTTP at native widths", () => {
  it.each([390, 1280])("opens and saves a new case and leaves finance unchanged at %ipx", async width => {
    const id = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`SYN-${randomUUID()}`, `حالة اصطناعية ${width}`])).rows[0].id as number;
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar" });
    const cookie = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => { if (response.url().includes("/case-study/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()} ${await response.text()}`); });
    const before = await counts();
    try {
      await page.goto(`${baseUrl}/patients/${id}?tab=treatment&sub=ortho`);
      const intake = page.getByRole("region", { name: "بداية حالة التقويم", exact: true }).first();
      await intake.getByLabel("سياق التقييم", { exact: true }).selectOption("new");
      await intake.getByLabel("الحالة السريرية للتقييم", { exact: true }).selectOption("new");
      await intake.getByLabel("سبب تدوين بداية الحالة", { exact: true }).fill("Synthetic browser intake");
      const pending = page.waitForResponse(r => r.url().includes("/api/ortho/intake") && r.request().method() === "POST");
      await intake.getByRole("button", { name: "حفظ بداية التقييم", exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(201); expect(response.headers()["cache-control"]).toContain("no-store");
      const caseId = (await db.query("SELECT id FROM ortho_cases WHERE patient_id=$1", [id])).rows[0].id;
      await page.getByTestId(`ortho-case-${caseId}`).waitFor();
      await page.waitForURL(url => url.searchParams.get("orthoCaseId") === String(caseId));
      await saveStudyWithLostReply(page, String(width));
      expect((await db.query("SELECT count(*)::int n FROM ortho_case_study_revisions WHERE ortho_case_id=$1", [caseId])).rows[0].n).toBe(1);
      await page.reload();
      const view = await (async () => { await openPresentation(page); return page.getByTestId("ortho-case-study"); })();
      await view.getByLabel("تعليق الدراسة", { exact: true }).waitFor();
      expect(await view.getByLabel("تعليق الدراسة", { exact: true }).inputValue()).toBe(`Synthetic retained complaint ${width}`);
      expect(await view.getByRole("heading", { name: `دراسة حالة تقويم — حالة اصطناعية ${width}` }).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-union-study-${width}.png`, fullPage: true });
      expect(await counts()).toEqual(before); expect(errors).toEqual([]);
    } catch (error) {
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-union-failure-${width}.png`, fullPage: true });
      await writeFile(`.settings-ui-artifacts/ortho-union-failure-${width}.txt`, `${errors.join("\n")}\n${await page.locator("body").innerText()}`);
      throw error;
    } finally { await context.close(); }
  });
  it.each([390, 1280])("joins historical 300000/120000 care to the same case, retaining an unknown start at %ipx", async width => {
    const id = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`HIST-${randomUUID()}`, `حالة تاريخية اصطناعية ${width}`])).rows[0].id as number;
    const serviceId = (await db.query("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,300000,true,true,'ortho') RETURNING id", [`Synthetic historical ortho ${randomUUID()}`])).rows[0].id;
    const financialCommand = JSON.stringify({ serviceId, scope: "both", currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-01-15", idempotencyKey: `historical-${randomUUID()}` });
    expect((await authedMutation(`/api/patients/${id}/legacy-treatments`, h.sessions.admin, "POST", financialCommand)).status).toBe(201);
    expect((await authedMutation(`/api/patients/${id}/legacy-treatments`, h.sessions.admin, "POST", financialCommand)).status).toBe(200);
    const bridge = (await db.query("SELECT id FROM clinical_cases WHERE patient_id=$1", [id])).rows[0].id;
    const plan = (await db.query("SELECT id FROM treatment_plans WHERE patient_id=$1", [id])).rows[0].id;
    const beforeClinical = await counts();
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar" });
    const cookie = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name: cookie[0], value: cookie.slice(1).join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15_000); page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/patients/${id}?tab=treatment&sub=ortho`);
      const intake = page.getByRole("region", { name: "بداية حالة التقويم", exact: true }).first();
      await intake.getByLabel("سياق التقييم", { exact: true }).selectOption("transferred");
      await intake.getByLabel("الحالة السريرية للتقييم", { exact: true }).selectOption(String(bridge));
      await intake.getByLabel("سبب تدوين بداية الحالة", { exact: true }).fill("Synthetic historical case; preserve original bridge");
      let pending = page.waitForResponse(r => r.url().includes("/api/ortho/intake") && r.request().method() === "POST");
      await intake.getByRole("button", { name: "حفظ بداية التقييم", exact: true }).click();
      expect((await pending).status()).toBe(201);
      const caseId = (await db.query("SELECT id FROM ortho_cases WHERE patient_id=$1", [id])).rows[0].id;
      await page.waitForURL(url => url.searchParams.get("orthoCaseId") === String(caseId));
      const activation = page.getByTestId(`ortho-case-${caseId}`).getByRole("region", { name: "بداية حالة التقويم", exact: true });
      await activation.getByLabel("الجهاز", { exact: true }).selectOption("fixed_metal");
      await activation.getByLabel("نطاق العلاج", { exact: true }).selectOption("both");
      await activation.getByLabel("مرحلة العلاج", { exact: true }).selectOption("working");
      await activation.getByLabel("دليل تاريخ بدء العلاج", { exact: true }).selectOption("unknown");
      await activation.getByLabel("سبب جهل تاريخ البدء", { exact: true }).fill("Historical source does not record a date");
      await activation.getByLabel("الاتفاق المالي عند البدء", { exact: true }).selectOption(String(plan));
      await activation.getByLabel("سبب تدوين بداية الحالة", { exact: true }).fill("Synthetic transferred care with explicit unknown date");
      pending = page.waitForResponse(r => r.url().includes("/api/ortho/intake") && r.request().method() === "POST");
      await activation.getByRole("button", { name: "توثيق بداية العلاج", exact: true }).click();
      expect((await pending).status()).toBe(201);
      await expect.poll(async () => (await db.query("SELECT status FROM ortho_cases WHERE id=$1", [caseId])).rows[0].status).toBe("active");
      await saveStudy(page, `historical-${width}`);
      await page.reload(); await openPresentation(page);
      expect(await page.getByTestId("ortho-case-study").getByLabel("تعليق الدراسة", { exact: true }).inputValue()).toBe(`Synthetic retained complaint historical-${width}`);
      expect((await db.query("SELECT start_date,planned_months,slot,plan_id FROM ortho_cases WHERE id=$1", [caseId])).rows).toEqual([{ start_date: null, planned_months: null, slot: null, plan_id: plan }]);
      expect((await db.query("SELECT id,ortho_case_id FROM clinical_cases WHERE patient_id=$1", [id])).rows).toEqual([{ id: bridge, ortho_case_id: caseId }]);
      expect((await db.query("SELECT amount_minor::int amount FROM patient_opening_balances WHERE patient_id=$1", [id])).rows).toEqual([{ amount: 180000 }]);
      expect((await db.query("SELECT agreed_minor::int agreed,previously_paid_minor::int paid,remaining_minor::int remaining FROM legacy_treatment_agreements WHERE patient_id=$1", [id])).rows).toEqual([{ agreed: 300000, paid: 120000, remaining: 180000 }]);
      expect(await counts()).toEqual(beforeClinical);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-union-historical-${width}.png`, fullPage: true });
      expect(errors).toEqual([]);
    } catch (error) {
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-union-historical-failure-${width}.png`, fullPage: true });
      await writeFile(`.settings-ui-artifacts/ortho-union-historical-failure-${width}.txt`, `${errors.join("\n")}\n${await page.locator("body").innerText()}`);
      throw error;
    } finally { await context.close(); }
  });
});
