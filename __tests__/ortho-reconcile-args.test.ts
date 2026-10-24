import { describe, expect, it } from "vitest";
import { parseReconcileArgs } from "../lib/ortho-legacy-reconciliation";

describe("db:ortho-reconcile arguments", () => {
  it("is report-only by default and always needs the target database name", () => {
    expect(parseReconcileArgs(["--database", "aqlan_synthetic"])).toEqual({ apply: false, expectedDatabase: "aqlan_synthetic", expectedFingerprint: undefined, actor: undefined, reason: undefined });
    expect(() => parseReconcileArgs([])).toThrow("ORTHO_RECONCILE_USAGE: --database is required");
    expect(() => parseReconcileArgs(["--apply"])).toThrow("ORTHO_RECONCILE_USAGE: --database is required");
  });
  it("passes the apply confirmation fields through unchanged", () => {
    expect(parseReconcileArgs(["--apply", "--database", "db", "--expect-fingerprint", "a".repeat(64), "--actor", "op", "--reason", "Reviewed"]))
      .toEqual({ apply: true, expectedDatabase: "db", expectedFingerprint: "a".repeat(64), actor: "op", reason: "Reviewed" });
  });
  it.each([[["--database"]], [["--database", "--apply"]], [["--force", "x", "--database", "db"]], [["db"]]])("rejects %j", argv => {
    expect(() => parseReconcileArgs(argv)).toThrow(/^ORTHO_RECONCILE_USAGE/);
  });
});
