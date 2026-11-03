import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
let browser: Browser, db: Client, h: Awaited<ReturnType<typeof harness>>;
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
  await page.getByLabel(`سبب غياب تاريخ ${title}`, { exact: true }).fill("تاريخ غير محدد في المثال الاصطناعي");
  await page.getByLabel(`طريقة توثيق ${title}`, { exact: true }).selectOption("direct_examination");
  await page.getByLabel(`وصف طريقة توثيق ${title}`, { exact: true }).fill("توثيق فحص اصطناعي للاختبار");
}
describe("case-oriented diagnostic sections and incremental saved evidence", () => {
  it.each([390, 1280])("opens the same case from the board and preserves partial reviews at %ipx", async width => {
    const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'حالة تنظيم اصطناعية') RETURNING id", [`SYN-NAV-${randomUUID()}`])).rows[0].id;
    const caseId = (await db.query("INSERT INTO ortho_cases(patient_id,created_by,status,phase,start_date) VALUES($1,'synthetic','active','aligning','2022-01-01') RETURNING id", [patientId])).rows[0].id;
    const clinicalCaseId = (await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic navigation bridge',$2,'synthetic') RETURNING id", [patientId, caseId])).rows[0].id;
    const rows = async () => (await db.query("SELECT version,clinical_case_id,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [caseId])).rows;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(20_000);
    try {
      await page.goto(`${baseUrl}/ortho`);
      const link = page.locator(`a[href*="orthoCaseId=${caseId}&"]`, { hasText: "ملف التقويم" });
      await link.waitFor();
      const href = await link.getAttribute("href"); expect(href).toContain(`patientId=${patientId}`); expect(href).toContain("pillar=diagnostics");
      await link.click();
      await page.getByRole("button", { name: "بدء تقييم غير معبأ", exact: true }).click();
      expect(await page.getByRole("button", { name: "المقابلة والتاريخ", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(await page.getByLabel("حالة تناظر الوجه", { exact: true }).isVisible()).toBe(false);
      await page.getByLabel("حالة الشكوى الرئيسية", { exact: true }).selectOption("recorded");
      const chief = page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true });
      await chief.fill("شكوى اصطناعية محفوظة على مراحل");
      await page.getByRole("region", { name: "حالة توثيق التقييم", exact: true }).getByText("الشكوى الرئيسية: افتح «المصدر والتاريخ» وحدد تاريخ الفحص، أو اختر غير معلوم مع السبب.", { exact: true }).waitFor();
      expect(await rows()).toHaveLength(0);
      await source(page, "الشكوى الرئيسية");
      await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("حفظ المقابلة قبل اكتمال بقية الفحص");
      await page.getByRole("button", { name: "فحص الوجه والابتسامة", exact: true }).click();
      await page.getByLabel("حالة تناظر الوجه", { exact: true }).waitFor();
      expect(await chief.isVisible()).toBe(false);
      await page.getByRole("button", { name: "الصور والأشعة", exact: true }).click();
      expect(await page.getByTestId("ortho-case-assessment-v2").isVisible()).toBe(true);
      expect(await page.getByRole("region", { name: "قراءة البانوراما وربطها بالأسنان", exact: true }).isVisible()).toBe(true);
      expect(await chief.isVisible()).toBe(false);
      await page.getByRole("button", { name: "المقابلة والتاريخ", exact: true }).click();
      expect(await chief.inputValue()).toBe("شكوى اصطناعية محفوظة على مراحل");
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      await page.getByText("ملخص التقييم المحفوظ — نسخة 1", { exact: true }).waitFor();
      const first = await rows(); expect(first).toHaveLength(1); expect(first[0].clinical_case_id).toBe(clinicalCaseId);
      const observations = first[0].content.draft.observations.observations;
      expect(observations.find((o: { id: string }) => o.id === "clinical_chiefComplaint").value).toEqual({ state: "recorded", text: "شكوى اصطناعية محفوظة على مراحل" });
      expect(observations.filter((o: { id: string; value: { state: string } }) => o.id !== "clinical_chiefComplaint").every((o: { value: { state: string } }) => o.value.state === "not_recorded")).toBe(true);
      await page.reload();
      await page.getByText("ملخص التقييم المحفوظ — نسخة 1", { exact: true }).waitFor();
      await page.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
      await page.getByRole("button", { name: "فحص الوجه والابتسامة", exact: true }).click();
      await page.getByLabel("حالة تناظر الوجه", { exact: true }).selectOption("not_measured");
      await page.getByLabel("سبب حالة تناظر الوجه", { exact: true }).fill("لم يكتمل الفحص في المثال الاصطناعي");
      await source(page, "تناظر الوجه");
      await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("استكمال حالة فحص الوجه مع حفظ الشكوى السابقة");
      await page.getByRole("button", { name: "خطة العلاج والميكانيكا", exact: true }).click();
      await page.getByRole("button", { name: /السجلات والسيفالومتري/ }).click();
      expect(await page.getByRole("button", { name: "فحص الوجه والابتسامة", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(await page.getByLabel("سبب حالة تناظر الوجه", { exact: true }).inputValue()).toBe("لم يكتمل الفحص في المثال الاصطناعي");
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      await page.getByText("ملخص التقييم المحفوظ — نسخة 2", { exact: true }).waitFor();
      const second = await rows(); expect(second).toHaveLength(2); expect(second[0]).toEqual(first[0]);
      const updated = second[1].content.draft.observations.observations;
      expect(updated.find((o: { id: string }) => o.id === "clinical_chiefComplaint")).toEqual(observations.find((o: { id: string }) => o.id === "clinical_chiefComplaint"));
      expect(updated.find((o: { id: string }) => o.id === "clinical_facialSymmetry").value.state).toBe("not_measured");
      expect((await db.query(`SELECT (SELECT count(*)::int FROM ortho_cases WHERE patient_id=$1) cases,
        (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,
        (SELECT count(*)::int FROM visits WHERE patient_id=$1) visits,(SELECT count(*)::int FROM appointments WHERE patient_id=$1) appointments`, [patientId])).rows[0])
        .toEqual({ cases: 1, invoices: 0, payments: 0, visits: 0, appointments: 0 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-case-navigation-${width}.png`, fullPage: true });
    } catch (error) {
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-case-navigation-failure-${width}.png`, fullPage: true });
      await writeFile(`.settings-ui-artifacts/ortho-case-navigation-failure-${width}.txt`, await page.locator("body").innerText()); throw error;
    } finally { await context.close(); }
  });
});
