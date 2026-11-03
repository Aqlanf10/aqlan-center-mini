import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { baseUrl, harness, authedMutation } from "./_server";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => { h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http"); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }); await mkdir(".settings-ui-artifacts", { recursive: true }); });
afterAll(async () => { await browser?.close(); await db?.end(); });
async function source(page: Page) {
  const title = "الشكوى الرئيسية";
  await page.getByRole("button", { name: `مصدر وتاريخ ${title}`, exact: true }).click();
  await page.getByLabel(`حالة تاريخ ${title}`, { exact: true }).selectOption("unknown");
  await page.getByLabel(`سبب غياب تاريخ ${title}`, { exact: true }).fill("مصدر اصطناعي؛ التاريخ غير معلوم");
  await page.getByLabel(`طريقة توثيق ${title}`, { exact: true }).selectOption("direct_examination");
  await page.getByLabel(`وصف طريقة توثيق ${title}`, { exact: true }).fill("مقابلة اصطناعية موثقة");
}
describe("one workup path over the existing record owners", () => {
  it.each([390, 1280])("saves the interview once, resumes a step and freely visits all destinations without clinical or financial side effects at %ipx", async width => {
    const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مسار ملف تقويم اصطناعي') RETURNING id", [`SYN-WORKUP-${randomUUID()}`])).rows[0].id;
    const opened = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "ملف اصطناعي لمسار التقييم" } }));
    expect(opened.status).toBe(201); const { orthoCaseId } = await opened.json();
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" }); const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [], writes: string[] = []; page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (request.method() !== "GET" && request.method() !== "HEAD") writes.push(request.url()); });
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${orthoCaseId}&pillar=diagnostics`);
      await page.getByRole("button", { name: "إعداد ملف التقويم خطوة بخطوة", exact: true }).click();
      await page.getByRole("region", { name: "هوية حالة التقويم", exact: true }).waitFor();
      const selector = page.getByLabel("خطوة إعداد ملف التقويم", { exact: true }); expect(await selector.locator("option").count()).toBe(13);
      await page.getByRole("button", { name: "الخطوة التالية دون حفظ", exact: true }).click(); expect(await selector.inputValue()).toBe("1");
      expect(await page.getByTestId("ortho-financial-context").isVisible()).toBe(false);
      expect(await page.getByRole("button", { name: "مسار الأسلاك والشدّات", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "بدء تقييم غير معبأ", exact: true }).click();
      await page.getByLabel("حالة الشكوى الرئيسية", { exact: true }).selectOption("recorded");
      await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).fill("شكوى اصطناعية محفوظة مرة واحدة");
      await source(page); await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("توثيق مقابلة اصطناعية");
      await page.getByRole("button", { name: "حفظ والمتابعة", exact: true }).click(); await expect.poll(() => selector.inputValue()).toBe("2");
      expect(new URL(page.url()).hash).toBe(`#ortho-workup/${patientId}/${orthoCaseId}/3`);
      const mutations = [...writes]; expect(mutations).toHaveLength(1); expect(mutations[0]).toContain(`/api/ortho/${orthoCaseId}/assessment`);
      for (const step of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) { await selector.selectOption(String(step)); expect(await selector.inputValue()).toBe(String(step)); }
      await selector.selectOption("9"); expect(await page.getByTestId("ortho-financial-context").isVisible()).toBe(true); await expect.poll(() => page.getByTestId("ortho-financial-context").getAttribute("open")).toBe("");
      await page.reload(); await expect.poll(() => selector.inputValue()).toBe("9");
      await selector.selectOption("1"); await page.getByText("ملخص التقييم المحفوظ — نسخة 1", { exact: true }).waitFor();
      expect((await db.query("SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [orthoCaseId])).rows[0].n).toBe(1);
      expect(writes).toEqual(mutations);
      expect((await db.query("SELECT (SELECT count(*)::int FROM ortho_cases WHERE patient_id=$1) cases,(SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits,(SELECT count(*)::int FROM ortho_retention_entries WHERE patient_id=$1) retention,(SELECT count(*)::int FROM ortho_case_study_revisions WHERE patient_id=$1) study", [patientId])).rows[0]).toEqual({ cases: 1, invoices: 0, visits: 0, retention: 0, study: 0 });
      expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const guide = page.getByRole("region", { name: "إعداد ملف التقويم خطوة بخطوة", exact: true }); await guide.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await guide.screenshot({ path: `.settings-ui-artifacts/ortho-workup-${width}.png` });
      await page.getByRole("button", { name: "العودة لأقسام الحالة", exact: true }).click(); expect(await guide.count()).toBe(0); await page.getByRole("navigation", { name: "أقسام تشخيص الحالة" }).waitFor();
    } finally { await context.close(); }
  });
});
