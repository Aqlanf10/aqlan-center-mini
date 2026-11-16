/** M2 slice 95a (G4-2; contract section 15): the historical onboarding reads on the canonical runtime,
 * real PostgreSQL, synthetic data only. The record read shows the clinical description and no
 * amount at any depth; amounts need finance.patient-ledger.view; the archive is refused without
 * it; plan sources need clinical.plans.view; action flags come from canonical grants; outside the
 * scope reads like a missing patient; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import type { SessionPayload } from "../../lib/auth";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-legacy-history-secret-95a");
const db = await import("../../lib/db");
const { canonicalDebtActor } = await import("../../lib/debt-installments-db");
const reads = await import("../../lib/canonical-legacy-reads");
const legacy = await import("../../lib/legacy-treatment-db");
const documents = await import("../../lib/legacy-treatment-document-db");
const onboarding = await import("../../lib/legacy-onboarding-db");
const { parseLegacyTreatmentRequest } = await import("../../lib/legacy-treatment");
const { DEFAULT_SPECIALTY_TEMPLATES } = await import("../../lib/specialty-templates");

const LEDGER = { "finance.patient-ledger.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-LH-OWNER", role: "admin" },
  clerk: { username: "SYN-LH-CLERK", role: "reception", patientScope: "all", grants: {} },
  ledger: { username: "SYN-LH-LEDGER", role: "accountant", patientScope: "all", grants: LEDGER },
  planner: { username: "SYN-LH-PLAN", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
  recorder: { username: "SYN-LH-REC", role: "reception", patientScope: "all", grants: { ...LEDGER, "finance.legacy.record": true, "finance.opening-balances.manage": true } },
  corrector: { username: "SYN-LH-COR", role: "reception", patientScope: "all",
    grants: { ...LEDGER, "patients.history.record": true, "patients.history.correct": true, "finance.opening-balances.manage": true } },
  label: { username: "SYN-LH-LABEL", role: "admin", patientScope: "all", grants: {} },
  doctor: { username: "SYN-LH-DR", role: "doctor", doctor: true, patientScope: "own", grants: { ...LEDGER, "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let legacySession: SessionPayload;
let serial = 0, endo = 0, crown = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string; name?: string }) => error);
/** Every key at any depth; amounts and free text must not appear in a record-only payload. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(item => keysOf(item, into));
  else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) { into.add(key); keysOf(inner, into); }
  return into;
}
const MONEY = /Minor$|^currency$|^discountReason$|^note$|^reason$|^voidReason$|^repayment|^sourceHash$|^scheduleVersion$|^openingEffect$|^openingHistoryId$|^idempotencyKey$|^terms$/;
const moneyKeys = (value: unknown) => [...keysOf(value)].filter(key => MONEY.test(key));

const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN LH patient',$2) RETURNING id", [`SYN-LH-${++serial}`, doctor]))[0].id as number;
async function agreement(patientId: number) {
  const parsed = parseLegacyTreatmentRequest({ serviceId: crown, toothCode: 14, sessions: 2, currency: "YER", agreedAmount: "300000",
    previouslyPaidAmount: "120000", historicalAsOf: "2025-01-01", note: "SYN note with 300000" }, "2026-11-07");
  if (!parsed.ok) throw new Error(parsed.message);
  const made = await legacy.createLegacyTreatment({ patientId, request: parsed.value, actor: "SYN-LH-OWNER", actorRole: "admin", canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES });
  if (!made.ok) throw new Error(String(made.reason));
}
async function historicalDocument(patientId: number) {
  await documents.createHistoricalDocument(patientId, { patientId, currency: "YER",
    items: [{ serviceId: endo, quantity: 1, price: "55000", catalogPriceMinor: 55000, toothCode: 26 }],
    discount: "5000", discountReason: "SYN original discount", previouslyPaidAmount: "10000", historicalAsOf: "2025-02-01",
    idempotencyKey: `syn-lh-doc-${++serial}`, repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: 40000,
    repaymentVersion: 0, repaymentSourceHash: null }, legacySession);
}
async function archive(patientId: number) {
  const [row] = await q(`INSERT INTO legacy_treatments (patient_id,legacy_number,treated_on,doctor_name,service,currency,price_minor,paid_minor,remaining_minor,rate,imported_by)
    VALUES ($1,$2,'2024-01-01','SYN old doctor','SYN old treatment','SAR',60000,60000,0,143.25,'syn-import') RETURNING id`, [patientId, 9000 + ++serial]);
  await q(`INSERT INTO legacy_payments(patient_id,legacy_treatment_id,legacy_number,paid_on,currency,amount_minor,rate,method,cash_box,imported_by)
    VALUES ($1,$2,$3,'2024-01-02','SAR',60000,142.75,'cash','SYN box','syn-import')`, [patientId, row.id, 8000 + serial]);
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  // Legacy staff authority is disabled in this database, so the fixture document is written by the real
  // writer through a branded actor whose re-check passes (seed only; the reads are what is under test).
  legacySession = canonicalDebtActor({ userId: fx.ids.owner, username: "SYN-LH-OWNER", role: "admin" }, async () => true) as unknown as SessionPayload;
  endo = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('SYN LH endo','rct',55000,TRUE,TRUE) RETURNING id"))[0].id;
  crown = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('SYN LH crown','crown',300000,TRUE,TRUE) RETURNING id"))[0].id;
  await db.openShift({ openedBy: "SYN-LH-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("historical onboarding reads", () => {
  it("pre-system agreements: the clinical description for the record read, amounts with the ledger view, flags by grant", async () => {
    const p = await patient(); await agreement(p);
    const full = (await legacy.listLegacyTreatments(p)).filter(row => row.documentId === null);
    const clerk = await reads.readCanonicalLegacyTreatments(await fx.session("clerk"), p);
    expect(clerk.agreements).toHaveLength(1);
    expect(clerk.agreements[0]).toMatchObject({ serviceName: "SYN LH crown", toothCode: 14, status: "live" });
    expect(moneyKeys(clerk)).toEqual([]);
    expect(JSON.stringify(clerk)).not.toMatch(/300000|120000|180000/);
    expect(clerk.access).toEqual({ add: false, edit: false, void: false });
    expect((await reads.readCanonicalLegacyTreatments(await fx.session("ledger"), p)).agreements).toEqual(full);
    expect((await reads.readCanonicalLegacyTreatments(await fx.session("recorder"), p)).access).toEqual({ add: true, edit: true, void: false });
    // The administrator label decides nothing.
    expect((await reads.readCanonicalLegacyTreatments(await fx.session("label"), p)).access).toEqual({ add: false, edit: false, void: false });
  });

  it("historical documents: identity and lines without money; the ledger view sees the legacy body; correction by grant", async () => {
    const p = await patient(); await historicalDocument(p);
    const full = await documents.listHistoricalDocuments(p);
    const clerk = await reads.readCanonicalHistoricalDocuments(await fx.session("clerk"), p);
    expect(clerk.documents).toHaveLength(1);
    expect(clerk.documents[0]).toMatchObject({ historicalAsOf: "2025-02-01", correctionAvailable: false, lines: [{ serviceId: endo, toothCode: 26 }] });
    expect(moneyKeys(clerk)).toEqual([]);
    expect(JSON.stringify(clerk)).not.toMatch(/55000|50000|40000|10000|5000/);
    expect((await reads.readCanonicalHistoricalDocuments(await fx.session("ledger"), p)).documents).toEqual(full.map(doc => ({ ...doc, correctionAvailable: false })));
    expect((await reads.readCanonicalHistoricalDocuments(await fx.session("corrector"), p)).documents[0].correctionAvailable).toBe(full[0].correctionAvailable);
    expect(full[0].correctionAvailable).toBe(true);
  });

  it("the archive needs the ledger view; onboarding plan sources need clinical.plans.view", async () => {
    const p = await patient(); await archive(p);
    expect(await refusal(reads.readCanonicalLegacyArchive(await fx.session("clerk"), p))).toMatchObject({ name: "CanonicalLegacyArchiveRefusal", code: "ledger_view_required" });
    expect(await reads.readCanonicalLegacyArchive(await fx.session("ledger"), p)).toEqual(await db.patientLegacyHistory(p));
    const o = await patient();
    await q("INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode) VALUES ($1,'syn','legacy',NOW(),NULL)", [o]);
    const legacyView = await onboarding.patientLegacyOnboarding(o);
    expect(legacyView).not.toBeNull();
    const planner = await reads.readCanonicalLegacyOnboarding(await fx.session("planner"), o, undefined);
    expect(planner.onboarding).toEqual(legacyView);
    const clerk = await reads.readCanonicalLegacyOnboarding(await fx.session("clerk"), o, undefined);
    expect(clerk.onboarding).toMatchObject({ complete: false, financialReference: { state: "restricted", sources: [] } });
    expect(clerk.onboarding!.steps.every(step => step.key === "baseline")).toBe(true);
  });

  it("own outside reads exactly like a missing patient on all four reads; revocation", async () => {
    const outside = await patient(), mine = await patient(fx.parties.doctor!);
    await agreement(outside); await archive(mine);
    const doctor = await fx.session("doctor");
    const four = (id: number) => [
      () => reads.readCanonicalLegacyTreatments(doctor, id), () => reads.readCanonicalHistoricalDocuments(doctor, id),
      () => reads.readCanonicalLegacyArchive(doctor, id), () => reads.readCanonicalLegacyOnboarding(doctor, id, undefined)];
    for (const [index, call] of four(outside).entries()) {
      const out = await refusal(call()), missing = await refusal(four(2_000_000_000)[index]());
      expect(out, `#${index}`).toMatchObject({ code: "patient_not_found" });
      expect({ code: out?.code, message: out?.message }).toEqual({ code: missing?.code, message: missing?.message });
    }
    expect(await reads.readCanonicalLegacyArchive(doctor, mine)).toEqual(await db.patientLegacyHistory(mine));
    await fx.setGrants("ledger", {}, { patientScope: "all" });
    try { expect(await refusal(reads.readCanonicalLegacyArchive(await fx.session("ledger"), mine))).toMatchObject({ code: "ledger_view_required" }); }
    finally { await fx.setGrants("ledger", LEDGER, { patientScope: "all" }); }
  });
});
