import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * (ENDO-4) رحلة علاج الجذور في المتصفح على التطبيق المبني وقاعدةٍ حقيقية معزولة:
 * الطبيب يفتح سنّ ٣٦، يسجّل التشخيص والقنوات وأطوالها العاملة، تُحفظ وتبقى بعد إعادة التحميل؛ زيارةٌ ثانية
 * تحشو القنوات؛ التوقيع يجمّد السجل وملحقٌ يضاف؛ التاج بعد الإكمال؛ والاستقبال يقرأ ولا يكتب.
 */

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let doctorParty = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  doctorParty = doctor.party_id;
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض رحلة العصب', $2) RETURNING id`,
    [`EU-${stamp}`, doctorParty]);
  patientId = patient.id;
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

const newVisit = async () => (await db.query<{ id: number }>(
  `INSERT INTO visits (patient_name, patient_id, doctor_id, status) VALUES ('مريض رحلة العصب', $1, $2, 'in_chair') RETURNING id`,
  [patientId, doctorParty])).rows[0].id;
const sign = (visitId: number) => db.query(`UPDATE visits SET signed_at = NOW(), signed_by = 'secdoctora' WHERE id = $1`, [visitId]);

async function open(who: "doctorA" | "reception"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("patient-endo").waitFor();
  return { context, page };
}

describe("ENDO-4 — endodontic chairside journey", () => {
  let visit1 = 0;
  let visit2 = 0;

  it("doctor opens tooth 36, records diagnosis + canals + working lengths; it survives a reload", async () => {
    visit1 = await newVisit();
    const { context, page } = await open("doctorA");
    await page.getByTestId("endo-new").click();
    await page.getByTestId("endo-tooth").selectOption("36");
    await page.getByTestId("endo-open-save").click(); // no case yet → an endodontics case is opened through the existing case model
    await page.getByTestId("endo-tooth-36").waitFor();
    expect(await page.getByTestId("endo-next").innerText()).toContain("ابدأ بالتقييم");

    await page.getByTestId("endo-record").click();
    await page.getByTestId("endo-pulpal").selectOption("pulp_necrosis");
    await page.getByTestId("endo-apical").selectOption("chronic_apical_abscess");
    // canals are suggested from the FDI tooth (MB, ML, D) — the doctor measures them
    expect(await page.locator('[data-testid^="endo-canal-label-"]').count()).toBe(3);
    await page.getByTestId("endo-canal-wl-0").fill("20.5");
    await page.getByTestId("endo-canal-ref-0").selectOption("cusp_tip");
    await page.getByTestId("endo-canal-method-0").selectOption("both");
    await page.getByTestId("endo-next-step").fill("تشكيل القنوات");
    await page.getByTestId("endo-save").click();
    await page.getByTestId("endo-sessions").waitFor();

    const strip = page.getByTestId("endo-strip");
    expect(await strip.getByTestId("endo-strip-dx").innerText()).toContain("موت اللبّ");
    expect(await strip.getByTestId("endo-strip-wl").innerText()).toContain("MB 20.5");
    await context.close();

    // durable: a fresh browser session reads the same record from the database
    const again = await open("doctorA");
    expect(await again.page.getByTestId("endo-strip-dx").innerText()).toContain("موت اللبّ");
    expect(await again.page.getByTestId("endo-strip-wl").innerText()).toContain("MB 20.5");
    expect(await again.page.getByTestId("endo-sessions").innerText()).toContain("مفتوحة");
    await again.context.close();
  });

  it("after sign-off the session is frozen; a correction is an addendum that keeps the original", async () => {
    await sign(visit1);
    const { context, page } = await open("doctorA");
    expect(await page.getByTestId("endo-sessions").innerText()).toContain("موقَّعة");
    await page.getByTestId(`endo-addendum-open-${await endoVisitId(visit1)}`).click();
    await page.getByTestId("endo-addendum-text").fill("تصحيح: الطول العامل لـ MB ٢٠٫٥ مم بالمحدّد");
    await page.getByTestId("endo-addendum-save").click();
    await page.getByTestId("endo-addendum").waitFor();
    const sessions = await page.getByTestId("endo-sessions").innerText();
    expect(sessions).toContain("تصحيح: الطول العامل");
    expect(sessions).toContain("موت اللبّ"); // the original record is untouched
    await context.close();
  });

  it("second visit: obturation + temporary restoration; crown decision; completion; crown becomes the next step", async () => {
    visit2 = await newVisit();
    const { context, page } = await open("doctorA");
    await page.getByTestId("endo-record").click();
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) {
        await page.getByTestId(`endo-canal-wl-${index}`).fill(String(19 + index));
        await page.getByTestId(`endo-canal-ref-${index}`).selectOption("cusp_tip");
        await page.getByTestId(`endo-canal-method-${index}`).selectOption("apex_locator");
      }
      await page.getByTestId(`endo-canal-obt-${index}`).check();
    }
    await page.getByTestId("endo-restoration").selectOption("temporary");
    await page.getByTestId("endo-stage").selectOption("obturation");
    await page.getByTestId("endo-save").click();
    await page.getByTestId("endo-form").waitFor({ state: "detached" });
    expect(await page.getByTestId("endo-sessions").locator("li").count()).toBe(2);

    // completion is refused while a record is unsigned (Arabic message from the server)
    await page.getByTestId("endo-complete").click();
    await page.getByTestId("endo-close-confirm").click();
    expect(await page.getByTestId("endo-error").innerText()).toContain("وقّع زيارة العلاج");

    await sign(visit2);
    await context.close();
    const second = await open("doctorA");
    await second.page.getByTestId("endo-crown-required").selectOption("yes");
    await second.page.getByTestId("endo-crown-state").filter({ hasText: "التاج بعد اكتمال علاج الجذور" }).waitFor();
    await second.page.getByTestId("endo-complete").click();
    await second.page.getByTestId("endo-close-confirm").click();
    await second.page.getByTestId("endo-crown-state").filter({ hasText: "التاج مطلوب" }).waitFor();
    expect(await second.page.getByTestId("endo-next").innerText()).toContain("إحالة السن للتاج");
    expect(await second.page.getByTestId("endo-strip-status").innerText()).toContain("مكتمل");
    await second.context.close();
  });

  it("reception reads the record but has no write controls; and no money appears anywhere", async () => {
    const { context, page } = await open("reception");
    expect(await page.getByTestId("endo-strip").innerText()).toContain("مكتمل");
    expect(await page.getByTestId("endo-new").count()).toBe(0);
    expect(await page.getByTestId("endo-record").count()).toBe(0);
    expect(await page.getByTestId("endo-complete").count()).toBe(0);
    expect(await page.getByTestId("patient-endo").innerText()).not.toMatch(/ريال|YER|SAR|USD/);
    await context.close();
  });
});

async function endoVisitId(visitId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM endo_visits WHERE visit_id = $1`, [visitId]);
  return rows[0].id;
}
