import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * Owner decision (2026-10-27): a case without a responsible doctor shows a suggested doctor; only the
 * admin's confirmation records it. Real PostgreSQL, synthetic data only. The suggestion is read-only:
 * no case, plan, audit or appointment row changes until the existing audited command saves it, and return
 * booking stays refused (responsibility_missing) until then.
 */
assertRealPostgresUrl(); stubPostgresEnv();
const auth = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: auth.token }) }), headers: async () => new Headers() }));
const db = await import("../../lib/db");
const { sessionCredentialVersion, createSessionToken } = await import("../../lib/auth");
const { GET: returnContextRoute } = await import("../../app/api/patients/[id]/return-booking-context/route");
const { patientResponsibilitySettings } = await import("../../lib/patient-responsibility-settings");
const { readReturnBookingContext } = await import("../../lib/return-booking-context");
let sequence = 0;
const q = async (sql: string, args: unknown[] = []) => (await db.getPool().query(sql, args)).rows;
beforeAll(async () => { await dropPublicSchema(assertRealPostgresUrl()); await db.ensureSchema(); });
afterAll(async () => { await db.resetPoolForTesting(); });

async function staff(role: string, permissions: Record<string, boolean> | null = null) {
  const username = `synthetic-suggest-${role}-${++sequence}`, hash = "synthetic-unused-password-hash";
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES ($1,'Synthetic staff',$2,$3,$4) RETURNING id",
    [username, hash, role, permissions === null ? null : JSON.stringify(permissions)]);
  return { userId: user.id as number, username, role, credentialVersion: sessionCredentialVersion(hash), expiresAt: Date.now() + 3600000 };
}
const admin = () => staff("admin");
async function doctor(label: string, active = true) {
  const [row] = await q("INSERT INTO parties(name,kind,is_active) VALUES ($1,'doctor',$2) RETURNING id,name", [`Synthetic ${label} ${++sequence}`, active]);
  return row as { id: number; name: string };
}
/** A case opened without a responsible doctor, with live plan items recorded for the given doctors. */
async function fixture(itemDoctors: (number | null)[], primary: number | null = null, cancelled: number[] = []) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'Synthetic suggestion patient',$2) RETURNING id", [`SUGGEST-${++sequence}`, primary]);
  const [clinical] = await q("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES ($1,'endodontics','Synthetic case','synthetic') RETURNING id", [patient.id]);
  const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,status,total_minor) VALUES ($1,'Synthetic plan','active',1000) RETURNING id", [patient.id]);
  for (const doctorId of itemDoctors) await q("INSERT INTO plan_items(plan_id,service_name,case_id,doctor_id,unit_price_minor,category) VALUES ($1,'Synthetic work',$2,$3,1000,'endo')", [plan.id, clinical.id, doctorId]);
  for (const doctorId of cancelled) await q("INSERT INTO plan_items(plan_id,service_name,case_id,doctor_id,unit_price_minor,category,status) VALUES ($1,'Synthetic cancelled',$2,$3,1000,'endo','cancelled')", [plan.id, clinical.id, doctorId]);
  return { patientId: patient.id as number, clinicalId: clinical.id as number, target: { patientId: patient.id as number, kind: "clinical" as const, sourceId: clinical.id as number } };
}
async function context(f: Awaited<ReturnType<typeof fixture>>) {
  const client = await db.getPool().connect();
  try { return await readReturnBookingContext(client, f.patientId, { kind: "clinical_case", id: f.clinicalId }); } finally { client.release(); }
}
const state = async (f: Awaited<ReturnType<typeof fixture>>) => ({
  cases: await q("SELECT to_jsonb(c) AS row FROM clinical_cases c WHERE patient_id=$1 ORDER BY id", [f.patientId]),
  items: await q("SELECT to_jsonb(i) AS row FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 ORDER BY i.id", [f.patientId]),
  audit: await q("SELECT count(*)::int AS n FROM audit_log WHERE action='case.responsibility_change' AND entity_id=$1", [String(f.patientId)]),
  appointments: await q("SELECT count(*)::int AS n FROM appointments WHERE patient_id=$1", [f.patientId]),
});

