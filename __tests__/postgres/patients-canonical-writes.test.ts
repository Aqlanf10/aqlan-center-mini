/** M2 slice 8: canonical patient edit (PATCH /api/patients/[id]) and contact consent
 * (POST /api/patients/[id]/contact) on real PostgreSQL, synthetic data only. One
 * admitted `patients.edit` transaction each: the patient locked and inside the actor's
 * current scope (outside = missing), field groups by grant (nobody writes what it cannot
 * see), only sent fields written, audit atomic with the change. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-patient-writes-2026");
const db = await import("../../lib/db");
const writes = await import("../../lib/canonical-patient-writes");

const EDIT = { "patients.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-W-OWNER", role: "admin" },
  reception: { username: "SYN-W-RECEPTION", role: "reception", patientScope: "all", grants: EDIT },
  operational: { username: "SYN-W-OPS", role: "reception", patientScope: "all", grants: { ...EDIT, "patients.operational-summary.view": true } },
  clinical: { username: "SYN-W-CLINICAL", role: "reception", patientScope: "all", grants: { ...EDIT, "clinical.plans.view": true } },
  doctor: { username: "SYN-W-DOCTOR", role: "doctor", doctor: true, patientScope: "own", grants: { ...EDIT, "clinical.plans.view": true } },
  viewer: { username: "SYN-W-VIEWER", role: "reception", patientScope: "all", grants: {} },
  noScope: { username: "SYN-W-NOSCOPE", role: "reception", patientScope: "none", grants: EDIT },
  revoked: { username: "SYN-W-REVOKED", role: "reception", patientScope: "all", grants: EDIT },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let mine = 0, other = 0;

const update = async (k: Key, id: number, body: Record<string, unknown>) => writes.commandCanonicalPatientUpdate(await fx.session(k), id, body);
const consent = async (k: Key, id: number, body: Record<string, unknown>) => writes.commandCanonicalContactConsent(await fx.session(k), id, writes.parseContactConsentInput(body));
const row = async (id: number) => (await fx.pool.query("SELECT phone, address, medical_alert, note, flags FROM patients WHERE id=$1", [id])).rows[0];
const audits = async (id: number, action = "patient.update") => (await fx.pool.query<{ actor: string; details: Record<string, unknown> }>("SELECT actor, details FROM audit_log WHERE entity='patient' AND entity_id=$1::text AND action=$2 ORDER BY id", [id, action])).rows;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const insert = async (number: string, doctor: number | null) =>
    (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,medical_alert) VALUES($1,$2,'0500000000',$3,'Synthetic latex allergy') RETURNING id", [number, `SYN Write ${number}`, doctor])).rows[0].id;
  mine = await insert("SYN-W-1", fx.parties.doctor!);
  other = await insert("SYN-W-2", null);
  await fx.pool.query("INSERT INTO settings(key,value) VALUES('patients.flags','VIP,متابعة خاصة') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("field groups follow the read projection", () => {
  it("identity fields with patients.edit: only sent fields change; the audit row carries the canonical actor", async () => {
    const saved = await update("reception", other, { phone: "0511111111", address: "Synthetic street 1" });
    expect(saved).toMatchObject({ id: other, phone: "0511111111", address: "Synthetic street 1" });
    expect(saved).not.toHaveProperty("medicalAlert");
    expect(saved).not.toHaveProperty("flags");
    expect(await row(other)).toMatchObject({ phone: "0511111111", address: "Synthetic street 1", medical_alert: "Synthetic latex allergy" });
    const [audit] = await audits(other);
    expect(audit.actor).toBe("SYN-W-RECEPTION");
    expect(Object.keys(audit.details).length).toBeGreaterThan(0);
  });
  it("clinical fields and flags outside the actor's groups refuse the whole request, naming the field; nothing is written", async () => {
    await expect(update("reception", other, { phone: "0522222222", medicalAlert: "" })).rejects.toMatchObject({ code: "patient_field_not_granted", status: 403, field: "medicalAlert" });
    await expect(update("reception", other, { flags: ["VIP"] })).rejects.toMatchObject({ code: "patient_field_not_granted", field: "flags" });
    expect(await row(other)).toMatchObject({ phone: "0511111111", medical_alert: "Synthetic latex allergy", flags: [] });
  });
  it("the operational summary may set coordination flags, never clinical text", async () => {
    expect(await update("operational", other, { flags: ["VIP"] })).toMatchObject({ flags: ["VIP"] });
    await expect(update("operational", other, { note: "x" })).rejects.toMatchObject({ code: "patient_field_not_granted", field: "note" });
    await expect(update("operational", other, { flags: ["Unknown flag"] })).rejects.toMatchObject({ code: "invalid_patient_input", field: "flags" });
  });
  it("a clinical grant may edit the medical alert; the result shows the care fields", async () => {
    expect(await update("clinical", other, { medicalAlert: "Synthetic penicillin allergy" })).toMatchObject({ medicalAlert: "Synthetic penicillin allergy", flags: ["VIP"] });
    expect((await row(other)).medical_alert).toBe("Synthetic penicillin allergy");
  });
  it("validation is the creation rule on the merged record; unknown fields and empty requests refuse", async () => {
    await expect(update("reception", other, { fullName: "" })).rejects.toMatchObject({ code: "invalid_patient_input", status: 400 });
    await expect(update("reception", other, { isOwner: true })).rejects.toMatchObject({ code: "invalid_patient_input", field: "isOwner" });
    await expect(update("reception", other, {})).rejects.toMatchObject({ code: "invalid_patient_input" });
  });
});

describe("scope and capability", () => {
  it("own scope edits the clinician's own patient; another patient reads exactly like a missing one", async () => {
    await expect(update("doctor", mine, { address: "Synthetic own street" })).resolves.toMatchObject({ address: "Synthetic own street" });
    const outside = await update("doctor", other, { address: "x" }).catch(error => error);
    const missing = await update("doctor", 999_999, { address: "x" }).catch(error => error);
    expect(outside).toMatchObject({ code: "patient_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
  });
  it("no record scope or no patients.edit refuses at admission; a role label never widens it", async () => {
    await expect(update("noScope", other, { address: "x" })).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    await expect(update("viewer", other, { address: "x" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
  });
  it("revocation: the old session is refused, the fresh one has no grant", async () => {
    const session = await fx.session("revoked");
    await fx.setGrants("revoked", {}, { patientScope: "all" });
    await expect(writes.commandCanonicalPatientUpdate(session, other, { address: "x" })).rejects.toThrow(/^STAFF_OPERATION_/);
    await expect(update("revoked", other, { address: "x" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
  });
});

describe("atomicity and concurrency", () => {
  it("two concurrent edits of different fields both survive (row lock, sent fields only)", async () => {
    await Promise.all([update("reception", other, { phone: "0533333333" }), update("clinical", other, { note: "Synthetic concurrent note" })]);
    expect(await row(other)).toMatchObject({ phone: "0533333333", note: "Synthetic concurrent note", medical_alert: "Synthetic penicillin allergy" });
  });
  it("an audit failure leaves no change", async () => {
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_patient_audit_refuses CHECK (actor <> 'SYN-W-RECEPTION') NOT VALID");
    try {
      await expect(update("reception", other, { address: "Synthetic must not persist" })).rejects.toThrow();
      expect((await row(other)).address).toBe("Synthetic street 1");
    } finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_patient_audit_refuses"); }
  });
});

describe("contact consent", () => {
  it("records a consent with its audit row; scope, capability and input are enforced", async () => {
    const saved = await consent("reception", other, { channel: "whatsapp", granted: true, source: "in_person", note: " Synthetic note " });
    expect(saved).toMatchObject({ channel: "whatsapp", granted: true, recordedBy: "SYN-W-RECEPTION", note: "Synthetic note" });
    expect(await audits(other, "patient.contact_consent")).toHaveLength(1);
    await expect(consent("viewer", other, { channel: "whatsapp", granted: true, source: "in_person" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(consent("doctor", other, { channel: "whatsapp", granted: true, source: "in_person" })).rejects.toMatchObject({ code: "patient_not_found" });
    expect(() => writes.parseContactConsentInput({ channel: "fax", granted: true, source: "in_person" })).toThrow(expect.objectContaining({ field: "channel" }));
  });
});
