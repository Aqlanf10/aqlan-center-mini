/** M2 slice 95c (G4-1, G4-6; contract section 15, points 3, 7 and 8): historical documents on the
 * canonical runtime, real PostgreSQL, synthetic data only. Record and preview by
 * patients.history.record with finance.patient-ledger.view; an existing opening also needs
 * finance.opening-balances.manage; the discount and price changes by the price grants; correction by
 * patients.history.correct with opening management and the ledger view; other grants, the label and
 * the reception setting never act; created_role records the authority class; outside reads as
 * missing, decided after the patient row lock (race test); revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-history-documents-secret-95c");
const db = await import("../../lib/db");
const writes = await import("../../lib/canonical-history-documents");
const documents = await import("../../lib/legacy-treatment-document-db");

const LEDGER = { "finance.patient-ledger.view": true };
const RECORD = { "patients.history.record": true };
const OPENING = { "finance.opening-balances.manage": true };
const ACCOUNTS = {
  owner: { username: "SYN-HD-OWNER", role: "admin" },
  recorder: { username: "SYN-HD-REC", role: "reception", patientScope: "all", grants: { ...RECORD, ...LEDGER } },
  blindRecorder: { username: "SYN-HD-BLIND", role: "admin", patientScope: "all", grants: RECORD },
  manager: { username: "SYN-HD-MGR", role: "reception", patientScope: "all", grants: { ...RECORD, ...LEDGER, ...OPENING } },
  discounter: { username: "SYN-HD-DISC", role: "reception", patientScope: "all", grants: { ...RECORD, ...LEDGER, "finance.discounts.apply": true } },
  corrector: { username: "SYN-HD-COR", role: "reception", patientScope: "all", grants: { ...RECORD, ...LEDGER, ...OPENING, "patients.history.correct": true } },
  plainCorrector: { username: "SYN-HD-PCOR", role: "admin", patientScope: "all", grants: { ...RECORD, ...LEDGER, "patients.history.correct": true } },
  ledger: { username: "SYN-HD-LEDGER", role: "accountant", patientScope: "all", grants: { ...LEDGER, ...OPENING } },
  legacyRecorder: { username: "SYN-HD-LEG", role: "reception", patientScope: "all", grants: { ...LEDGER, "finance.legacy.record": true } },
  label: { username: "SYN-HD-LABEL", role: "admin", patientScope: "all", grants: {} },
  receptionLabel: { username: "SYN-HD-RCPT", role: "reception", patientScope: "all", grants: {} },
  doctor: { username: "SYN-HD-DR", role: "doctor", doctor: true, patientScope: "own",
    grants: { ...RECORD, ...LEDGER, ...OPENING, "patients.history.correct": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0, endo = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string; name?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const ledgerRefused = { code: "ledger_view_required" };
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN HD patient',$2) RETURNING id", [`SYN-HD-${++serial}`, doctor]))[0].id as number;
/** A first document on a patient without an opening: one line, paid 10000, remaining 45000. */
function source(patientId: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { patientId, currency: "YER", items: [{ serviceId: endo, quantity: 1, price: "55000", catalogPriceMinor: 55000, toothCode: 26 }],
    discount: "0", discountReason: null, previouslyPaidAmount: "10000", historicalAsOf: "2025-02-01", note: null,
    idempotencyKey: `syn-hd-doc-${++serial}`, repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: 45000,
    repaymentVersion: 0, repaymentSourceHash: null, ...extra };
}
const stored = async (p: number) => q("SELECT created_by, created_role FROM legacy_treatment_documents WHERE patient_id=$1 ORDER BY id", [p]);
const opening = async (p: number) => (await q("SELECT amount_minor::int AS amount FROM patient_opening_balances WHERE patient_id=$1 AND currency='YER'", [p]))[0]?.amount ?? null;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  endo = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('SYN HD endo','rct',55000,TRUE,TRUE) RETURNING id"))[0].id;
  // The reception setting is on: it must decide nothing on the canonical runtime.
  await q(`INSERT INTO settings(key,value) VALUES('finance.reception_adds_opening_balance','true'),('billing.max_discount_percent','50')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  await db.openShift({ openedBy: "SYN-HD-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("historical documents on the canonical runtime", () => {
  it("record by patients.history.record with the ledger view; an existing opening needs opening management; the key replays", async () => {
    const p = await patient(), recorder = await fx.session("recorder"), first = source(p);
    const preview = await writes.readCanonicalHistoricalDocumentPreview(recorder, p, first);
    expect(preview).toMatchObject({ patientId: p, currency: "YER", remainingMinor: 45000, scheduleVersion: 0 });
    const made = await writes.commandCanonicalHistoricalDocument(recorder, p, first);
    expect(made).toMatchObject({ replayed: false, document: { patientId: p, version: 1 } });
    expect(await opening(p)).toBe(45000);
    expect(await writes.commandCanonicalHistoricalDocument(recorder, p, first)).toEqual({ document: made.document, replayed: true });
    // A second document changes the existing opening: refused for the add-only grant set.
    const draft = source(p, { items: [{ serviceId: endo, quantity: 1, price: "55000", catalogPriceMinor: 55000, toothCode: 27 }] });
    expect(await refusal(writes.readCanonicalHistoricalDocumentPreview(recorder, p, draft))).toMatchObject({ code: "unauthorized" });
    const manager = await fx.session("manager");
    const view = await writes.readCanonicalHistoricalDocumentPreview(manager, p, draft);
    const second = { ...draft, repaymentVersion: view.scheduleVersion, repaymentSourceHash: view.sourceHash, repaymentRemainingMinor: view.remainingMinor };
    expect(await refusal(writes.commandCanonicalHistoricalDocument(recorder, p, second))).toMatchObject({ code: "unauthorized" });
    expect(await writes.commandCanonicalHistoricalDocument(manager, p, second)).toMatchObject({ replayed: false });
    expect(await opening(p)).toBe(90000);
    // created_role is the authority class (point 8), never the label.
    expect(await stored(p)).toEqual([{ created_by: "SYN-HD-REC", created_role: "reception" }, { created_by: "SYN-HD-MGR", created_role: "admin" }]);
    expect((await q("SELECT actor FROM audit_log WHERE action='legacy_document.create' AND entity_id=$1::text ORDER BY id", [p])).map(row => row.actor))
      .toEqual(["SYN-HD-REC", "SYN-HD-MGR"]);
  });

  it("the ledger view is required; other grants, the label and the reception setting never record or preview", async () => {
    const p = await patient();
    const blind = await fx.session("blindRecorder");
    expect(await refusal(writes.readCanonicalHistoricalDocumentPreview(blind, p, source(p)))).toMatchObject(ledgerRefused);
    expect(await refusal(writes.commandCanonicalHistoricalDocument(blind, p, source(p)))).toMatchObject(ledgerRefused);
    for (const key of ["ledger", "legacyRecorder", "label", "receptionLabel"] as const) {
      expect(await refusal(writes.commandCanonicalHistoricalDocument(await fx.session(key), p, source(p))), key).toMatchObject(denied);
      expect(await refusal(writes.readCanonicalHistoricalDocumentPreview(await fx.session(key), p, source(p))), key).toMatchObject(denied);
    }
    expect(await stored(p)).toEqual([]);
    expect(await opening(p)).toBeNull();
  });

  it("the discount and a price above the catalogue follow the price grants, not the label", async () => {
    const p = await patient(), q2 = await patient();
    const discounted = (patientId: number) => source(patientId, { discount: "5000", discountReason: "SYN historical discount", repaymentRemainingMinor: 40000 });
    const noDiscount = await refusal(writes.commandCanonicalHistoricalDocument(await fx.session("recorder"), p, discounted(p)));
    expect(noDiscount).toMatchObject({ code: "invalid", message: "الخصم على الفاتورة يحتاج صلاحية تطبيق الخصم." });
    expect(await refusal(writes.readCanonicalHistoricalDocumentPreview(await fx.session("recorder"), p, discounted(p)))).toMatchObject({ code: "invalid" });
    expect(await writes.commandCanonicalHistoricalDocument(await fx.session("discounter"), p, discounted(p))).toMatchObject({ replayed: false, document: { discountMinor: 5000 } });
    const raised = source(q2, { items: [{ serviceId: endo, quantity: 1, price: "60000", catalogPriceMinor: 55000, toothCode: 26, priceReason: "SYN raised" }],
      repaymentRemainingMinor: 50000 });
    expect(await refusal(writes.commandCanonicalHistoricalDocument(await fx.session("discounter"), q2, raised))).toMatchObject({ code: "invalid" });
    expect(await stored(q2)).toEqual([]);
  });

  it("correction needs the correct grant, opening management and the ledger view", async () => {
    const p = await patient();
    const { document } = await writes.commandCanonicalHistoricalDocument(await fx.session("recorder"), p, source(p));
    const [view] = await documents.listHistoricalDocuments(p);
    const remaining = view.openingRemainingMinor + document.previouslyPaidMinor - 15000;
    const change = () => ({ idempotencyKey: `syn-hd-cor-${++serial}`, expectedVersion: document.version, expectedSourceHash: view.sourceHash,
      prices: document.lines.map(line => String(line.unitPriceMinor)), discount: String(document.discountMinor), discountReason: document.discountReason,
      previouslyPaidAmount: "15000", historicalAsOf: document.historicalAsOf, note: document.note, reason: "SYN corrected historical facts",
      repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: remaining, repaymentVersion: view.scheduleVersion });
    expect(await refusal(writes.commandCanonicalHistoricalCorrection(await fx.session("plainCorrector"), p, document.id, change()))).toMatchObject({ code: "unauthorized" });
    for (const key of ["recorder", "manager", "ledger", "label"] as const) {
      expect(await refusal(writes.commandCanonicalHistoricalCorrection(await fx.session(key), p, document.id, change())), key).toMatchObject(denied);
    }
    const body = change();
    const corrected = await writes.commandCanonicalHistoricalCorrection(await fx.session("corrector"), p, document.id, body);
    expect(corrected).toMatchObject({ replayed: false, document: { id: document.id, version: 2, previouslyPaidMinor: 15000 } });
    expect(await writes.commandCanonicalHistoricalCorrection(await fx.session("corrector"), p, document.id, body)).toEqual({ document: corrected.document, replayed: true });
    expect(await opening(p)).toBe(40000);
    expect((await q("SELECT actor FROM audit_log WHERE action='legacy_document.correct' AND entity_id=$1::text", [p])).map(row => row.actor)).toEqual(["SYN-HD-COR"]);
  });

  it("own outside reads like missing for record, preview and correction; revocation", async () => {
    const outside = await patient(), doctor = await fx.session("doctor");
    const { document } = await writes.commandCanonicalHistoricalDocument(await fx.session("manager"), outside, source(outside));
    const out = await refusal(writes.commandCanonicalHistoricalDocument(doctor, outside, source(outside)));
    const missing = await refusal(writes.commandCanonicalHistoricalDocument(doctor, 2_000_000_000, source(2_000_000_000)));
    expect(out).toMatchObject({ code: "missing" }); expect(out?.message).toBe(missing?.message);
    expect(await refusal(writes.readCanonicalHistoricalDocumentPreview(doctor, outside, source(outside)))).toMatchObject({ code: "patient_not_found" });
    const corOut = await refusal(writes.commandCanonicalHistoricalCorrection(doctor, outside, document.id, { idempotencyKey: `syn-hd-cor-${++serial}` }));
    const corMissing = await refusal(writes.commandCanonicalHistoricalCorrection(doctor, 2_000_000_000, document.id, { idempotencyKey: `syn-hd-cor-${++serial}` }));
    expect(corOut).toMatchObject({ code: "missing" }); expect(corOut?.message).toBe(corMissing?.message);
    expect(await stored(outside)).toEqual([{ created_by: "SYN-HD-MGR", created_role: "admin" }]);
    // Inside the clinician's own scope the same grants act.
    const own = await patient(fx.parties.doctor!);
    expect(await writes.commandCanonicalHistoricalDocument(doctor, own, source(own))).toMatchObject({ replayed: false });
    await fx.setGrants("recorder", {}, { patientScope: "all" });
    try { const p = await patient(); expect(await refusal(writes.commandCanonicalHistoricalDocument(await fx.session("recorder"), p, source(p)))).toMatchObject(denied); }
    finally { await fx.setGrants("recorder", { ...RECORD, ...LEDGER }, { patientScope: "all" }); }
  });

  it("refuses a patient that leaves the clinician's scope while the record waits for the patient row", async () => {
    const pid = await patient(fx.parties.doctor!), session = await fx.session("doctor");
    const blocker: PoolClient = await blockers.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [pid]);
      pending = refusal(writes.commandCanonicalHistoricalDocument(session, pid, source(pid)));
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id=$1 FOR NO KEY UPDATE%'")).length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: "missing" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
    expect(await stored(pid)).toEqual([]);
    expect(await opening(pid)).toBeNull();
  });
});