it("suggests the single active plan-item doctor, writes nothing, and books only after the admin confirms it", async () => {
  const itemDoctor = await doctor("item doctor"), primary = await doctor("primary doctor");
  const f = await fixture([itemDoctor.id, itemDoctor.id], primary.id, [primary.id]);
  const session = await admin(), before = await state(f);
  const settings = await patientResponsibilitySettings(f.target, session);
  expect(settings).toMatchObject({ doctorId: null, suggestion: { doctorId: itemDoctor.id, doctorName: itemDoctor.name, basis: "plan_items" }, suggestionNote: null });
  expect(await state(f)).toEqual(before);
  expect(await context(f)).toMatchObject({ ok: false, code: "responsibility_missing" });
  const confirmed = await patientResponsibilitySettings(f.target, session, { expectedSourceFingerprint: settings.sourceFingerprint,
    doctorId: settings.suggestion!.doctorId, reason: "تأكيد الطبيب المقترح من بنود علاج الحالة" });
  expect(confirmed).toMatchObject({ doctorId: itemDoctor.id, suggestion: null, suggestionNote: null });
  expect((await state(f)).audit).toEqual([{ n: 1 }]);
  expect(await context(f)).toMatchObject({ ok: true, doctorId: itemDoctor.id });
});

it("never guesses between several plan-item doctors", async () => {
  const one = await doctor("first"), two = await doctor("second"), primary = await doctor("primary");
  const f = await fixture([one.id, two.id], primary.id);
  expect(await patientResponsibilitySettings(f.target, await admin())).toMatchObject({ doctorId: null, suggestion: null,
    suggestionNote: "بنود هذه الحالة مسجّلة لأكثر من طبيب؛ اختر الطبيب المسؤول يدويًا." });
});

it("falls back to the active primary doctor when the item doctor is inactive or absent, and says why", async () => {
  const retired = await doctor("retired", false), primary = await doctor("primary");
  const inactiveItem = await fixture([retired.id], primary.id);
  expect(await patientResponsibilitySettings(inactiveItem.target, await admin())).toMatchObject({
    suggestion: { doctorId: primary.id, basis: "primary_doctor" }, suggestionNote: "طبيب بنود الحالة غير نشط؛ المقترح هو الطبيب الأساسي للمريض." });
  const noItems = await fixture([null], primary.id);
  expect(await patientResponsibilitySettings(noItems.target, await admin())).toMatchObject({ suggestion: { doctorId: primary.id, basis: "primary_doctor" }, suggestionNote: null });
});

it("offers nothing without an active candidate, and nothing once a responsible doctor is recorded", async () => {
  const retired = await doctor("retired", false), retiredPrimary = await doctor("retired primary", false);
  const none = await fixture([retired.id], retiredPrimary.id);
  expect(await patientResponsibilitySettings(none.target, await admin())).toMatchObject({ suggestion: null,
    suggestionNote: "طبيب بنود الحالة غير نشط ولا يوجد طبيب أساسي نشط؛ اختر الطبيب يدويًا." });
  const current = await doctor("current"), other = await doctor("other");
  const owned = await fixture([other.id]);
  await q("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=$1", [owned.clinicalId, current.id]);
  expect(await patientResponsibilitySettings(owned.target, await admin())).toMatchObject({ doctorId: current.id, suggestion: null, suggestionNote: null });
});

const writes = async (f: Awaited<ReturnType<typeof fixture>>) => ({ responsible: (await q("SELECT responsible_party_id FROM clinical_cases WHERE id=$1", [f.clinicalId]))[0].responsible_party_id,
  audit: (await q("SELECT count(*)::int AS n FROM audit_log WHERE action='case.responsibility_change' AND entity_id=$1", [String(f.patientId)]))[0].n });
const confirmBody = (fingerprint: string, doctorId: number) => ({ expectedSourceFingerprint: fingerprint, doctorId, reason: "Synthetic confirmation" });

it("default reception sees the suggestion read-only; saving is refused and writes nothing", async () => {
  const itemDoctor = await doctor("item doctor"), f = await fixture([itemDoctor.id]);
  const reception = await staff("reception");
  const view = await patientResponsibilitySettings(f.target, reception);
  expect(view).toMatchObject({ canConfirm: false, doctors: [], suggestion: { doctorId: itemDoctor.id, basis: "plan_items" } });
  await expect(patientResponsibilitySettings(f.target, reception, confirmBody(view.sourceFingerprint, itemDoctor.id))).rejects.toMatchObject({ status: 403 });
  expect(await writes(f)).toEqual({ responsible: null, audit: 0 });
});

