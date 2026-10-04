import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
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
async function expand(page: Page, testId: string) {
  const detail = page.getByTestId(testId);
  if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
}

async function signThroughUi(page: Page, visitId: number) {
  await page.goto(`${baseUrl}/patients/${patientId}?tab=today`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
  const review = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة" });
  await review.waitFor();
  // Closing review is a real cancellation: it must not sign the visit.
  await review.getByRole("button", { name: "رجوع — أكمل العمل" }).click();
  expect((await db.query(`SELECT signed_at FROM visits WHERE id = $1`, [visitId])).rows[0].signed_at).toBeNull();
  await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
  const signedResponse = page.waitForResponse((res) => res.url().endsWith(`/api/visits/${visitId}/clinical`)
    && res.request().method() === "POST" && res.request().postDataJSON()?.action === "sign");
  await review.getByRole("button", { name: /وقّع الزيارة|تأكيد إنهاء الزيارة/ }).click();
  const signed = await signedResponse;
  expect(signed.status()).toBe(200);
  expect((await signed.json()).invoiceId).toBeNull();
  expect((await db.query(`SELECT signed_at FROM visits WHERE id = $1`, [visitId])).rows[0].signed_at).not.toBeNull();
  expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
}


async function refuseEmptySignThroughUi(page: Page, visitId: number) {
  await page.goto(`${baseUrl}/patients/${patientId}?tab=today`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
  const review = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة" });
  await review.waitFor();
  const response = page.waitForResponse((res) => res.url().endsWith(`/api/visits/${visitId}/clinical`)
    && res.request().method() === "POST" && res.request().postDataJSON()?.action === "sign");
  await review.getByRole("button", { name: /وقّع الزيارة|تأكيد إنهاء الزيارة/ }).click();
  const refused = await response;
  expect(refused.status()).toBe(409);
  expect((await refused.json()).message).toContain("سجّل إجراءً أو تشخيصًا");
  expect((await db.query(`SELECT signed_at FROM visits WHERE id = $1`, [visitId])).rows[0].signed_at).toBeNull();
  expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
  await review.getByRole("button", { name: "رجوع — أكمل العمل" }).click();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("patient-endo").waitFor();
}

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
    let refused = false;
    await page.route(`**/api/patients/${patientId}/endo`, async (route) => {
      if (route.request().method() === "POST" && !refused) {
        refused = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّر فتح العلاج تجريبيًا" }) });
      } else await route.continue();
    });
    let caseResponseLost = false;
    await page.route(`**/api/patients/${patientId}/cases`, async (route) => {
      if (route.request().method() === "POST" && !caseResponseLost) {
        caseResponseLost = true;
        // The real case POST commits; only its response to the browser is lost.
        const committed = await route.fetch(); expect(committed.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await page.getByTestId("endo-open-save").click();
    await page.getByTestId("endo-error").waitFor();
    const caseCount = async () => (await db.query(`SELECT id FROM clinical_cases WHERE patient_id = $1`, [patientId])).rows.length;
    expect(await caseCount()).toBe(1);
    expect(await page.getByTestId("endo-open-save").isDisabled()).toBe(true);
    await page.getByRole("button", { name: "إعادة التحميل", exact: true }).click();
    const { rows: [savedCase] } = await db.query(`SELECT id FROM clinical_cases WHERE patient_id = $1`, [patientId]);
    await page.getByTestId("endo-case").locator(`option[value="${savedCase.id}"]`).waitFor({ state: "attached" });
    await page.getByTestId("endo-case").selectOption(String(savedCase.id));
    await page.getByTestId("endo-open-save").click(); // first episode POST is deliberately rejected
    await page.getByTestId("endo-error").filter({ hasText: "تعذّر فتح العلاج تجريبيًا" }).waitFor();
    expect(await caseCount()).toBe(1);
    expect(await page.getByTestId("endo-case").inputValue()).toBe(String(savedCase.id));
    await page.getByTestId("endo-open-save").click(); // both retries reuse the committed case
    await page.getByTestId("endo-tooth-36").waitFor();
    expect(await page.getByTestId("endo-next").innerText()).toContain("ابدأ بالتقييم");
    expect(await caseCount()).toBe(1);

    // Three real UI saves remain unsigned: empty row, stage-only, and suggested canal labels.
    await page.getByTestId("endo-record").click();
    await expand(page, "endo-canal-editor");
    while (await page.getByRole("button", { name: "حذف القناة", exact: true }).count()) {
      await page.getByRole("button", { name: "حذف القناة", exact: true }).first().click();
    }
    await page.getByTestId("endo-save").click();
    await page.getByTestId("endo-form").waitFor({ state: "detached" });
    await refuseEmptySignThroughUi(page, visit1);
    await page.getByTestId("endo-record").click();
    await page.getByTestId("endo-stage").selectOption("shaping");
    await page.getByTestId("endo-save").click();
    await page.getByTestId("endo-form").waitFor({ state: "detached" });
    await refuseEmptySignThroughUi(page, visit1);
    await page.getByTestId("endo-record").click();
    await page.getByTestId("endo-stage").selectOption("assessment");
    await expand(page, "endo-canal-editor");
    for (const [index, canal] of ["MB", "ML", "D"].entries()) {
      await page.getByRole("button", { name: "+ قناة", exact: true }).click();
      await page.getByTestId(`endo-canal-label-${index}`).fill(canal);
    }
    await page.getByTestId("endo-save").click();
    await page.getByTestId("endo-form").waitFor({ state: "detached" });
    await refuseEmptySignThroughUi(page, visit1);

    await page.getByTestId("endo-record").click();
    await page.getByTestId("endo-pulpal").selectOption("pulp_necrosis");
    await page.getByTestId("endo-apical").selectOption("chronic_apical_abscess");
    await expand(page, "endo-canal-editor");
    // canals are suggested from the FDI tooth (MB, ML, D) — the doctor measures them
    expect(await page.locator('[data-testid^="endo-canal-label-"]').count()).toBe(3);
    await page.getByTestId("endo-canal-wl-0").fill("20.5");
    await page.getByTestId("endo-canal-ref-0").selectOption("cusp_tip");
    await page.getByTestId("endo-canal-method-0").selectOption("both");
    await page.getByTestId("endo-next-step").fill("تشكيل القنوات");
    let releaseSave!: () => void;
    const pausedSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    let reachedSave!: () => void;
    const savingStarted = new Promise<void>((resolve) => { reachedSave = resolve; });
    await page.route(`**/api/patients/${patientId}/endo/*/visits`, async (route) => {
      if (route.request().method() === "PUT") { reachedSave(); await pausedSave; }
      await route.continue();
    });
    await page.getByTestId("endo-save").click();
    await page.waitForFunction(() => document.querySelector<HTMLFieldSetElement>('[data-testid="patient-endo"]')?.disabled === true);
    await savingStarted;
    expect(await page.getByTestId("endo-next-step").isDisabled()).toBe(true);
    expect(await page.getByTestId("endo-new").isDisabled()).toBe(true);
    releaseSave();
    await page.getByTestId("endo-form").waitFor({ state: "detached" });
    await expand(page, "endo-history");
    await page.getByTestId("endo-sessions").waitFor();

    const strip = page.getByTestId("endo-strip");
    expect(await strip.getByTestId("endo-strip-dx").innerText()).toContain("موت اللبّ");
    expect(await strip.getByTestId("endo-strip-wl").innerText()).toContain("MB 20.5");
    await context.close();

    // durable: a fresh browser session reads the same record from the database
    const again = await open("doctorA");
    expect(await again.page.getByTestId("endo-strip-dx").innerText()).toContain("موت اللبّ");
    expect(await again.page.getByTestId("endo-strip-wl").innerText()).toContain("MB 20.5");
    await expand(again.page, "endo-history");
    expect(await again.page.getByTestId("endo-sessions").innerText()).toContain("مفتوحة");
    await again.page.getByTestId("endo-history").locator(":scope > summary").click();
    await mkdir(".settings-ui-artifacts", { recursive: true });
    for (const width of [1280, 390]) {
      await again.page.setViewportSize({ width, height: 1100 });
      expect(await again.page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await again.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await again.page.screenshot({ path: `.settings-ui-artifacts/endodontics-cockpit-${width}.png`, fullPage: true });
    }
    await again.context.close();
  });

  it("after sign-off the session is frozen; a correction is an addendum that keeps the original", async () => {
    const { context, page } = await open("doctorA");
    await signThroughUi(page, visit1);
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("patient-endo").waitFor();
    await expand(page, "endo-history");
    expect(await page.getByTestId("endo-sessions").innerText()).toContain("موقَّعة");
    await page.getByTestId(`endo-addendum-open-${await endoVisitId(visit1)}`).click();
    await page.getByTestId("endo-addendum-text").fill("تصحيح: الطول العامل لـ MB ٢٠٫٥ مم بالمحدّد");
    await page.getByTestId("endo-addendum-save").click();
    await page.getByTestId("endo-addendum-text").waitFor({ state: "detached" });
    await expand(page, "endo-history");
    await page.getByTestId("endo-addendum").waitFor();
    const sessions = await page.getByTestId("endo-sessions").innerText();
    expect(sessions).toContain("تصحيح: الطول العامل");
    expect(sessions).toContain("موت اللبّ"); // the original record is untouched
    await context.close();
  });

  it("second visit: obturation, temporary then permanent core; required crown remains the next step", async () => {
    visit2 = await newVisit();
    const { context, page } = await open("doctorA");
    await page.getByTestId("endo-record").click();
    await page.getByTestId("endo-stage").selectOption("obturation");
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
    // A permanent core/filling is separate from completing a required crown.
    await page.getByTestId("endo-record").click();
    await page.getByTestId("endo-restoration").selectOption("permanent");
    await page.getByTestId("endo-save").click();
    await page.getByTestId("endo-form").waitFor({ state: "detached" });
    expect(await page.getByTestId("endo-strip-status").innerText()).toContain("ترميم دائم");

    // completion is refused while a record is unsigned (Arabic message from the server)
    await expand(page, "endo-completion");
    await page.getByTestId("endo-complete").click();
    await page.getByTestId("endo-close-confirm").click();
    await page.getByTestId("endo-error").filter({ hasText: "وقّع زيارة العلاج" }).waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "رجوع", exact: true }).click();
    await signThroughUi(page, visit2);
    await context.close();
    const second = await open("doctorA");
    await expand(second.page, "endo-completion");
    await second.page.getByTestId("endo-crown-required").selectOption("yes");
    await second.page.getByTestId("endo-crown-state").filter({ hasText: "التاج بعد اكتمال علاج الجذور" }).waitFor();
    await second.page.getByTestId("endo-complete").click();
    await second.page.getByTestId("endo-close-confirm").click();
    await second.page.getByTestId("endo-close-confirm").waitFor({ state: "detached" });
    await expand(second.page, "endo-completion");
    await second.page.getByTestId("endo-crown-state").filter({ hasText: "مكتمل سريريًا" }).waitFor();
    expect(await second.page.getByTestId("endo-next").innerText()).toContain("إحالة السن للتاج");
    expect(await second.page.getByTestId("endo-strip-status").innerText()).toContain("مكتمل");
    await second.context.close();
  });

  it("links an explicit same-case RCT prerequisite to the crown through the existing plan engine", async () => {
    const { rows: [episode] } = await db.query(`SELECT id, case_id FROM endo_treatments WHERE patient_id = $1 AND tooth_code = 36`, [patientId]);
    const { rows: [plan] } = await db.query(`INSERT INTO treatment_plans (patient_id, title, total_minor, status)
      VALUES ($1, 'خطة تاج تجريبية', 0, 'active') RETURNING id`, [patientId]);
    const { rows: [rct] } = await db.query(`INSERT INTO plan_items (plan_id, service_name, category, tooth_code, case_id)
      VALUES ($1, 'علاج جذور تجريبي', 'rct', 36, $2) RETURNING id`, [plan.id, episode.case_id]);
    const { rows: [crown] } = await db.query(`INSERT INTO plan_items (plan_id, service_name, category, tooth_code)
      VALUES ($1, 'تاج تجريبي', 'crown', 36) RETURNING id`, [plan.id]);
    const { context, page } = await open("doctorA");
    await expand(page, "endo-completion");
    const candidates = await page.getByTestId("endo-crown-item").locator("option").allTextContents();
    expect(candidates.join(" ")).toContain("تاج تجريبي"); expect(candidates.join(" ")).not.toContain("علاج جذور تجريبي");
    await page.getByTestId("endo-crown-item").selectOption(String(crown.id));
    expect(await page.getByTestId("endo-crown-link").isDisabled()).toBe(true);
    await page.getByTestId("endo-rct-item").selectOption(String(rct.id));
    await page.getByTestId("endo-crown-link").click();
    await page.getByTestId("endo-crown-link").waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[data-testid="endo-crown-item"]')?.value === "");
    await expand(page, "endo-completion");
    await page.getByText("مرتبط ببند: تاج تجريبي", { exact: true }).waitFor();
    expect((await db.query(`SELECT item_id, requires_item_id, requirement FROM plan_item_dependencies WHERE item_id = $1`, [crown.id])).rows)
      .toEqual([{ item_id: crown.id, requires_item_id: rct.id, requirement: "completed" }]);
    // Projection fixture: only the persisted canonical crown item's done state means crown completion.
    // This is not a claim that the prosthodontic procedure/billing flow ran in this test.
    await db.query(`UPDATE plan_items SET status = 'done' WHERE id = $1`, [crown.id]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expand(page, "endo-completion");
    await page.getByTestId("endo-crown-state").filter({ hasText: "التاج مكتمل" }).waitFor();
    const { rows: [user] } = await db.query<{ permissions: string | null }>(`SELECT permissions FROM users WHERE username = 'secdoctora'`);
    const permissions = { ...JSON.parse(user.permissions ?? "{}"), canViewPlans: false, canEditPlans: false };
    await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [JSON.stringify(permissions)]);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("patient-endo").waitFor();
      await expand(page, "endo-completion");
      const hidden = await page.getByTestId("patient-endo").innerText();
      expect(hidden).not.toContain("تاج تجريبي"); expect(hidden).not.toContain("التاج مكتمل");
      expect(await page.getByTestId("endo-crown-item").count()).toBe(0);
      expect(await page.getByTestId("endo-next").innerText()).toContain("إحالة السن للتاج");
    } finally {
      await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [user.permissions]);
      await context.close();
    }
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

  it("keeps quick entry compact on mobile, preserves optional fields and retries the same draft", async () => {
    const { rows: [patient] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض إدخال مختصر', $2) RETURNING id`,
      [`EU-QUICK-${stamp}`, doctorParty]);
    const { rows: [visit] } = await db.query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, doctor_id, status) VALUES ('مريض إدخال مختصر', $1, $2, 'in_chair') RETURNING id`,
      [patient.id, doctorParty]);
    const { context, page } = await open("doctorA");
    try {
      await page.goto(`${baseUrl}/patients/${patient.id}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("endo-new").click(); await page.getByTestId("endo-tooth").selectOption("36");
      await page.getByTestId("endo-open-save").click(); await page.getByTestId("endo-record").click();
      expect(await page.getByTestId("endo-form").locator("input:visible,select:visible,textarea:visible").count()).toBe(6);
      await page.getByTestId("endo-note").fill("توثيق عمل الجلسة التجريبي");
      await page.getByTestId("endo-next-step").fill("مراجعة");
      await page.getByTestId("endo-next-step").press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("endo-save");
      await mkdir(".settings-ui-artifacts", { recursive: true });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 1100 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `.settings-ui-artifacts/endodontics-cockpit-${width}.png`, fullPage: true });
      }
      await expand(page, "endo-assessment-more");
      await page.getByTestId("endo-radiographicFindings").fill("موجودات شعاعية تجريبية محفوظة");
      await page.getByTestId("endo-stage").selectOption("shaping");
      await page.getByTestId("endo-canal-wl-0").fill("20.5");
      await page.getByTestId("endo-canal-ref-0").selectOption("cusp_tip");
      await page.getByTestId("endo-canal-method-0").selectOption("both");
      await expand(page, "endo-canal-more-0"); await page.getByTestId("endo-canal-note-0").fill("ملاحظة قناة محفوظة");
      await page.getByTestId("endo-stage").selectOption("medicament");
      expect(await page.getByTestId("endo-form").locator("input:visible,select:visible,textarea:visible").count()).toBe(5);
      await page.getByTestId("endo-medicament").fill("دواء مسجّل صراحة");
      let fail = true;
      const submitted: unknown[] = [];
      await page.route(`**/api/patients/${patient.id}/endo/*/visits`, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        submitted.push(route.request().postDataJSON());
        if (fail) { fail = false; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "إعادة محاولة تجريبية" }) }); }
        return route.continue();
      });
      await page.getByTestId("endo-save").click(); await page.getByTestId("endo-error").waitFor();
      expect(await page.getByTestId("endo-note").inputValue()).toBe("توثيق عمل الجلسة التجريبي");
      await page.getByTestId("endo-save").click(); await page.getByTestId("endo-form").waitFor({ state: "detached" });
      expect(submitted).toHaveLength(2); expect(submitted[0]).toEqual(submitted[1]);
      await page.reload({ waitUntil: "domcontentloaded" }); await expand(page, "endo-history");
      const savedId = (await db.query<{ id: number }>(`SELECT id FROM endo_visits WHERE visit_id=$1`, [visit.id])).rows[0].id;
      await expand(page, `endo-record-details-${savedId}`);
      expect(await page.getByTestId("endo-history").innerText()).toContain("موجودات شعاعية تجريبية محفوظة");
      expect(await page.getByTestId("endo-history").innerText()).toContain("ملاحظة قناة محفوظة");
      await page.getByTestId("endo-record").click(); await page.getByTestId("endo-stage").selectOption("obturation");
      expect(await page.getByTestId("endo-canal-obt-0").isChecked()).toBe(false);
      await page.getByTestId("endo-stage").selectOption("review"); await page.getByTestId("endo-save").click();
      await page.getByTestId("endo-form").waitFor({ state: "detached" });
      const { rows: [saved] } = await db.query(`SELECT e.radiographic_findings, c.working_length_mm, c.note, c.obturated
        FROM endo_visits e JOIN endo_canal_records c ON c.endo_visit_id=e.id WHERE e.visit_id=$1 AND c.canal_label='MB'`, [visit.id]);
      expect(saved.radiographic_findings).toBe("موجودات شعاعية تجريبية محفوظة");
      expect(Number(saved.working_length_mm)).toBe(20.5); expect(saved.note).toBe("ملاحظة قناة محفوظة"); expect(saved.obturated).toBe(false);
      expect((await db.query(`SELECT signed_at FROM visits WHERE id=$1`, [visit.id])).rows[0].signed_at).toBeNull();
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id=$1`, [patient.id])).rows).toHaveLength(0);
    } finally { await context.close(); }
  });
});

describe("ENDO reference reads in the real patient file", () => {
  it.each([1280, 390])("retires denied references before stalled cases, then restores the same draft without a write at %ipx", async width => {
    // Actual isolated patient/case/visit reads, with only bounded fault responses
    // substituted. No financial endpoint or signed clinical history is altered.
    expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
    expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
    const { rows: [patient] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض سلامة مرجع العصب التجريبي', $2) RETURNING id`,
      [`EU-READ-${stamp}-${width}`, doctorParty]);
    const { rows: [visit] } = await db.query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, doctor_id, status) VALUES ('مريض سلامة مرجع العصب التجريبي', $1, $2, 'in_chair') RETURNING id`,
      [patient.id, doctorParty]);
    const { rows: [caseRow] } = await db.query<{ id: number }>(
      `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'endodontics', 'حالة جذور تجريبية للمرجع', 'secdoctora') RETURNING id`, [patient.id]);
    await db.query(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'secdoctora')`, [patient.id, caseRow.id]);
    const before = async () => (await db.query(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]') FROM endo_visits e WHERE e.visit_id=$2) AS records,
      (SELECT COALESCE(jsonb_agg(to_jsonb(v)), '[]') FROM visits v WHERE v.id=$2) AS visit,
      (SELECT COALESCE(jsonb_agg(to_jsonb(i)), '[]') FROM invoices i WHERE i.patient_id=$1) AS invoices,
      (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]') FROM payments p WHERE p.patient_id=$1) AS payments`, [patient.id, visit.id])).rows;
    const originalRows = await before();
    const { context, page } = await open("doctorA");
    const pendingCases: Route[] = []; const writes: string[] = []; const errors: string[] = [];
    let markCaseStarted!: () => void;
    const caseStarted = new Promise<void>(resolve => { markCaseStarted = resolve; });
    let deny = false; let failCases = false;
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/api/**", async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(`${request.method()} ${path}`);
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "فشل حفظ تجريبي؛ المسودة محفوظة" }) });
      } else if (path === `/api/patients/${patient.id}/endo` && deny) {
        // Guarantee the optional headers really are stalled before the shared
        // denial aborts them; this does not depend on browser request ordering.
        await caseStarted;
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "رفض القراءة التجريبي" }) });
      } else if (path === `/api/patients/${patient.id}/cases` && deny) { pendingCases.push(route); markCaseStarted(); }
      else if (path === `/api/patients/${patient.id}/cases` && failCases) {
        await route.fulfill({ status: 503, contentType: "application/json", body: "{invalid" });
      } else await route.continue();
    });
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${baseUrl}/patients/${patient.id}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("endo-record").click();
      await page.getByTestId("endo-note").fill("مسودة هذه الزيارة فقط");
      await expand(page, "endo-assessment-more");
      await page.getByTestId("endo-radiographicFindings").fill("موجودات شعاعية للمسودة فقط");
      await page.getByTestId("endo-save").click(); await page.getByTestId("endo-error").waitFor();
      expect(writes).toEqual([`PUT /api/patients/${patient.id}/endo/${(await db.query<{ id: number }>(`SELECT id FROM endo_treatments WHERE patient_id=$1`, [patient.id])).rows[0].id}/visits`]);
      const expectedWrites = [...writes]; deny = true;
      await page.getByRole("button", { name: "تحديث البيانات مع إبقاء المسودة", exact: true }).click();
      await page.getByTestId("endo-read-unavailable").getByRole("alert").waitFor();
      await expect.poll(() => pendingCases.length).toBe(1);
      expect(await page.getByTestId("endo-read-unavailable").innerText()).toContain("غير مصرّح");
      await page.getByTestId("endo-read-retained-draft").waitFor();
      for (const id of ["endo-strip", "endo-form", "endo-history", "endo-work-links", "endo-crown-link", "endo-new"]) expect(await page.getByTestId(id).count()).toBe(0);
      expect(await page.getByText("مسودة هذه الزيارة فقط", { exact: true }).count()).toBe(0);
      const reload = page.getByTestId("endo-reload"); await reload.scrollIntoViewIfNeeded();
      const bounds = await reload.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hits = [[box.left + 3, box.top + 3], [box.right - 3, box.top + 3],
          [box.left + 3, box.bottom - 3], [box.right - 3, box.bottom - 3], [box.left + box.width / 2, box.top + box.height / 2]]
          .map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); });
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height,
          viewport: { width: innerWidth, height: innerHeight }, hits, pageWidth: document.documentElement.scrollWidth };
      });
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await writeFile(`.settings-ui-artifacts/endodontics-read-denied-${width}-bounds.json`, JSON.stringify(bounds, null, 2));
      await page.getByTestId("endo-read-unavailable").screenshot({ path: `.settings-ui-artifacts/endodontics-read-denied-${width}.png` });
      expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.width).toBeGreaterThan(70);
      expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width);
      expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport.height);
      expect(bounds.pageWidth).toBeLessThanOrEqual(width + 1); expect(bounds.hits).toEqual([true, true, true, true, true]);
      deny = false; failCases = true; await reload.click();
      await page.getByTestId("endo-form").waitFor(); await page.getByTestId("endo-case-unavailable").getByRole("button").waitFor();
      await expect.poll(() => page.getByTestId("endo-case-unavailable").getAttribute("role")).toBe("alert");
      expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة هذه الزيارة فقط");
      expect(await page.getByTestId("endo-radiographicFindings").inputValue()).toBe("موجودات شعاعية للمسودة فقط");
      expect(await page.getByTestId("endo-save").isEnabled()).toBe(true);
      expect(await page.getByTestId("endo-case-unavailable").innerText()).toContain("هذا لا يعني عدم وجود خطة");
      for (const id of ["endo-plan-context", "endo-open-plans", "endo-crown-item", "endo-new"]) expect(await page.getByTestId(id).count()).toBe(0);
      failCases = false; await page.getByTestId("endo-reload").click();
      await page.getByTestId("endo-plan-context").waitFor();
      expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة هذه الزيارة فقط");
      expect(writes).toEqual(expectedWrites); expect(errors).toEqual([]); expect(await before()).toEqual(originalRows);
    } finally { await context.close(); }
  });
});

async function endoVisitId(visitId: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM endo_visits WHERE visit_id = $1`, [visitId]);
  return rows[0].id;
}
