import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VISIT_RECORD_REFERENCES } from "../lib/visit-record-identity";

// Supplemental source contracts only. They cannot establish PostgreSQL locking
// behavior; the separate guarded suite uses only synthetic already-linked visits.
const source = readFileSync("lib/db.ts", "utf8");
const start = source.indexOf("export async function createInventoryMovement(input:");
const end = source.indexOf("export const AUTO_MATERIAL_REASON_PREFIX", start);
const create = source.slice(start, end);
const itemLock = create.indexOf("SELECT id, is_active, name FROM inventory_items WHERE id = $1 FOR UPDATE");
const guard = create.slice(create.indexOf('await client.query("BEGIN")'), itemLock);

describe("manual inventory visit identity source contract", () => {
  it("rechecks the preflight pair under patient then visit locks before the item lock", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const patient = create.indexOf("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE");
    const visit = create.indexOf("SELECT patient_id FROM visits WHERE id = $1 FOR SHARE");
    const check = create.indexOf("!visits[0] || visits[0].patient_id !== patientId");
    expect(patient).toBeGreaterThan(create.indexOf('await client.query("BEGIN")'));
    expect(visit).toBeGreaterThan(patient);
    expect(check).toBeGreaterThan(visit);
    expect(itemLock).toBeGreaterThan(check);
    expect(guard).toContain("if (!patients[0])");
    expect(guard.match(/await client.query\("ROLLBACK"\)/g)).toHaveLength(2);
    expect(guard.match(/return \{ ok: false, message:/g)).toHaveLength(2);
    for (const effect of ["SELECT ${INVENTORY_BALANCE_SELECT}", "validateMovement(",
      "FROM parties WHERE", "INSERT INTO payables", "INSERT INTO inventory_movements", "void recordAudit("]) {
      expect(create.indexOf(effect)).toBeGreaterThan(itemLock);
    }
  });

  it("preserves optional context and exact nullable walk-in ownership without adoption", () => {
    expect(guard).toContain("if (input.visitId != null)");
    expect(guard).toContain("const patientId = input.patientId ?? null");
    expect(guard).toContain("if (patientId !== null)");
    expect(guard).toContain("visits[0].patient_id !== patientId");
    expect(guard).not.toMatch(/input\.patientId\s*=|patientId\s*=\s*visits|signed_at|status\s*=|input\.kind/);
    expect(create).toContain("expiry, input.reason ?? null, input.visitId ?? null, input.patientId ?? null");
  });

  it("keeps the route's role/access checks, derivation, conflict status and successful payload", () => {
    const route = readFileSync("app/api/inventory/[id]/movements/route.ts", "utf8");
    expect(route).toContain("patientId = visit.patientId");
    const access = route.indexOf("canAccessPatient(session, patientId)");
    const write = route.indexOf("await createInventoryMovement({");
    expect(access).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(access);
    expect(route).toContain("if (!canManageInventory(session.role) && kind !== \"out\")");
    expect(route).toContain("NextResponse.json({ message: result.message }, { status: 409 })");
    expect(route).toContain("NextResponse.json(result, { status: 201 })");
  });

  it("retains item serialization, quantities, costs, supplier currency and post-commit audit", () => {
    expect(create).toContain("validateMovement(input.kind, input.qty, input.reason ?? null, balance)");
    expect(create).toContain("input.kind === \"adjust\" ? input.qty : Math.abs(input.qty)");
    expect(create).toContain("const isPurchase = input.kind === \"in\" && !input.isReturn");
    expect(create).toContain("Math.round(input.unitCostMinor)");
    expect(create).toContain("const amountMinor = Math.round(unitCost * qty)");
    expect(create).toContain("CLINIC_BASE_CURRENCY, input.supplierDueDate ?? null, input.createdBy");
    expect(create.indexOf('await client.query("COMMIT")')).toBeLessThan(create.indexOf("void recordAudit("));
    expect(create).toContain('await client.query("ROLLBACK").catch(() => {})');
    expect(create).toContain("client.release()");
    expect(create).not.toMatch(/ON CONFLICT|idempotency_key|DELETE FROM|UPDATE inventory_movements/);
  });

  it("keeps full lifecycle coverage deferred and automatic sign deduction separate", () => {
    expect(VISIT_RECORD_REFERENCES.find(row => row.table === "inventory_movements")).toMatchObject({
      mismatch: "r.patient_id IS NOT NULL AND r.patient_id IS DISTINCT FROM $2::int",
      relinkFence: "deferred", deletion: "restrict_financial",
    });
    const autoStart = source.indexOf("async function deductServiceMaterials(input:");
    const auto = source.slice(autoStart, source.indexOf("export async function addVisitAddendum", autoStart));
    expect(auto).toContain("SELECT 1 FROM inventory_items WHERE id = $1 FOR UPDATE");
    expect(auto).not.toContain("createInventoryMovement(");
  });
});