it("a non-admin explicitly granted confirmation confirms without an admin role; audit names the actor and role", async () => {
  const itemDoctor = await doctor("item doctor"), f = await fixture([itemDoctor.id]);
  const reception = await staff("reception", { canConfirmCaseResponsibility: true });
  const view = await patientResponsibilitySettings(f.target, reception);
  expect(view.canConfirm).toBe(true);
  await patientResponsibilitySettings(f.target, reception, confirmBody(view.sourceFingerprint, itemDoctor.id));
  expect(await writes(f)).toEqual({ responsible: itemDoctor.id, audit: 1 });
  expect((await q("SELECT actor, actor_role FROM audit_log WHERE action='case.responsibility_change' AND entity_id=$1", [String(f.patientId)]))[0])
    .toEqual({ actor: reception.username, actor_role: "reception" });
});

it("revoking the grant after the window opened stops the save, even with a valid fingerprint", async () => {
  const itemDoctor = await doctor("item doctor"), f = await fixture([itemDoctor.id]);
  const reception = await staff("reception", { canConfirmCaseResponsibility: true });
  const view = await patientResponsibilitySettings(f.target, reception);
  await q("UPDATE users SET permissions=$2 WHERE id=$1", [reception.userId, JSON.stringify({ canConfirmCaseResponsibility: false })]);
  await expect(patientResponsibilitySettings(f.target, reception, confirmBody(view.sourceFingerprint, itemDoctor.id))).rejects.toMatchObject({ status: 403 });
  expect(await writes(f)).toEqual({ responsible: null, audit: 0 });
});

it("a doctor or cashier without a view grant is refused on read", async () => {
  const f = await fixture([(await doctor("item doctor")).id]);
  for (const role of ["doctor", "cashier"]) await expect(patientResponsibilitySettings(f.target, await staff(role))).rejects.toMatchObject({ status: 403 });
});

async function contextAs(session: Awaited<ReturnType<typeof staff>>, f: Awaited<ReturnType<typeof fixture>>) {
  auth.token = createSessionToken(session);
  const response = await returnContextRoute(new Request(`http://localhost/api/patients/${f.patientId}/return-booking-context?kind=clinical_case&sourceId=${f.clinicalId}`),
    { params: Promise.resolve({ id: String(f.patientId) }) });
  return { status: response.status, body: await response.json() };
}

it("reception's refused booking context shows the suggested doctor awaiting confirmation, and books normally after it", async () => {
  const itemDoctor = await doctor("item doctor"), f = await fixture([itemDoctor.id]);
  const reception = await staff("reception"), before = await state(f);
  expect(await contextAs(reception, f)).toMatchObject({ status: 409, body: { code: "responsibility_missing",
    responsibilitySuggestion: { doctorName: itemDoctor.name, basis: "plan_items", message: "بانتظار تأكيد المدير." } } });
  expect(await state(f)).toEqual(before);
  const confirmer = await admin(), view = await patientResponsibilitySettings(f.target, confirmer);
  await patientResponsibilitySettings(f.target, confirmer, confirmBody(view.sourceFingerprint, itemDoctor.id));
  const allowed = await contextAs(reception, f);
  expect(allowed).toMatchObject({ status: 200, body: { ok: true, doctorId: itemDoctor.id } });
  expect(allowed.body).not.toHaveProperty("responsibilitySuggestion");
});

it("no guessed name in the booking context: ambiguity says the administration must decide; no view grant shows nothing", async () => {
  const one = await doctor("first"), two = await doctor("second"), f = await fixture([one.id, two.id]);
  expect(await contextAs(await staff("reception"), f)).toMatchObject({ status: 409,
    body: { responsibilitySuggestion: { doctorName: null, basis: null, message: "تحديد الطبيب المسؤول مطلوب من الإدارة." } } });
  const single = await fixture([one.id]);
  expect((await contextAs(await staff("reception", { canViewResponsibilitySuggestion: false }), single)).body).toMatchObject({ code: "responsibility_missing", responsibilitySuggestion: null });
});
