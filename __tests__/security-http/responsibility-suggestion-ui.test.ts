import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

/**
 * Owner decision (2026-10-27): a case without a responsible doctor opens the admin's responsibility
 * settings on a suggested doctor; only the admin's confirmation records it. Built app, isolated harness
 * database, synthetic data only. Covers confirmation, a concurrent change (stale fingerprint) and a save
 * whose first transport attempt fails, each proven in the database and the audit log.
 */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
const stamp = Date.now();
let serial = 0;
let doctorA = { id: 0, name: "" }, doctorB = { id: 0, name: "" };
let reception = { id: 0, permissions: null as unknown };

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const party = async (username: string) => (await db.query<{ id: number; name: string }>(
    "SELECT p.id, p.name FROM users u JOIN parties p ON p.id = u.party_id WHERE u.username = $1", [username])).rows[0];
  doctorA = await party("secdoctora"); doctorB = await party("secdoctorb");
  ({ rows: [reception] } = await db.query<{ id: number; permissions: unknown }>("SELECT id, permissions FROM users WHERE username = 'secreception'"));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => {
  // Restore the shared harness account exactly; later suites rely on its default grants.
  if (reception.id) await db?.query("UPDATE users SET permissions = $2 WHERE id = $1", [reception.id, reception.permissions]);
  await browser?.close(); await db?.end();
});

/** A case opened without a responsible doctor whose live plan item is recorded for doctor A. */
async function unassignedCase() {
  const { rows: [patient] } = await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES ($1,'مريض اقتراح مسؤول اصطناعي') RETURNING id",
    [`RSG-${stamp}-${++serial}`]);
  const { rows: [clinical] } = await db.query<{ id: number }>("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES ($1,'endodontics','حالة اصطناعية','synthetic') RETURNING id", [patient.id]);
  const { rows: [plan] } = await db.query<{ id: number }>("INSERT INTO treatment_plans(patient_id,title,status,total_minor) VALUES ($1,'خطة اصطناعية','active',1000) RETURNING id", [patient.id]);
  await db.query("INSERT INTO plan_items(plan_id,service_name,case_id,doctor_id,unit_price_minor,category) VALUES ($1,'علاج اصطناعي',$2,$3,1000,'endo')", [plan.id, clinical.id, doctorA.id]);
  return { patientId: patient.id, clinicalId: clinical.id };
}
const responsible = async (clinicalId: number) => (await db.query("SELECT responsible_party_id FROM clinical_cases WHERE id = $1", [clinicalId])).rows[0].responsible_party_id;
const audits = async (patientId: number) => (await db.query<{ doctor: number; reason: string }>(
  "SELECT (details->>'doctorId')::int AS doctor, details->>'reason' AS reason FROM audit_log WHERE action = 'case.responsibility_change' AND entity_id = $1 ORDER BY id", [String(patientId)])).rows;

