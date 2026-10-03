import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LabOrderIdentityConflict } from "../lib/lab-order-identity";
import { VISIT_RECORD_REFERENCES } from "../lib/visit-record-identity";

// Source contracts are supplemental: only guarded PostgreSQL tests can establish
// actual lock ordering. These assertions do not claim a reproduced incident.
const source = readFileSync("lib/db.ts", "utf8");
const start = source.indexOf("export async function createLabOrder(input:");
const end = source.indexOf("export async function updateLabOrderAccounting(", start);
const create = source.slice(start, end);

describe("manual lab canonical identity contract", () => {
  it("uses a narrow typed conflict with refresh/retry guidance", () => {
    const conflict = new LabOrderIdentityConflict();
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.name).toBe("LabOrderIdentityConflict");
    expect(conflict.code).toBe("lab_order_identity_changed");
    expect(conflict.message).toContain("حدّث الشاشة");
    expect(new Error("lab_order_identity_changed")).not.toBeInstanceOf(LabOrderIdentityConflict);
  });
  it("locks patient first and rechecks a supplied current visit owner before any side effects", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const begin = create.indexOf('client.query("BEGIN")');
    const patient = create.indexOf("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE");
    const visit = create.indexOf("SELECT patient_id FROM visits WHERE id = $1 FOR SHARE");
    const check = create.indexOf("visits[0].patient_id !== input.patientId");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(patient).toBeGreaterThan(begin);
    expect(visit).toBeGreaterThan(patient);
    expect(check).toBeGreaterThan(visit);
    expect(create).toContain("if (!patient.rows.length) throw new LabOrderIdentityConflict()");
    expect(create).toContain("if (input.visitId != null)");
    for (const effect of ["SELECT id FROM parties", "INSERT INTO parties", "FROM lab_pricing_rules", "INSERT INTO lab_orders", "INSERT INTO lab_order_tracking", "INSERT INTO payables"]) {
      expect(create.indexOf(effect)).toBeGreaterThan(check);
    }
    expect(create.slice(begin, create.indexOf("let resolvedPartyId"))).not.toMatch(/signed_at|status\s*=|FOR UPDATE/);
    expect(create).toContain('await client.query("ROLLBACK").catch(() => {})');
  });
  it("preserves the relink footprint and permitted later visit detachment", () => {
    expect(VISIT_RECORD_REFERENCES.find(row => row.table === "lab_orders")).toMatchObject({
      mismatch: "r.patient_id IS DISTINCT FROM $2::int", deletion: "detach",
    });
    expect(source).toContain("UPDATE lab_orders SET visit_id = NULL WHERE visit_id = $1");
  });
});
