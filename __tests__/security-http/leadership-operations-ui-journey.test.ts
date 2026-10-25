import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";
import type { OperationalOverview } from "../../lib/leadership-operations";

/** Hosted acceptance on the standard isolated synthetic harness. Never target Production.
 * Not executed locally where browser execution is denied. */
let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let patientId: number;
let day: string;
const stamp = Date.now();
const name = `مريض اختبار القيادة الاصطناعي ${stamp}`;
const panel = () => page.getByTestId("leadership-operations");
const operations = (url: string) => new URL(url).pathname === "/api/executive/operations";
const loaded = () => page.waitForResponse(response => operations(response.url()));
beforeAll(async () => {
  const h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  day = (await db.query("SELECT (NOW() AT TIME ZONE 'Asia/Aden')::date::text AS day")).rows[0].day;
  patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES ($1,$2) RETURNING id", [`SYN-LEAD-${stamp}`, name])).rows[0].id;
  const doctor = (await db.query("INSERT INTO parties(name,kind) VALUES ('طبيب إحالة اصطناعي','doctor') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,$2,'16:00','no_show')", [patientId, day]);
  await db.query(`INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,status,created_by,closed_at,kind,to_party_id,workflow_state,doctor_party_id,completed_at)
    VALUES ($1,'مستقبل اصطناعي','other','سبب اصطناعي','completed','synthetic',NOW(),'internal',$2,'completed',$2,NOW())`, [patientId, doctor]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-YE" });
  const [cookieName, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name: cookieName, value: value.join("="), url: baseUrl }]);
  // Fail closed against any external browser traffic; all fixtures and screenshots are synthetic.
  await context.route("**/*", route => new URL(route.request().url()).origin === new URL(baseUrl).origin ? route.continue() : route.abort());
  page = await context.newPage();
  // A failed legacy financial read must never suppress the separate operational panel.
  await page.route(url => url.pathname === "/api/executive", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "اختبار تعذّر المصدر المالي" }) }));
}, 180_000);
afterAll(async () => { await context?.close(); await browser?.close(); await db?.end(); });
it("shows verified patient destinations and scope on narrow RTL while the financial source fails", async () => {
  await page.goto(`${baseUrl}/executive`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "المالية", exact: true }).click();
  await expect.poll(() => page.getByTestId("leadership-finance").innerText()).toContain("اختبار تعذّر المصدر المالي");
  const response = loaded(); await page.getByRole("button", { name: "مراجعات اليوم", exact: true }).click(); await response;
  await expect.poll(() => panel().getByText(name, { exact: false }).count()).toBe(2);
  expect(await panel().getByLabel("يوم الموعد / اكتمال الإحالة").inputValue()).toBe(day);
  expect(await panel().locator(`a[href='/patients/${patientId}?tab=summary']`).count()).toBe(1);
  expect(await panel().locator(`a[href='/patients/${patientId}?tab=treatment&sub=referrals']`).count()).toBe(1);
  expect(await panel().innerText()).toContain("ليست قائمة بكل المتابعات المتراكمة");
  await panel().getByText("كيف تُقرأ هذه القائمة؟", { exact: true }).click();
  expect(await panel().innerText()).toContain("فتح الملف لا يغلق المتابعة");
  await panel().getByText("كيف تُقرأ هذه القائمة؟", { exact: true }).click();
  expect(await panel().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await panel().locator("label[for='operational-day']").click();
  expect(await page.locator("#operational-day").evaluate(element => document.activeElement === element)).toBe(true);
  const keyboardRead = loaded();
  await panel().getByRole("button", { name: "تحديث القراءة" }).focus();
  await page.keyboard.press("Enter"); await keyboardRead;
  await expect.poll(() => panel().getByText(name, { exact: false }).count()).toBe(2);
  await mkdir(".settings-ui-artifacts", { recursive: true });
  await panel().screenshot({ path: ".settings-ui-artifacts/leadership-operational-synthetic-narrow.png" });
});
it("filters action lanes and handles a verified empty selected day without implying an empty backlog", async () => {
  let response = loaded(); await panel().getByRole("button", { name: "الإحالات", exact: true }).click(); await response;
  await expect.poll(() => panel().getByRole("heading", { name: "نتائج إحالات بانتظار مراجعة الطبيب" }).count()).toBe(1);
  expect(await panel().getByRole("heading", { name: "مواعيد لم يحضر أصحابها أو أُلغيت" }).count()).toBe(0);
  response = loaded(); await panel().getByLabel("يوم الموعد / اكتمال الإحالة").fill("2098-01-01"); await response;
  await expect.poll(() => panel().innerText()).toContain("هذا لا ينفي وجود متابعات في أيام أخرى");
  response = loaded(); await panel().getByLabel("يوم الموعد / اكتمال الإحالة").fill(day); await response;
  response = loaded(); await panel().getByRole("button", { name: "الكل", exact: true }).click(); await response;
});
it("isolates one failed operational source and clears all patient results on a subsequent 401", async () => {
  await page.route(url => operations(url.toString()), async route => {
    const reply = await route.fetch(); const body = await reply.json() as OperationalOverview;
    body.sections[0] = { source: "appointments", status: "error", asOf: null, total: null, message: "عدد المواعيد غير معروف في اختبار فشل المصدر" };
    await route.fulfill({ response: reply, json: body });
  });
  let response = loaded(); await panel().getByRole("button", { name: "تحديث القراءة" }).click(); await response;
  await expect.poll(() => panel().getByRole("alert").innerText()).toContain("عدد المواعيد غير معروف");
  expect(await panel().locator(`a[href='/patients/${patientId}?tab=treatment&sub=referrals']`).count()).toBe(1);
  await page.unrouteAll({ behavior: "wait" });
  await page.route(url => operations(url.toString()), route => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
  response = loaded(); await panel().getByRole("button", { name: "تحديث القراءة" }).click(); await response;
  await expect.poll(() => panel().innerText()).toContain("انتهت الجلسة");
  expect(await panel().getByRole("link").count()).toBe(0);
});
