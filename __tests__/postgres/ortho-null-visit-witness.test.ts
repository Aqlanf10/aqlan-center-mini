import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-null-visit-secret-0123456789abcdef");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ortho-decisions");
const accounts = { owner: { username: "SYN-NULL-OWNER", role: "admin" }, own: { username: "SYN-NULL-OWN", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.ortho.view": true } }, other: { username: "SYN-NULL-OTHER", role: "doctor", doctor: true, patientScope: "none", grants: {} } } as const;
let fx: CanonicalInventoryDatabase<keyof typeof accounts>;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, accounts, "owner"); }, 180000);
afterAll(async () => { await fx?.close(); });
it.each(["own", "owner"] as const)("%s refuses a legacy visit without patient ownership and leaves history unchanged", async key => {
  const patient = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN own patient',$2) RETURNING id", [`SYN-NULL-${key}`, fx.parties.own])).rows[0].id;
  const c = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [patient])).rows[0].id;
  const visit = (await fx.pool.query("INSERT INTO visits(patient_name,doctor_id) VALUES('SYN unrelated unlinked visit',$1) RETURNING id", [fx.parties.other])).rows[0].id;
  const adjustment = (await fx.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,recorded_by,billing_class) VALUES($1,$2,'SYN','REVIEW_REQUIRED') RETURNING id", [c, visit])).rows[0].id;
  const before = (await fx.pool.query("SELECT to_jsonb(v) visit,to_jsonb(a) adjustment FROM visits v JOIN ortho_adjustments a ON a.visit_id=v.id WHERE a.id=$1", [adjustment])).rows;
  await expect(reads.readCanonicalOrthoDecisions(await fx.session(key))).rejects.toThrow("STAFF_READ_READ_FAILED");
  expect((await fx.pool.query("SELECT to_jsonb(v) visit,to_jsonb(a) adjustment FROM visits v JOIN ortho_adjustments a ON a.visit_id=v.id WHERE a.id=$1", [adjustment])).rows).toEqual(before);
  // Correct ownership is still readable; the test changes only synthetic data.
  await fx.pool.query("UPDATE visits SET patient_id=$1 WHERE id=$2", [patient, visit]);
  expect((await reads.readCanonicalOrthoDecisions(await fx.session(key))).pending.some(row => row.adjustmentId === adjustment)).toBe(true);
});
