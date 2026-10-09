import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

/**
 * (ORTHO-ID-2) رحلة هوية دراسات السيفالو في المتصفح على التطبيق المبني وقاعدةٍ حقيقية معزولة (بيانات اصطناعية):
 *  - الطبيب يربط دراسة T1 سابقة بحالة التقويم باختياره وتأكيده (لا ربط تلقائي)، وتبقى مربوطة بعد إعادة التحميل؛
 *  - دراسة بلا تاريخ تُعرض «غير معروف»؛ السياق القديم يُرفض بعربية ولا يُكتب شيء؛ فشل الحفظ يُبقي تأكيد الطبيب مفتوحًا؛
 *  - «تصحيح هذه الدراسة» يفتح مسودة بأصلها وهويتها والأصل لا يتغير؛ ونقرتان/تبويبان ينتجان مسودة واحدة؛
 *  - نطاق الوصول: طبيب آخر والاستقبال ممنوعان؛ عرض الهاتف 390 وسطح المكتب 1280 دون تمرير أفقي للصفحة.
 */

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorParty = 0;
const stamp = Date.now();
const MARKER = `SYN-CEPH-ID-${stamp}`;

interface Fixture { patientId: number; caseId: number; oldT1: number; undated: number; onCase: number }

async function seed(label: string): Promise<Fixture> {
  const patientId = (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`CID-${label}-${stamp}`, `مريض هوية سيفالو اصطناعي ${label}`, doctorParty])).rows[0].id;
  const document = async (n: number) => (await db.query<{ id: number }>(
    `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, 'imaging', $2, 'image/png', 68, $3, $4, 'synthetic-ceph-id') RETURNING id`,
    [patientId, `صورة سيفالو اصطناعية ${n}`, `${label}${n}`.padEnd(64, "0"), `synthetic-ceph-id/${patientId}/${n}.png`])).rows[0].id;
  // Studies that pre-date the case: an approved T1 with a date, and an approved study of unknown date.
  const study = async (documentId: number, phase: string, xray: string | null, caseId: number | null) => (await db.query<{ id: number }>(
    `INSERT INTO ceph_analyses (patient_id, document_id, status, phase, xray_date, ortho_case_id, mm_per_pixel, created_by, completed_by, completed_at)
     VALUES ($1, $2, 'completed', $3, $4::date, $5, 0.5, 'synthetic', 'synthetic', NOW()) RETURNING id`,
    [patientId, documentId, phase, xray, caseId])).rows[0].id;
  const oldT1 = await study(await document(1), "pretreatment", "2025-11-20", null);
  const undated = await study(await document(2), "during", null, null);
  const caseId = (await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, status, phase, bracket_system, created_by) VALUES ($1, 'active', 'aligning', $2, 'synthetic-ceph-id') RETURNING id`,
    [patientId, `${MARKER}-${label}`])).rows[0].id;
  const onCase = await study(await document(3), "posttreatment", "2026-08-02", caseId);
  await db.query(`INSERT INTO ceph_measurements (analysis_id, code, value) VALUES ($1, 'SNA', 82.5), ($1, 'SNB', 79.1)`, [onCase]);
  await db.query(`INSERT INTO ceph_landmarks (analysis_id, code, x, y, source, confirmed_by) VALUES ($1, 'S', 100, 100, 'manual', 'synthetic')`, [onCase]);
  return { patientId, caseId, oldT1, undated, onCase };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  doctorParty = (await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`)).rows[0].party_id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(who: "admin" | "doctorA" | "doctorB", width: number): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function openRecords(page: Page, patientId: number, label: string) {
  await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`, { waitUntil: "domcontentloaded" });
  const card = page.locator("li").filter({ has: page.getByText(new RegExp(`^${MARKER}-${label}\\s*·`)) });
  await card.waitFor();
  await card.getByRole("button", { name: /السجلات/ }).click();
  const panel = card.getByRole("region", { name: "دراسات سابقة غير مرتبطة بأي حالة" });
  await panel.waitFor();
  return { card, panel };
}
const state = async (id: number) => (await db.query(
  `SELECT to_jsonb(a) - 'ortho_case_id' AS rest, ortho_case_id FROM ceph_analyses a WHERE id = $1`, [id])).rows[0] as { rest: Record<string, unknown>; ortho_case_id: number | null };

describe.each([{ width: 1280 }, { width: 390 }])("ORTHO-ID-2 explicit T1 link — viewport $width", ({ width }) => {
  it("lists earlier unlinked studies, links only the chosen one after confirmation, and survives a reload", async () => {
    const f = await seed(`link${width}`);
    const { context, page, errors } = await open("admin", width);
    try {
      const { card, panel } = await openRecords(page, f.patientId, `link${width}`);
      // Both earlier studies are offered; the case's own study is not; the unknown date is shown as unknown.
      await expect.poll(() => panel.getByRole("listitem").count()).toBe(2);
      expect(await panel.innerText()).toContain("تاريخ الأشعة غير معروف");
      expect(await panel.innerText()).not.toContain(`#${f.onCase} ·`);
      expect(await noHorizontalScroll(page)).toBe(true);

      // Nothing is linked yet — creating the case never linked anything.
      expect((await state(f.oldT1)).ortho_case_id).toBeNull();
      const before = await state(f.oldT1);
      const measurements = (await db.query(`SELECT code, value FROM ceph_measurements WHERE analysis_id = $1`, [f.oldT1])).rows;

      const row = panel.getByRole("listitem").filter({ hasText: `#${f.oldT1}` });
      await row.getByRole("button", { name: "ربط بهذه الحالة" }).click();
      const confirm = row.getByRole("button", { name: "تأكيد الربط" });
      expect(await confirm.isDisabled()).toBe(true); // explicit confirmation required
      await row.getByRole("checkbox").check();

      const requests: string[] = [];
      page.on("request", (request) => { if (request.url().includes("/link-case")) requests.push(request.url()); });
      await confirm.dblclick(); // double click
      await page.getByText(`تم ربط الدراسة #${f.oldT1} بحالة التقويم #${f.caseId}.`).waitFor();
      expect(requests).toHaveLength(1);

      const after = await state(f.oldT1);
      expect(after.ortho_case_id).toBe(f.caseId);
      expect(after.rest).toEqual(before.rest); // status, approval, phase, date, calibration untouched
      expect((await db.query(`SELECT code, value FROM ceph_measurements WHERE analysis_id = $1`, [f.oldT1])).rows).toEqual(measurements);
      expect((await state(f.undated)).ortho_case_id).toBeNull(); // the other study was never picked for the doctor
      expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'ceph.link' AND entity_id = $1`, [String(f.oldT1)])).rows).toHaveLength(1);

      // It is now a study of this case, no longer offered; the unlinked one remains offered.
      await expect.poll(() => panel.getByRole("listitem").count()).toBe(1);
      await expect(card.getByRole("cell", { name: `#${f.oldT1}`, exact: false }).first()).toBeVisible();

      await page.reload({ waitUntil: "domcontentloaded" });
      const reopened = await openRecords(page, f.patientId, `link${width}`);
      await expect.poll(() => reopened.panel.getByRole("listitem").count()).toBe(1);
      expect(await noHorizontalScroll(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it("refuses a stale preview with an Arabic message and writes nothing; a failed save keeps the doctor's confirmation open", async () => {
    const f = await seed(`stale${width}`);
    const { context, page, errors } = await open("admin", width);
    try {
      const { panel } = await openRecords(page, f.patientId, `stale${width}`);
      const row = panel.getByRole("listitem").filter({ hasText: `#${f.oldT1}` });

      // Failed save (500): the error is shown and the confirmation stays open for a retry.
      let failOnce = true;
      await page.route("**/api/ceph/*/link-case", async (route) => {
        if (failOnce) { failOnce = false; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "تعذّر ربط الدراسة بالحالة. أعد المحاولة." }) }); }
        else await route.continue();
      });
      await row.getByRole("button", { name: "ربط بهذه الحالة" }).click();
      await row.getByRole("checkbox").check();
      await row.getByRole("button", { name: "تأكيد الربط" }).click();
      await panel.getByRole("alert").filter({ hasText: "تعذّر ربط الدراسة بالحالة" }).waitFor();
      expect(await row.getByRole("checkbox").isChecked()).toBe(true);
      expect((await state(f.oldT1)).ortho_case_id).toBeNull();

      // Someone changed the study after the doctor saw it: the server refuses the stale context.
      await db.query(`UPDATE ceph_analyses SET phase = 'followup' WHERE id = $1`, [f.oldT1]);
      await row.getByRole("button", { name: "تأكيد الربط" }).click();
      await panel.getByRole("alert").filter({ hasText: "تغيّرت الدراسة منذ المعاينة" }).waitFor();
      expect((await state(f.oldT1)).ortho_case_id).toBeNull();
      expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'ceph.link' AND entity_id = $1`, [String(f.oldT1)])).rows).toHaveLength(0);
      // The list was re-read: the refreshed row carries the new stage and can be linked after a fresh confirmation.
      const fresh = panel.getByRole("listitem").filter({ hasText: `#${f.oldT1}` });
      await fresh.getByRole("button", { name: "ربط بهذه الحالة" }).click();
      await fresh.getByRole("checkbox").check();
      await fresh.getByRole("button", { name: "تأكيد الربط" }).click();
      await page.getByText(`تم ربط الدراسة #${f.oldT1} بحالة التقويم #${f.caseId}.`).waitFor();
      expect((await state(f.oldT1)).ortho_case_id).toBe(f.caseId);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});

