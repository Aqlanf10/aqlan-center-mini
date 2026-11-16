/** M2 slice 82: canonical materials reads on real PostgreSQL, synthetic data only. A
 * clinical grant inside the patient scope; the visit read follows the queue read's
 * condition; outside reads like missing; quantities only, never a cost; no clinical grant
 * is refused. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-materials-secret-2026-xyz");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-patient-reads");

const ACCOUNTS = {
  owner: { username: "SYN-MT-OWNER", role: "admin" },
  doctor: { username: "SYN-MT-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.visits.document": true } },
  viewer: { username: "SYN-MT-VIEW", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
  front: { username: "SYN-MT-FRONT", role: "reception", patientScope: "all", grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error);
const ids = { mine: 0, other: 0, visitMine: 0, visitOther: 0, item: 0 };

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000711',$3) RETURNING id", [number, `SYN MT ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-MT-1", fx.parties.doctor!);
  ids.other = await patient("SYN-MT-2", null);
  const visit = async (patientId: number) => (await q("INSERT INTO visits (patient_name, patient_id) VALUES ('SYN MT', $1) RETURNING id", [patientId]))[0].id as number;
  ids.visitMine = await visit(ids.mine);
  ids.visitOther = await visit(ids.other);
  ids.item = (await q("INSERT INTO inventory_items(name,unit,created_by) VALUES('SYN MT material','unit','SYN') RETURNING id"))[0].id;
  await q("INSERT INTO inventory_movements(item_id,kind,qty,reason,created_by) VALUES($1,'in',10,'SYN stock','SYN')", [ids.item]);
  // A consumption on the visit, with a cost on the movement: the reads must never return it.
  await q("INSERT INTO inventory_movements (item_id, kind, qty, visit_id, patient_id, created_by, unit_cost_minor, is_return) VALUES ($1,'out',2,$2,$3,'SYN',4321,false)", [ids.item, ids.visitMine, ids.mine]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("materials", () => {
  it("reads a patient's and a visit's consumables by a clinical grant inside the scope, without costs", async () => {
    const patient = await reads.readCanonicalPatientMaterials(await fx.session("viewer"), ids.mine);
    expect(Array.isArray(patient)).toBe(true);
    const visit = await reads.readCanonicalVisitMaterials(await fx.session("doctor"), ids.visitMine);
    expect(visit).toMatchObject({ patientId: ids.mine, lines: expect.any(Array) });
    expect(patient.map(row => row.itemName)).toContain("SYN MT material");
    expect(visit.lines.map(row => [row.itemName, row.qty])).toEqual([["SYN MT material", 2]]);
    expect(JSON.stringify([patient, visit])).not.toMatch(/cost|price|minor|amount|4321/i);
  });

  it("outside the scope reads like missing; no clinical grant is refused", async () => {
    expect(await refusal(reads.readCanonicalPatientMaterials(await fx.session("doctor"), ids.other))).toMatchObject({ code: "patient_not_found" });
    expect(await refusal(reads.readCanonicalVisitMaterials(await fx.session("doctor"), ids.visitOther))).toMatchObject({ code: "patient_not_found" });
    expect(await refusal(reads.readCanonicalVisitMaterials(await fx.session("doctor"), 2147483000))).toMatchObject({ code: "patient_not_found" });
    expect(await refusal(reads.readCanonicalPatientMaterials(await fx.session("front"), ids.mine))).not.toBeNull();
    expect(await refusal(reads.readCanonicalVisitMaterials(await fx.session("front"), ids.visitMine))).not.toBeNull();
  });
});
