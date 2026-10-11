import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { baseUrl, harness } from "./_server";
import { emptyStrategy, missingBridge, restrictedStrategy, savedStrategy, strategyHistory,
  STRATEGY_IDS, STRATEGY_TEXT } from "../fixtures/ortho-strategy";
import { assertStrategyControlBounds, chooseStrategyTreatment, orthoWorkspace, patientEntry, readyOrtho,
  selectedPatientSection, settleStrategy, strategyFieldSnapshot, strategyFixture,
  STRATEGY_UNCERTAIN, type Harness } from "./_ortho-strategy-ui-fixture";

// STATUS: UNRUN. Acceptance source for actual built PatientOrtho composition.
// Uses real session/tab controller/CSS. All writes are isolated synthetic replies.
let browser: Browser, h: Harness;
const ids = STRATEGY_IDS.a, text = STRATEGY_TEXT.a;
const PATH = `/api/ortho/${ids.orthoCaseId}/strategy`;
const REASON = "سبب توثيق اصطناعي صريح";
const CANCEL = "هل تريد تجاهل التغييرات غير المحفوظة في مسودة خطة الحالة؟";
const editor = (page: Page) => page.getByTestId("ortho-strategy-editor");
const draft = (page: Page) => editor(page).getByTestId("ortho-strategy-draft");
const row = (page: Page) => draft(page).getByTestId("ortho-strategy-row");
const save = (page: Page) => editor(page).getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true });
const cancel = (page: Page) => editor(page).getByRole("button", { name: "إلغاء مسودة الخطة", exact: true });
const begin = (page: Page) => editor(page).getByRole("button", { name: "بدء خطة الحالة من نموذج فارغ", exact: true });
const revise = (page: Page) => editor(page).getByRole("button", { name: "فتح مراجعة جديدة من النسخة الحالية", exact: true });
const field = (page: Page, name: string) => editor(page).getByLabel(name, { exact: true });
const objective = (page: Page) => field(page, "الهدف (نص الطبيب)");
const strategy = (page: Page) => field(page, "الاستراتيجية (نص الطبيب)");
const rationale = (page: Page) => field(page, "المبرر أو ملاحظة القرار (اختياري)");
const reason = (page: Page) => field(page, "سبب توثيق هذه النسخة (مطلوب)");

