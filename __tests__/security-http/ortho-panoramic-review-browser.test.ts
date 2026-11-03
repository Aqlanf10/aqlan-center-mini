import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { baseUrl, harness, authedMutation, authedGet } from "./_server";
import { newAssessmentEditorV2, assessmentEditorCommandV2 } from "../../lib/ortho-assessment-editor-v2";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => { h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http"); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }); await mkdir(".settings-ui-artifacts", { recursive: true }); });
afterAll(async () => { await browser?.close(); await db?.end(); });
async function setup() {
  const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'قراءة بانوراما اصطناعية') RETURNING id", [`SYN-PANO-UI-${randomUUID()}`])).rows[0].id;
  const opened = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "ملف اصطناعي لمراجعة الصور" } }));
  expect(opened.status).toBe(201); const { orthoCaseId } = await opened.json();
  const documents: number[] = [];
  for (const [index, color] of ["#34667b", "#6e557c"].entries()) {
    const bytes = await sharp({ create: { width: 600, height: 240, channels: 3, background: color } }).png().toBuffer();
    const form = new FormData(); form.set("patientId", String(patientId)); form.set("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "synthetic-panorama.png");
    form.set("command", JSON.stringify({ schemaVersion: 1, clientRequestId: randomUUID(), title: `بانوراما اصطناعية ${index + 1}`, photoView: "panoramic", photoStage: index ? "progress" : "initial",
      occurrence: { state: "known", takenOn: index ? "2026-10-02" : "2026-10-01", sourceNote: "رسم لوني اصطناعي فقط للاختبار" }, file: { sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png", sizeBytes: bytes.length } }));
    const saved = await fetch(`${baseUrl}/api/ortho/${orthoCaseId}/record-uploads`, { method: "POST", headers: { Cookie: h.sessions.admin.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" }, body: form });
    expect(saved.status).toBe(201); documents.push((await saved.json()).documentId);
  }
  const editor = newAssessmentEditorV2(randomUUID(), null)!; editor.reason = "مقابلة اصطناعية سابقة";
  editor.measurements.values.clinical_chiefComplaint = { ...editor.measurements.values.clinical_chiefComplaint, state: "recorded", text: "شكوى اصطناعية محفوظة من المقابلة", dateState: "unknown", dateReason: "تاريخ المقابلة غير معلوم في العينة", method: "direct_examination", methodDescription: "مقابلة اصطناعية" };
  const command = assessmentEditorCommandV2(editor)!; expect(command).not.toBeNull();
  expect((await authedMutation(`/api/ortho/${orthoCaseId}/assessment`, h.sessions.admin, "POST", JSON.stringify(command))).status).toBe(201);
  return { patientId, orthoCaseId, documents };
}
describe("source-bound panoramic review on the built patient page", () => {
  it.each([390, 1280])("keeps image-specific findings, the original complaint and immutable corrections through lost replies at %ipx", async width => {
    const { patientId, orthoCaseId, documents } = await setup(), endpoint = `/api/ortho/${orthoCaseId}/assessment`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" }); const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [], sent: string[] = []; page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${orthoCaseId}&pillar=diagnostics#ortho-assessment/${patientId}/${orthoCaseId}/records`);
      const workspace = page.getByTestId("ortho-case-assessment-v2"), review = workspace.getByRole("region", { name: "قراءة البانوراما وربطها بالأسنان", exact: true });
      await workspace.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
      await review.getByLabel("صورة البانوراما", { exact: true }).selectOption(String(documents[0]));
      await expect.poll(() => review.locator("img").evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
      await review.getByLabel("نطاق الملاحظة", { exact: true }).selectOption("13"); await review.getByRole("button", { name: "إضافة ملاحظة غير معبأة", exact: true }).click();
      const tooth = review.getByRole("group", { name: "قراءة السن FDI 13", exact: true });
      await tooth.getByLabel("حالة قراءة السن FDI 13", { exact: true }).selectOption("recorded"); await tooth.getByRole("textbox", { name: "نتائج قراءة السن FDI 13", exact: true }).fill("قراءة سن اصطناعية من الصورة الأولى");
      await tooth.getByLabel("حالة تاريخ قراءة السن FDI 13", { exact: true }).selectOption("unknown"); await tooth.getByLabel("سبب غياب تاريخ قراءة السن FDI 13", { exact: true }).fill("تاريخ القراءة الأصلي غير معلوم");
      await tooth.getByLabel("طريقة قراءة السن FDI 13", { exact: true }).selectOption("direct_examination"); await tooth.getByLabel("وصف طريقة قراءة السن FDI 13", { exact: true }).fill("قراءة الطبيب للرسم الاصطناعي");
      await review.getByLabel("صورة البانوراما", { exact: true }).selectOption(String(documents[1])); expect(await tooth.count()).toBe(0);
      await review.getByLabel("نطاق الملاحظة", { exact: true }).selectOption("case"); await review.getByRole("button", { name: "إضافة ملاحظة غير معبأة", exact: true }).click();
      const general = review.getByRole("group", { name: "قراءة القراءة العامة", exact: true });
      await general.getByLabel("حالة قراءة القراءة العامة", { exact: true }).selectOption("recorded"); await general.getByRole("textbox", { name: "نتائج قراءة القراءة العامة", exact: true }).fill("قراءة عامة اصطناعية للصورة الثانية");
      await general.getByLabel("حالة تاريخ قراءة القراءة العامة", { exact: true }).selectOption("known"); await general.getByLabel("تاريخ قراءة القراءة العامة", { exact: true }).fill("2026-10-03");
      await general.getByLabel("طريقة قراءة القراءة العامة", { exact: true }).selectOption("direct_examination"); await general.getByLabel("وصف طريقة قراءة القراءة العامة", { exact: true }).fill("قراءة عامة من الطبيب للرسم الاصطناعي");
      await page.getByRole("button", { name: "المقابلة والتاريخ", exact: true }).click(); expect(await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).inputValue()).toBe("شكوى اصطناعية محفوظة من المقابلة");
      await page.getByRole("button", { name: "الصور والأشعة", exact: true }).click(); await review.getByLabel("صورة البانوراما", { exact: true }).selectOption(String(documents[0]));
      expect(await tooth.getByRole("textbox", { name: "نتائج قراءة السن FDI 13", exact: true }).inputValue()).toBe("قراءة سن اصطناعية من الصورة الأولى");
      await workspace.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("توثيق قراءتين اصطناعيتين من مصدرهما");
      await page.route(`**${endpoint}`, async route => { if (route.request().method() !== "POST") return route.continue(); sent.push(route.request().postData()!); const response = await route.fetch(); if (sent.length === 1) { expect(response.status()).toBe(201); return route.abort("failed"); } expect(response.status()).toBe(200); return route.fulfill({ response }); });
      await workspace.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click(); await workspace.getByRole("button", { name: "التحقق بإعادة نفس طلب الحفظ", exact: true }).click();
      await workspace.getByText("ملخص التقييم المحفوظ — نسخة 2", { exact: true }).waitFor(); expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]); await page.unroute(`**${endpoint}`);
      await page.reload(); await review.getByLabel("صورة البانوراما", { exact: true }).selectOption(String(documents[0])); expect(await tooth.getByRole("textbox", { name: "نتائج قراءة السن FDI 13", exact: true }).inputValue()).toBe("قراءة سن اصطناعية من الصورة الأولى");
      await workspace.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click(); await review.getByLabel("صورة البانوراما", { exact: true }).selectOption(String(documents[0]));
      await tooth.getByRole("textbox", { name: "نتائج قراءة السن FDI 13", exact: true }).fill("تصحيح اصطناعي موثق للسن"); await workspace.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("تصحيح القراءة مع حفظ النسخة الأصلية");
      await workspace.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click(); await workspace.getByText("ملخص التقييم المحفوظ — نسخة 3", { exact: true }).waitFor();
      const revisions = (await db.query("SELECT id,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [orthoCaseId])).rows; expect(revisions).toHaveLength(3);
      await workspace.getByRole("combobox", { name: "نسخة التقييم", exact: true }).selectOption(String(revisions[1].id)); await review.getByLabel("صورة البانوراما", { exact: true }).selectOption(String(documents[0]));
      expect(await tooth.getByRole("textbox", { name: "نتائج قراءة السن FDI 13", exact: true }).inputValue()).toBe("قراءة سن اصطناعية من الصورة الأولى"); expect(await tooth.getByRole("textbox", { name: "نتائج قراءة السن FDI 13", exact: true }).isDisabled()).toBe(true);
      const observations = revisions[2].content.draft.observations.observations;
      expect(observations.find((o: { id: string }) => o.id === "clinical_chiefComplaint").value.text).toBe("شكوى اصطناعية محفوظة من المقابلة");
      expect((await authedGet(`${endpoint}?acceptSchema=1,2`, h.sessions.doctorB)).status).toBe(403);
      expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patientId])).rows[0]).toEqual({ invoices: 0, payments: 0, visits: 0 });
      expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await tooth.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" })); await page.screenshot({ path: `.settings-ui-artifacts/ortho-panoramic-review-${width}.png` });
      await page.route(`**/api/patients/${patientId}/documents`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic image source outage" }) }));
      await page.reload(); await workspace.getByText("تعذر تحميل أصل البانوراما؛ لم يُعتبر السجل فارغاً.", { exact: true }).waitFor();
      await review.getByLabel("صورة البانوراما", { exact: true }).selectOption(String(documents[0]));
      expect(await review.locator("img").count()).toBe(0); await review.getByRole("alert").filter({ hasText: "تعذّر التحقق من أصل الصورة" }).waitFor();
    } catch (error) {
      await writeFile(`.settings-ui-artifacts/ortho-panoramic-failure-${width}.txt`, await page.getByTestId("ortho-case-assessment-v2").ariaSnapshot());
      throw error;
    } finally { await context.close(); }
  });
  it("admits a newly uploaded original immediately without replacing an unfinished interview", async () => {
    const { patientId, orthoCaseId } = await setup();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" }); const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${orthoCaseId}&pillar=diagnostics`);
      await page.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
      await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).fill("مسودة مقابلة غير محفوظة أثناء رفع الصورة");
      await page.getByRole("button", { name: "الصور والأشعة", exact: true }).click();
      const chooser = page.waitForEvent("filechooser"); await page.getByTestId("ortho-record-slot-panoramic").getByRole("button", { name: "إضافة نسخة أخرى", exact: true }).click();
      const bytes = await sharp({ create: { width: 400, height: 180, channels: 3, background: "#58805c" } }).png().toBuffer();
      await (await chooser).setFiles({ name: "synthetic-new-panoramic.png", mimeType: "image/png", buffer: bytes });
      await page.getByLabel("عنوان صورة التقويم", { exact: true }).fill("بانوراما جديدة أثناء المقابلة"); await page.getByLabel("مرحلة صورة التقويم", { exact: true }).selectOption("unknown");
      await page.getByLabel("حالة تاريخ تصوير التقويم", { exact: true }).selectOption("unknown"); await page.getByLabel("مصدر صورة التقويم وتاريخها", { exact: true }).fill("مصدر اصطناعي جديد دون تاريخ معلوم");
      await page.getByRole("button", { name: "حفظ الصورة ومصدرها", exact: true }).click();
      const images = page.getByRole("region", { name: "قراءة البانوراما وربطها بالأسنان", exact: true }).getByLabel("صورة البانوراما", { exact: true });
      await expect.poll(() => images.locator("option").allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("بانوراما جديدة أثناء المقابلة")]));
      await images.selectOption({ label: (await images.locator("option").allTextContents()).find(label => label.includes("بانوراما جديدة أثناء المقابلة"))! });
      await page.getByRole("button", { name: "المقابلة والتاريخ", exact: true }).click(); expect(await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).inputValue()).toBe("مسودة مقابلة غير محفوظة أثناء رفع الصورة");
      expect((await db.query("SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [orthoCaseId])).rows[0].n).toBe(1);
    } finally { await context.close(); }
  });
});
