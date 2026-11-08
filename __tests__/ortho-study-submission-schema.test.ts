import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORTHO_STUDY_SUBMISSION_SQL } from "../lib/ortho-study-submission-schema";
import { ORTHO_STUDY_HISTORY_TABLES, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("additive orthodontic study submission journal", () => {
  it("registers the exact reserved migration without altering existing history", () => {
    expect(ORTHO_STUDY_SUBMISSION_SQL).toBe(readFileSync("migrations/0112_ortho_study_submissions.sql", "utf8"));
    expect(ORTHO_STUDY_SUBMISSION_SQL).not.toMatch(/\b(?:DROP|ALTER TABLE)\b/);
    const runtime = readFileSync("lib/db.ts", "utf8");
    expect(runtime).toContain('version: "0112", name: "ortho_study_submissions", filename: "0112_ortho_study_submissions.sql", sql: ORTHO_STUDY_SUBMISSION_SQL');
  });
  it("protects retained proofs and fences reset in writer order", () => {
    expect(ORTHO_STUDY_HISTORY_TABLES).toEqual(["ortho_case_study_revisions", "ortho_study_submissions"]);
    expect(RESET_KEEP_TABLES).toContain("ortho_study_submissions");
    expect(RESET_WIPE_TABLES).not.toContain("ortho_study_submissions");
    expect(ORTHO_STUDY_SUBMISSION_SQL).toContain("ortho_study_submission_no_truncate BEFORE TRUNCATE");
    expect(ORTHO_STUDY_SUBMISSION_SQL).toContain("ON ortho_study_submissions(ortho_case_id) WHERE acknowledged_at IS NULL");
  });
});
