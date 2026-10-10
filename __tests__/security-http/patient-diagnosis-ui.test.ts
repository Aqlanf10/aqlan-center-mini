import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { authedMutation, baseUrl, harness, TEST_USERS, type Session } from "./_server";

// Remote CI built-app acceptance only. The existing harness owns its isolated
// database and real cookie authentication. Authorized diagnosis saves reach the
// real route; only the explicit failure-read test intercepts a diagnosis GET.
let browser: Browser, db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patient: number, caseA: number, caseB: number;
const stamp = Date.now();
const noteA = "تشخيص الحالة أ التجريبي";
const noteB = "تشخيص الحالة ب التجريبي الأحدث";
const standalone = "تشخيص عام تجريبي غير مرتبط بحالة";
const snapshot = async () => (await db.query("SELECT * FROM patient_diagnoses WHERE patient_id=$1 ORDER BY id", [patient])).rows;

beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username=$1", [TEST_USERS.doctorA.username])).rows[0].party_id;
  patient = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number,full_name,primary_doctor_id)
    VALUES ($1,'مريض تشخيص التقويم التجريبي — ليس حقيقياً',$2) RETURNING id`, [`DXUI-${stamp}`, doctor])).rows[0].id;
  const cases = await db.query<{ id: number }>(`INSERT INTO ortho_cases (patient_id,status,bracket_system,created_by)
    VALUES ($1,'active','DIAG-CASE-A','synthetic-diagnosis-ui'),($1,'completed','DIAG-CASE-B','synthetic-diagnosis-ui') RETURNING id`, [patient]);
  [caseA, caseB] = cases.rows.map(row => row.id);
  for (const [orthoCaseId, note] of [[null, standalone], [caseA, noteA], [caseB, noteB]]) {
    const saved = await authedMutation(`/api/patients/${patient}/diagnoses`, h.sessions.doctorA, "POST", JSON.stringify({ content: { note }, orthoCaseId }));
    expect(saved.status).toBe(201);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

function caseCard(page: Page, key: "A" | "B") {
  return page.locator("li").filter({ has: page.getByText(new RegExp(`^DIAG-CASE-${key}\\s*·`)) });
}
function diagnosisPanel(card: Locator, page: Page) {
  return card.locator("section").filter({ has: page.getByRole("heading", { name: /التشخيص السريري لهذه الحالة/ }) });
}
const draftLabels = ["الصنف الهيكلي", "الصنف السني", "الازدحام", "البعد الأفقي", "الإطباق", "ملاحظات التشخيص", "سبب التحديث"];
async function expectBlankDraft(panel: Locator) {
  for (const label of draftLabels) expect(await panel.getByLabel(label, { exact: true }).inputValue()).toBe("");
}
async function openChoices(panel: Locator, label: string) {
  await panel.getByRole("button", { name: `اختيارات — ${label}`, exact: true }).click();
  const search = panel.getByRole("combobox", { name: `بحث في الاختيارات — ${label}`, exact: true });
  await search.waitFor();
  expect(await search.inputValue()).toBe("");
  return { search, list: panel.getByRole("listbox", { name: `اختيارات — ${label}`, exact: true }) };
}
async function fixture(width: number, session: Pick<Session, "cookie"> = h.sessions.doctorA, allowSave = false) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = session.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], pageErrors: string[] = [], writes: string[] = [], diagnosisReads: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (allowSave && method === "POST" && url.pathname === `/api/patients/${patient}/diagnoses`) writes.push(request.postData() ?? "");
      else { unexpected.push(`${method} ${url.pathname}`); await route.abort(); return; }
    }
    await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === `/api/patients/${patient}/diagnoses`) diagnosisReads.push(url.search);
  });
  const open = async () => {
    await page.goto(`${baseUrl}/patients/${patient}?tab=treatment&sub=ortho`, { waitUntil: "domcontentloaded" });
    if (width < 640) {
      await page.getByTestId("patient-treatment-section").waitFor();
      await expect.poll(() => page.getByTestId("patient-treatment-section").inputValue()).toBe("ortho");
    } else await page.getByTestId("patient-subtab-ortho").waitFor();
    const card = caseCard(page, "A"); await card.getByRole("button", { name: /السجلات/ }).click();
    const panel = diagnosisPanel(card, page); await panel.getByRole("heading", { name: /التشخيص السريري لهذه الحالة/ }).waitFor();
    return panel;
  };
  return { context, page, open, unexpected, pageErrors, writes, diagnosisReads };
}

describe("case-scoped diagnosis on the built RTL patient page", () => {
  it.each([1280, 390])("reads one case, saves through the real route and captures RTL at %s", async width => {
    const f = await fixture(width, h.sessions.doctorA, true);
    try {
      const panel = await f.open(); await panel.getByText(noteA, { exact: true }).waitFor();
      expect(await panel.getByText(noteB, { exact: true }).count()).toBe(0);
      expect(await panel.getByText(standalone, { exact: true }).count()).toBe(0);
      expect(await panel.getByText("نسخ هذه الحالة فقط؛ أرقام النسخ تتبع سجل المريض الكامل.", { exact: true }).count()).toBe(1);
      expect(f.diagnosisReads.every(search => new URLSearchParams(search).get("orthoCaseId") === String(caseA))).toBe(true);
      const before = await snapshot();
      await panel.getByRole("button", { name: /تحديث التشخيص/ }).click();
      // A new version starts empty, never copied from history or filled by defaults.
      await expectBlankDraft(panel);
      for (const label of ["الصنف الهيكلي", "الصنف السني", "الازدحام", "البعد الأفقي", "الإطباق"])
        expect(await panel.getByLabel(label, { exact: true }).getAttribute("maxlength")).toBe("200");
      expect(await panel.getByLabel("ملاحظات التشخيص", { exact: true }).getAttribute("maxlength")).toBe("1000");
      expect(await panel.getByLabel("سبب التحديث", { exact: true }).getAttribute("maxlength")).toBe("120");

      const skeletal = panel.getByLabel("الصنف الهيكلي", { exact: true });
      await skeletal.fill("صياغة هيكلية تجريبية غير مدرجة");
      const skeletalChoices = await openChoices(panel, "الصنف الهيكلي");
      await skeletalChoices.search.fill("الصنف الثاني");
      expect(await skeletalChoices.list.getByRole("option").allTextContents()).toEqual(["Class II"]);
      expect(await skeletal.inputValue()).toBe("صياغة هيكلية تجريبية غير مدرجة");
      expect(f.writes).toEqual([]);
      await skeletalChoices.list.getByRole("option", { name: "Class II", exact: true }).click();
      expect(await skeletal.inputValue()).toBe("Class II");
      expect(await panel.getByRole("combobox").count()).toBe(0);
      expect(await skeletal.evaluate(element => element === document.activeElement)).toBe(true);
      const skeletalValue = `Class II؛ تفصيل سريري تجريبي ${width}`;
      await skeletal.fill(skeletalValue); // A chosen description stays editable.

      // Opening, filtering, arrow navigation and dismissal must not assign a
      // default dental class. The actual popup remains within the RTL viewport.
      const dentalChoices = await openChoices(panel, "الصنف السني");
      const menuBounds = await dentalChoices.list.evaluate(element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { left: bounds.left, right: bounds.right, width: window.innerWidth,
          height: bounds.height, maxHeight: style.maxHeight, overflowY: style.overflowY,
          viewportLimit: window.innerHeight * 0.3,
          remLimit: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 12 };
      });
      expect(menuBounds.left).toBeGreaterThanOrEqual(-1);
      expect(menuBounds.right).toBeLessThanOrEqual(menuBounds.width + 1);
      expect(menuBounds.height).toBeGreaterThan(0);
      expect(menuBounds.maxHeight).not.toBe("none");
      expect(menuBounds.height).toBeLessThanOrEqual(menuBounds.viewportLimit + 1);
      expect(menuBounds.height).toBeLessThanOrEqual(menuBounds.remLimit + 1);
      expect(menuBounds.overflowY).toBe("auto");
      await dentalChoices.search.fill(" DIV 2 ");
      expect(await dentalChoices.list.getByRole("option").allTextContents()).toEqual(["Class II Div 2"]);
      await dentalChoices.search.press("ArrowDown");
      const activeId = await dentalChoices.search.getAttribute("aria-activedescendant");
      expect(activeId).toBeTruthy();
      expect(await dentalChoices.list.getByRole("option", { name: "Class II Div 2", exact: true }).getAttribute("id")).toBe(activeId);
      await dentalChoices.search.press("Escape");
      expect(await panel.getByRole("combobox").count()).toBe(0);
      expect(await panel.getByLabel("الصنف السني", { exact: true }).inputValue()).toBe("");

      const crowding = panel.getByLabel("الازدحام", { exact: true });
      await crowding.fill("وصف ازدحام تجريبي غير مدرج");
      const crowdingChoices = await openChoices(panel, "الازدحام");
      await crowdingChoices.search.fill("zz-no-synthetic-choice");
      expect(await crowdingChoices.list.getByRole("option").count()).toBe(0);
      expect(await crowdingChoices.search.getAttribute("aria-activedescendant")).toBeNull();
      await crowdingChoices.search.press("ArrowDown"); await crowdingChoices.search.press("Enter");
      expect(await crowding.inputValue()).toBe("وصف ازدحام تجريبي غير مدرج");
      await panel.getByRole("button", { name: "أخرى — اكتب بحرية", exact: true }).click();
      expect(await crowding.inputValue()).toBe("وصف ازدحام تجريبي غير مدرج");
      expect(await crowding.evaluate(element => element === document.activeElement)).toBe(true);
      const crowdingValue = `قياس تجريبي علوي 4.25 mm؛ صياغة حرة ${width}`;
      await crowding.fill(crowdingValue);

      const biteChoices = await openChoices(panel, "الإطباق");
      await biteChoices.search.fill("posterior crossbite");
      expect(await biteChoices.list.getByRole("option").allTextContents()).toEqual(["عضة معكوسة خلفية"]);
      await biteChoices.search.press("ArrowDown"); await biteChoices.search.press("Enter");
      expect(await panel.getByLabel("الإطباق", { exact: true }).inputValue()).toBe("عضة معكوسة خلفية");

      // Overjet remains numeric-or-free-text. Neither entry is converted into
      // a diagnosis, category, or a presumed normal measurement.
      const overjet = panel.getByLabel("البعد الأفقي", { exact: true });
      expect(await overjet.getAttribute("type")).not.toBe("number");
      expect(await panel.getByText("Overjet — البعد الأفقي (مم)", { exact: true }).count()).toBe(1);
      expect(await panel.getByRole("button", { name: "اختيارات — البعد الأفقي", exact: true }).count()).toBe(0);
      const overjetValue = width === 1280 ? "-1.5" : "غير مقاس؛ مثال تجريبي";
      await overjet.fill(overjetValue); expect(await overjet.inputValue()).toBe(overjetValue);
      const note = `تحديث سريري تجريبي ${width}`, label = `مراجعة تجريبية ${width}`;
      await panel.getByLabel("ملاحظات التشخيص", { exact: true }).fill(note);
      await panel.getByLabel("سبب التحديث", { exact: true }).fill(label);
      const submittedContent = { skeletal: skeletalValue, dental: "", crowding: crowdingValue,
        overjet: overjetValue, bite: "عضة معكوسة خلفية", note };
      expect(f.writes).toEqual([]);
      const saved = f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/patients/${patient}/diagnoses`
        && response.request().method() === "POST");
      await panel.getByRole("button", { name: "احفظ النسخة الجديدة", exact: true }).click();
      expect((await saved).status()).toBe(201);
      await panel.getByText(`تحديث سريري تجريبي ${width}`, { exact: true }).waitFor();
      const after = await snapshot(); expect(after.slice(0, before.length)).toEqual(before); expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)).toMatchObject({ patient_id: patient, ortho_case_id: caseA, supersedes: before.at(-1).id,
        version: before.at(-1).version + 1, created_by: TEST_USERS.doctorA.username, label });
      // The unchanged server turns the deliberately untouched blank field into
      // null. Every explicit selection, edit and unknown measurement is exact.
      expect(after.at(-1).content).toEqual({ ...submittedContent, dental: null });
      expect(f.writes).toHaveLength(1);
      expect(JSON.parse(f.writes[0])).toEqual({ content: submittedContent, label, orthoCaseId: caseA });
      expect(await panel.getByText(noteB, { exact: true }).count()).toBe(0);
      // Real form cancellation discards its draft without making another write.
      await panel.getByRole("button", { name: /تحديث التشخيص/ }).click();
      await expectBlankDraft(panel);
      await panel.getByLabel("ملاحظات التشخيص", { exact: true }).fill("مسودة تجريبية ملغاة");
      await panel.getByRole("button", { name: "إلغاء", exact: true }).click();
      expect(f.writes).toHaveLength(1);
      await panel.getByRole("button", { name: /تحديث التشخيص/ }).click();
      await expectBlankDraft(panel);
      await panel.getByRole("button", { name: "إلغاء", exact: true }).click();
      expect(f.writes).toHaveLength(1); expect(await snapshot()).toEqual(after);
      await panel.scrollIntoViewIfNeeded();
      expect(await panel.evaluate(element => getComputedStyle(element).direction)).toBe("rtl");
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await f.page.screenshot({ path: `.settings-ui-artifacts/ortho-diagnosis-case-${width}.png` });
      expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("shows a failed read as unavailable, retries to real case data and never claims an empty history", async () => {
    const f = await fixture(390); const before = await snapshot(); let failed = true;
    try {
      await f.page.route(`**/api/patients/${patient}/diagnoses*`, async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === "GET" && url.searchParams.get("orthoCaseId") === String(caseA) && failed) {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic temporary read failure" }) });
        } else await route.fallback();
      });
      const panel = await f.open(); await panel.getByRole("alert").waitFor();
      expect(await panel.textContent()).toContain("هذا لا يعني عدم وجود تشخيص مسجل");
      expect(await panel.getByText("لا تشخيص سريري مسجل لهذه الحالة بعد.", { exact: true }).count()).toBe(0);
      expect(await panel.getByRole("button", { name: /تحديث التشخيص|سجّل تشخيص/ }).count()).toBe(0);
      failed = false; await panel.getByRole("button", { name: "إعادة تحميل التشخيص", exact: true }).click();
      await panel.getByText(noteA, { exact: true }).waitFor(); expect(await panel.getByRole("alert").count()).toBe(0);
      expect(await panel.getByText(noteB, { exact: true }).count()).toBe(0);
      expect(f.writes).toEqual([]); expect(await snapshot()).toEqual(before);
      expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("keeps reception read-only in the diagnosis panel", async () => {
    const f = await fixture(1280, h.sessions.reception); const before = await snapshot();
    try {
      const panel = await f.open(); await panel.getByText(noteA, { exact: true }).waitFor();
      expect(await panel.getByRole("button", { name: /تحديث التشخيص|سجّل تشخيص/ }).count()).toBe(0);
      expect(f.writes).toEqual([]); expect(await snapshot()).toEqual(before); expect(f.unexpected).toEqual([]); expect(f.pageErrors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
