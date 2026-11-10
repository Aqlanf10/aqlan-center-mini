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
  await page.getByRole("combobox", { name: `حالة تاريخ ${title}`, exact: true }).selectOption("unknown");
  await page.getByLabel(`سبب غياب تاريخ ${title}`, { exact: true }).fill("مصدر اصطناعي؛ التاريخ غير معلوم");
  await page.getByRole("combobox", { name: `طريقة توثيق ${title}`, exact: true }).selectOption("direct_examination");
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
      expect(await page.getByTestId("ortho-financial-context").evaluate(element => element.tagName)).toBe("DETAILS");
      expect(await page.getByTestId("ortho-financial-context").getAttribute("open")).toBeNull();
      expect(await page.getByRole("button", { name: "مسار الأسلاك والشدّات", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "فتح التقييم السريري والقياسات", exact: true }).click();
      await page.getByRole("button", { name: "بدء تقييم غير معبأ", exact: true }).click();
      await page.getByRole("combobox", { name: "حالة الشكوى الرئيسية", exact: true }).selectOption("recorded");
      await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).fill("شكوى اصطناعية محفوظة مرة واحدة");
      // A quick entry with incomplete provenance stays local and names what to fix,
      // even while the source/date editor is collapsed. Untouched fields stay optional.
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      const feedback = page.getByTestId("assessment-save-feedback");
      await feedback.waitFor();
      expect(await feedback.innerText()).toContain("سبب إنشاء المراجعة");
      expect(await feedback.innerText()).toContain("الشكوى الرئيسية");
      expect(await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).inputValue()).toBe("شكوى اصطناعية محفوظة مرة واحدة");
      expect(writes).toEqual([]);
      expect((await db.query("SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [orthoCaseId])).rows[0].n).toBe(0);
      await source(page); await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("توثيق مقابلة اصطناعية");
      await expect.poll(() => feedback.count()).toBe(0);
      // Same draft survives section and pillar changes; navigation never sends a write.
      await selector.selectOption("2"); await selector.selectOption("8"); await selector.selectOption("1");
      await expect.poll(() => page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).inputValue()).toBe("شكوى اصطناعية محفوظة مرة واحدة");
      expect(writes).toEqual([]);
      const assessmentPath = `${baseUrl}/api/ortho/${orthoCaseId}/assessment`;
      await page.route(assessmentPath, async route => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch(); expect(response.status()).toBe(201);
        await route.abort("failed"); // Real commit; only its response is lost.
      });
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      const retry = page.getByRole("button", { name: "التحقق بإعادة نفس طلب الحفظ", exact: true });
      await retry.waitFor();
      await selector.selectOption("8"); expect(await selector.inputValue()).toBe("1");
      await page.getByRole("button", { name: "العودة لأقسام الحالة", exact: true }).click(); expect(await selector.isVisible()).toBe(true);
      await page.evaluate(hash => { window.location.hash = hash; }, `#ortho-workup/${patientId}/${orthoCaseId}/9`);
      await expect.poll(() => new URL(page.url()).hash).toBe(`#ortho-workup/${patientId}/${orthoCaseId}/2`);
      expect(await retry.isVisible()).toBe(true);
      await page.unroute(assessmentPath);
      await retry.click();
      await page.getByText("حُفظت مراجعة موثقة؛ جارٍ إعادة قراءة القيم والنتائج المحفوظة.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "الخطوة التالية دون حفظ", exact: true }).click(); await expect.poll(() => selector.inputValue()).toBe("2");
      expect(new URL(page.url()).hash).toBe(`#ortho-workup/${patientId}/${orthoCaseId}/3`);
      expect(await page.getByText("أكمل التحقق من طلب الحفظ المعلّق قبل الانتقال بين خطوات الحالة.", { exact: true }).isVisible()).toBe(false);
      const mutations = [...writes]; expect(mutations).toHaveLength(2); expect(mutations[0]).toContain(`/api/ortho/${orthoCaseId}/assessment`);
      for (const step of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) { await selector.selectOption(String(step)); expect(await selector.inputValue()).toBe(String(step)); }
      await selector.selectOption("7");
      await page.getByRole("button", { name: "+ سجّل تشخيص هذه الحالة", exact: true }).click();
      await page.getByLabel("ملاحظات التشخيص", { exact: true }).fill("مسودة تشخيص اصطناعية محفوظة أثناء التنقل");
      await selector.selectOption("8"); await selector.selectOption("0"); await selector.selectOption("7");
      expect(await page.getByLabel("ملاحظات التشخيص", { exact: true }).inputValue()).toBe("مسودة تشخيص اصطناعية محفوظة أثناء التنقل");
      await page.getByRole("button", { name: "إلغاء", exact: true }).click();
      await selector.selectOption("9"); expect(await page.getByTestId("ortho-financial-context").isVisible()).toBe(true); expect(await page.getByTestId("ortho-financial-context").evaluate(element => element.tagName)).toBe("DIV");
      await page.reload(); await expect.poll(() => selector.inputValue()).toBe("9");
      await selector.selectOption("1"); await page.getByRole("button", { name: "فتح التقييم السريري والقياسات", exact: true }).click(); await page.getByRole("combobox", { name: "نسخة التقييم", exact: true }).waitFor();
      await expect.poll(() => page.getByTestId("ortho-case-assessment-v2").innerText()).toContain("شكوى اصطناعية محفوظة مرة واحدة");
      // Saved documentation remains concise without losing the complaint or its exact source facts.
      const savedFindings = page.getByRole("region", { name: "نتائج المقابلة والفحص المحفوظة", exact: true });
      const savedDate = (await db.query("SELECT created_at FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version DESC LIMIT 1", [orthoCaseId])).rows[0].created_at as Date;
      const recordingDate = savedFindings.locator("p").filter({ hasText: "المراجعة #" }).locator("bdi");
      expect(await recordingDate.getAttribute("dir")).toBe("ltr");
      expect(await recordingDate.innerText()).toBe(savedDate.toISOString().slice(0, 10));
      const historySummary = savedFindings.getByRole("region", { name: "ملخص التوثيق المحفوظ — المقابلة وتاريخ الحالة", exact: true });
      expect(await historySummary.getByText("موثق: 1", { exact: true }).isVisible()).toBe(true);
      expect(await historySummary.getByText("غير مسجل: 4", { exact: true }).isVisible()).toBe(true);
      const savedComplaint = savedFindings.locator("p").filter({ hasText: "الشكوى الرئيسية المحفوظة:" });
      expect(await savedComplaint.isVisible()).toBe(true);
      expect(await savedComplaint.innerText()).toBe("الشكوى الرئيسية المحفوظة: شكوى اصطناعية محفوظة مرة واحدة");
      const correction = page.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true });
      await correction.scrollIntoViewIfNeeded();
      const actionBox = await correction.boundingBox(), overviewBox = await savedFindings.boundingBox();
      expect(actionBox).not.toBeNull(); expect(overviewBox).not.toBeNull();
      expect(actionBox!.height).toBeGreaterThanOrEqual(44);
      expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(overviewBox!.y);
      const historyDetails = historySummary.locator("details"), toggle = historyDetails.locator("summary");
      const originalComplaint = historyDetails.getByRole("article", { name: "الملاحظة المحفوظة clinical_chiefComplaint", exact: true });
      expect(await historyDetails.getAttribute("open")).toBeNull(); expect(await originalComplaint.isVisible()).toBe(false);
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await toggle.click(); await originalComplaint.waitFor();
      expect(await historyDetails.getAttribute("open")).not.toBeNull();
      const exactDetails = await originalComplaint.innerText();
      expect(exactDetails).toContain("شكوى اصطناعية محفوظة مرة واحدة");
      expect(exactDetails).toContain("غير معلوم · مصدر اصطناعي؛ التاريخ غير معلوم");
      expect(exactDetails).toContain("مقابلة اصطناعية موثقة");
      expect(exactDetails).toContain("المنفذ الموثق: غير معلوم");
      await toggle.click(); await expect.poll(() => originalComplaint.isVisible()).toBe(false);
      expect(await historyDetails.getAttribute("open")).toBeNull(); expect(await savedComplaint.isVisible()).toBe(true);
      await savedFindings.scrollIntoViewIfNeeded();
      await savedFindings.screenshot({ path: `.settings-ui-artifacts/ortho-saved-assessment-${width}.png` });
      expect(writes).toEqual(mutations);
      expect((await db.query("SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [orthoCaseId])).rows[0].n).toBe(1);
      expect(writes).toEqual(mutations);
      expect((await db.query("SELECT (SELECT count(*)::int FROM ortho_cases WHERE patient_id=$1) cases,(SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits,(SELECT count(*)::int FROM ortho_retention_entries WHERE patient_id=$1) retention,(SELECT count(*)::int FROM ortho_case_study_revisions WHERE patient_id=$1) study", [patientId])).rows[0]).toEqual({ cases: 1, invoices: 0, visits: 0, retention: 0, study: 0 });
      expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const guide = page.getByRole("region", { name: "إعداد ملف التقويم خطوة بخطوة", exact: true }); await guide.scrollIntoViewIfNeeded(); await guide.screenshot({ path: `.settings-ui-artifacts/ortho-workup-${width}.png` });
      await page.getByRole("button", { name: "العودة لأقسام الحالة", exact: true }).click(); expect(await guide.count()).toBe(0); await page.getByRole("navigation", { name: "الانتقال بين أقسام التشخيص" }).waitFor();
      expect(new URL(page.url()).searchParams.get("orthoCaseId")).toBe(String(orthoCaseId));
      expect(new URL(page.url()).hash).toBe("");
    } finally { await context.close(); }
  });
});
