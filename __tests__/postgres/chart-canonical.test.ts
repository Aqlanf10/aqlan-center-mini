/** M2 slice 76: the canonical dental chart on real PostgreSQL, synthetic data only.
 * GET by a clinical grant inside the patient scope; POST by clinical.visits.document with
 * the clinician link or the owner; the chart.record audit row commits with the event;
 * a visit of another patient is refused without a write; optional request-key receipt;
 * revocation refuses an earlier session. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-dental-chart-secret-2026");
const db = await import("../../lib/db");
const rec = await import("../../lib/canonical-clinical-records");
const reads = await import("../../lib/canonical-patient-reads");

const DOC = { "clinical.visits.document": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-CH-OWNER", role: "admin" },
  doctor: { username: "SYN-CH-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { ...DOC } },
  nurse: { username: "SYN-CH-NURSE", role: "assistant", patientScope: "all", grants: { ...DOC } },
  viewer: { username: "SYN-CH-VIEW", role: "reception", patientScope: "all", grants: { "clinical.xrays.view": true } },
  front: { username: "SYN-CH-FRONT", role: "reception", patientScope: "all", grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const key = () => `syn-chart-key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const ids = { mine: 0, other: 0, otherVisit: 0 };
const events = async (patientId: number) => (await q("SELECT count(*)::int AS n FROM tooth_conditions WHERE patient_id=$1", [patientId]))[0].n as number;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000961',$3) RETURNING id", [number, `SYN CH ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-CH-1", fx.parties.doctor!);
  ids.other = await patient("SYN-CH-2", null);
  ids.otherVisit = (await q("INSERT INTO visits (patient_name, patient_id) VALUES ('SYN CH visit', $1) RETURNING id", [ids.other]))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("record", () => {
  it("the clinician records inside the scope; the audit row commits with the event; a keyed double press writes one", async () => {
    const body = { requestKey: key(), toothCode: 16, condition: "caries", stage: "existing", surfaces: "MO", note: "تسوس اصطناعي" };
    const [a, b] = await Promise.all([
      rec.commandCanonicalToothCondition(await fx.session("doctor"), String(ids.mine), body),
      rec.commandCanonicalToothCondition(await fx.session("doctor"), String(ids.mine), body),
    ]);
    expect(a.id).toBe(b.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a).toMatchObject({ toothCode: 16, condition: "caries", stage: "existing", recordedBy: "SYN-CH-DOC" });
    expect(await events(ids.mine)).toBe(1);
    expect((await q("SELECT actor, details->>'السجل' AS record FROM audit_log WHERE action='chart.record' AND entity_id=$1::text", [ids.mine])))
      .toEqual([{ actor: "SYN-CH-DOC", record: String(a.id) }]);
    expect(await refusal(rec.commandCanonicalToothCondition(await fx.session("doctor"), String(ids.mine), { ...body, condition: "filling" })))
      .toMatchObject({ code: "clinical_request_key_reused", status: 409 });
    // Without a key: one event per accepted request (the editor blocks a repeated press).
    expect(await rec.commandCanonicalToothCondition(await fx.session("owner"), String(ids.mine), { toothCode: 11, condition: "crown", stage: "planned" }))
      .toMatchObject({ toothCode: 11, condition: "crown", stage: "planned", replayed: false });
    expect(await events(ids.mine)).toBe(2);
  });

  it("refuses without the clinician link, without the grant, outside the scope and on another patient's visit — writing nothing", async () => {
    const before = await events(ids.mine);
    const beforeOther = await events(ids.other);
    expect(await refusal(rec.commandCanonicalToothCondition(await fx.session("nurse"), String(ids.mine), { toothCode: 21, condition: "caries" })))
      .toMatchObject({ code: "chart_clinician_required", status: 403 });
    await expect(rec.commandCanonicalToothCondition(await fx.session("viewer"), String(ids.mine), { toothCode: 21, condition: "caries" })).rejects.toThrow("CAPABILITY_DENIED");
    expect(await refusal(rec.commandCanonicalToothCondition(await fx.session("doctor"), String(ids.other), { toothCode: 21, condition: "caries" })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(rec.commandCanonicalToothCondition(await fx.session("owner"), String(ids.mine), { toothCode: 21, condition: "caries", visitId: ids.otherVisit })))
      .toMatchObject({ code: "chart_visit_conflict", status: 409 });
    expect(await refusal(rec.commandCanonicalToothCondition(await fx.session("owner"), String(ids.mine), { toothCode: 99, condition: "caries" })))
      .toMatchObject({ status: 400, field: "toothCode" });
    expect(await refusal(rec.commandCanonicalToothCondition(await fx.session("owner"), String(ids.mine), { toothCode: 21, condition: "toString" })))
      .toMatchObject({ status: 400, field: "condition" });
    expect(await events(ids.mine)).toBe(before);
    expect(await events(ids.other)).toBe(beforeOther);
    expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='chart.record' AND entity_id=$1::text", [ids.other]))[0].n).toBe(0);
  });
});

describe("read and revocation", () => {
  it("reads by a clinical grant inside the scope; outside answers like missing; no clinical grant is refused", async () => {
    const chart = await reads.readCanonicalChart(await fx.session("viewer"), ids.mine);
    expect(chart.records.map(row => row.toothCode)).toEqual([16, 11]);
    expect(chart.chart.length).toBeGreaterThan(0);
    expect(JSON.stringify(chart)).not.toMatch(/price|amount|balance/i);
    expect(await refusal(reads.readCanonicalChart(await fx.session("doctor"), ids.other))).toMatchObject({ code: "patient_not_found" });
    expect(await refusal(reads.readCanonicalChart(await fx.session("front"), ids.mine))).not.toBeNull();
  });

  it("revoking the grant refuses an earlier session's write and writes nothing", async () => {
    const issued = await fx.session("doctor");
    const before = await events(ids.mine);
    await fx.setGrants("doctor", {}, { patientScope: "own" });
    try {
      await expect(rec.commandCanonicalToothCondition(issued, String(ids.mine), { toothCode: 26, condition: "caries" })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("doctor", { ...DOC }, { patientScope: "own" }); }
    expect(await events(ids.mine)).toBe(before);
  });
});
