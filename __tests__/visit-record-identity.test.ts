import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VISIT_OWNER_CONTEXTS, VISIT_RECORD_REFERENCES, VISIT_RELINK_FOOTPRINT_SQL,
  visitRelinkFootprintRefusal, type VisitRelinkFootprint,
  VISIT_DELETE_FOOTPRINT_SQL, visitDeleteFootprintRefusal,
} from "../lib/visit-record-identity";

const empty: VisitRelinkFootprint = {
  has_records: false, incompatible_owner: false, intrinsic_clinical: false,
  has_context: false, incompatible_context: false,
};

describe("visit record identity policy", () => {
  it("allows an empty already-linked standalone correction", () => {
    expect(visitRelinkFootprintRefusal(101, 102, empty)).toBeNull();
  });
  it("preserves same-patient refresh regardless of clinical footprint", () => {
    expect(visitRelinkFootprintRefusal(101, 101, {
      has_records: true, incompatible_owner: true, intrinsic_clinical: true,
      has_context: true, incompatible_context: true,
    })).toBeNull();
  });
  it("separates retained owner context from clinical history", () => {
    expect(visitRelinkFootprintRefusal(101, 102, { ...empty, has_records: true })).toBe("has_clinical_history");
    expect(visitRelinkFootprintRefusal(101, 102, { ...empty, intrinsic_clinical: true })).toBe("has_clinical_history");
    expect(visitRelinkFootprintRefusal(101, 102, { ...empty, has_context: true })).toBe("has_linked_workflow");
  });
  it("classifies every current incoming visit FK without equating inventory with race closure", () => {
    const contract = JSON.parse(readFileSync("schema/current-schema-contract.pg18.json", "utf8")) as {
      tables: Record<string, { foreignKeys: { columns: string[]; refTable: string }[] }>;
    };
    const incoming = Object.entries(contract.tables).flatMap(([table, definition]) =>
      definition.foreignKeys.filter(fk => fk.refTable === "visits").map(fk => `${table}.${fk.columns.join(",")}`));
    expect(VISIT_RECORD_REFERENCES.map(r => `${r.table}.visit_id`).sort()).toEqual(incoming.sort());
    expect(VISIT_RECORD_REFERENCES.filter(r => r.relinkFence === "deferred").map(r => r.table)).toEqual([
      "patient_diagnoses", "lab_orders", "inventory_movements",
      "plan_items", "treatment_sessions", "planned_visits",
    ]);
    expect(VISIT_RECORD_REFERENCES.find(r => r.table === "visit_procedures")?.relinkFence).toBe("atomic_route_only");
  });
  it("lists the four outgoing patient-owned contexts separately", () => {
    expect(VISIT_OWNER_CONTEXTS.map(c => c.column)).toEqual(["appointment_id", "planned_visit_id", "case_id", "invoice_id"]);
  });
  it("reads footprint history without child locks, status filters or operational note classification", () => {
    expect(VISIT_RELINK_FOOTPRINT_SQL).not.toMatch(/FOR\s+(UPDATE|SHARE|KEY)|removed_at|status\s*=|v\.note\b/i);
    for (const column of ["chief_complaint", "examination", "diagnosis", "treatment_done", "next_plan", "addendum"]) {
      expect(VISIT_RELINK_FOOTPRINT_SQL).toContain(`v.${column}`);
    }
  });
  it("keeps deletion action-specific and preserves permitted chart/vitals detach", () => {
    expect(VISIT_RECORD_REFERENCES.filter(r => r.deletion.startsWith("restrict_")).map(r => r.table)).toEqual([
      "perio_exams", "endo_visits", "patient_diagnoses", "inventory_movements", "planned_visits",
    ]);
    expect(VISIT_DELETE_FOOTPRINT_SQL).not.toMatch(/tooth_conditions|patient_vitals|patient_documents|visit_procedures|FOR\s+(UPDATE|SHARE)/);
    expect(visitDeleteFootprintRefusal({ clinical: false, workflow: false, financial: false })).toBeNull();
    expect(visitDeleteFootprintRefusal({ clinical: true, workflow: false, financial: false })).toBe("has_clinical_history");
    expect(visitDeleteFootprintRefusal({ clinical: false, workflow: true, financial: false })).toBe("has_linked_workflow");
    expect(visitDeleteFootprintRefusal({ clinical: false, workflow: false, financial: true })).toBe("has_financial_history");
  });
});
