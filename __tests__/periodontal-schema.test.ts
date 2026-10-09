import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PERIODONTAL_SQL } from "../lib/periodontal-schema";
import { COORDINATED_MIGRATION_VERSIONS } from "../lib/migrations";

describe("unregistered periodontal SQL source contract (SQL never executed)", () => {
  it("adds only two measurement tables, without touching existing rows or changing ownership", () => {
    expect(PERIODONTAL_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)?.map((line) => line.split(" ").pop()))
      .toEqual(["periodontal_records", "periodontal_sites"]);
    expect(PERIODONTAL_SQL).not.toMatch(/\b(DROP|ALTER TABLE|TRUNCATE)\b|^\s*(UPDATE|DELETE|INSERT)\s/im);
    expect(PERIODONTAL_SQL).not.toMatch(/currency|amount_minor|plan_id|case_id|doctor_id|visit_id|diagnosis|severity/i);
  });
  it("does not register schema, a numbered migration, a route or an editor", () => {
    expect(readFileSync("lib/db.ts", "utf8")).not.toContain("PERIODONTAL_SQL");
    expect(readdirSync("migrations").filter((name) => /^\d{4}_.*\.sql$/.test(name)).map((name) => name.slice(0, 4)))
      .toEqual(COORDINATED_MIGRATION_VERSIONS);
    expect(readdirSync("migrations").some((name) => name.includes("periodontal"))).toBe(false);
    expect(readdirSync("app/api/patients/[id]")).not.toContain("periodontal");
    expect(readFileSync("components/DentalChart.tsx", "utf8")).toContain("recordingAvailable={false}");
  });
  it("makes observed values nullable and never defaults them to normal or negative", () => {
    expect(PERIODONTAL_SQL).toMatch(/depth_mm\s+NUMERIC CHECK/);
    expect(PERIODONTAL_SQL).toMatch(/bleeding\s+BOOLEAN,/);
    expect(PERIODONTAL_SQL).not.toMatch(/depth_mm[^\n]*DEFAULT|bleeding[^\n]*DEFAULT/);
    expect(PERIODONTAL_SQL).toContain("depth_mm < 'Infinity'::numeric");
  });
  it("guards identities, predecessor, replay and unique positional sites", () => {
    expect(PERIODONTAL_SQL).toContain("CONSTRAINT periodontal_records_one_request UNIQUE (recorded_by, request_key)");
    expect(PERIODONTAL_SQL).toContain("PRIMARY KEY (record_id, surface, position)");
    expect(PERIODONTAL_SQL).toContain("prior_record_id < id");
    expect(PERIODONTAL_SQL).toContain("CONSTRAINT periodontal_record_identity UNIQUE (id, patient_id, tooth_code)");
    expect(PERIODONTAL_SQL).toContain("FOREIGN KEY (prior_record_id, patient_id, tooth_code)");
    expect(PERIODONTAL_SQL).toContain("REFERENCES periodontal_records (id, patient_id, tooth_code)");
    expect(PERIODONTAL_SQL).toContain("ON UPDATE NO ACTION ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED");
    expect(PERIODONTAL_SQL).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(PERIODONTAL_SQL).not.toContain("ON DELETE CASCADE");
  });
  it("preserves the canonical patient-only merge update without permitting measurement rewrites", () => {
    expect(PERIODONTAL_SQL).toContain("NEW.patient_id <> OLD.patient_id");
    expect(PERIODONTAL_SQL).toContain("(to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id')");
    expect(PERIODONTAL_SQL).toContain("BEFORE UPDATE OR DELETE ON periodontal_records");
    expect(PERIODONTAL_SQL).toContain("BEFORE UPDATE OR DELETE ON periodontal_sites");
    expect(PERIODONTAL_SQL).not.toMatch(/UNIQUE \(patient_id, tooth_code/);
  });
  it("requires a complete six-position snapshot at commit without fabricating measurements", () => {
    expect(PERIODONTAL_SQL).toContain("COUNT(*) FROM periodontal_sites WHERE record_id = NEW.id) <> 6");
    expect(PERIODONTAL_SQL).toContain("depth_mm IS NOT NULL OR bleeding IS NOT NULL");
    expect(PERIODONTAL_SQL).toContain("CREATE CONSTRAINT TRIGGER periodontal_record_complete");
  });
  it("bounds raw replay identifiers and rejects any non-grammar character without end anchors", () => {
    expect(PERIODONTAL_SQL).toContain("length(request_key) BETWEEN 8 AND 128 AND request_key !~ '[^A-Za-z0-9._:-]'");
    expect(PERIODONTAL_SQL).toContain("length(request_fingerprint) = 64 AND request_fingerprint !~ '[^a-f0-9]'");
  });
});
