/** Migration 0137: numbered file and runtime constant are byte-identical, registered once, and reset protects it. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CEPH_COMPLETION_PROVENANCE_SQL } from "../lib/ceph-provenance/schema";
import { CEPH_PROVENANCE_HISTORY_TABLES, RESET_KEEP_TABLES } from "../lib/clinic-reset";

describe("ceph completion provenance schema (0137)", () => {
  it("numbered file equals the runtime constant", () => {
    expect(readFileSync(new URL("../migrations/0137_ceph_completion_provenance.sql", import.meta.url), "utf8")).toBe(CEPH_COMPLETION_PROVENANCE_SQL);
  });
  it("is registered at runtime once under 0137 with the checksum of the same text", () => {
    const db = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    expect(db.match(/version: "0137", name: "ceph_completion_provenance", filename: "0137_ceph_completion_provenance.sql", sql: CEPH_COMPLETION_PROVENANCE_SQL, checksum: checksumOf\(CEPH_COMPLETION_PROVENANCE_SQL\)/g)).toHaveLength(1);
  });
  it("is additive: no back-fill, no edit of existing ceph rows, sealed rows immutable", () => {
    expect(CEPH_COMPLETION_PROVENANCE_SQL).not.toMatch(/INSERT INTO|UPDATE ceph_|DELETE FROM|DROP TABLE|ALTER TABLE/i);
    for (const trigger of ["ceph_completion_provenance_immutable", "ceph_witnessed_analysis_immutable", "ceph_witnessed_landmarks_immutable",
      "ceph_witnessed_measurements_immutable", "ceph_witnessed_diagnoses_immutable", "ceph_completion_provenance_final_state"]) {
      expect(CEPH_COMPLETION_PROVENANCE_SQL).toContain(`CREATE ${trigger.endsWith("final_state") ? "CONSTRAINT " : ""}TRIGGER ${trigger}`);
    }
  });
  it("reset keeps sealed records and is refused while any exists", () => {
    expect(CEPH_PROVENANCE_HISTORY_TABLES).toEqual(["ceph_completion_provenance"]);
    expect(RESET_KEEP_TABLES).toContain("ceph_completion_provenance");
    const db = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    expect(db).toContain("if (cephHistory.exists) throw new ProtectedCephProvenanceHistoryError();");
  });
});
