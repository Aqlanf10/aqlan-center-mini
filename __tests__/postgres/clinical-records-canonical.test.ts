/** M2 slice 74: canonical clinical record writes (medical history, vitals, intake,
 * diagnosis) on real PostgreSQL, synthetic data only. clinical.visits.document inside the
 * patient scope; the audit row commits with the record; idempotent by request key;
 * diagnosis needs the clinician link or the owner; revocation and concurrency. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-clinical-records-2026");
const db = await import("../../lib/db");
const rec = await import("../../lib/canonical-clinical-records");

const DOC = { "clinical.visits.document": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-CR-OWNER", role: "admin" },
  doctor: { username: "SYN-CR-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { ...DOC } },
  nurse: { username: "SYN-CR-NURSE", role: "assistant", patientScope: "all", grants: { ...DOC } },
  viewer: { username: "SYN-CR-VIEW", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const key = () => `syn-clinical-key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const ids = { mine: 0, other: 0, ortho: 0 };
const history = () => ({ answers: {}, allergies: [], medications: [], asaClass: null, bloodGroup: null, notes: "اصطناعي", patientConfirmed: true });

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000991',$3) RETURNING id", [number, `SYN CR ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-CR-1", fx.parties.doctor!);
  ids.other = await patient("SYN-CR-2", null);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("medical history, vitals and intake", () => {
  it("a double press writes one version; the audit row commits with it; a reused key is refused", async () => {
    const body = { requestKey: key(), ...history() };
    const [a, b] = await Promise.all([rec.commandCanonicalMedicalHistory(await fx.session("nurse"), String(ids.mine), body), rec.commandCanonicalMedicalHistory(await fx.session("nurse"), String(ids.mine), body)]);
    expect(a.id).toBe(b.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await q("SELECT count(*)::int AS n FROM patient_medical_history WHERE patient_id=$1", [ids.mine]))[0].n).toBe(1);
    expect((await q("SELECT actor FROM audit_log WHERE action='patient.medical_history' AND details->>'requestKey'=$1", [body.requestKey])).map(row => row.actor)).toEqual(["SYN-CR-NURSE"]);
    expect(await refusal(rec.commandCanonicalMedicalHistory(await fx.session("nurse"), String(ids.mine), { ...body, notes: "آخر" })))
      .toMatchObject({ code: "clinical_request_key_reused", status: 409 });
  });
  it("vitals with the alert in the same transaction; a future date and a missing key are refused without writing", async () => {
    const saved = await rec.commandCanonicalVitals(await fx.session("doctor"), String(ids.mine), { requestKey: key(), bpSystolic: 120, bpDiastolic: 80, pulse: 70, medicalAlert: "ضغط اصطناعي" });
    expect(saved).toMatchObject({ patientId: ids.mine, bpSystolic: 120, medicalAlert: "ضغط اصطناعي", replayed: false });
    expect((await q("SELECT medical_alert FROM patients WHERE id=$1", [ids.mine]))[0].medical_alert).toBe("ضغط اصطناعي");
    expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='patient.vitals' AND details->>'القراءة'=$1::text", [saved.id]))[0].n).toBe(1);
    const before = (await q("SELECT count(*)::int AS n FROM patient_vitals"))[0].n;
    expect(await refusal(rec.commandCanonicalVitals(await fx.session("doctor"), String(ids.mine), { requestKey: key(), pulse: 70, recordedAt: "2999-01-01" })))
      .toMatchObject({ code: "invalid_clinical_record", status: 400 });
    expect(await refusal(rec.commandCanonicalVitals(await fx.session("doctor"), String(ids.mine), { pulse: 70 }))).toMatchObject({ field: "requestKey" });
    expect((await q("SELECT count(*)::int AS n FROM patient_vitals"))[0].n).toBe(before);
  });
  it("intake by staff with its audit; outside the scope reads as missing; a grant without documentation is refused", async () => {
    const intake = await rec.commandCanonicalIntake(await fx.session("doctor"), String(ids.mine), { requestKey: key(), conditions: [], allergies: "لا شيء" });
    expect(intake.replayed).toBe(false);
    expect((await q("SELECT actor FROM audit_log WHERE action='intake.staff' AND details->>'الاستمارة'=$1::text", [intake.id])).map(row => row.actor)).toEqual(["SYN-CR-DOC"]);
    expect(await refusal(rec.commandCanonicalIntake(await fx.session("doctor"), String(ids.other), { requestKey: key(), conditions: [] })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    await expect(rec.commandCanonicalIntake(await fx.session("viewer"), String(ids.mine), { requestKey: key(), conditions: [] })).rejects.toThrow("CAPABILITY_DENIED");
  });
});

describe("diagnosis", () => {
  const content = () => ({ crowding: "ازدحام اصطناعي" });
  it("the linked clinician writes versions in order; concurrent writes get distinct versions; the nurse without a clinician link is refused", async () => {
    const doctor = await fx.session("doctor");
    const [a, b] = await Promise.all([
      rec.commandCanonicalDiagnosis(doctor, String(ids.mine), { requestKey: key(), content: content(), label: "أ" }),
      rec.commandCanonicalDiagnosis(await fx.session("doctor"), String(ids.mine), { requestKey: key(), content: content(), label: "ب" }),
    ]);
    expect([a.version, b.version].sort()).toEqual([1, 2]);
    expect(await refusal(rec.commandCanonicalDiagnosis(await fx.session("nurse"), String(ids.mine), { requestKey: key(), content: content() })))
      .toMatchObject({ code: "diagnosis_clinician_required", status: 403 });
    expect((await q("SELECT count(*)::int AS n FROM patient_diagnoses WHERE patient_id=$1", [ids.mine]))[0].n).toBe(2);
    expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='diagnosis.create' AND details->>'المريض'=$1::text", [ids.mine]))[0].n).toBe(2);
  });
  it("the owner may write (with or without a key); a foreign case is refused; revocation refuses an earlier session", async () => {
    expect((await rec.commandCanonicalDiagnosis(await fx.session("owner"), String(ids.other), { requestKey: key(), content: content() })).version).toBe(1);
    // The reviewed panel's exact body (no key) writes one version under the advisory lock.
    expect((await rec.commandCanonicalDiagnosis(await fx.session("owner"), String(ids.other), { content: content(), label: null, orthoCaseId: null })).version).toBe(2);
    expect(await refusal(rec.commandCanonicalDiagnosis(await fx.session("doctor"), String(ids.mine), { requestKey: key(), content: content(), orthoCaseId: 999999 })))
      .toMatchObject({ code: "invalid_clinical_record", status: 400 });
    const issued = await fx.session("doctor");
    await fx.setGrants("doctor", {}, { patientScope: "own" });
    try {
      await expect(rec.commandCanonicalDiagnosis(issued, String(ids.mine), { requestKey: key(), content: content() })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("doctor", { ...DOC }, { patientScope: "own" }); }
    expect((await q("SELECT count(*)::int AS n FROM patient_diagnoses WHERE patient_id=$1", [ids.mine]))[0].n).toBe(2);
  });
});
