/** M2 slice 79: canonical patient merge and delete on real PostgreSQL, synthetic data only.
 * patients.merge / patients.delete with every file inside the patient scope; the legacy
 * guards (financial and clinical history) refuse and roll back; the audit row commits
 * with the change; financial counts only with finance.patient-ledger.view; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-patient-lifecycle-secret-2026");
const db = await import("../../lib/db");
const life = await import("../../lib/canonical-patient-lifecycle");

const ACCOUNTS = {
  owner: { username: "SYN-PL-OWNER", role: "admin" },
  merger: { username: "SYN-PL-MERGE", role: "reception", patientScope: "all", grants: { "patients.edit": true, "patients.merge": true } },
  deleter: { username: "SYN-PL-DEL", role: "reception", patientScope: "all", grants: { "patients.edit": true, "patients.delete": true } },
  ledger: { username: "SYN-PL-LEDGER", role: "reception", patientScope: "all", grants: { "patients.edit": true, "patients.delete": true, "patients.merge": true, "finance.patient-ledger.view": true } },
  doctor: { username: "SYN-PL-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "patients.edit": true, "patients.merge": true, "patients.delete": true } },
  editor: { username: "SYN-PL-EDIT", role: "reception", patientScope: "all", grants: { "patients.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; counts?: Record<string, number> }) => error);
const patient = async (number: string, doctor: number | null = null, extra: { alert?: string } = {}) =>
  (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,medical_alert) VALUES ($1,$2,'0500000941',$3,$4) RETURNING id", [number, `SYN PL ${number}`, doctor, extra.alert ?? null]))[0].id as number;
const exists = async (id: number) => (await q("SELECT count(*)::int AS n FROM patients WHERE id=$1", [id]))[0].n === 1;
const audits = async (action: string, id: number) => (await q("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, id])).map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("merge", () => {
  it("merges a duplicate into the original with its audit in the same transaction; alerts are joined", async () => {
    const target = await patient("SYN-PL-T1", null, { alert: "حساسية بنسلين" });
    const source = await patient("SYN-PL-S1", null, { alert: "سكري" });
    const merged = await life.commandCanonicalPatientMerge(await fx.session("merger"), String(target), { duplicateNumber: "syn-pl-s1", reason: "ملف مكرر" });
    expect(merged.message).toContain("syn-pl-s1");
    expect(await exists(source)).toBe(false);
    expect(merged.patient).toMatchObject({ id: target, patientNumber: "SYN-PL-T1" });
    expect(merged.patient).not.toHaveProperty("medicalAlert");
    expect((await q("SELECT medical_alert FROM patients WHERE id=$1", [target]))[0].medical_alert).toBe("حساسية بنسلين؛ سكري");
    expect(await audits("patient.merge", target)).toEqual(["SYN-PL-MERGE"]);
  });

  it("a source with financial history is refused and rolled back; counts only with the ledger grant", async () => {
    const target = await patient("SYN-PL-T2");
    const source = await patient("SYN-PL-S2");
    await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'SAR',7000,'2026-01-01','SYN')", [source]);
    const plain = await refusal(life.commandCanonicalPatientMerge(await fx.session("merger"), String(target), { duplicateNumber: "SYN-PL-S2", reason: null }));
    expect(plain).toMatchObject({ code: "merge_source_has_financial_history", status: 409 });
    expect(plain?.counts).toBeUndefined();
    const ledger = await refusal(life.commandCanonicalPatientMerge(await fx.session("ledger"), String(target), { duplicateNumber: "SYN-PL-S2", reason: null }));
    expect(ledger?.counts).toMatchObject({ openingBalances: 1 });
    expect(await exists(source)).toBe(true);
    expect(await audits("patient.merge", target)).toEqual([]);
  });

  it("refuses without the grant, outside the scope and the same file — changing nothing", async () => {
    const target = await patient("SYN-PL-T3", fx.parties.doctor!);
    const outside = await patient("SYN-PL-S3");
    await expect(life.commandCanonicalPatientMerge(await fx.session("editor"), String(target), { duplicateNumber: "SYN-PL-S3", reason: null })).rejects.toThrow("CAPABILITY_DENIED");
    expect(await refusal(life.commandCanonicalPatientMerge(await fx.session("doctor"), String(target), { duplicateNumber: "SYN-PL-S3", reason: null })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(life.commandCanonicalPatientMerge(await fx.session("doctor"), String(outside), { duplicateNumber: "SYN-PL-T3", reason: null })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(life.commandCanonicalPatientMerge(await fx.session("merger"), String(target), { duplicateNumber: "SYN-PL-T3", reason: null })))
      .toMatchObject({ code: "merge_same_patient", status: 400 });
    expect(await exists(outside)).toBe(true);
    expect(() => life.parseCanonicalMerge({ duplicatePatientNumber: "SYN-PL-S3", confirmDuplicateNumber: "OTHER" })).toThrow();
  });
});

describe("delete", () => {
  it("deletes a file registered by mistake with its audit; the confirmation must match", async () => {
    const id = await patient("SYN-PL-D1");
    expect(await refusal(life.commandCanonicalPatientDelete(await fx.session("deleter"), String(id), { confirmNumber: "SYN-PL-XX", reason: null })))
      .toMatchObject({ status: 400 });
    expect(await exists(id)).toBe(true);
    const deleted = await life.commandCanonicalPatientDelete(await fx.session("deleter"), String(id), { confirmNumber: "SYN-PL-D1", reason: "تسجيل خاطئ" });
    expect(deleted.message).toContain("SYN PL SYN-PL-D1");
    expect(deleted.counts).not.toHaveProperty("payments");
    expect(await exists(id)).toBe(false);
    expect(await audits("patient.delete", id)).toEqual(["SYN-PL-DEL"]);
  });

  it("financial and clinical history refuse and roll back; financial counts only with the ledger grant", async () => {
    const money = await patient("SYN-PL-D2");
    await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'SAR',5000,'2026-01-01','SYN')", [money]);
    const plain = await refusal(life.commandCanonicalPatientDelete(await fx.session("deleter"), String(money), { confirmNumber: "SYN-PL-D2", reason: null }));
    expect(plain).toMatchObject({ code: "delete_has_financial_history", status: 409 });
    expect(plain?.counts).toBeUndefined();
    expect((await refusal(life.commandCanonicalPatientDelete(await fx.session("ledger"), String(money), { confirmNumber: "SYN-PL-D2", reason: null })))?.counts)
      .toMatchObject({ openingBalances: 1 });
    expect(await exists(money)).toBe(true);

    const clinical = await patient("SYN-PL-D3");
    await q("INSERT INTO patient_vitals (patient_id, pulse, recorded_by) VALUES ($1, 70, 'SYN')", [clinical]);
    const refused = await refusal(life.commandCanonicalPatientDelete(await fx.session("deleter"), String(clinical), { confirmNumber: "SYN-PL-D3", reason: null }));
    expect(refused).toMatchObject({ code: "delete_has_clinical_history", status: 409 });
    expect(refused?.counts).toMatchObject({ medicalHistory: 1 });
    expect(refused?.counts).not.toHaveProperty("payments");
    expect(refused?.counts).not.toHaveProperty("invoices");
    expect(await exists(clinical)).toBe(true);
    expect([...await audits("patient.delete", money), ...await audits("patient.delete", clinical)]).toEqual([]);
  });

  it("outside the scope reads as missing; revocation refuses an earlier session", async () => {
    const outside = await patient("SYN-PL-D4");
    expect(await refusal(life.commandCanonicalPatientDelete(await fx.session("doctor"), String(outside), { confirmNumber: "SYN-PL-D4", reason: null })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    const issued = await fx.session("deleter");
    await fx.setGrants("deleter", { "patients.edit": true }, { patientScope: "all" });
    try {
      await expect(life.commandCanonicalPatientDelete(issued, String(outside), { confirmNumber: "SYN-PL-D4", reason: null })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("deleter", { "patients.edit": true, "patients.delete": true }, { patientScope: "all" }); }
    expect(await exists(outside)).toBe(true);
  });
});
