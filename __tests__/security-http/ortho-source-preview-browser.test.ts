import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function measurement(page: Page, tooth: number, value: string, date: string, method: string, operator: string) {
  await page.getByRole("combobox", { name: `حالة السن ${tooth}`, exact: true }).selectOption("measured");
  await page.getByLabel(`قيمة السن ${tooth} (mm)`, { exact: true }).fill(value);
  await page.getByRole("button", { name: `المصدر والتاريخ: السن ${tooth}`, exact: true }).click();
  const metadata = page.getByRole("region", { name: "مصدر القياس وتاريخه", exact: true });
  await metadata.getByLabel("حالة تاريخ الفحص", { exact: true }).selectOption("known");
  await metadata.getByLabel("تاريخ الفحص المعلوم", { exact: true }).fill(date);
  await metadata.getByLabel("طريقة القياس", { exact: true }).selectOption("manual_record_measurement");
  await metadata.getByLabel("وصف طريقة القياس", { exact: true }).fill(method);
  await metadata.getByLabel("حالة منفذ الفحص", { exact: true }).selectOption("documented");
  await metadata.getByLabel("إسناد منفذ الفحص", { exact: true }).fill(operator);
}

describe("built measurement session provenance preview", () => {
  it.each([390, 1280])("reviews exact replacements, preserves cancel and opt-out, then saves one unchanged-value revision at %ipx", async width => {
    const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مراجعة مصادر قياس اصطناعية') RETURNING id", [`SYN-SOURCE-PREVIEW-${randomUUID()}`])).rows[0].id;
    const opened = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId,
      command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "اختبار اصطناعي لمراجعة مصادر القياس" } }));
    expect(opened.status).toBe(201); const { orthoCaseId } = await opened.json();
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [], writes: string[] = [];
    page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url()); });
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${orthoCaseId}&pillar=diagnostics`);
      await page.getByRole("button", { name: "إعداد ملف التقويم خطوة بخطوة", exact: true }).click();
      const step = page.getByLabel("خطوة إعداد ملف التقويم", { exact: true }); await step.selectOption("4");
      await page.getByRole("button", { name: "فتح التقييم السريري والقياسات", exact: true }).click();
      await page.getByRole("button", { name: "بدء تقييم غير معبأ", exact: true }).click();
      await measurement(page, 11, "7.5", "2026-10-01", "طريقة مصدر اصطناعية", "منفذ مصدر اصطناعي");
      await measurement(page, 12, "8.1", "2026-09-01", "طريقة سابقة اصطناعية", "منفذ سابق اصطناعي");
      await measurement(page, 13, "8.3", "2026-09-02", "طريقة مستبعدة اصطناعية", "منفذ مستبعد اصطناعي");
      for (const tooth of [12, 13]) await page.getByRole("checkbox", { name: `اختيار السن ${tooth} لجلسة القياس`, exact: true }).check();
      await page.getByRole("button", { name: "المصدر والتاريخ: السن 11", exact: true }).click();
      const preview = page.getByRole("region", { name: "مراجعة تطبيق مصدر الجلسة", exact: true }); await preview.waitFor();
      const reviewText = await preview.innerText();
      for (const expected of ["2026-10-01", "2026-09-01", "2026-09-02", "طريقة مصدر اصطناعية", "طريقة سابقة اصطناعية", "منفذ مصدر اصطناعي", "منفذ سابق اصطناعي"]) expect(reviewText).toContain(expected);
      expect(writes).toEqual([]);
      page.once("dialog", async dialog => { expect(dialog.type()).toBe("confirm"); await dialog.dismiss(); });
      await page.getByRole("button", { name: "تطبيق مصدر الجلسة على 2 مدخلات مختارة", exact: true }).click();
      expect(await page.getByRole("checkbox", { name: "اختيار السن 12 لجلسة القياس", exact: true }).isChecked()).toBe(true);
      expect(await page.getByRole("checkbox", { name: "اختيار السن 13 لجلسة القياس", exact: true }).isChecked()).toBe(true);
      expect(await preview.innerText()).toBe(reviewText); expect(writes).toEqual([]);
      await preview.getByRole("checkbox", { name: "إبقاء FDI 13 ضمن التطبيق", exact: true }).uncheck();
      expect(await page.getByRole("checkbox", { name: "اختيار السن 13 لجلسة القياس", exact: true }).isChecked()).toBe(false);
      expect(await preview.getByRole("checkbox").count()).toBe(1);
      await preview.scrollIntoViewIfNeeded();
      expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await preview.screenshot({ path: `.settings-ui-artifacts/ortho-source-preview-${width}.png` });
      page.once("dialog", dialog => void dialog.accept());
      await page.getByRole("button", { name: "تطبيق مصدر الجلسة على 1 مدخلات مختارة", exact: true }).click();
      for (const [tooth, number, date, method, operator] of [
        [12, "8.1", "2026-10-01", "طريقة مصدر اصطناعية", "منفذ مصدر اصطناعي"],
        [13, "8.3", "2026-09-02", "طريقة مستبعدة اصطناعية", "منفذ مستبعد اصطناعي"],
      ] as const) {
        expect(await page.getByLabel(`قيمة السن ${tooth} (mm)`, { exact: true }).inputValue()).toBe(number);
        await page.getByRole("button", { name: `المصدر والتاريخ: السن ${tooth}`, exact: true }).click();
        const metadata = page.getByRole("region", { name: "مصدر القياس وتاريخه", exact: true });
        expect(await metadata.getByLabel("تاريخ الفحص المعلوم", { exact: true }).inputValue()).toBe(date);
        expect(await metadata.getByLabel("وصف طريقة القياس", { exact: true }).inputValue()).toBe(method);
        expect(await metadata.getByLabel("إسناد منفذ الفحص", { exact: true }).inputValue()).toBe(operator);
      }
      await step.selectOption("1"); await step.selectOption("4");
      expect(await page.getByLabel("قيمة السن 12 (mm)", { exact: true }).inputValue()).toBe("8.1");
      expect(writes).toEqual([]);
      await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("توثيق اصطناعي بعد مراجعة المصدر والاستبعاد");
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      await page.getByText("حُفظت مراجعة موثقة؛ جارٍ إعادة قراءة القيم والنتائج المحفوظة.", { exact: true }).waitFor();
      const revisions = (await db.query("SELECT content FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [orthoCaseId])).rows;
      expect(revisions).toHaveLength(1);
      const rows = revisions[0].content.draft.observations.observations as Array<{ id: string; value: unknown; occurredOn: unknown; provenance: { method: { description: string }; performer: { attribution: string } } }>;
      const target = rows.find(row => row.id === "width_12")!, excluded = rows.find(row => row.id === "width_13")!;
      expect(target.value).toEqual({ state: "measured", value: 8.1 }); expect(target.occurredOn).toEqual({ state: "known", date: "2026-10-01" });
      expect(target.provenance.method.description).toBe("طريقة مصدر اصطناعية"); expect(target.provenance.performer.attribution).toBe("منفذ مصدر اصطناعي");
      expect(excluded.value).toEqual({ state: "measured", value: 8.3 }); expect(excluded.occurredOn).toEqual({ state: "known", date: "2026-09-02" });
      expect(excluded.provenance.method.description).toBe("طريقة مستبعدة اصطناعية");
      expect(writes).toEqual([`${baseUrl}/api/ortho/${orthoCaseId}/assessment`]);
      expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patientId])).rows[0]).toEqual({ invoices: 0, payments: 0, visits: 0 });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
