import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORTHO_TREATMENT_STRATEGY_SQL } from "../lib/ortho-treatment-strategy-schema";
import { HTTP_PERMISSIONS } from "../lib/http-permissions";
import { RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("reserved0051 case strategy schema ownership", () => {
  it("shares the exact migration body with runtime bootstrap, without touching earlier migrations", () => {
    const migration = readFileSync(new URL("../migrations/0051_ortho_treatment_strategy.sql", import.meta.url), "utf8");
    expect(migration.slice(migration.indexOf("CREATE TABLE")).trim()).toBe(ORTHO_TREATMENT_STRATEGY_SQL);
    const db = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    expect(db.match(/await getPool\(\)\.query\(ORTHO_TREATMENT_STRATEGY_SQL\);/g)).toHaveLength(1);
    expect(db.indexOf("query(ORTHO_TREATMENT_STRATEGY_SQL)")).toBeGreaterThan(db.indexOf("query(SPECIALTY_CASES_SQL)"));
    expect(db.indexOf("query(ORTHO_TREATMENT_STRATEGY_SQL)")).toBeLessThan(db.indexOf('if (process.env.SKIP_SEED === "true") return;'));
  });
  it("adds only strategy history, with no backfill or existing clinical/financial changes", () => {
    expect(ORTHO_TREATMENT_STRATEGY_SQL).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i);
    expect(ORTHO_TREATMENT_STRATEGY_SQL.match(/CREATE TABLE IF NOT EXISTS /g)).toHaveLength(1);
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("BEFORE UPDATE OR DELETE ON ortho_strategy_revisions");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("UNIQUE (ortho_case_id, version)");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("UNIQUE (ortho_case_id, actor_user_id, command_id)");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("UNIQUE (supersedes_revision_id)");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("FOREIGN KEY (ortho_case_id, supersedes_revision_id)");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("CREATE CONSTRAINT TRIGGER ortho_strategy_revision_final_state");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("predecessor.version <> current_revision.version - 1");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("o.patient_id = current_revision.patient_id AND c.patient_id = current_revision.patient_id");
  });
  it("retains current ownership FK and permits only ownership reassignment, never recorded provenance", () => {
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("patient_id               INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("recorded_patient_id      INTEGER NOT NULL CHECK (recorded_patient_id > 0)");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).toContain("(to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id')");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).not.toContain("- 'recorded_patient_id'");
    expect(ORTHO_TREATMENT_STRATEGY_SQL).not.toMatch(/recorded_patient_id[^\n]*REFERENCES/);
  });
  it("explicitly classifies patient-owned history for the existing confirmed reset", () => {
    expect(RESET_WIPE_TABLES.filter(name => name === "ortho_strategy_revisions")).toHaveLength(1);
    expect(RESET_KEEP_TABLES as readonly string[]).not.toContain("ortho_strategy_revisions");
    expect(RESET_WIPE_TABLES.indexOf("ortho_strategy_revisions")).toBeLessThan(RESET_WIPE_TABLES.indexOf("ortho_cases"));
    expect(RESET_WIPE_TABLES.indexOf("ortho_strategy_revisions")).toBeLessThan(RESET_WIPE_TABLES.indexOf("clinical_cases"));
  });
  it("registers only canonical clinical reader/writer roles and preserves bounded-body admission", () => {
    expect(HTTP_PERMISSIONS["/api/ortho/[id]/strategy"]).toEqual({ GET: ["admin", "reception", "doctor"], POST: ["admin", "doctor"] });
    const route = readFileSync(new URL("../app/api/ortho/[id]/strategy/route.ts", import.meta.url), "utf8");
    expect(route).toContain("readJsonBody(request, JSON_BODY_LIMIT_BYTES)");
    expect(route).toContain("guardPatient(found.patientId, write)");
    expect(route).not.toMatch(/export async function (PATCH|DELETE|PUT)/);
  });
  it("registers the append audit action and a readable label", () => {
    const audit = readFileSync(new URL("../lib/audit.ts", import.meta.url), "utf8");
    expect(audit).toContain('| "ortho.strategy_revision"');
    expect(audit).toContain('"ortho.strategy_revision": "توثيق مراجعة خطة الحالة التقويمية"');
  });
});
