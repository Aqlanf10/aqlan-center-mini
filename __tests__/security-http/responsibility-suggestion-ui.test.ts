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

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const party = async (username: string) => (await db.query<{ id: number; name: string }>(
    "SELECT p.id, p.name FROM users u JOIN parties p ON p.id = u.party_id WHERE u.username = $1", [username])).rows[0];
  doctorA = await party("secdoctora"); doctorB = await party("secdoctorb");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

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
  await page.getByRole("button", { name: "إعداد الطبيب المسؤول", exact: true }).click();
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
