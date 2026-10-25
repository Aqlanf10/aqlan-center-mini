import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { harness } from "./_server";
import { openHrJourneyServer } from "./_hr-isolated-server";

/** Real standalone app + owned synthetic database. Hosted browser acceptance;
 * do not bypass a local Chromium denial. No fixture is read from a clinic. */
let h: Awaited<ReturnType<typeof harness>>, owned: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser;
let receivedId: number, patientId: number;
const evidenceDir = "/tmp/lab-backlog-evidence";
beforeAll(async () => {
  h = await harness(); owned = await openHrJourneyServer(h);
  const db = owned.db;
  const adminId = (await db.query("SELECT id FROM users WHERE username='secadmin'")).rows[0].id;
  const otherId = (await db.query("SELECT id FROM users WHERE username='secdoctora'")).rows[0].id;
  patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-BACKLOG-BROWSER','مريض متابعة تركيب اصطناعي') RETURNING id")).rows[0].id;
  const orders = (await db.query(`INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date,created_at,tooth_code)
    SELECT $1,'معمل اختبار اصطناعي','تاج اصطناعي',status,'2000-01-01','2000-01-10','2000-01-01T12:00:00Z',36
    FROM unnest(ARRAY['needed','sent','in_progress','remake','received']) status RETURNING id,status`, [patientId])).rows;
  receivedId = orders.find(row => row.status === "received")!.id;
  await db.query("INSERT INTO lab_order_tracking(lab_order_id,action,to_status,actor,created_at) VALUES ($1,'status_change','received','مسجّل وصول اصطناعي','2000-01-11T12:00:00Z')", [receivedId]);
  const staffId = (await db.query("INSERT INTO hr_staff(full_name,created_by) VALUES ('مسؤول متابعة اصطناعي','synthetic') RETURNING id")).rows[0].id;
  const taskId = (await db.query(`INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,assignee_staff_id,assignee_label,due_at)
    VALUES ('التحقق من موعد التجربة',$1,'مالك اصطناعي','synthetic',$2,'مسؤول متابعة اصطناعي','2000-01-12T12:00:00Z') RETURNING id`, [adminId, staffId])).rows[0].id;
  const privateId = (await db.query(`INSERT INTO hr_tasks(title,is_private,owner_user_id,owner_display_name,created_by)
    VALUES ('OTHER-PRIVATE-LAB-FOLLOWUP',TRUE,$1,'مالك خاص اصطناعي','synthetic') RETURNING id`, [otherId])).rows[0].id;
  for (const id of [taskId, privateId]) await db.query("INSERT INTO hr_task_links(task_id,link_kind,link_id,linked_by) VALUES ($1,'lab_order',$2,'synthetic')", [id, receivedId]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 180_000);
afterAll(async () => { await browser?.close(); await owned?.close(); });
async function context(role: "admin" | "doctorA", width: number): Promise<BrowserContext> {
  const result = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions[role].cookie.split("=");
  await result.addCookies([{ name, value: value.join("="), url: owned.baseUrl }]);
  await result.route("**/*", route => new URL(route.request().url()).origin === owned.baseUrl ? route.continue() : route.abort());
  return result;
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ["lab_orders", "lab_order_tracking", "hr_tasks", "hr_task_links", "payables", "expenses", "appointments"])
    result[table] = (await owned.db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return result;
}
it("keeps all-date waiting work visible on desktop/mobile, respects privacy, and changes no workflow state", async () => {
  const before = await snapshot(), captures: Array<{ width: number; png: Buffer }> = [];
  for (const width of [1280, 390]) {
    const ctx = await context("admin", width), page = await ctx.newPage();
    const mutationRequests: string[] = [], backlogReads: string[] = [];
    page.on("request", request => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      if (new URL(request.url()).pathname === "/api/lab/backlog") backlogReads.push(request.url());
    });
    try {
      await page.goto(`${owned.baseUrl}/executive`, { waitUntil: "domcontentloaded" });
      const panel = page.getByTestId("lab-backlog"), order = panel.locator(`#backlog-order-${receivedId}`);
      await expect.poll(() => panel.locator("article").count()).toBe(5);
      expect(await panel.innerText()).toContain("1 مريض · 5 طلب مفتوح");
      expect(await panel.innerText()).toContain("مهما كان تاريخها");
      expect(await order.innerText()).toContain("المدة غير معروفة");
      expect(await order.innerText()).toContain("الوصول ليس اكتمال العلاج");
      await order.locator("summary").click();
      const details = await order.innerText();
      expect(details).toContain("المسؤول المسند في المهمة: مسؤول متابعة اصطناعي");
      expect(details).toContain("المسجّل: مسجّل وصول اصطناعي");
      expect(details).toContain("لا يُعدّ ذلك إسناد مسؤولية المتابعة إليه");
      expect(details).toContain("عدم وجود هذا الربط لا يثبت غياب المريض");
      expect(await panel.innerText()).not.toContain("OTHER-PRIVATE-LAB-FOLLOWUP");
      expect(await order.locator(`a[href='/patients/${patientId}?tab=treatment&sub=lab']`).count()).toBe(2);
      const beforeIds = await panel.locator("article").evaluateAll(elements => elements.map(element => element.id));
      const readCount = backlogReads.length;
      const changedDay = page.waitForResponse(response => new URL(response.url()).pathname === "/api/executive/operations"
        && new URL(response.url()).searchParams.get("day") === "2098-01-01");
      await page.getByLabel("يوم الموعد / اكتمال الإحالة").fill("2098-01-01"); await changedDay;
      expect(await panel.locator("article").evaluateAll(elements => elements.map(element => element.id))).toEqual(beforeIds);
      expect(backlogReads).toHaveLength(readCount);
      expect(backlogReads.every(url => !new URL(url).searchParams.has("day"))).toBe(true);
      await panel.scrollIntoViewIfNeeded();
      expect(await panel.evaluate(element => getComputedStyle(element).direction)).toBe("rtl");
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await panel.getByRole("button").evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height >= 44))).toBe(true);
      captures.push({ width, png: await panel.screenshot() });
      expect(mutationRequests).toEqual([]);
    } finally { await ctx.close(); }
  }
  const denied = await context("doctorA", 390);
  try {
    const response = await denied.request.get(`${owned.baseUrl}/api/lab/backlog`); expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain("مريض متابعة تركيب اصطناعي");
    const page = await denied.newPage(); await page.goto(`${owned.baseUrl}/executive`, { waitUntil: "domcontentloaded" });
    expect(await page.getByTestId("lab-backlog").count()).toBe(0);
  } finally { await denied.close(); }
  expect(await snapshot()).toEqual(before);
  // Only publish these fresh synthetic images after all acceptance assertions pass.
  await mkdir(evidenceDir, { recursive: true });
  for (const capture of captures) await writeFile(`${evidenceDir}/lab-backlog-all-open-${capture.width}.png`, capture.png);
}, 180_000);
