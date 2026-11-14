/** M2 slice 95b (G4-1, G4-6; contract section 15): pre-system treatments on the canonical runtime,
 * real PostgreSQL, synthetic data only. Record by finance.legacy.record (an existing opening also
 * needs finance.opening-balances.manage); preview with opening amounts only for the ledger view;
 * void with finance.legacy.void and the ledger view (the exception mode also opening management);
 * other grants, the label and the reception setting never act; outside reads as missing, decided
 * after the patient row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-legacy-writes-secret-95b");
const db = await import("../../lib/db");
const writes = await import("../../lib/canonical-legacy-writes");
const { parseLegacyTreatmentRequest } = await import("../../lib/legacy-treatment");

const LEDGER = { "finance.patient-ledger.view": true };
const RECORD = { "finance.legacy.record": true };
const ACCOUNTS = {
  owner: { username: "SYN-LW-OWNER", role: "admin" },
  recorder: { username: "SYN-LW-REC", role: "reception", patientScope: "all", grants: RECORD },
  manager: { username: "SYN-LW-MGR", role: "reception", patientScope: "all", grants: { ...RECORD, ...LEDGER, "finance.opening-balances.manage": true } },
  voider: { username: "SYN-LW-VOID", role: "reception", patientScope: "all", grants: { ...RECORD, ...LEDGER, "finance.legacy.void": true } },
  blindVoider: { username: "SYN-LW-BVOID", role: "reception", patientScope: "all", grants: { ...RECORD, "finance.legacy.void": true } },
  ledger: { username: "SYN-LW-LEDGER", role: "accountant", patientScope: "all", grants: LEDGER },
  historian: { username: "SYN-LW-HIST", role: "reception", patientScope: "all", grants: { "patients.history.record": true } },
  collector: { username: "SYN-LW-COLL", role: "cashier", patientScope: "all", grants: { "finance.payments.collect": true } },
  label: { username: "SYN-LW-LABEL", role: "admin", patientScope: "all", grants: {} },
  receptionLabel: { username: "SYN-LW-RCPT", role: "reception", patientScope: "all", grants: {} },
  doctor: { username: "SYN-LW-DR", role: "doctor", doctor: true, patientScope: "own", grants: { ...RECORD, ...LEDGER, "finance.legacy.void": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0, crown = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { reason?: string; code?: string; message?: string; name?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN LW patient',$2) RETURNING id", [`SYN-LW-${++serial}`, doctor]))[0].id as number;
function request(tooth = 14, extra: Record<string, unknown> = {}) {
  const parsed = parseLegacyTreatmentRequest({ serviceId: crown, toothCode: tooth, sessions: 1, currency: "YER", agreedAmount: "300000",
    previouslyPaidAmount: "120000", historicalAsOf: "2025-01-01", idempotencyKey: `syn-lw-${++serial}-key`, ...extra }, "2026-11-07");
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}
const opening = async (p: number) => (await q("SELECT amount_minor::int AS amount FROM patient_opening_balances WHERE patient_id=$1 AND currency='YER'", [p]))[0]?.amount ?? null;
const agreements = async (p: number) => q("SELECT id, status, created_by FROM legacy_treatment_agreements WHERE patient_id=$1 ORDER BY id", [p]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  crown = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('SYN LW crown','crown',300000,TRUE,TRUE) RETURNING id"))[0].id;
  await q("INSERT INTO settings(key,value) VALUES('finance.reception_adds_opening_balance','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("pre-system treatment writes", () => {
  it("record adds an opening by finance.legacy.record; increasing it needs opening management; the key replays", async () => {
    const p = await patient(), recorder = await fx.session("recorder"), first = request(14);
    const made = await writes.commandCanonicalLegacyTreatment(recorder, p, first);
    expect(made).toMatchObject({ replayed: false, agreement: { patientId: p, createdBy: "SYN-LW-REC", status: "live", remainingMinor: 180000 } });
    expect(await opening(p)).toBe(180000);
    expect(await writes.commandCanonicalLegacyTreatment(recorder, p, first)).toMatchObject({ replayed: true, agreement: { id: made.agreement.id } });
    expect(await refusal(writes.commandCanonicalLegacyTreatment(recorder, p, request(15)))).toMatchObject({ reason: "opening_edit_forbidden" });
    expect(await opening(p)).toBe(180000);
    expect(await writes.commandCanonicalLegacyTreatment(await fx.session("manager"), p, request(15))).toMatchObject({ replayed: false });
    expect(await opening(p)).toBe(360000);
    expect((await agreements(p)).map(row => row.created_by)).toEqual(["SYN-LW-REC", "SYN-LW-MGR"]);
  });

  it("other grants, the label and the reception setting never record; the preview hides opening amounts without the ledger view", async () => {
    const p = await patient();
    for (const key of ["ledger", "historian", "collector", "label", "receptionLabel"] as const) {
      expect(await refusal(writes.commandCanonicalLegacyTreatment(await fx.session(key), p, request(16))), key).toMatchObject(denied);
      expect(await refusal(writes.readCanonicalLegacyTreatmentPreview(await fx.session(key), p, request(16))), key).toMatchObject(denied);
    }
    expect(await agreements(p)).toEqual([]);
    // A new opening: the record grant sees the effect, not the amount; the ledger view sees both.
    const blind = await writes.readCanonicalLegacyTreatmentPreview(await fx.session("recorder"), p, request(17));
    expect(blind).toMatchObject({ ok: true, preview: { opening: { effect: "created", beforeMinor: null, afterMinor: null } } });
    expect(await writes.readCanonicalLegacyTreatmentPreview(await fx.session("manager"), p, request(17)))
      .toMatchObject({ ok: true, preview: { opening: { effect: "created", beforeMinor: null, afterMinor: 180000 } } });
    // An increase: refused for the record grant alone (as the writer refuses it), shown with opening management.
    await writes.commandCanonicalLegacyTreatment(await fx.session("manager"), p, request(16));
    expect(await writes.readCanonicalLegacyTreatmentPreview(await fx.session("recorder"), p, request(18))).toMatchObject({ ok: false, reason: "opening_edit_forbidden" });
    expect(await writes.readCanonicalLegacyTreatmentPreview(await fx.session("manager"), p, request(18)))
      .toMatchObject({ ok: true, preview: { opening: { effect: "increased", beforeMinor: 180000, afterMinor: 360000 } } });
  });

  it("void needs the void grant with the ledger view; the exception mode also needs opening management", async () => {
    const p = await patient(); const { agreement } = await writes.commandCanonicalLegacyTreatment(await fx.session("manager"), p, request(21));
    expect(await refusal(writes.readCanonicalLegacyVoidPreview(await fx.session("blindVoider"), p, agreement.id, "ordinary"))).toMatchObject({ reason: "void_forbidden" });
    expect(await refusal(writes.commandCanonicalLegacyVoid(await fx.session("blindVoider"), p, agreement.id, { reason: "SYN void reason", mode: "ordinary" }))).toMatchObject({ reason: "void_forbidden" });
    expect(await refusal(writes.commandCanonicalLegacyVoid(await fx.session("voider"), p, agreement.id, { reason: "SYN void reason", mode: "manager_authorized", previewToken: "x".repeat(64) }))).toMatchObject({ reason: "void_forbidden" });
    for (const key of ["recorder", "ledger", "label"] as const) {
      expect(await refusal(writes.commandCanonicalLegacyVoid(await fx.session(key), p, agreement.id, { reason: "SYN void reason", mode: "ordinary" })), key).toMatchObject(denied);
    }
    const { preview } = await writes.readCanonicalLegacyVoidPreview(await fx.session("voider"), p, agreement.id, "ordinary");
    expect(preview).toMatchObject({ canVoid: true });
    const done = await writes.commandCanonicalLegacyVoid(await fx.session("voider"), p, agreement.id, { reason: "SYN void reason", mode: "ordinary", previewToken: preview.previewToken });
    expect(done.agreement).toMatchObject({ id: agreement.id, status: "void", voidedBy: "SYN-LW-VOID" });
    expect(await opening(p)).toBeNull();
    expect((await q("SELECT actor FROM audit_log WHERE action='legacy_treatment.void' AND entity_id=$1::text", [p])).map(row => row.actor)).toEqual(["SYN-LW-VOID"]);
  });

  it("own outside reads like missing for record, preview and void; revocation", async () => {
    const outside = await patient(), doctor = await fx.session("doctor");
    const { agreement } = await writes.commandCanonicalLegacyTreatment(await fx.session("manager"), outside, request(31));
    const out = await refusal(writes.commandCanonicalLegacyTreatment(doctor, outside, request(32)));
    const missing = await refusal(writes.commandCanonicalLegacyTreatment(doctor, 2_000_000_000, request(32)));
    expect(out).toMatchObject({ reason: "no_patient" }); expect(out?.reason).toBe(missing?.reason);
    expect(await refusal(writes.readCanonicalLegacyTreatmentPreview(doctor, outside, request(33)))).toMatchObject({ code: "patient_not_found" });
    const voidOut = await refusal(writes.commandCanonicalLegacyVoid(doctor, outside, agreement.id, { reason: "SYN void reason", mode: "ordinary" }));
    const voidMissing = await refusal(writes.commandCanonicalLegacyVoid(doctor, 2_000_000_000, agreement.id, { reason: "SYN void reason", mode: "ordinary" }));
    expect(voidOut).toMatchObject({ reason: "not_found" }); expect(voidOut?.reason).toBe(voidMissing?.reason);
    expect(await agreements(outside)).toEqual([{ id: agreement.id, status: "live", created_by: "SYN-LW-MGR" }]);
    await fx.setGrants("recorder", {}, { patientScope: "all" });
    try { expect(await refusal(writes.commandCanonicalLegacyTreatment(await fx.session("recorder"), await patient(), request(34)))).toMatchObject(denied); }
    finally { await fx.setGrants("recorder", RECORD, { patientScope: "all" }); }
  });

  it("refuses a patient that leaves the clinician's scope while the record waits for the patient row", async () => {
    const pid = await patient(fx.parties.doctor!), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [pid]);
      pending = refusal(writes.commandCanonicalLegacyTreatment(session, pid, request(41)));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id = $1 FOR NO KEY UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ reason: "no_patient" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await agreements(pid)).toEqual([]);
    expect(await opening(pid)).toBeNull();
  });
});
