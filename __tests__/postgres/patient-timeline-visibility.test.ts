import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateLocalVerificationTarget, validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import type { PatientTimelineReadScope } from "../../lib/patient-timeline-read";

// Source authored only. Before application import, require the existing disposable
// loopback PostgreSQL lane. No new database/server, schema drops, fixture deletion,
// grants, live roles, production targets or unlinked-visit fixtures.
validateOperationalVerificationEnvironment(process.env);
if (process.env.USE_LOCAL_DB === "true") throw new Error("Timeline visibility contract requires PostgreSQL, not PGlite.");
const target = validateLocalVerificationTarget(process.env.TEST_DATABASE_URL, process.env, {
  varName: "TEST_DATABASE_URL", databaseName: "aqlan_p1_test",
});
vi.stubEnv("DATABASE_URL", target.toString()); vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("SKIP_SEED", "true");
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.getPool().query(sql, values)).rows as T[];
const namespace = `TL-SCOPE-${randomUUID()}`;
// Counter reseeding extracts ALL digits from patient/invoice/receipt codes.
// Keep UUIDs in labels; numbering uses an alphabetic unique prefix plus a bounded
// numeric suffix, checked before every sequence-aligned insert below.
const numberNamespace = namespace.replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)));
function documentCode(kind: "patient" | "invoice" | "receipt", fixtureIndex: number, rowIndex = 0) {
  expect(Number.isSafeInteger(fixtureIndex) && fixtureIndex > 0 && fixtureIndex < 1000).toBe(true);
  expect(Number.isSafeInteger(rowIndex) && rowIndex >= 0 && rowIndex < 100).toBe(true);
  const code = `${numberNamespace}-${kind}-${880000 + fixtureIndex * 100 + rowIndex}`;
  const extracted = code.replace(/\D/g, "");
  expect(extracted).toMatch(/^[0-9]{1,10}$/);
  expect(BigInt(extracted) <= 9223372036854775807n).toBe(true);
  return code;
}
let reader = 0; let provider = 0; let shift = 0; let sequence = 0;
beforeAll(async () => {
  await db.ensureSchema();
  reader = (await q<{ id: number }>("INSERT INTO parties (kind, name) VALUES ('doctor', $1) RETURNING id", [`${namespace} reader`]))[0].id;
  provider = (await q<{ id: number }>("INSERT INTO parties (kind, name) VALUES ('doctor', $1) RETURNING id", [`${namespace} provider`]))[0].id;
  shift = (await q<{ id: number }>(`INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at)
    VALUES ($1, 'closed', $1, '2026-09-30T12:00:00Z') RETURNING id`, [namespace]))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); vi.unstubAllEnvs(); });

async function fixture() {
  const fixtureIndex = ++sequence;
  const tag = `${namespace}-${fixtureIndex}`;
  const patient = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, 'Synthetic linked timeline patient', $2) RETURNING id`, [documentCode("patient", fixtureIndex), provider]))[0].id;
  const invoice = (await q<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_at)
    VALUES ($1, $2, 123456, 789, 'USD', '2026-09-29T09:00:00Z') RETURNING id`, [documentCode("invoice", fixtureIndex), patient]))[0].id;
  const visibleAppointment = (await q<{ id: number }>(`INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id, status)
    VALUES ($1, '2026-09-01', '10:00', NULL, 'done') RETURNING id`, [patient]))[0].id;
  const visit = (await q<{ id: number }>(`INSERT INTO visits
    (patient_id, patient_name, doctor_id, invoice_id, appointment_id, status, signed_at, signed_by, treatment_done)
    VALUES ($1, 'Synthetic linked timeline patient', $2, $3, $4, 'done', '2026-09-01T09:00:00Z', $5, 'CLINICAL_LINKED_SENTINEL') RETURNING id`,
    [patient, provider, invoice, visibleAppointment, namespace]))[0].id;
  expect(await q("SELECT patient_id, doctor_id, invoice_id, appointment_id FROM visits WHERE id = $1", [visit]))
    .toEqual([{ patient_id: patient, doctor_id: provider, invoice_id: invoice, appointment_id: visibleAppointment }]);
  // Every hidden source exceeds the requested cap and is newer than readable
  // clinical work. Filtering a completed capped array would incorrectly starve it.
  for (let i = 0; i < 12; i++) {
    const stamp = `2026-09-${String(10 + i).padStart(2, "0")}T12:00:00Z`;
    const hiddenInvoice = (await q<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_at)
      VALUES ($1, $2, 999999, 0, 'SAR', $3) RETURNING id`, [documentCode("invoice", fixtureIndex, i + 1), patient, stamp]))[0].id;
    await q(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method, created_at)
      VALUES ($1, $2, $3, $4, 'payment', 888888, 'SAR', 1, 888888, 'SAR', 'HIDDEN_METHOD', $5)`, [documentCode("receipt", fixtureIndex, i + 1), patient, hiddenInvoice, shift, stamp]);
    await q(`INSERT INTO treatment_plans (patient_id, title, total_minor, created_at)
      VALUES ($1, $2, 777777, $3)`, [patient, `HIDDEN_PLAN_${tag}_${i}`, stamp]);
    await q(`INSERT INTO patient_documents (patient_id, visit_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by, uploaded_at)
      VALUES ($1, $2, 'other', $3, 'application/pdf', 0, $4, $5, $6, $7)`,
      [patient, visit, `HIDDEN_FILE_${tag}_${i}`, "a".repeat(64), `${tag}-${i}.pdf`, namespace, stamp]);
    await q(`INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id, status, note)
      VALUES ($1, $2::date, '11:00', $3, 'done', 'HIDDEN_APPOINTMENT')`, [patient, stamp.slice(0, 10), provider]);
  }
  const ownedPatientIds = await db.doctorOwnedPatientIds(reader, [patient]);
  expect(ownedPatientIds).toEqual(new Set());
  const denied: PatientTimelineReadScope = { plans: false, documents: false, financial: false,
    appointments: { kind: "doctor", doctorPartyId: reader, ownedPatientIds } };
  return { tag, patient, invoice, visibleAppointment, visit, denied };
}

