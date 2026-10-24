import { describe, expect, it } from "vitest";
import reference from "../schema/ortho-empty51-reference.pg18.json";
import { catalogHash } from "../lib/ortho-reconciliation-catalog";
import { validateEmpty51Approval, type Empty51Approval } from "../lib/ortho-empty51-reconciliation";
const approval = (): Empty51Approval => ({ environment: "staging", endpoint: { host: "synthetic.invalid", port: 5432, database: "synthetic", user: "ci" },
  identity: { database: "synthetic", oid: "123", owner: "ci", role: "ci", serverAddress: "127.0.0.1", serverPort: 5432, version: "180006" },
  reviewedReferenceDigest: catalogHash(reference), approvalId: "synthetic-review-001", actionId: "synthetic-action-001",
  window: { from: new Date(Date.now()-1000).toISOString(), until: new Date(Date.now()+15*60_000).toISOString(), noApplicationOrDDLOrSequenceCallers: true, preserveAuditAndRegistry: true } });
describe("empty0051 approval is explicit and source-bound", () => {
  it("accepts a bounded independently approved synthetic reference", () => expect(() => validateEmpty51Approval(approval(), reference)).not.toThrow());
  it.each(["digest", "expired", "long", "identity", "maintenance", "retention"])("refuses %s before connecting", defect => {
    const input = approval();
    if (defect === "digest") input.reviewedReferenceDigest = "0".repeat(64);
    if (defect === "expired") input.window.until = new Date(0).toISOString();
    if (defect === "long") input.window.until = new Date(Date.now()+60*60_000).toISOString();
    if (defect === "identity") input.identity.database = "different";
    if (defect === "maintenance") Object.assign(input.window, { noApplicationOrDDLOrSequenceCallers: false });
    if (defect === "retention") Object.assign(input.window, { preserveAuditAndRegistry: false });
    expect(() => validateEmpty51Approval(input, reference)).toThrow("ORTHO_RECONCILIATION_TARGET");
  });
  it("an approved digest cannot approve altered migration/audit structure", () => {
    const changed = structuredClone(reference); changed.auditCatalog = [];
    const input = approval(); input.reviewedReferenceDigest = catalogHash(changed);
    expect(() => validateEmpty51Approval(input, changed)).toThrow("ORTHO_RECONCILIATION_CATALOG");
  });
});
