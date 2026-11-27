/** M2 slice 95d (G4-1, G4-6; contract section 15, "95d detail", point 9): the previous-balance
 * collection arrangement on the canonical runtime, real PostgreSQL, synthetic data only. Create and
 * cancel by finance.legacy.record with finance.patient-ledger.view; other grants and the label
 * never act; the audit row is written with the arrangement; outside reads as missing, decided
 * after the patient row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-legacy-arrangement-secret-95d");
const db = await import("../../lib/db");
const writes = await import("../../lib/canonical-legacy-arrangements");

const LEDGER = { "finance.patient-ledger.view": true };
const RECORD = { "finance.legacy.record": true };
const ACCOUNTS = {
  owner: { username: "SYN-LA-OWNER", role: "admin" },
  arranger: { username: "SYN-LA-ARR", role: "reception", patientScope: "all", grants: { ...RECORD, ...LEDGER } },
  blind: { username: "SYN-LA-BLIND", role: "admin", patientScope: "all", grants: RECORD },
  ledger: { username: "SYN-LA-LEDGER", role: "accountant", patientScope: "all", grants: { ...LEDGER, "finance.opening-balances.manage": true } },
  historian: { username: "SYN-LA-HIST", role: "reception", patientScope: "all", grants: { ...LEDGER, "patients.history.record": true } },
  label: { username: "SYN-LA-LABEL", role: "admin", patientScope: "all", grants: {} },
  receptionLabel: { username: "SYN-LA-RCPT", role: "reception", patientScope: "all", grants: {} },
  doctor: { username: "SYN-LA-DR", role: "doctor", doctor: true, patientScope: "own", grants: { ...RECORD, ...LEDGER } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { reason?: string; code?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
/** A patient with a previous balance of 90,000 YER. */
async function patient(doctor: number | null = null, opening = true) {
  const id = (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN LA patient',$2) RETURNING id", [`SYN-LA-${++serial}`, doctor]))[0].id as number;
  if (opening) await db.setPatientOpeningBalance({ patientId: id, currency: "YER", amountMinor: 90000, asOfDate: "2025-01-01", note: "SYN opening", createdBy: "SYN-LA-OWNER", reason: "SYN opening" });
  return id;
}
const input = (extra: Record<string, unknown> = {}) => ({ currency: "YER" as const, cadence: "per_visit" as const, installmentMinor: 10000, firstDueDate: null, note: "SYN note", today: "2026-11-10", ...extra });
const stored = async (p: number) => q("SELECT id, created_by, cancelled_by, cancel_reason FROM legacy_balance_arrangements WHERE patient_id=$1 ORDER BY id", [p]);
const audits = async (p: number) => (await q("SELECT action, actor FROM audit_log WHERE action LIKE 'legacy_balance_arrangement.%' AND entity_id=$1::text ORDER BY id", [p]));

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("previous-balance arrangement on the canonical runtime", () => {
  it("create and cancel by finance.legacy.record with the ledger view; legacy refusals; audited with the write", async () => {
    const p = await patient(), arranger = await fx.session("arranger");
    const made = await writes.commandCanonicalLegacyArrangement(arranger, p, input());
    expect(made).toMatchObject({ patientId: p, currency: "YER", cadence: "per_visit", installmentMinor: 10000, startingDueMinor: 90000, createdBy: "SYN-LA-ARR" });
    expect(await refusal(writes.commandCanonicalLegacyArrangement(arranger, p, input()))).toMatchObject({ reason: "already_active" });
    expect(await refusal(writes.commandCanonicalLegacyArrangementCancel(arranger, p, { arrangementId: 2_000_000_000, reason: "SYN cancel" }))).toMatchObject({ reason: "not_found" });
    expect(await writes.commandCanonicalLegacyArrangementCancel(arranger, p, { arrangementId: made.id, reason: "SYN cancel" })).toEqual({ ok: true });
    expect(await refusal(writes.commandCanonicalLegacyArrangementCancel(arranger, p, { arrangementId: made.id, reason: "SYN cancel" }))).toMatchObject({ reason: "already_cancelled" });
    expect(await stored(p)).toEqual([{ id: made.id, created_by: "SYN-LA-ARR", cancelled_by: "SYN-LA-ARR", cancel_reason: "SYN cancel" }]);
    expect(await audits(p)).toEqual([{ action: "legacy_balance_arrangement.create", actor: "SYN-LA-ARR" }, { action: "legacy_balance_arrangement.cancel", actor: "SYN-LA-ARR" }]);
    // The refused attempts wrote no audit row and no arrangement.
    expect(await refusal(writes.commandCanonicalLegacyArrangement(arranger, p, input({ installmentMinor: 90001 })))).toMatchObject({ reason: "installment_exceeds_remaining" });
    const bare = await patient(null, false);
    expect(await refusal(writes.commandCanonicalLegacyArrangement(arranger, bare, input()))).toMatchObject({ reason: "no_opening_balance" });
    expect(await stored(bare)).toEqual([]); expect(await audits(bare)).toEqual([]); expect(await audits(p)).toHaveLength(2);
  });

  it("the ledger view is required; other grants and the labels never create or cancel", async () => {
    const p = await patient();
    const { id } = await writes.commandCanonicalLegacyArrangement(await fx.session("arranger"), p, input());
    const blind = await fx.session("blind");
    expect(await refusal(writes.commandCanonicalLegacyArrangement(blind, p, input({ currency: "SAR" })))).toMatchObject({ code: "ledger_view_required" });
    expect(await refusal(writes.commandCanonicalLegacyArrangementCancel(blind, p, { arrangementId: id, reason: "SYN cancel" }))).toMatchObject({ code: "ledger_view_required" });
    for (const key of ["ledger", "historian", "label", "receptionLabel"] as const) {
      expect(await refusal(writes.commandCanonicalLegacyArrangement(await fx.session(key), p, input({ currency: "SAR" }))), key).toMatchObject(denied);
      expect(await refusal(writes.commandCanonicalLegacyArrangementCancel(await fx.session(key), p, { arrangementId: id, reason: "SYN cancel" })), key).toMatchObject(denied);
    }
    expect(await stored(p)).toEqual([{ id, created_by: "SYN-LA-ARR", cancelled_by: null, cancel_reason: null }]);
    expect(await audits(p)).toHaveLength(1);
  });

  it("own outside reads like missing for create and cancel; inside the own scope the grants act; revocation", async () => {
    const outside = await patient(), doctor = await fx.session("doctor");
    const { id } = await writes.commandCanonicalLegacyArrangement(await fx.session("arranger"), outside, input());
    const out = await refusal(writes.commandCanonicalLegacyArrangement(doctor, outside, input({ currency: "SAR" })));
    const missing = await refusal(writes.commandCanonicalLegacyArrangement(doctor, 2_000_000_000, input()));
    expect(out).toMatchObject({ reason: "patient_not_found" }); expect(out?.reason).toBe(missing?.reason);
    const cancelOut = await refusal(writes.commandCanonicalLegacyArrangementCancel(doctor, outside, { arrangementId: id, reason: "SYN cancel" }));
    const cancelMissing = await refusal(writes.commandCanonicalLegacyArrangementCancel(doctor, 2_000_000_000, { arrangementId: id, reason: "SYN cancel" }));
    expect(cancelOut).toMatchObject({ reason: "not_found" }); expect(cancelOut?.reason).toBe(cancelMissing?.reason);
    expect(await stored(outside)).toEqual([{ id, created_by: "SYN-LA-ARR", cancelled_by: null, cancel_reason: null }]);
    const own = await patient(fx.parties.doctor!);
    expect(await writes.commandCanonicalLegacyArrangement(doctor, own, input())).toMatchObject({ createdBy: "SYN-LA-DR" });
    await fx.setGrants("arranger", {}, { patientScope: "all" });
    try { expect(await refusal(writes.commandCanonicalLegacyArrangement(await fx.session("arranger"), await patient(), input()))).toMatchObject(denied); }
    finally { await fx.setGrants("arranger", { ...RECORD, ...LEDGER }, { patientScope: "all" }); }
  });

  it("refuses a patient that leaves the clinician's scope while the create waits for the patient row", async () => {
    const pid = await patient(fx.parties.doctor!), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [pid]);
      pending = refusal(writes.commandCanonicalLegacyArrangement(session, pid, input()));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id = $1 FOR SHARE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ reason: "patient_not_found" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await stored(pid)).toEqual([]);
    expect(await audits(pid)).toEqual([]);
  });
});
