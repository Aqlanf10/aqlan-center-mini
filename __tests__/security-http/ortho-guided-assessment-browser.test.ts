import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { baseUrl, harness, authedMutation } from "./_server";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function source(page: Page, title: string) {
  await page.getByRole("button", { name: `مصدر وتاريخ ${title}`, exact: true }).click();
  await page.getByLabel(`حالة تاريخ ${title}`, { exact: true }).selectOption("unknown");
  await page.getByLabel(`سبب غياب تاريخ ${title}`, { exact: true }).fill("مصدر اصطناعي؛ التاريخ غير معلوم");
  await page.getByLabel(`طريقة توثيق ${title}`, { exact: true }).selectOption("direct_examination");
  await page.getByLabel(`وصف طريقة توثيق ${title}`, { exact: true }).fill("فحص اصطناعي موثق");
}
describe("confirmed save-and-continue through the existing assessment", () => {
  it.each([390, 1280])("keeps invalid/uncertain edits, resumes a bookmarked section and preserves prior findings at %ipx", async width => {
    const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'تقييم متدرج اصطناعي') RETURNING id", [`SYN-GUIDED-${randomUUID()}`])).rows[0].id;
    const opened = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "ملف اصطناعي لرحلة التقييم" } }));
    expect(opened.status).toBe(201); const { orthoCaseId } = await opened.json();
    const records = async () => (await db.query("SELECT version,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [orthoCaseId])).rows;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [], commands: string[] = []; page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
    const section = (name: string) => page.getByRole("button", { name, exact: true });
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${orthoCaseId}&pillar=diagnostics`);
      await section("بدء تقييم غير معبأ").click();
      await page.getByLabel("حالة الشكوى الرئيسية", { exact: true }).selectOption("recorded");
      await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).fill("شكوى اصطناعية لا تتكرر في الخطوات");
      await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("توثيق المقابلة الاصطناعية");
      await section("حفظ والمتابعة").click();
      await page.getByText("أكمل السبب والقياسات ومصدر وتاريخ كل قيمة قبل الحفظ؛ الفراغ ليس صفرًا.", { exact: true }).waitFor();
      expect(await section("المقابلة والتاريخ").getAttribute("aria-pressed")).toBe("true"); expect(await records()).toHaveLength(0);
      await source(page, "الشكوى الرئيسية");
      await page.route(`**/api/ortho/${orthoCaseId}/assessment`, async route => {
        if (route.request().method() !== "POST") return route.continue();
        commands.push(route.request().postData()!); const response = await route.fetch();
        if (commands.length === 1) { expect(response.status()).toBe(201); return route.abort("failed"); }
        return route.fulfill({ response });
      });
      await section("حفظ والمتابعة").click(); await section("التحقق بإعادة نفس طلب الحفظ").waitFor();
      expect(await section("المقابلة والتاريخ").getAttribute("aria-pressed")).toBe("true"); expect(await records()).toHaveLength(1);
      // A deliberate section change invalidates the earlier continue intent.
      if (width === 1280) await section("فحص الفم والإطباق").click();
      await section("التحقق بإعادة نفس طلب الحفظ").click(); expect(commands[1]).toBe(commands[0]);
      if (width === 1280) {
        await page.getByText("ملخص التقييم المحفوظ — نسخة 1", { exact: true }).waitFor();
        expect(await section("فحص الفم والإطباق").getAttribute("aria-pressed")).toBe("true");
        await section("فتح مراجعة تصحيحية من النسخة الحالية").click(); await section("فحص الوجه والابتسامة").click();
      } else {
        await expect.poll(() => section("فحص الوجه والابتسامة").getAttribute("aria-pressed")).toBe("true");
        await page.getByTestId("assessment-v2-draft").waitFor();
      }
      expect(await records()).toHaveLength(1);
      await page.getByLabel("حالة تناظر الوجه", { exact: true }).selectOption("not_measured");
      await page.getByLabel("سبب حالة تناظر الوجه", { exact: true }).fill("الفحص لم يكتمل في المثال"); await source(page, "تناظر الوجه");
      await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("استكمال فحص الوجه الاصطناعي");
      await section("حفظ والمتابعة").click();
      await expect.poll(() => section("فحص الفم والإطباق").getAttribute("aria-pressed")).toBe("true");
      const saved = await records(); expect(saved).toHaveLength(2);
      const observations = saved.map(row => row.content.draft.observations.observations);
      expect(observations[1].find((o: { id: string }) => o.id === "clinical_chiefComplaint")).toEqual(observations[0].find((o: { id: string }) => o.id === "clinical_chiefComplaint"));
      await section("التالي دون حفظ").click();
      expect(await section("الموديلات والقياسات").getAttribute("aria-pressed")).toBe("true");
      expect(new URL(page.url()).hash).toBe(`#ortho-assessment/${patientId}/${orthoCaseId}/measurements`);
      await page.reload(); await page.getByText("ملخص التقييم المحفوظ — نسخة 2", { exact: true }).waitFor();
      expect(await section("الموديلات والقياسات").getAttribute("aria-pressed")).toBe("true");
      await section("السابق").click(); expect(await section("فحص الفم والإطباق").getAttribute("aria-pressed")).toBe("true");
      expect(await records()).toEqual(saved);
      expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes("شكوى اصطناعية لا تتكرر")))).toBe(false);
      expect((await db.query("SELECT (SELECT count(*)::int FROM ortho_cases WHERE patient_id=$1) cases,(SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patientId])).rows[0]).toEqual({ cases: 1, invoices: 0, payments: 0, visits: 0 });
      expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-guided-assessment-${width}.png`, fullPage: true });
    } finally { await context.close(); }
  });
});
