import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PERIODONTICS_SQL } from "../lib/periodontics-schema";
describe("periodontal persistence schema", () => {
  it("keeps complete migration bytes identical to runtime SQL", () => expect(readFileSync("migrations/0041_periodontics.sql", "utf8")).toBe(PERIODONTICS_SQL));
  it("creates only three clinical tables and has no money or duplicate patient/signature store", () => {
    expect(PERIODONTICS_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)?.map((m) => m.split(" ").pop())).toEqual(["perio_exams", "perio_site_observations", "perio_addenda"]);
    const tables = PERIODONTICS_SQL.split("CREATE OR REPLACE FUNCTION")[0];
    expect(tables).not.toMatch(/patient_id|signed_at|signed_by|amount|currency|price|invoice/);
    expect(PERIODONTICS_SQL).not.toMatch(/ON DELETE CASCADE|NUMERIC\s*\(/i);
    expect(PERIODONTICS_SQL).toContain("scale(probing_depth_mm) <= 2");
  });
  it("guards signed writes and stable identities under the existing visit lock", () => {
    expect(PERIODONTICS_SQL).toContain("WHERE id = NEW.visit_id FOR UPDATE");
    expect(PERIODONTICS_SQL).toContain("WHERE e.id = target_exam FOR UPDATE OF v");
    expect(PERIODONTICS_SQL).toContain("signed periodontal record is immutable");
    expect(PERIODONTICS_SQL).toContain("periodontal site identity is immutable");
    expect(PERIODONTICS_SQL).toContain("signed periodontal visit signature is immutable");
    expect(PERIODONTICS_SQL).toContain("periodontal addenda are append-only");
    expect(PERIODONTICS_SQL).toContain("UNIQUE (exam_id, request_key)");
  });
  it("does not infer context or healthy measurements from a service or tooth presence", () => {
    expect(PERIODONTICS_SQL).toContain("specialty = 'periodontics'");
    expect(PERIODONTICS_SQL).toContain("kind = 'doctor'");
    expect(PERIODONTICS_SQL).not.toMatch(/bleeding_on_probing BOOLEAN\s+DEFAULT|probing_depth_mm NUMERIC\s+DEFAULT/);
  });
});