async function openSettings(patientId: number, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=cases`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "الطبيب المسؤول عن الحالة", exact: true }).click();
  const note = page.getByRole("note").filter({ hasText: "مقترح:" });
  await note.waitFor({ timeout: 30_000 });
  return { context, page, errors, note, select: page.getByLabel("الطبيب المسؤول الجديد", { exact: true }),
    reason: page.getByLabel("سبب تحديد أو تغيير المسؤولية", { exact: true }),
    confirm: page.getByRole("button", { name: "تأكيد الطبيب المقترح", exact: true }) };
}

describe.each([390, 1280])("responsibility suggestion at %ipx", (width) => {
  it("shows the suggestion without writing, records it only on confirmation, and unlocks return booking", async () => {
    const f = await unassignedCase();
    const ui = await openSettings(f.patientId, width);
    try {
      expect((await ui.note.innerText()).replace(/\s+/g, " ")).toContain(`مقترح: ${doctorA.name} — طبيب بنود علاج هذه الحالة. لا يُعتمد إلا بعد تأكيدك.`);
      expect(await ui.select.inputValue()).toBe(String(doctorA.id));
      expect(await ui.reason.inputValue()).toBe("تأكيد الطبيب المقترح من بنود علاج الحالة");
      // Viewing the suggestion writes nothing, and reception still cannot book.
      expect(await responsible(f.clinicalId)).toBeNull();
      expect(await audits(f.patientId)).toEqual([]);
      const refused = await authedGet(`/api/patients/${f.patientId}/return-booking-context?kind=clinical_case&sourceId=${f.clinicalId}`, h.sessions.reception);
      expect(refused.status).toBe(409);
      expect((await refused.json()).code).toBe("responsibility_missing");
      await ui.confirm.click();
      await ui.page.getByText("حُفظ الطبيب المسؤول للمواعيد القادمة", { exact: false }).waitFor({ timeout: 30_000 });
      expect(await responsible(f.clinicalId)).toBe(doctorA.id);
      expect(await audits(f.patientId)).toEqual([{ doctor: doctorA.id, reason: "تأكيد الطبيب المقترح من بنود علاج الحالة" }]);
      const allowed = await authedGet(`/api/patients/${f.patientId}/return-booking-context?kind=clinical_case&sourceId=${f.clinicalId}`, h.sessions.reception);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ ok: true, doctorId: doctorA.id });
      expect(ui.errors).toEqual([]);
    } finally { await ui.context.close(); }
  }, 120_000);

  it("a concurrent change makes the displayed suggestion stale: refused, nothing overwritten", async () => {
    const f = await unassignedCase();
    const ui = await openSettings(f.patientId, width);
    try {
      // Another admin records doctor B through the same audited route after the suggestion was shown.
      const read = await authedGet(`/api/patients/${f.patientId}/responsibility?kind=clinical&sourceId=${f.clinicalId}`, h.sessions.admin);
      const { sourceFingerprint } = await read.json();
      const changed = await authedMutation(`/api/patients/${f.patientId}/responsibility`, h.sessions.admin, "PATCH", JSON.stringify({
        kind: "clinical", sourceId: f.clinicalId, expectedSourceFingerprint: sourceFingerprint, doctorId: doctorB.id, reason: "تغيير متزامن اصطناعي" }));
      expect(changed.status).toBe(200);
      const refusal = ui.page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith("/responsibility"));
      await ui.confirm.click();
      expect((await refusal).status()).toBe(409);
      await ui.page.getByText("تغيّرت المسؤولية منذ عرضها", { exact: false }).waitFor({ timeout: 30_000 });
      expect(await responsible(f.clinicalId)).toBe(doctorB.id);
      expect(await audits(f.patientId)).toEqual([{ doctor: doctorB.id, reason: "تغيير متزامن اصطناعي" }]);
    } finally { await ui.context.close(); }
  }, 120_000);

  it("a save lost in transport changes nothing; confirming again records it exactly once", async () => {
    const f = await unassignedCase();
    const ui = await openSettings(f.patientId, width);
    try {
      const sent: string[] = [];
      await ui.page.route("**/api/patients/*/responsibility", async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        sent.push(route.request().postData() ?? "");
        if (sent.length === 1) return route.abort("failed");
        return route.continue();
      });
      await ui.confirm.click();
      await ui.page.getByText("تعذّر التحقق من الحفظ", { exact: false }).waitFor({ timeout: 30_000 });
      expect(await responsible(f.clinicalId)).toBeNull();
      expect(await audits(f.patientId)).toEqual([]);
      await ui.confirm.click();
      await ui.page.getByText("حُفظ الطبيب المسؤول للمواعيد القادمة", { exact: false }).waitFor({ timeout: 30_000 });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe(sent[0]);
      expect(await responsible(f.clinicalId)).toBe(doctorA.id);
      expect(await audits(f.patientId)).toHaveLength(1);
    } finally { await ui.context.close(); }
  }, 120_000);
});

/** A planned next visit linked through its treatment session to the unassigned case. */
async function plannedVisitFor(patientId: number, clinicalId: number) {
  const { rows: [item] } = await db.query<{ id: number; plan_id: number }>("SELECT i.id, i.plan_id FROM plan_items i WHERE i.case_id = $1", [clinicalId]);
  const { rows: [planned] } = await db.query<{ id: number }>(`INSERT INTO planned_visits (patient_id, plan_id, sequence, title, status)
    VALUES ($1, $2, 1, 'جلسة مراجعة اصطناعية', 'planned') RETURNING id`, [patientId, item.plan_id]);
  await db.query("INSERT INTO treatment_sessions (plan_item_id, sequence, planned_visit_id) VALUES ($1, 1, $2)", [item.id, planned.id]);
  return planned.id;
}
async function asRole(role: "admin" | "reception", width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions[role].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}
const confirmGrant = async () => (await db.query("SELECT permissions::jsonb->>'canConfirmCaseResponsibility' AS v FROM users WHERE id = $1", [reception.id])).rows[0].v;
async function setReceptionConfirm(value: boolean) {
  const response = await authedMutation(`/api/users/${reception.id}`, h.sessions.admin, "PATCH", JSON.stringify({
    permissions: { ...JSON.parse((await db.query<{ p: string | null }>("SELECT permissions AS p FROM users WHERE id = $1", [reception.id])).rows[0].p ?? "{}"), canConfirmCaseResponsibility: value } }));
  expect(response.status, await response.clone().text()).toBe(200);
}

describe("reception sees the suggestion; confirmation follows the grant managed in settings", () => {
  it("view-only by default, granted from settings, revoked mid-window (refused), re-granted, confirmed, then booked", async () => {
    const f = await unassignedCase();
    const plannedId = await plannedVisitFor(f.patientId, f.clinicalId);
    // 1. Default reception: the booking form shows who is suggested, awaiting confirmation; booking stays unavailable.
    const desk = await asRole("reception", 390);
    try {
      await desk.page.goto(`${baseUrl}/patients/${f.patientId}?tab=summary`, { waitUntil: "domcontentloaded" });
      await desk.page.getByRole("button", { name: "جدولها", exact: true }).click();
      const pending = desk.page.getByTestId("responsibility-pending");
      await pending.waitFor({ timeout: 30_000 });
      expect((await pending.innerText()).trim()).toBe(`مقترح: ${doctorA.name} — بانتظار تأكيد المدير.`);
      expect(await desk.page.getByRole("button", { name: "احجز", exact: true }).isDisabled()).toBe(true);
      // The case panel is read-only for this grant; a direct save is refused server-side.
      await desk.page.goto(`${baseUrl}/patients/${f.patientId}?tab=treatment&sub=cases`, { waitUntil: "domcontentloaded" });
      await desk.page.getByRole("button", { name: "الطبيب المسؤول عن الحالة", exact: true }).click();
      await desk.page.getByText("بانتظار تأكيد الإدارة.", { exact: false }).waitFor({ timeout: 30_000 });
      expect(await desk.page.getByRole("button", { name: "تأكيد الطبيب المقترح", exact: true }).count()).toBe(0);
      const read = await (await authedGet(`/api/patients/${f.patientId}/responsibility?kind=clinical&sourceId=${f.clinicalId}`, h.sessions.reception)).json();
      const denied = await authedMutation(`/api/patients/${f.patientId}/responsibility`, h.sessions.reception, "PATCH", JSON.stringify({
        kind: "clinical", sourceId: f.clinicalId, expectedSourceFingerprint: read.sourceFingerprint, doctorId: doctorA.id, reason: "محاولة دون صلاحية" }));
      expect(denied.status).toBe(403);
      expect(await responsible(f.clinicalId)).toBeNull();
      expect(await audits(f.patientId)).toEqual([]);
      expect(desk.errors).toEqual([]);
    } finally { await desk.context.close(); }

    // 2. The admin grants confirmation to reception from the users settings screen.
    const office = await asRole("admin");
    try {
      await office.page.goto(`${baseUrl}/settings/users`, { waitUntil: "domcontentloaded" });
      const card = office.page.locator("div").filter({ hasText: "secreception" }).filter({ has: office.page.getByRole("button", { name: "🔐 الصلاحيات", exact: true }) }).last();
      await card.getByRole("button", { name: "🔐 الصلاحيات", exact: true }).click();
      const grant = office.page.getByRole("switch", { name: "اعتماد الطبيب المسؤول أو تغييره", exact: true });
      expect(await grant.getAttribute("aria-checked")).toBe("false");
      await grant.click();
      const saved = office.page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/users/${reception.id}`);
      await office.page.getByRole("button", { name: "حفظ التغييرات والصلاحيات", exact: true }).click();
      const savedResponse = await saved;
      expect(savedResponse.status(), `${savedResponse.url()} ${await savedResponse.text()} ${savedResponse.request().postData()}`).toBe(200);
      await expect.poll(confirmGrant, { timeout: 30_000 }).toBe("true");
      expect(office.errors).toEqual([]);
    } finally { await office.context.close(); }

    // 3. Granted reception opens the confirmation; the grant is withdrawn while the window is open: refused.
    const granted = await asRole("reception");
    try {
      await granted.page.goto(`${baseUrl}/patients/${f.patientId}?tab=treatment&sub=cases`, { waitUntil: "domcontentloaded" });
      await granted.page.getByRole("button", { name: "الطبيب المسؤول عن الحالة", exact: true }).click();
      const confirm = granted.page.getByRole("button", { name: "تأكيد الطبيب المقترح", exact: true });
      await confirm.waitFor({ timeout: 30_000 });
      await setReceptionConfirm(false);
      const refusal = granted.page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith("/responsibility"));
      await confirm.click();
      expect((await refusal).status()).toBe(403);
      await granted.page.getByText("اعتماد الطبيب المسؤول يحتاج صلاحية تمنحها الإدارة من الإعدادات.", { exact: false }).waitFor({ timeout: 30_000 });
      expect(await responsible(f.clinicalId)).toBeNull();
      expect(await audits(f.patientId)).toEqual([]);
      // 4. Re-granted: the same reception user confirms without an admin role.
      await setReceptionConfirm(true);
      await granted.page.getByRole("button", { name: "تحديث البيانات", exact: true }).click();
      await confirm.waitFor({ timeout: 30_000 });
      await confirm.click();
      await granted.page.getByText("حُفظ الطبيب المسؤول للمواعيد القادمة", { exact: false }).waitFor({ timeout: 30_000 });
      expect(await responsible(f.clinicalId)).toBe(doctorA.id);
      expect(await audits(f.patientId)).toEqual([{ doctor: doctorA.id, reason: "تأكيد الطبيب المقترح من بنود علاج الحالة" }]);
      expect((await db.query("SELECT actor, actor_role FROM audit_log WHERE action = 'case.responsibility_change' AND entity_id = $1", [String(f.patientId)])).rows)
        .toEqual([{ actor: "secreception", actor_role: "reception" }]);

      // 5. Booking now proceeds normally, re-verified against the recorded responsibility.
      await granted.page.goto(`${baseUrl}/patients/${f.patientId}?tab=summary`, { waitUntil: "domcontentloaded" });
      await granted.page.getByRole("button", { name: "جدولها", exact: true }).click();
      const region = granted.page.getByRole("region", { name: "الطبيب المسؤول عن موعد المراجعة" });
      await expect.poll(() => region.innerText(), { timeout: 30_000 }).toContain(`الطبيب المسؤول الحالي: ${doctorA.name}`);
      expect(await granted.page.getByTestId("responsibility-pending").count()).toBe(0);
      const date = new Date(Date.now() + (420 + serial * 7) * 86_400_000);
      while (date.getUTCDay() !== 0) date.setUTCDate(date.getUTCDate() + 1);
      const day = date.toISOString().slice(0, 10);
      await granted.page.getByLabel("التاريخ", { exact: true }).fill(day);
      await granted.page.getByLabel("الوقت", { exact: true }).fill("17:00");
      await granted.page.getByRole("button", { name: "احجز", exact: true }).click();
      await expect.poll(async () => (await db.query("SELECT appointment_id FROM planned_visits WHERE id = $1", [plannedId])).rows[0].appointment_id, { timeout: 30_000 }).not.toBeNull();
      expect((await db.query(`SELECT a.doctor_id, a.scheduled_date::text AS day FROM appointments a JOIN planned_visits v ON v.appointment_id = a.id WHERE v.id = $1`, [plannedId])).rows)
        .toEqual([{ doctor_id: doctorA.id, day }]);
      expect(granted.errors).toEqual([]);
    } finally { await granted.context.close(); }
  }, 300_000);
});