describe.each([{ width: 1280 }, { width: 390 }])("ORTHO-ID-2 correct this study — viewport $width", ({ width }) => {
  it("opens a correction draft that points at its origin, keeps the origin untouched, and two tabs end on one draft", async () => {
    const f = await seed(`fix${width}`);
    const { context, page, errors } = await open("admin", width);
    try {
      page.on("dialog", (dialog) => void dialog.accept());
      const before = await state(f.onCase);
      const measurements = (await db.query(`SELECT code, value FROM ceph_measurements WHERE analysis_id = $1 ORDER BY code`, [f.onCase])).rows;

      await page.goto(`${baseUrl}/ceph/${f.onCase}`, { waitUntil: "domcontentloaded" });
      const button = page.getByRole("button", { name: "تصحيح هذه الدراسة", exact: true });
      await button.waitFor();
      await button.click();
      await page.waitForURL((url) => /\/ceph\/\d+$/.test(url.pathname) && !url.pathname.endsWith(`/${f.onCase}`));
      const draftId = Number(new URL(page.url()).pathname.split("/").pop());
      await page.getByTestId("ceph-lineage").waitFor();
      expect(await page.getByTestId("ceph-lineage").innerText()).toContain(`تصحيح للدراسة المعتمدة #${f.onCase}`);

      const draft = (await db.query(`SELECT corrects_analysis_id::int AS corrects, ortho_case_id, phase, xray_date::text AS xray, status FROM ceph_analyses WHERE id = $1`, [draftId])).rows[0];
      expect(draft).toEqual({ corrects: f.onCase, ortho_case_id: f.caseId, phase: "posttreatment", xray: "2026-08-02", status: "draft" });
      expect(await state(f.onCase)).toEqual(before);
      expect((await db.query(`SELECT code, value FROM ceph_measurements WHERE analysis_id = $1 ORDER BY code`, [f.onCase])).rows).toEqual(measurements);

      // The origin shows its correction instead of hiding history; a second tab pressing the same action lands on the same draft.
      const second = await context.newPage();
      second.on("dialog", (dialog) => void dialog.accept());
      await second.goto(`${baseUrl}/ceph/${f.onCase}`, { waitUntil: "domcontentloaded" });
      expect(await second.getByTestId("ceph-lineage").innerText()).toContain(`#${draftId}`);
      await second.getByRole("button", { name: "تصحيح هذه الدراسة", exact: true }).click();
      await second.waitForURL((url) => url.pathname === `/ceph/${draftId}`);
      expect((await db.query(`SELECT id FROM ceph_analyses WHERE corrects_analysis_id = $1`, [f.onCase])).rows).toHaveLength(1);
      expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'ceph.create' AND entity_id = $1`, [String(draftId)])).rows).toHaveLength(1);
      expect(await noHorizontalScroll(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it("the patient's study table shows the origin and its correction side by side", async () => {
    const f = await seed(`list${width}`);
    const res = await authedMutation(`/api/ceph/${f.onCase}/duplicate`, h.sessions.admin, "POST");
    expect(res.status).toBe(201);
    const draftId = (await res.json()).id as number;
    const { context, page, errors } = await open("admin", width);
    try {
      await page.goto(`${baseUrl}/patients/${f.patientId}?tab=treatment&sub=ortho`, { waitUntil: "domcontentloaded" });
      const card = page.locator("li").filter({ has: page.getByText(new RegExp(`^${MARKER}-list${width}\\s*·`)) });
      await card.waitFor();
      await card.getByRole("button", { name: /السجلات/ }).click();
      await card.getByText(`تصحيح للدراسة #${f.onCase}`).waitFor();
      await card.getByText(`لها تصحيح: #${draftId}`).waitFor();
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});

describe("ORTHO-ID-2 access scope", () => {
  it("another doctor, reception and a cross-patient case are refused; nothing is written", async () => {
    const mine = await seed("scope-a");
    const other = await seed("scope-b");
    const { context, page } = await open("doctorB", 1280);
    try {
      await page.goto(`${baseUrl}/ceph/${mine.onCase}`, { waitUntil: "domcontentloaded" });
      await page.getByText("التحليل غير موجود أو مرفوض.").waitFor();
      expect(await page.getByRole("button", { name: "تصحيح هذه الدراسة" }).count()).toBe(0);
    } finally { await context.close(); }

    const body = (analysisCase: number, study: { phase: string; xray: string | null; status: string }) => JSON.stringify({
      orthoCaseId: analysisCase, confirm: true, expected: { phase: study.phase, xrayDate: study.xray, status: study.status } });
    const t1 = { phase: "pretreatment", xray: "2025-11-20", status: "completed" };
    for (const who of ["reception", "doctorB"] as const) {
      const denied = await authedMutation(`/api/ceph/${mine.oldT1}/link-case`, h.sessions[who], "POST", body(mine.caseId, t1));
      expect(denied.status).toBe(403);
    }
    const crossCase = await authedMutation(`/api/ceph/${mine.oldT1}/link-case`, h.sessions.admin, "POST", body(other.caseId, t1));
    expect(crossCase.status).toBe(404);
    const noConfirm = await authedMutation(`/api/ceph/${mine.oldT1}/link-case`, h.sessions.admin, "POST",
      JSON.stringify({ orthoCaseId: mine.caseId, expected: { phase: "pretreatment", xrayDate: "2025-11-20", status: "completed" } }));
    expect(noConfirm.status).toBe(400);
    expect((await state(mine.oldT1)).ortho_case_id).toBeNull();
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'ceph.link' AND entity_id = $1`, [String(mine.oldT1)])).rows).toHaveLength(0);
  });
});
