import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { verifyStandaloneAssets } from "./verify-standalone-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historical = await readFile(path.join(root, "migrations/0079_ortho_followup_coverage.sql"));
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "standalone-assets-synthetic-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source"), shipped = path.join(dir, "standalone");
  const files = {
    "lib/preflight-provenance.ts": 'export const PREFLIGHT_SOURCE_FILES = ["lib/preflight-provenance.ts", "lib/example.ts"] as const;',
    "lib/example.ts": "// synthetic preflight source\n",
    "migrations/0001_baseline.sql": "-- synthetic migration\n",
    "migrations/0079_ortho_followup_coverage.sql": historical,
  };
  async function put(base, name, data) { const dst = path.join(base, name); await mkdir(path.dirname(dst), { recursive: true }); await writeFile(dst, data); }
  for (const [name, bytes] of Object.entries(files)) { await put(source, name, bytes); await put(shipped, name, bytes); }
  await put(shipped, "server.js", "// synthetic server\n"); await put(shipped, "package.json", "{}\n");
  await put(source, ".next/BUILD_ID", "synthetic-build-id\n"); await put(shipped, ".next/BUILD_ID", "synthetic-build-id\n");
  await mkdir(path.join(shipped, ".next/server"));
  return { source, shipped, put };
}
const rejects = (operation, code) => assert.rejects(operation, { message: code });

test("matches the complete migration and preflight source inventory", async (t) => {
  const { source, shipped } = await fixture(t);
  assert.deepEqual(await verifyStandaloneAssets(source, shipped), { migrationCount: 2, preflightSourceCount: 2 });
});
test("rejects missing or altered migration and preflight bytes", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await rm(path.join(shipped, "migrations/0001_baseline.sql"));
  await rejects(verifyStandaloneAssets(source, shipped), "REQUIRED_FILE_MISSING");
  await put(shipped, "migrations/0001_baseline.sql", "-- synthetic migration\n");
  await put(shipped, "lib/example.ts", "// altered\n");
  await rejects(verifyStandaloneAssets(source, shipped), "SHIPPED_ASSET_MISMATCH");
  await put(shipped, "lib/example.ts", "// synthetic preflight source\n");
  await put(shipped, "migrations/0001_baseline.sql", "-- altered SQL\n");
  await rejects(verifyStandaloneAssets(source, shipped), "SHIPPED_ASSET_MISMATCH");
});
test("rejects unexpected raw files and synthetic witness paths without reading their contents", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(shipped, "lib/unexpected.ts", "synthetic private marker");
  await rejects(verifyStandaloneAssets(source, shipped), "UNEXPECTED_RAW_ENTRY");
  await rm(path.join(shipped, "lib/unexpected.ts"));
  await put(shipped, "synthetic-trace-witness/marker.txt", "synthetic marker");
  await rejects(verifyStandaloneAssets(source, shipped), "UNEXPECTED_RAW_ENTRY");
  await rm(path.join(shipped, "synthetic-trace-witness"), { recursive: true });
  await put(shipped, ".next/server/app/synthetic-trace-probe/route.js", "// synthetic\n");
  await rejects(verifyStandaloneAssets(source, shipped), "SYNTHETIC_TRACE_MARKER");
});
test("rejects duplicate migration versions and an altered historical source", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(source, "migrations/0001_duplicate.sql", "-- duplicate\n");
  await rejects(verifyStandaloneAssets(source, shipped), "INVALID_MIGRATION_CATALOG");
  await rm(path.join(source, "migrations/0001_duplicate.sql"));
  await put(source, "migrations/0079_ortho_followup_coverage.sql", "-- changed historical SQL\n");
  await rejects(verifyStandaloneAssets(source, shipped), "INVALID_HISTORICAL_0079");
});
test("rejects ambiguous provenance declarations and symlinks for required files", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(source, "lib/preflight-provenance.ts", 'export const PREFLIGHT_SOURCE_FILES = ["lib/example.ts", ...other] as const;');
  await rejects(verifyStandaloneAssets(source, shipped), "INVALID_PREFLIGHT_LIST");
  const contents = 'export const PREFLIGHT_SOURCE_FILES = ["lib/preflight-provenance.ts", "lib/example.ts"] as const;';
  await put(source, "lib/preflight-provenance.ts", contents);
  await rm(path.join(shipped, "lib/example.ts"));
  await symlink(path.join(source, "lib/example.ts"), path.join(shipped, "lib/example.ts"));
  await rejects(verifyStandaloneAssets(source, shipped), "REQUIRED_FILE_NOT_REGULAR");
});
test("rejects an output from a different build", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(shipped, ".next/BUILD_ID", "different-build-id\n");
  await rejects(verifyStandaloneAssets(source, shipped), "BUILD_ID_MISMATCH");
});
