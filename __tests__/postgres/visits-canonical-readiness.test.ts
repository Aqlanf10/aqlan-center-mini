/** M2 slice 13: canonical chair readiness (GET /api/visits/readiness) on real PostgreSQL,
 * synthetic data only. Rows inside the actor's current patient scope; the checklist by
 * the care or operational group (the operational summary never sees an alert's text or
 * the medical history); balances and the «paid» step only with the ledger grant. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-readiness-2026");
const db = await import("../../lib/db");
const visits = await import("../../lib/canonical-visits");

const ACCOUNTS = {
  owner: { username: "SYN-R-OWNER", role: "admin" },
  clinical: { username: "SYN-R-CLINICAL", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
  operational: { username: "SYN-R-OPS", role: "reception", patientScope: "all", grants: { "patients.operational-summary.view": true } },
  plain: { username: "SYN-R-PLAIN", role: "reception", patientScope: "all", grants: {} },
  cashier: { username: "SYN-R-CASHIER", role: "reception", patientScope: "all", grants: { "finance.patient-ledger.view": true } },
  doctor: { username: "SYN-R-DOCTOR", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
  noScope: { username: "SYN-R-NOSCOPE", role: "reception", patientScope: "none", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let alerted = 0, other = 0, alertedVisit = 0, walkInVisit = 0;

const read = async (k: Key, patientId: number | null = null) => visits.readCanonicalChairReadiness(await fx.session(k), patientId);
const itemFor = (view: Awaited<ReturnType<typeof read>>, visitId: number) => view.items!.find(item => item.visitId === visitId)!;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  alerted = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,medical_alert,flags) VALUES('SYN-R-1','SYN Ready 1','0500000000',$1,'Synthetic penicillin allergy',ARRAY['VIP']) RETURNING id", [fx.parties.doctor!])).rows[0].id;
  other = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-R-2','SYN Ready 2','0500000001') RETURNING id")).rows[0].id;
  await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYN-R-INV',$1,5000,0,'YER','open','synthetic')", [alerted]);
  alertedVisit = (await fx.pool.query<{ id: number }>("INSERT INTO visits(patient_name,patient_id) VALUES('SYN Ready 1',$1) RETURNING id", [alerted])).rows[0].id;
  await fx.pool.query("INSERT INTO visits(patient_name,patient_id) VALUES('SYN Ready 2',$1)", [other]);
  walkInVisit = (await fx.pool.query<{ id: number }>("INSERT INTO visits(patient_name) VALUES('SYN walk-in') RETURNING id")).rows[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("checklist by group", () => {
  it("a clinical grant reads the whole checklist with the alert text; no balances without the ledger grant", async () => {
    const view = await read("clinical");
    expect(view.projection).toEqual({ checklist: "care", balances: false });
    const item = itemFor(view, alertedVisit);
    expect(item.checklist!.map(entry => entry.key)).toEqual(["medical_history", "alerts", "flags", "intake"]);
    expect(item.alerts).toEqual(["Synthetic penicillin allergy"]);
    expect(item.editableAlert).toBe("Synthetic penicillin allergy");
    expect(item).not.toHaveProperty("balances");
    expect(itemFor(view, walkInVisit).checklist).toEqual([expect.objectContaining({ key: "file", state: "attention" })]);
  });
  it("the operational summary sees the alert's existence, flags and intake — never its text or the medical history", async () => {
    const view = await read("operational");
    expect(view.projection.checklist).toBe("operational");
    const item = itemFor(view, alertedVisit);
    expect(item.checklist!.map(entry => entry.key)).toEqual(["alerts", "flags", "intake"]);
    expect(item.checklist!.find(entry => entry.key === "alerts")).toMatchObject({ state: "attention" });
    expect(item.attention).toBe(1);
    for (const hidden of ["alerts", "historyAlerts", "editableAlert", "balances"]) expect(item).not.toHaveProperty(hidden);
    expect(JSON.stringify(view)).not.toMatch(/penicillin|تاريخ طبي|التاريخ الطبي/);
  });
  it("without either group: status and clearance only", async () => {
    const view = await read("plain");
    expect(view.projection).toEqual({ checklist: "none", balances: false });
    const item = itemFor(view, alertedVisit);
    expect(Object.keys(item).sort()).toEqual(["arrivedAt", "chair", "cleared", "patientId", "seatedAt", "signedAt", "status", "visitId"]);
  });
  it("the ledger grant adds the due lines and nothing clinical", async () => {
    const view = await read("cashier");
    const item = itemFor(view, alertedVisit);
    expect(item.balances).toEqual([{ currency: "YER", dueMinor: 5000, warn: false }]);
    expect(item).not.toHaveProperty("checklist");
  });
});

describe("scope and the patient mode", () => {
  it("own scope lists only the clinician's patients' visits; another patient reads exactly like a missing one", async () => {
    const view = await read("doctor");
    expect(view.items!.map(item => item.visitId)).toEqual([alertedVisit]);
    const outside = await read("doctor", other).catch(error => error);
    const missing = await read("doctor", 999_999).catch(error => error);
    expect(outside).toMatchObject({ code: "patient_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    await expect(read("noScope")).rejects.toThrow(/RECORD_SCOPE_DENIED/);
  });
  it("the patient mode returns its visit with the stepper; «paid» only with the ledger grant", async () => {
    const withoutLedger = await read("clinical", alerted);
    expect(withoutLedger.visit!.stepper!.steps.map(step => step.key)).toEqual(["arrived", "ready", "in_chair", "signed"]);
    const withLedger = await read("owner", alerted);
    expect(withLedger.visit!.stepper!.steps.map(step => step.key)).toEqual(["arrived", "ready", "in_chair", "signed", "paid"]);
    expect(withLedger.visit).toMatchObject({ visitId: alertedVisit, balances: [{ currency: "YER", dueMinor: 5000 }] });
  });
  it("a clearance recorded through the canonical move shows on the next read", async () => {
    await visits.commandCanonicalVisitMove(await fx.session("owner"), alertedVisit, visits.parseCanonicalVisitMove({ action: "clear" }));
    expect(itemFor(await read("plain"), alertedVisit).cleared).toMatchObject({ by: "SYN-R-OWNER" });
  });
});