const snapshot = async (patient: number) => ({
  visits: await q("SELECT * FROM visits WHERE patient_id = $1 ORDER BY id", [patient]),
  invoices: await q("SELECT * FROM invoices WHERE patient_id = $1 ORDER BY id", [patient]),
  payments: await q("SELECT * FROM payments WHERE patient_id = $1 ORDER BY id", [patient]),
  plans: await q("SELECT * FROM treatment_plans WHERE patient_id = $1 ORDER BY id", [patient]),
  documents: await q("SELECT * FROM patient_documents WHERE patient_id = $1 ORDER BY id", [patient]),
  appointments: await q("SELECT * FROM appointments WHERE patient_id = $1 ORDER BY id", [patient]),
});

describe("linked patient timeline SQL source scope", () => {
  it("filters forbidden sources and actual appointment provider rows before source/global caps", async () => {
    const f = await fixture(); const before = await snapshot(f.patient);
    const events = await db.patientTimeline(f.patient, 10, f.denied);
    expect(events.map((event) => event.key)).toEqual([`appointment:${f.visibleAppointment}`, `visit:${f.visit}`]);
    expect(events.find((event) => event.kind === "visit")).toMatchObject({ detail: "CLINICAL_LINKED_SENTINEL", amountMinor: null, currency: null });
    for (const hidden of ["HIDDEN_", "999999", "888888", "777777", "invoice:", "payment:", "plan:", "document:", "tab=account", "tab=files"])
      expect(JSON.stringify(events)).not.toContain(hidden);
    expect(await snapshot(f.patient)).toEqual(before);
  });
  it("explicit no-calendar scope hides even unassigned rows without hiding visits", async () => {
    const f = await fixture();
    const events = await db.patientTimeline(f.patient, 10, { ...f.denied, appointments: { kind: "none" } });
    expect(events.map((event) => event.key)).toEqual([`visit:${f.visit}`]);
  });
  it("preserves full/owned scope and deliberate internal-reader currency compatibility", async () => {
    const f = await fixture();
    const all = await db.patientTimeline(f.patient, 200, { plans: true, documents: true, financial: true, appointments: { kind: "all" } });
    expect(await db.patientTimeline(f.patient, 200)).toEqual(all);
    expect(all.find((event) => event.key === `invoice:${f.invoice}`)).toMatchObject({ amountMinor: 122667, currency: "USD" });
    expect(all.filter((event) => event.kind === "appointment")).toHaveLength(13);
    // Synthetic fixture authority witness, not a live user/role/grant change.
    await q("UPDATE patients SET primary_doctor_id = $2 WHERE id = $1", [f.patient, reader]);
    const ownedPatientIds = await db.doctorOwnedPatientIds(reader, [f.patient]);
    expect(ownedPatientIds).toEqual(new Set([f.patient]));
    const owned = await db.patientTimeline(f.patient, 200, { ...f.denied,
      appointments: { kind: "doctor", doctorPartyId: reader, ownedPatientIds } });
    expect(owned.filter((event) => event.kind === "appointment")).toEqual(all.filter((event) => event.kind === "appointment"));
  });
  it("permits actual own-provider rows added after ownership scope resolution", async () => {
    const f = await fixture();
    expect(f.denied.appointments.kind).toBe("doctor");
    const own = (await q<{ id: number }>(`INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id, status)
      VALUES ($1, '2026-09-02', '10:00', $2, 'done') RETURNING id`, [f.patient, reader]))[0].id;
    const events = await db.patientTimeline(f.patient, 10, f.denied);
    expect(events.filter((event) => event.kind === "appointment").map((event) => event.key))
      .toEqual([`appointment:${own}`, `appointment:${f.visibleAppointment}`]);
  });
  it("requires actual appointment patient identity even with full-calendar scope", async () => {
    const requested = await fixture(); const other = await fixture();
    const events = await db.patientTimeline(requested.patient, 200, { ...requested.denied, appointments: { kind: "all" } });
    expect(events.filter((event) => event.kind === "appointment")).toHaveLength(13);
    expect(events.some((event) => event.key === `appointment:${other.visibleAppointment}`)).toBe(false);
  });
  it("preserves Endo visit, diagnosis, ortho, lab and scheduled clinical referral progression with every optional source denied", async () => {
    const f = await fixture();
    const caseId = (await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, created_by)
      VALUES ($1, 'endodontics', 'CLINICAL_CASE', $2) RETURNING id`, [f.patient, namespace]))[0].id;
    const endoId = (await q<{ id: number }>(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by)
      VALUES ($1, $2, 36, $3) RETURNING id`, [f.patient, caseId, namespace]))[0].id;
    await q(`INSERT INTO endo_visits (treatment_id, visit_id, doctor_id, stage, recorded_by)
      VALUES ($1, $2, $3, 'shaping', $4)`, [endoId, f.visit, provider, namespace]);
    await q(`INSERT INTO patient_diagnoses (patient_id, visit_id, content, label, created_by, created_at)
      VALUES ($1, $2, '{}', 'CLINICAL_DIAGNOSIS', $3, '2026-09-01T09:00:00Z')`, [f.patient, f.visit, namespace]);
    const orthoId = (await q<{ id: number }>(`INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, $2) RETURNING id`, [f.patient, namespace]))[0].id;
    await q(`INSERT INTO ortho_adjustments (case_id, visit_id, done, recorded_by, recorded_at)
      VALUES ($1, $2, 'CLINICAL_ORTHO', $3, '2026-09-01T09:00:00Z')`, [orthoId, f.visit, namespace]);
    await q(`INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, created_at)
      VALUES ($1, 'Synthetic lab', 'CLINICAL_LAB', '2026-09-01', '2026-09-01T09:00:00Z')`, [f.patient]);
    const referralId = (await q<{ id: number }>(`INSERT INTO patient_referrals
      (patient_id, to_name, to_specialty, reason, created_by, kind, to_party_id, doctor_party_id, workflow_state)
      VALUES ($1, 'CLINICAL_RECIPIENT', 'endodontics', 'CLINICAL_REASON', $2, 'internal', $3, $3, 'scheduled') RETURNING id`, [f.patient, namespace, provider]))[0].id;
    await q(`INSERT INTO audit_log (action, entity, entity_id, summary, details, actor, created_at)
      VALUES ('referral.schedule', 'patient', $1, 'Synthetic scheduled clinical progression', $2::jsonb, $3, '2026-09-01T09:00:00Z')`,
      [String(f.patient), JSON.stringify({ الإحالة: referralId }), namespace]);
    const before = await snapshot(f.patient);
    const clinicalOnly = await db.patientTimeline(f.patient, 10, { ...f.denied, appointments: { kind: "none" } });
    expect(clinicalOnly.map((event) => event.kind).sort()).toEqual(["diagnosis", "lab", "ortho", "referral", "visit"]);
    expect(clinicalOnly.find((event) => event.kind === "visit")).toMatchObject({ specialties: ["rct"], caseTitle: "CLINICAL_CASE" });
    expect(clinicalOnly.find((event) => event.kind === "visit")?.title).toContain("علاج جذور سن 36");
    expect(clinicalOnly.find((event) => event.kind === "referral")?.title).toContain("CLINICAL_RECIPIENT");
    const full = await db.patientTimeline(f.patient, 200);
    expect(clinicalOnly).toEqual(full.filter((event) => ["visit", "diagnosis", "ortho", "lab", "referral"].includes(event.kind)));
    expect(await snapshot(f.patient)).toEqual(before);
  });
});
