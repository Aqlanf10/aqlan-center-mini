import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORTHO_ADJUSTMENT_REQUESTS_SQL } from "../lib/ortho-adjustment-requests-schema";
import { RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";
describe("additive orthodontic request persistence", () => {
  it("keeps the runtime SQL identical to reserved local migration0109", () => {
    expect(ORTHO_ADJUSTMENT_REQUESTS_SQL).toBe(readFileSync("migrations/0109_ortho_adjustment_requests.sql", "utf8"));
    expect(ORTHO_ADJUSTMENT_REQUESTS_SQL).not.toMatch(/\b(?:DROP|ALTER TABLE)\b/);
    expect(ORTHO_ADJUSTMENT_REQUESTS_SQL).toContain("PRIMARY KEY (actor_user_id, request_key)");
    expect(ORTHO_ADJUSTMENT_REQUESTS_SQL).toContain("request_hash ~ '^[a-f0-9]{64}$'");
  });
  it("keeps command proofs protected from reset and identity reuse", () => {
    expect(RESET_KEEP_TABLES).toContain("ortho_adjustment_requests");
    expect(RESET_WIPE_TABLES).not.toContain("ortho_adjustment_requests");
    expect(ORTHO_ADJUSTMENT_REQUESTS_SQL).toContain("ortho_adjustment_request_no_truncate BEFORE TRUNCATE");
  });
});
