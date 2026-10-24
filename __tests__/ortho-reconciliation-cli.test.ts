import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("synthetic operator boundary", () => {
  it.each([
    ["postgresql://private-user:private-secret@198.51.100.1/production", []],
    ["postgresql://private-user:private-secret@198.51.100.1/aqlan_ortho_legacy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_fixture", []],
    ["postgresql://ci:ci@127.0.0.1:1/aqlan_ortho_legacy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_fixture", ["--apply-synthetic"]],
    ["postgresql://ci:ci@127.0.0.1:1/aqlan_ortho_legacy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_fixture", ["--apply-synthetic", "--apply-synthetic"]],
  ] as [string, string[]][])("rejects unsafe/missing identity inputs without echoing them", (url, args) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/db-ortho-reconcile.ts", ...args], {
      encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test", ORTHO_RECONCILE_URL: url }, timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ event: "ortho_reconciliation_refused" });
    expect(result.stderr).not.toMatch(/private|198\.51|postgresql|127\.0|ECONNREFUSED/);
  });
});
