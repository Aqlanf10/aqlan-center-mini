/** M2 slice 88b (owner decision G4-7): the case's responsible doctor on the canonical
 * runtime, real PostgreSQL, synthetic data only. The protected owner alone; finance grants,
 * patients.edit and clinical grants never reach it; a written reason; the audit records the
 * actor, the previous and the new doctor in the same transaction; a stale fingerprint and a
 * concurrent change refuse; nothing changes on refusal. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-case-responsibility-secret-88b");
const db = await import("../../lib/db");
const resp = await import("../../lib/canonical-case-responsibility");

const ACCOUNTS = {
  owner: { username: "SYN-CR-OWNER", role: "admin" },
  manager: { username: "SYN-CR-MGR", role: "admin", patientScope: "all", grants: {
    "patients.edit": true, "finance.patient-ledger.view": true, "finance.patient-ledger.manage": true, "clinical.plans.view": true, "clinical.plans.edit": true } },
  doctor: { username: "SYN-CR-DR", role: "doctor", doctor: true, patientScope: "all", grants: { "patients.edit": true, "clinical.ortho.view": true, "clinical.ortho.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status?: number; message?: string }) => error);

async function fixture() {
  const n = ++serial;
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'SYN CR patient') RETURNING id", [`SYN-CR-${n}`]);
  const doctors = await q("INSERT INTO parties(name,kind,is_active) VALUES ($1,'doctor',TRUE),($2,'doctor',TRUE) RETURNING id", [`SYN CR first ${n}`, `SYN CR second ${n}`]);
  const [clinical] = await q("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'endodontics','SYN case',$2,'SYN') RETURNING id", [patient.id, doctors[0].id]);
  return { target: { patientId: patient.id as number, kind: "clinical" as const, sourceId: clinical.id as number }, first: doctors[0].id as number, second: doctors[1].id as number };
}
const responsible = async (id: number) => (await q("SELECT responsible_party_id FROM clinical_cases WHERE id=$1", [id]))[0].responsible_party_id as number;
const auditsFor = async (patientId: number) => q("SELECT actor, details FROM audit_log WHERE action='case.responsibility_change' AND entity_id=$1::text", [patientId]);

beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); }, 180_000);
afterAll(async () => { await fx?.close(); });

describe("case responsibility", () => {
  it("the owner reads and changes it with a reason; the audit records the actor, previous and new doctor in the transaction", async () => {
    const f = await fixture(), owner = await fx.session("owner");
    const read = await resp.commandCanonicalCaseResponsibility(owner, f.target, undefined);
    expect(read).toMatchObject({ doctorId: f.first, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const changed = await resp.commandCanonicalCaseResponsibility(owner, f.target, { expectedSourceFingerprint: read.sourceFingerprint, doctorId: f.second, reason: "SYN reassignment" });
    expect(changed).toMatchObject({ doctorId: f.second });
    expect(await responsible(f.target.sourceId)).toBe(f.second);
    expect(await auditsFor(f.target.patientId)).toEqual([{ actor: "SYN-CR-OWNER",
      details: expect.objectContaining({ previousDoctorId: f.first, doctorId: f.second, reason: "SYN reassignment", actorUserId: fx.ids.owner }) }]);
  });

  it("never a finance grant, an administrative label, patients.edit or a clinical grant; nothing changes", async () => {
    const f = await fixture();
    const read = await resp.commandCanonicalCaseResponsibility(await fx.session("owner"), f.target, undefined);
    for (const key of ["manager", "doctor"] as const) {
      expect(await refusal(resp.commandCanonicalCaseResponsibility(await fx.session(key), f.target, undefined))).toMatchObject({ status: 403 });
      expect(await refusal(resp.commandCanonicalCaseResponsibility(await fx.session(key), f.target,
        { expectedSourceFingerprint: read.sourceFingerprint, doctorId: f.second, reason: "SYN not owner" }))).toMatchObject({ status: 403 });
    }
    expect(await responsible(f.target.sourceId)).toBe(f.first);
    expect(await auditsFor(f.target.patientId)).toEqual([]);
  });

  it("a written reason, a fresh fingerprint and an active doctor are required", async () => {
    const f = await fixture(), owner = await fx.session("owner");
    const read = await resp.commandCanonicalCaseResponsibility(owner, f.target, undefined);
    expect(await refusal(resp.commandCanonicalCaseResponsibility(owner, f.target, { expectedSourceFingerprint: read.sourceFingerprint, doctorId: f.second, reason: " " }))).toMatchObject({ status: 400 });
    await q("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=$1", [f.target.sourceId, f.second]);
    expect(await refusal(resp.commandCanonicalCaseResponsibility(owner, f.target, { expectedSourceFingerprint: read.sourceFingerprint, doctorId: f.first, reason: "SYN stale" }))).toMatchObject({ status: 409 });
    const fresh = await resp.commandCanonicalCaseResponsibility(owner, f.target, undefined);
    await q("UPDATE parties SET is_active=FALSE WHERE id=$1", [f.first]);
    expect(await refusal(resp.commandCanonicalCaseResponsibility(owner, f.target, { expectedSourceFingerprint: fresh.sourceFingerprint, doctorId: f.first, reason: "SYN inactive" }))).toMatchObject({ status: 409 });
    expect(await responsible(f.target.sourceId)).toBe(f.second);
    expect(await auditsFor(f.target.patientId)).toEqual([]);
  });

  it("a concurrent holder of the case row refuses instead of waiting (NOWAIT), and nothing changes", async () => {
    const f = await fixture(), owner = await fx.session("owner");
    const read = await resp.commandCanonicalCaseResponsibility(owner, f.target, undefined);
    const blocker = await fx.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM clinical_cases WHERE id=$1 FOR UPDATE", [f.target.sourceId]);
      expect(await refusal(resp.commandCanonicalCaseResponsibility(owner, f.target, { expectedSourceFingerprint: read.sourceFingerprint, doctorId: f.second, reason: "SYN contended" })))
        .toMatchObject({ status: 409 });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect(await responsible(f.target.sourceId)).toBe(f.first);
  });
});
