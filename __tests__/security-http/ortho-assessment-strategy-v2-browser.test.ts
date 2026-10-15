import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../lib/auth";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { baseUrl, harness, loginStaff, authedMutation, type Session } from "./_server";

let browser: Browser, db: Client;
beforeAll(async () => {
  const h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

async function seed(width: number) {
  const username = `syntheticorthov2${width}`;
  const user = (await db.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic Ortho recorder',$2,'admin') RETURNING id", [username, await hashPassword("SyntheticOrtho#Pass1")])).rows[0].id;
  const session = await loginStaff(username, "SyntheticOrtho#Pass1") as Session;
  const patient = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`SYN-UI-V2-${width}`, `حالة اصطناعية للتقييم ${width}`])).rows[0].id;
  const ortho = (await db.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [patient])).rows[0].id;
  const clinical = (await db.query("INSERT INTO clinical_cases(id,patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,$2,'orthodontics','Synthetic explicit bridge',$3,'synthetic') RETURNING id", [900000 + width, patient, ortho])).rows[0].id;
  expect(clinical).not.toBe(ortho); // Distinct numeric ids expose accidental aliasing.
  const problem = (await db.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'مشكلة اصطناعية موثقة','synthetic') RETURNING id", [patient, clinical])).rows[0].id;
  const command = assessmentCommandV2(); command.commandId = `synthetic_assessment_ui_${width}`;
  const response = await authedMutation(`/api/ortho/${ortho}/assessment`, session, "POST", JSON.stringify(command));
  expect(response.status).toBe(201);
  return { patient, ortho, clinical, problem, user, session };
}
const records = async (ortho: number) => (await db.query("SELECT id,version,command_id,content_sha256,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [ortho])).rows;
async function openAssessment(page: Page, patient: number) {
  await page.goto(`${baseUrl}/patients/${patient}?tab=treatment&sub=ortho`);
  await page.getByRole("button", { name: /السجلات والسيفالومتري/ }).click();
  await page.getByRole("button", { name: "فتح التقييم السريري والقياسات", exact: true }).click();
  await page.getByTestId("assessment-v2-saved").waitFor();
}

describe("existing linked episodes: real built assessment/strategy editors", () => {
  it.each([390, 1280])("saves/reopens, reconciles a lost response and keeps stale/denied edits isolated at %ipx", async width => {
    const scope = await seed(width), context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    const [name, ...value] = scope.session.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), stale = await context.newPage(), errors: string[] = [];
    for (const p of [page, stale]) { p.setDefaultTimeout(15000); p.on("pageerror", error => errors.push(error.message)); }
    const financeBefore = (await db.query("SELECT (SELECT COUNT(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT COUNT(*)::int FROM payments WHERE patient_id=$1) payments", [scope.patient])).rows;
    try {
      expect((await context.request.get(`${baseUrl}/api/auth/me`)).status()).toBe(200);
      await openAssessment(page, scope.patient); await openAssessment(stale, scope.patient);
      for (const p of [page, stale]) await p.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
      await page.getByLabel("سبب إنشاء هذه المراجعة").fill("تصحيح اصطناعي محفوظ من الواجهة");
      await stale.getByLabel("سبب إنشاء هذه المراجعة").fill("مسودة تبويب قديم تبقى دون نقل صامت");
      // Enter one clinical value once, choose two teeth for explicitly confirmed
      // session provenance, and reuse the same input across multiple analyses.
      await page.getByLabel("قيمة السن 11 (mm)", { exact: true }).fill("7.5");
      await page.getByRole("checkbox", { name: "اختيار السن 11 لجلسة القياس", exact: true }).check();
      await page.getByRole("checkbox", { name: "اختيار السن 12 لجلسة القياس", exact: true }).check();
      await page.getByRole("button", { name: "المصدر والتاريخ: السن 11", exact: true }).click();
      await page.getByLabel("إسناد منفذ الفحص", { exact: true }).fill("Synthetic shared measurement session");
      page.once("dialog", dialog => void dialog.accept());
      await page.getByRole("button", { name: "تطبيق مصدر الجلسة على 2 مدخلات مختارة", exact: true }).click();
      await page.getByRole("checkbox", { name: "Bolton أمامي", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "Bolton أمامي", exact: true }).check();
      const path = `${baseUrl}/api/ortho/${scope.ortho}/assessment`;
      await page.route(path, async route => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch(); expect(response.status()).toBe(201);
        await route.abort("failed"); // The real transaction committed; only its response is lost.
      });
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      await page.getByRole("button", { name: "التحقق بإعادة نفس طلب الحفظ", exact: true }).waitFor();
      const committed = await records(scope.ortho); expect(committed).toHaveLength(2);
      const content = committed[1].content;
      expect((await db.query("SELECT ortho_case_id,clinical_case_id FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [scope.ortho])).rows).toEqual([
        { ortho_case_id: scope.ortho, clinical_case_id: scope.clinical }, { ortho_case_id: scope.ortho, clinical_case_id: scope.clinical },
      ]);
      const observation = (id: string) => content.draft.observations.observations.filter((row: { id: string }) => row.id === id);
      expect(observation("width_11")).toHaveLength(1);
      expect(observation("width_11")[0].value).toEqual({ state: "measured", value: 7.5 });
      for (const id of ["width_11", "width_12"]) expect(observation(id)[0].provenance.performer.attribution).toBe("Synthetic shared measurement session");
      expect(observation("width_13")[0].provenance.performer.attribution).toBe("Synthetic examiner");
      expect(content.results).toHaveLength(4);
      const dependentResults = content.results.filter((entry: { result: { dependencyObservationIds: string[] } }) => entry.result.dependencyObservationIds.includes("width_11"));
      expect(dependentResults).toHaveLength(3); // upper space + both Bolton methods
      for (const entry of content.results) {
        expect(entry.result.state).toBe("ready"); expect(entry.result.witness.clinicalApproval).toBe("unapproved");
        expect(entry.result.witness.formula.engineVersion).toBe("ortho-model-2.1.0");
      }
      await page.unroute(path);
      await page.getByRole("button", { name: "التحقق بإعادة نفس طلب الحفظ", exact: true }).click();
      await expect.poll(async () => page.getByTestId("assessment-v2-saved").innerText()).toContain("نسخة 2");
      expect(await records(scope.ortho)).toEqual(committed);
      await stale.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      await stale.getByText("المراجعة السابقة لا تطابق الرأس الحالي.", { exact: true }).waitFor();
      expect(await stale.getByLabel("سبب إنشاء هذه المراجعة").inputValue()).toBe("مسودة تبويب قديم تبقى دون نقل صامت");
      expect(await records(scope.ortho)).toEqual(committed);
      await page.reload();
      await page.getByRole("button", { name: /السجلات والسيفالومتري/ }).click();
      await page.getByRole("button", { name: "فتح التقييم السريري والقياسات", exact: true }).click();
      await expect.poll(async () => page.getByTestId("assessment-v2-saved").innerText()).toContain("نسخة 2");
      await page.getByRole("button", { name: /خطة العلاج والميكانيكا/ }).click();
      const strategy = page.getByTestId("ortho-strategy-editor");
      await stale.getByRole("button", { name: /خطة العلاج والميكانيكا/ }).click();
      const staleStrategy = stale.getByTestId("ortho-strategy-editor");
      for (const editor of [strategy, staleStrategy]) {
        await editor.getByRole("button", { name: "بدء خطة الحالة من نموذج فارغ", exact: true }).click();
        await editor.getByRole("listbox", { name: "المشكلة", exact: true }).selectOption(String(scope.problem));
        await editor.getByLabel("الهدف (نص الطبيب)", { exact: true }).fill("هدف اصطناعي يراجعه الطبيب");
        await editor.getByLabel("الاستراتيجية (نص الطبيب)", { exact: true }).fill("استراتيجية موثقة دون تنفيذ آلي");
        await editor.getByLabel("سبب توثيق هذه النسخة (مطلوب)").fill("توثيق اصطناعي للاستراتيجية");
      }
      const strategyPath = `${baseUrl}/api/ortho/${scope.ortho}/strategy`;
      await page.route(strategyPath, async route => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch(); expect(response.status()).toBe(201);
        await route.abort("failed");
      });
      await strategy.getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true }).click();
      await strategy.getByRole("button", { name: "التحقق بإعادة نفس طلب الخطة", exact: true }).waitFor();
      const strategyRows = async () => (await db.query("SELECT id,command_id,request_fingerprint,rows FROM ortho_strategy_revisions WHERE ortho_case_id=$1 ORDER BY version", [scope.ortho])).rows;
      const strategyCommitted = await strategyRows(); expect(strategyCommitted).toHaveLength(1);
      expect((await db.query("SELECT ortho_case_id,clinical_case_id FROM ortho_strategy_revisions WHERE ortho_case_id=$1", [scope.ortho])).rows).toEqual([{ ortho_case_id: scope.ortho, clinical_case_id: scope.clinical }]);
      await page.unroute(strategyPath);
      await strategy.getByRole("button", { name: "التحقق بإعادة نفس طلب الخطة", exact: true }).click();
      await strategy.getByTestId("ortho-strategy-saved").waitFor();
      expect(await strategyRows()).toEqual(strategyCommitted);
      await staleStrategy.getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true }).click();
      await staleStrategy.getByText("تغيرت نسخة الخطة. أعد قراءتها قبل المراجعة.", { exact: true }).waitFor();
      expect(await staleStrategy.getByLabel("الاستراتيجية (نص الطبيب)", { exact: true }).inputValue()).toBe("استراتيجية موثقة دون تنفيذ آلي");
      expect(await strategyRows()).toEqual(strategyCommitted);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-v2-strategy-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: /السجلات والسيفالومتري/ }).click();
      // The existing owner retains its opened assessment across pillar remounts.
      await page.getByTestId("assessment-v2-saved").waitFor();
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-v2-assessment-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
      await page.getByLabel("سبب إنشاء هذه المراجعة").fill("رفض بعد سحب صلاحية الجلسة");
      await db.query("UPDATE users SET is_active=false WHERE id=$1", [scope.user]);
      await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).isEnabled().catch(() => false)).toBe(false);
      expect(await records(scope.ortho)).toEqual(committed);
      await staleStrategy.getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true }).click();
      await expect.poll(() => staleStrategy.getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true }).isEnabled().catch(() => false)).toBe(false);
      expect(await strategyRows()).toEqual(strategyCommitted);
      expect((await db.query("SELECT (SELECT COUNT(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT COUNT(*)::int FROM payments WHERE patient_id=$1) payments", [scope.patient])).rows).toEqual(financeBefore);
      expect(errors).toEqual([]);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-v2-authority-${width}.png`, fullPage: true });
    } catch (error) {
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-v2-failure-${width}.png`, fullPage: true });
      await writeFile(`.settings-ui-artifacts/ortho-v2-failure-${width}.txt`, await page.locator("body").innerText());
      throw error;
    } finally { await context.close(); }
  });
});
