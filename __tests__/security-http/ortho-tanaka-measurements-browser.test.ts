import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import { authedMutation, baseUrl, harness } from "./_server";
let db: Client, browser: Browser, h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function open(page: Page, patient: number) {
  await page.goto(`${baseUrl}/patients/${patient}?tab=treatment&sub=ortho`);
  await page.getByRole("button", { name: /السجلات والسيفالومتري/ }).click();
  await page.getByRole("button", { name: "الموديلات والقياسات", exact: true }).click();
  await page.getByTestId("assessment-v2-saved").waitFor();
  await page.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
}
describe("shared mixed dentition measurements in the built application", () => {
  it.each([390, 1280])("selects, corrects, saves and restores upper/lower estimates at%ipx", async width => {
    const patient = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`SYN-TANAKA-${randomUUID()}`, `تقدير مسافة اصطناعي ${width}`])).rows[0].id;
    const ortho = (await db.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patient])).rows[0].id;
    await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic mixed model bridge',$2,'synthetic')", [patient, ortho]);
    const initial = tanakaCommandV2(); initial.commandId = randomUUID(); initial.content.analyses = [];
    expect((await authedMutation(`/api/ortho/${ortho}/assessment`, h.sessions.admin, "POST", JSON.stringify(initial))).status).toBe(201);
    const stored = async () => (await db.query("SELECT id,version,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [ortho])).rows;
    const original = (await stored())[0]; expect(original.content.verifierVersion).toBe("ortho-assessment-payload-2.1.0");
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), stale = await context.newPage(), errors: string[] = [];
    for (const p of [page, stale]) { p.setDefaultTimeout(15000); p.on("pageerror", error => errors.push(error.message)); }
    const upperName = "Tanaka–Johnston — مسافة الفك العلوي المختلط", lowerName = "Tanaka–Johnston — مسافة الفك السفلي المختلط";
    const upperResult = () => page.getByText("Tanaka–Johnston: تقدير المسافة المختلطة · الفك العلوي", { exact: true }).locator("..");
    const lowerResult = () => page.getByText("Tanaka–Johnston: تقدير المسافة المختلطة · الفك السفلي", { exact: true }).locator("..");
    try {
      await open(page, patient); await open(stale, patient);
      await page.getByRole("checkbox", { name: upperName, exact: true }).check();
      await page.getByRole("checkbox", { name: lowerName, exact: true }).check();
      expect(await upperResult().innerText()).toContain("المطلوب المقدّر 74 mm");
      expect(await lowerResult().innerText()).toContain("المطلوب المقدّر 65 mm");
      await page.getByLabel("قيمة السن 11 (mm)", { exact: true }).fill("");
      expect(await upperResult().innerText()).toContain("قياس السن 11 غير مكتمل");
      expect(await lowerResult().innerText()).toContain("المطلوب المقدّر 65 mm");
      await page.getByLabel("قيمة السن 11 (mm)", { exact: true }).fill("9");
      expect(await upperResult().innerText()).toContain("المطلوب المقدّر 75 mm");
      await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("Synthetic upper incisor corrected once for shared analysis");
      const wrote = page.waitForResponse(r => r.url().endsWith(`/api/ortho/${ortho}/assessment`) && r.request().method() === "POST");
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click(); expect((await wrote).status()).toBe(201);
      await expect.poll(async () => page.getByTestId("assessment-v2-saved").innerText()).toContain("نسخة 2");
      const saved = await stored(); expect(saved).toHaveLength(2); expect(saved[0]).toEqual(original);
      expect(saved[1].content.verifierVersion).toBe("ortho-assessment-payload-2.2.0");
      expect(saved[1].content.draft.observations.observations).toHaveLength(35);
      expect(saved[1].content.draft.observations.observations.filter((r: { id: string }) => r.id === "width_11")).toHaveLength(1);
      expect(saved[1].content.results).toHaveLength(2);
      expect(saved[1].content.results[0].result.witness.result.estimatedRequiredMm).toBe(75);
      expect(saved[1].content.results[1].result.witness.result.estimatedRequiredMm).toBe(65);
      await stale.getByRole("checkbox", { name: upperName, exact: true }).check();
      await stale.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("Synthetic stale tab keeps its entered value");
      const refused = stale.waitForResponse(r => r.url().endsWith(`/api/ortho/${ortho}/assessment`) && r.request().method() === "POST");
      await stale.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click(); expect((await refused).status()).toBe(409);
      await stale.getByText("المراجعة السابقة لا تطابق الرأس الحالي.", { exact: true }).waitFor();
      expect(await stale.getByLabel("قيمة السن 11 (mm)", { exact: true }).inputValue()).toBe("8");
      expect(await stored()).toEqual(saved);
      expect((await authedMutation(`/api/ortho/${ortho}/assessment`, h.sessions.reception, "POST", JSON.stringify({ ...tanakaCommandV2(), commandId: randomUUID(), expectedRevisionId: saved[1].id }))).status).toBe(403);
      await open(page, patient);
      expect(await page.getByRole("checkbox", { name: upperName, exact: true }).isChecked()).toBe(true);
      expect(await page.getByRole("checkbox", { name: lowerName, exact: true }).isChecked()).toBe(true);
      expect(await upperResult().innerText()).toContain("المطلوب المقدّر 75 mm");
      expect(await lowerResult().innerText()).toContain("المطلوب المقدّر 65 mm");
      await upperResult().scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-tanaka-shared-${width}.png` });
      expect((await db.query("SELECT count(*)::int n FROM patient_problems WHERE patient_id=$1", [patient])).rows).toEqual([{ n: 0 }]);
      expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments", [patient])).rows).toEqual([{ invoices: 0, payments: 0 }]);
      expect(errors).toEqual([]);
    } catch (error) { await page.screenshot({ path: `.settings-ui-artifacts/ortho-tanaka-failure-${width}.png`, fullPage: true }); throw error; }
    finally { await context.close(); }
  });
});