beforeAll(async () => {
  h = await harness(); expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
async function openPrescription(page: Page) {
  // Hidden responsive label text is used only to locate the existing button;
  // clicking still targets the visible canonical pillar, not a test UI seam.
  await orthoWorkspace(page).getByRole("button").filter({ hasText: "خطة العلاج والميكانيكا" }).click();
  await editor(page).waitFor();
  await expect.poll(() => editor(page).getByText("جارٍ التحقق من خطة الحالة…", { exact: true }).count()).toBe(0);
}
async function newDraft(page: Page) {
  await openPrescription(page); await begin(page).click(); await draft(page).waitFor();
}
async function fillDraft(page: Page, owner: "a" | "b" = "a") {
  const ownerText = STRATEGY_TEXT[owner], ownerIds = STRATEGY_IDS[owner];
  await row(page).locator("select").selectOption(String(ownerIds.problemId));
  await objective(page).fill(ownerText.objective); await strategy(page).fill(ownerText.strategy);
  await rationale(page).fill(ownerText.rationale); await reason(page).fill(REASON);
  await row(page).getByRole("checkbox", { name: new RegExp(ownerText.service) }).check();
}
async function assertStableTextNames(page: Page) {
  // These are real accessible names, not test IDs or a partial-label fallback.
  for (const name of ["الهدف (نص الطبيب)", "الاستراتيجية (نص الطبيب)",
    "المبرر أو ملاحظة القرار (اختياري)", "سبب توثيق هذه النسخة (مطلوب)"]) {
    expect(await editor(page).getByRole("textbox", { name, exact: true }).count()).toBe(1);
  }
}
async function retained(page: Page, url: string, length: number, snapshot: Awaited<ReturnType<typeof strategyFieldSnapshot>>) {
  await settleStrategy(page); expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
  await selectedPatientSection(page, "patient-subtab-ortho"); expect(await strategyFieldSnapshot(editor(page))).toEqual(snapshot);
}

describe("Ortho problem → objective → strategy on the real patient page", () => {
  it.each([390, 1280])("refuses wrong-patient and stale-case navigation replies without selecting or writing at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      const original = f.page.url();
      for (const fault of ["wrong_patient", "wrong_case"] as const) {
        f.armContextFault(fault);
        const count = f.contextReads.length;
        await orthoWorkspace(f.page).getByRole("button").filter({ hasText: "خطة العلاج والميكانيكا" }).click();
        await f.page.getByRole("alert").filter({ hasText: "تعذّر فتح العلاج المحدد. لم يتم اختيار حالة بديلة." }).waitFor();
        expect(f.contextReads).toHaveLength(count + 1);
        expect(f.page.url()).toBe(original); expect(await editor(f.page).count()).toBe(0);
        expect(f.writes).toEqual([]); await readyOrtho(f.page, "a");
      }
      await openPrescription(f.page);
      expect(new URL(f.page.url()).searchParams.get("orthoCaseId")).toBe(String(ids.orthoCaseId));
      expect(new URL(f.page.url()).searchParams.get("clinicalCaseId")).toBe(String(ids.clinicalCaseId));
      expect(f.contextReads.every(read => read.patientId === f.patientIds.a && read.status === 200)).toBe(true);
      expect(f.writes).toEqual([]);
    });
  });
  it.each([390, 1280])("starts explicitly blank, searches without choosing, preserves clinician text and fits every control at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await openPrescription(f.page);
      expect(await draft(f.page).count()).toBe(0); expect(f.writes).toEqual([]);
      expect(await editor(f.page).getByTestId("ortho-strategy-saved").count()).toBe(0);
      await begin(f.page).click();
      expect(await row(f.page).count()).toBe(1); expect(await row(f.page).locator("select").inputValue()).toBe("");
      expect(await row(f.page).getByTestId("ortho-selected-problem").textContent()).toBe("لم تُختر مشكلة لهذا السطر بعد.");
      for (const control of [objective(f.page), strategy(f.page), rationale(f.page), reason(f.page)]) expect(await control.inputValue()).toBe("");
      await assertStableTextNames(f.page);
      expect(await row(f.page).getByRole("checkbox").isChecked()).toBe(false); expect(await save(f.page).isDisabled()).toBe(true);
      const problemSearch = field(f.page, "بحث في مشاكل هذه الحالة"), itemSearch = field(f.page, "بحث في بنود خطة هذه الحالة");
      await problemSearch.fill("لا توجد نتيجة اصطناعية");
      expect(await row(f.page).locator("select option").count()).toBe(1); expect(await row(f.page).locator("select").inputValue()).toBe("");
      await problemSearch.fill(text.problem);
      expect(await row(f.page).locator("select option").count()).toBe(2); expect(await row(f.page).locator("select").inputValue()).toBe("");
      await objective(f.page).fill("هدف حر بلا اختيار مشكلة"); await strategy(f.page).fill("قرار حر لا تولّده القائمة");
      await itemSearch.fill("لا يوجد بند مطابق"); expect(await row(f.page).getByRole("checkbox").count()).toBe(0);
      await assertStableTextNames(f.page);
      expect(await objective(f.page).inputValue()).toBe("هدف حر بلا اختيار مشكلة");
      expect(await strategy(f.page).inputValue()).toBe("قرار حر لا تولّده القائمة");
      await problemSearch.fill(""); await itemSearch.fill(""); await fillDraft(f.page);
      const problem = row(f.page).getByRole("listbox", { name: "المشكلة", exact: true });
      const detail = row(f.page).getByTestId("ortho-selected-problem");
      expect(await problem.getAttribute("aria-describedby")).toBe(await detail.getAttribute("id"));
      const values = await Promise.all([objective(f.page), strategy(f.page), rationale(f.page), reason(f.page)].map(control => control.inputValue()));
      // Native keyboard choice exposes the complete raw unknown status next to
      // the finite-width listbox; no title-only or inferred-normal fallback.
      await problem.focus(); await problem.press("End");
      await expect.poll(() => problem.inputValue()).toBe(String(ids.otherProblemId));
      const selectedText = `المشكلة المختارة: ${text.otherProblem} · الحالة الحالية: unknown_synthetic_status`;
      expect(await detail.textContent()).toBe(selectedText);
      await problemSearch.fill("لا يوجد خيار مطابق");
      expect(await problem.inputValue()).toBe(String(ids.otherProblemId)); expect(await detail.textContent()).toBe(selectedText);
      expect(await Promise.all([objective(f.page), strategy(f.page), rationale(f.page), reason(f.page)].map(control => control.inputValue()))).toEqual(values);
      await problemSearch.fill("");
      await assertStrategyControlBounds(f.page, width, "blank-explicit-draft", [problemSearch, itemSearch,
        problem, objective(f.page), strategy(f.page), rationale(f.page),
        row(f.page).getByRole("checkbox"), reason(f.page), save(f.page), cancel(f.page), detail]);
      const fullText = await detail.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const parent = element.getBoundingClientRect();
        return { box: { left: parent.left, right: parent.right, top: parent.top, bottom: parent.bottom },
          lines: [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
            .map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) };
      });
      expect(fullText.lines.length).toBeGreaterThan(0);
      for (const line of fullText.lines) {
        expect(line.left).toBeGreaterThanOrEqual(fullText.box.left - 1); expect(line.right).toBeLessThanOrEqual(fullText.box.right + 1);
        expect(line.top).toBeGreaterThanOrEqual(fullText.box.top - 1); expect(line.bottom).toBeLessThanOrEqual(fullText.box.bottom + 1);
      }
      expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([390, 1280])("keeps exact draft through cancelled editor/tab/subtab exits and discards only after confirmation at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await newDraft(f.page); await fillDraft(f.page);
      const snapshot = await strategyFieldSnapshot(editor(f.page)), url = f.page.url(), length = await f.page.evaluate(() => history.length);
      await f.prompt(false, () => cancel(f.page).click(), CANCEL); await retained(f.page, url, length, snapshot);
      await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click()); await retained(f.page, url, length, snapshot);
      await f.prompt(false, () => chooseStrategyTreatment(f.page, "plans")); await retained(f.page, url, length, snapshot);
      await f.prompt(true, () => cancel(f.page).click(), CANCEL);
      expect(await draft(f.page).count()).toBe(0); await begin(f.page).click();
      expect(await objective(f.page).inputValue()).toBe(""); expect(await strategy(f.page).inputValue()).toBe("");
      await fillDraft(f.page);
      await f.prompt(true, () => f.page.getByTestId("patient-tab-summary").click());
      await selectedPatientSection(f.page, "patient-tab-summary");
      await f.page.getByTestId("patient-tab-treatment").click(); await chooseStrategyTreatment(f.page, "ortho");
      await readyOrtho(f.page, "a"); await openPrescription(f.page); expect(await draft(f.page).count()).toBe(0);
      expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([390, 1280])("blocks pending departure without a prompt and preserves an explicitly rejected command at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await newDraft(f.page); await fillDraft(f.page);
      const snapshot = await strategyFieldSnapshot(editor(f.page)), url = f.page.url(), length = await f.page.evaluate(() => history.length);
      f.arm(PATH, { message: "رفض استراتيجية اصطناعي" }, 409); await save(f.page).click();
      await expect.poll(() => f.writes.length).toBe(1);
      const body = f.writes[0].body as Record<string, unknown>;
      expect(body).toEqual({ schemaVersion: 1, commandId: expect.stringMatching(/^[a-zA-Z0-9_-]{16,80}$/), expectedRevisionId: null,
        reason: REASON, rows: [{ problemId: ids.problemId, objective: text.objective, strategy: text.strategy,
          rationale: text.rationale, planItemIds: [ids.planItemId] }] });
      expect(await save(f.page).isDisabled()).toBe(true); expect(await cancel(f.page).isDisabled()).toBe(true);
      await f.page.getByTestId("patient-tab-summary").click(); await retained(f.page, url, length, snapshot);
      await chooseStrategyTreatment(f.page, "plans"); await retained(f.page, url, length, snapshot); expect(f.dialogs).toEqual([]);
      await f.release(); await expect.poll(() => editor(f.page).innerText()).toContain("رفض استراتيجية اصطناعي");
      await retained(f.page, url, length, snapshot); expect(await save(f.page).isEnabled()).toBe(true);
      expect(f.writes).toHaveLength(1);
    });
  });

  it.each([390, 1280])("freezes an uncertain command and cannot duplicate it through refresh, cancel or attempted leave at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await newDraft(f.page); await fillDraft(f.page);
      const snapshot = await strategyFieldSnapshot(editor(f.page)), url = f.page.url(), length = await f.page.evaluate(() => history.length);
      f.arm(PATH, { message: "نتيجة اصطناعية غير مؤكدة", code: "strategy_result_unknown" }, 500);
      await save(f.page).click(); await expect.poll(() => f.writes.length).toBe(1); const sent = JSON.stringify(f.writes[0].body);
      await f.release(); await expect.poll(() => save(f.page).isDisabled()).toBe(true);
      expect(await cancel(f.page).isDisabled()).toBe(true);
      await f.prompt(false, () => chooseStrategyTreatment(f.page, "plans"), STRATEGY_UNCERTAIN);
      await retained(f.page, url, length, snapshot);
      const before = f.reads.length; await editor(f.page).getByRole("button", { name: "تحديث سجل الخطة", exact: true }).click();
      await expect.poll(() => f.reads.length).toBe(before + 1);
      await expect.poll(() => editor(f.page).getByText("جارٍ التحقق من خطة الحالة…", { exact: true }).count()).toBe(0);
      await retained(f.page, url, length, snapshot); expect(await save(f.page).isDisabled()).toBe(true);
      expect(f.writes).toHaveLength(1); expect(JSON.stringify(f.writes[0].body)).toBe(sent);
      await f.prompt(true, () => f.page.getByTestId("patient-tab-summary").click(), STRATEGY_UNCERTAIN);
      await selectedPatientSection(f.page, "patient-tab-summary"); expect(f.writes).toHaveLength(1);
    });
  });

  it.each([390, 1280])("reads exact historical versions and opens a current-head retrospective revision only explicitly at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    f.closeCase("a"); f.response(strategyHistory(f.patientIds.a));
    f.response(strategyHistory(f.patientIds.a, "a", 1), "a", ids.revision1);
    f.response(strategyHistory(f.patientIds.a), "a", ids.revision2);
    await f.run(async () => {
      await openPrescription(f.page); expect(await draft(f.page).count()).toBe(0);
      const history = field(f.page, "نسخة خطة الحالة");
      expect(await history.inputValue()).toBe(String(ids.revision2));
      expect(await editor(f.page).getByTestId("ortho-strategy-saved").innerText()).toContain(`${text.strategy} مراجعة صريحة`);
      await history.selectOption(String(ids.revision1));
      await expect.poll(() => f.reads.at(-1)).toBe(`${PATH}?revisionId=${ids.revision1}`);
      await expect.poll(() => revise(f.page).isDisabled()).toBe(true);
      expect(await editor(f.page).getByTestId("ortho-strategy-saved").innerText()).not.toContain("مراجعة صريحة");
      expect(await draft(f.page).count()).toBe(0); expect(f.writes).toEqual([]);
      await history.selectOption(String(ids.revision2)); await expect.poll(() => revise(f.page).isEnabled()).toBe(true);
      await revise(f.page).click();
      await assertStableTextNames(f.page);
      expect(await objective(f.page).inputValue()).toBe(text.objective);
      expect(await strategy(f.page).inputValue()).toBe(`${text.strategy} مراجعة صريحة`);
      expect(await reason(f.page).inputValue()).toBe(""); expect(await save(f.page).isDisabled()).toBe(true);
      expect(await draft(f.page).innerText()).toContain("تبقى حالة العلاج كما هي");
      await reason(f.page).fill("تصحيح استعادي جديد اصطناعي");
      f.arm(PATH, { message: "رفض اصطناعي للاختبار فقط" }, 409); await save(f.page).click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].body).toMatchObject({ expectedRevisionId: ids.revision2, reason: "تصحيح استعادي جديد اصطناعي" });
      expect(Object.keys(f.writes[0].body as object).sort()).toEqual(["commandId", "expectedRevisionId", "reason", "rows", "schemaVersion"]);
      await f.release(); expect(f.writes.map(one => [one.method, one.path])).toEqual([["POST", PATH]]);
      await assertStableTextNames(f.page);
      await assertStrategyControlBounds(f.page, width, "retrospective-revision", [objective(f.page), strategy(f.page), reason(f.page), save(f.page), cancel(f.page)]);
    });
  });

  it.each([390, 1280])("keeps hidden-plan and selected-source revision permissions read-only at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    f.response(restrictedStrategy(f.patientIds.a));
    const source = strategyHistory(f.patientIds.a, "a", 1); source.canRevise = false;
    f.response(source, "a", ids.revision1);
    await f.run(async () => {
      await openPrescription(f.page);
      expect(await revise(f.page).isDisabled()).toBe(true); expect(await draft(f.page).count()).toBe(0);
      expect(await editor(f.page).innerText()).not.toContain(text.service);
      expect(await editor(f.page).innerText()).not.toContain(String(ids.planItemId));
      await field(f.page, "نسخة خطة الحالة").selectOption(String(ids.revision1));
      await expect.poll(() => f.reads.at(-1)).toBe(`${PATH}?revisionId=${ids.revision1}`);
      await expect.poll(() => editor(f.page).innerText()).toContain(text.service);
      expect(await revise(f.page).isDisabled()).toBe(true); expect(await draft(f.page).count()).toBe(0);
      expect(f.writes).toEqual([]);
    });
  });

  it.each([390, 1280])("retires A's draft on genuine patient routing and keeps B's new guard working at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await newDraft(f.page); await fillDraft(f.page);
      const response = await f.page.goto(patientEntry(f.patientIds.b), { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200); await readyOrtho(f.page, "b"); await openPrescription(f.page);
      expect(await editor(f.page).innerText()).not.toContain(text.objective); expect(await draft(f.page).count()).toBe(0);
      await begin(f.page).click(); expect(await objective(f.page).inputValue()).toBe(""); await fillDraft(f.page, "b");
      const snapshot = await strategyFieldSnapshot(editor(f.page)), url = f.page.url(), length = await f.page.evaluate(() => history.length);
      await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click()); await retained(f.page, url, length, snapshot);
      await f.prompt(true, () => f.page.getByTestId("patient-tab-summary").click());
      await selectedPatientSection(f.page, "patient-tab-summary");
      const returned = await f.page.goto(patientEntry(f.patientIds.a), { waitUntil: "domcontentloaded" });
      expect(returned?.status()).toBe(200); await readyOrtho(f.page, "a"); await openPrescription(f.page);
      expect(await draft(f.page).count()).toBe(0); expect(await editor(f.page).innerText()).not.toContain(STRATEGY_TEXT.b.objective);
      expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(3);
    });
  });

  it.each([390, 1280])("creates a canonical problem only through its explicit existing action and never preselects it at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    const empty = emptyStrategy(f.patientIds.a); empty.choices.problems = []; f.response(empty);
    await f.run(async () => {
      await newDraft(f.page); expect(await row(f.page).locator("select option").count()).toBe(1);
      expect(await save(f.page).isDisabled()).toBe(true); expect(f.writes).toEqual([]);
      await editor(f.page).locator("summary").filter({ hasText: "إضافة مشكلة سريرية لهذه الحالة" }).click();
      const problem = field(f.page, "نص المشكلة"), site = field(f.page, "موضع المشكلة (اختياري)");
      expect(await problem.inputValue()).toBe(""); expect(await site.inputValue()).toBe("");
      await problem.fill(text.problem); await site.fill("الفك العلوي");
      f.arm(`/api/patients/${f.patientIds.a}/problems`, { id: ids.problemId, patientId: f.patientIds.a,
        caseId: ids.clinicalCaseId, label: text.problem }, 201);
      await editor(f.page).getByRole("button", { name: "حفظ المشكلة في هذه الحالة", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].body).toEqual({ label: text.problem, site: "الفك العلوي", specialty: "orthodontics", caseId: ids.clinicalCaseId });
      f.response(emptyStrategy(f.patientIds.a)); await f.release();
      await expect.poll(() => row(f.page).locator("select option").count()).toBe(3);
      expect(await row(f.page).locator("select").inputValue()).toBe("");
      expect(await objective(f.page).inputValue()).toBe(""); expect(await strategy(f.page).inputValue()).toBe("");
      expect(f.writes.map(one => one.path)).toEqual([`/api/patients/${f.patientIds.a}/problems`]);
    });
  });

  it.each([390, 1280])("does not auto-create a missing clinical bridge just by opening or refreshing at %ipx", async width => {
    const f = await strategyFixture(browser, h, width); f.response(missingBridge(f.patientIds.a));
    await f.run(async () => {
      await openPrescription(f.page); expect(await begin(f.page).count()).toBe(0); expect(await draft(f.page).count()).toBe(0);
      const bridge = editor(f.page).getByRole("button", { name: "ربط هذه الحالة بالمشاكل وبنود الخطة", exact: true });
      expect(await bridge.isEnabled()).toBe(true);
      await editor(f.page).getByRole("button", { name: "تحديث سجل الخطة", exact: true }).click();
      await expect.poll(() => f.reads.length).toBe(2); expect(f.writes).toEqual([]);
      await assertStrategyControlBounds(f.page, width, "bridge-prerequisite", [bridge]);
    });
  });

  it.each([390, 1280])("links the existing exact case only after explicit bridge confirmation at %ipx", async width => {
    const f = await strategyFixture(browser, h, width); f.response(missingBridge(f.patientIds.a));
    await f.run(async () => {
      await openPrescription(f.page);
      const bridge = editor(f.page).getByRole("button", { name: "ربط هذه الحالة بالمشاكل وبنود الخطة", exact: true });
      const title = "تقويم ثابت معدني · الفكّان";
      const confirmation = `ربط ${title} بالمشاكل وبنود الخطة؟ لا ينشئ هذا الإجراء حالة تقويم أو فاتورة جديدة.`;
      await f.prompt(false, () => bridge.click(), confirmation); expect(f.writes).toEqual([]);
      f.arm(`/api/patients/${f.patientIds.a}/cases`, { id: ids.clinicalCaseId, patientId: f.patientIds.a, orthoCaseId: ids.orthoCaseId }, 201);
      await f.prompt(true, () => bridge.click(), confirmation); await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].body).toEqual({ specialty: "orthodontics", title, orthoCaseId: ids.orthoCaseId });
      f.response(emptyStrategy(f.patientIds.a)); await f.release();
      await expect.poll(() => begin(f.page).isEnabled()).toBe(true); expect(await draft(f.page).count()).toBe(0);
      expect(f.writes.map(one => [one.method, one.path])).toEqual([["POST", `/api/patients/${f.patientIds.a}/cases`]]);
    });
  });

  it.each([390, 1280])("confirms exactly one documentation revision and rereads it without creating clinical work at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await newDraft(f.page); await fillDraft(f.page);
      const revision = { ...savedStrategy(f.patientIds.a), reason: REASON };
      f.arm(PATH, { ok: true, replayed: false, revision }, 201); await save(f.page).click();
      await expect.poll(() => f.writes.length).toBe(1);
      const { revisionId, version, supersedesRevisionId, recordedPatientId, recordingContext, createdAt, createdBy, reason: savedReason } = revision;
      f.response({ ...emptyStrategy(f.patientIds.a), revision, history: [{ revisionId, version, supersedesRevisionId,
        recordedPatientId, recordingContext, createdAt, createdBy, reason: savedReason }] });
      await f.release(); await expect.poll(() => draft(f.page).count()).toBe(0);
      await expect.poll(() => editor(f.page).getByTestId("ortho-strategy-saved").innerText()).toContain(text.objective);
      expect(await editor(f.page).getByTestId("ortho-strategy-saved").innerText()).toContain(REASON);
      expect(f.writes.map(one => [one.method, one.path])).toEqual([["POST", PATH]]);
      expect(f.reads).toEqual([PATH, PATH]);
      await f.page.getByTestId("patient-tab-summary").click(); await selectedPatientSection(f.page, "patient-tab-summary");
      expect(f.dialogs).toEqual([]); expect(f.writes).toHaveLength(1);
    });
  });

  it.each([390, 1280])("settles a successful hidden-pillar command but preserves unrelated problem text and its dirty guard at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await newDraft(f.page); await fillDraft(f.page);
      await editor(f.page).locator("summary").filter({ hasText: "إضافة مشكلة سريرية لهذه الحالة" }).click();
      await field(f.page, "نص المشكلة").fill("مشكلة أخرى لم تُحفظ");
      await field(f.page, "موضع المشكلة (اختياري)").fill("موضع آخر لم يُحفظ");
      const revision = { ...savedStrategy(f.patientIds.a), reason: REASON };
      f.arm(PATH, { ok: true, replayed: false, revision }, 201); await save(f.page).click();
      await expect.poll(() => f.writes.length).toBe(1); const sent = JSON.stringify(f.writes[0].body);
      await orthoWorkspace(f.page).getByRole("button").filter({ hasText: "مسار الأسلاك والشدّات" }).click();
      await expect.poll(() => editor(f.page).count()).toBe(0); expect(f.dialogs).toEqual([]);
      const { revisionId, version, supersedesRevisionId, recordedPatientId, recordingContext, createdAt, createdBy, reason: savedReason } = revision;
      f.response({ ...emptyStrategy(f.patientIds.a), revision, history: [{ revisionId, version, supersedesRevisionId,
        recordedPatientId, recordingContext, createdAt, createdBy, reason: savedReason }] });
      await f.release(); expect(await editor(f.page).count()).toBe(0);
      expect(f.reads).toEqual([PATH]); expect(f.writes).toHaveLength(1);
      await openPrescription(f.page); expect(f.reads).toEqual([PATH, PATH]);
      expect(await draft(f.page).count()).toBe(0);
      expect(await editor(f.page).getByTestId("ortho-strategy-saved").innerText()).toContain(text.objective);
      expect(await field(f.page, "نص المشكلة").inputValue()).toBe("مشكلة أخرى لم تُحفظ");
      expect(await field(f.page, "موضع المشكلة (اختياري)").inputValue()).toBe("موضع آخر لم يُحفظ");
      const url = f.page.url(), length = await f.page.evaluate(() => history.length), snapshot = await strategyFieldSnapshot(editor(f.page));
      await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click()); await retained(f.page, url, length, snapshot);
      await editor(f.page).locator("summary").filter({ hasText: "إضافة مشكلة سريرية لهذه الحالة" }).click();
      await field(f.page, "نص المشكلة").fill(""); await field(f.page, "موضع المشكلة (اختياري)").fill("");
      await f.page.getByTestId("patient-tab-summary").click(); await selectedPatientSection(f.page, "patient-tab-summary");
      expect(f.dialogs).toHaveLength(1); expect(f.writes).toHaveLength(1); expect(JSON.stringify(f.writes[0].body)).toBe(sent);
    });
  });

  it.each([390, 1280])("freezes a hidden-pillar uncertain result and returns to the identical non-replayable draft at %ipx", async width => {
    const f = await strategyFixture(browser, h, width);
    await f.run(async () => {
      await newDraft(f.page); await fillDraft(f.page);
      const snapshot = await strategyFieldSnapshot(editor(f.page));
      f.arm(PATH, { message: "نتيجة حفظ مخفية غير مؤكدة", code: "strategy_result_unknown" }, 500);
      await save(f.page).click(); await expect.poll(() => f.writes.length).toBe(1); const sent = JSON.stringify(f.writes[0].body);
      await orthoWorkspace(f.page).getByRole("button").filter({ hasText: "مسار الأسلاك والشدّات" }).click();
      await expect.poll(() => editor(f.page).count()).toBe(0); expect(f.dialogs).toEqual([]);
      await f.release(); expect(await editor(f.page).count()).toBe(0); expect(f.reads).toEqual([PATH]);
      await openPrescription(f.page);
      expect(await strategyFieldSnapshot(editor(f.page))).toEqual(snapshot);
      expect(await save(f.page).isDisabled()).toBe(true); expect(await cancel(f.page).isDisabled()).toBe(true);
      expect(await editor(f.page).innerText()).toContain("نتيجة الطلب السابق غير مؤكدة");
      await editor(f.page).getByRole("button", { name: "تحديث سجل الخطة", exact: true }).click();
      await expect.poll(() => f.reads.length).toBe(3);
      await expect.poll(() => editor(f.page).getByText("جارٍ التحقق من خطة الحالة…", { exact: true }).count()).toBe(0);
      expect(await strategyFieldSnapshot(editor(f.page))).toEqual(snapshot); expect(await save(f.page).isDisabled()).toBe(true);
      const url = f.page.url(), length = await f.page.evaluate(() => history.length);
      await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click(), STRATEGY_UNCERTAIN);
      await retained(f.page, url, length, snapshot);
      expect(f.writes).toHaveLength(1); expect(JSON.stringify(f.writes[0].body)).toBe(sent);
    });
  });

  it.each([390, 1280].flatMap(width => (["confirmed", "server-error", "malformed-body"] as const).map(outcome => ({ width, outcome }))))(
    "updates the currently remounted adapter after its GET finished before the old POST ($outcome, $width px)", async ({ width, outcome }) => {
      const f = await strategyFixture(browser, h, width);
      await f.run(async () => {
        await newDraft(f.page); await fillDraft(f.page);
        await editor(f.page).locator("summary").filter({ hasText: "إضافة مشكلة سريرية لهذه الحالة" }).click();
        await field(f.page, "نص المشكلة").fill("مشكلة مستقلة لم تُحفظ");
        await field(f.page, "موضع المشكلة (اختياري)").fill("موضع مستقل لم يُحفظ");
        const snapshot = await strategyFieldSnapshot(editor(f.page));
        const revision = { ...savedStrategy(f.patientIds.a), reason: REASON };
        const response = outcome === "confirmed" ? { ok: true, replayed: false, revision }
          : outcome === "malformed-body" ? { ok: true, replayed: false, revision: null }
            : { message: "نتيجة متأخرة غير مؤكدة" };
        f.arm(PATH, response, outcome === "server-error" ? 500 : 201);
        await save(f.page).click(); await expect.poll(() => f.writes.length).toBe(1);
        const sent = JSON.stringify(f.writes[0].body);
        await orthoWorkspace(f.page).getByRole("button").filter({ hasText: "مسار الأسلاك والشدّات" }).click();
        await expect.poll(() => editor(f.page).count()).toBe(0);
        // Critical order: new view mounts and FINISHES its read while the old
        // command remains held. A later user action must not be needed to redraw.
        await openPrescription(f.page);
        expect(f.reads).toEqual([PATH, PATH]);
        expect(await save(f.page).isDisabled()).toBe(true);
        expect(await cancel(f.page).isDisabled()).toBe(true);
        expect(await strategyFieldSnapshot(editor(f.page))).toEqual(snapshot);
        if (outcome === "confirmed") {
          const { revisionId, version, supersedesRevisionId, recordedPatientId, recordingContext, createdAt, createdBy, reason: savedReason } = revision;
          f.response({ ...emptyStrategy(f.patientIds.a), revision, history: [{ revisionId, version, supersedesRevisionId,
            recordedPatientId, recordingContext, createdAt, createdBy, reason: savedReason }] });
        }
        await f.release();
        if (outcome === "confirmed") {
          await expect.poll(() => draft(f.page).count()).toBe(0);
          await expect.poll(() => editor(f.page).getByTestId("ortho-strategy-saved").innerText()).toContain(text.objective);
          expect(f.reads).toEqual([PATH, PATH, PATH]);
          expect(await field(f.page, "نص المشكلة").inputValue()).toBe("مشكلة مستقلة لم تُحفظ");
          expect(await field(f.page, "موضع المشكلة (اختياري)").inputValue()).toBe("موضع مستقل لم يُحفظ");
          // The completed strategy must not clear the other unsaved fields.
          await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click());
        } else {
          await expect.poll(() => editor(f.page).innerText()).toContain("نتيجة الطلب السابق غير مؤكدة");
          expect(await save(f.page).isDisabled()).toBe(true); expect(await cancel(f.page).isDisabled()).toBe(true);
          expect(await strategyFieldSnapshot(editor(f.page))).toEqual(snapshot);
          expect(f.reads).toEqual([PATH, PATH]);
          // A distinct uncertainty prompt proves pending has settled; a still
          // stale busy adapter would block without presenting this decision.
          await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click(), STRATEGY_UNCERTAIN);
        }
        await selectedPatientSection(f.page, "patient-subtab-ortho");
        expect(f.writes).toHaveLength(1); expect(JSON.stringify(f.writes[0].body)).toBe(sent);
        expect(f.documents).toHaveLength(1);
      });
    },
  );
});
