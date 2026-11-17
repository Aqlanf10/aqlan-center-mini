import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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
  for (const [name, bytes] of Object.entries(files)) { await put(source, name, bytes); if (name.startsWith("migrations/")) await put(shipped, name, bytes); }
  const hash = value => createHash("sha256").update(value).digest("hex");
  const runner = "// synthetic preflight runner\n";
  await put(source, ".preflight/runner/run.mjs", runner);
  await put(source, ".preflight/manifest.json", JSON.stringify({ bundleSha256: hash(runner), sourceFiles: {
    "lib/preflight-provenance.ts": hash(files["lib/preflight-provenance.ts"]), "lib/example.ts": hash(files["lib/example.ts"]),
  } }));
  await put(shipped, "server.js", "// synthetic server\n"); await put(shipped, "package.json", "{}\n");
  await put(source, ".next/BUILD_ID", "synthetic-build-id\n"); await put(shipped, ".next/BUILD_ID", "synthetic-build-id\n");
  await mkdir(path.join(source, "public")); await mkdir(path.join(source, ".next/static"));
  await mkdir(path.join(shipped, ".next/server"));
  return { source, shipped, put };
}
const rejects = (operation, code) => assert.rejects(operation, { message: code });

test("matches the complete migration and preflight source inventory", async (t) => {
  const { source, shipped } = await fixture(t);
  assert.deepEqual(await verifyStandaloneAssets(source, shipped), { migrationCount: 2, preflightSourceCount: 2 });
});
test("rejects missing or altered migration and preflight inputs", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await rm(path.join(shipped, "migrations/0001_baseline.sql"));
  await rejects(verifyStandaloneAssets(source, shipped), "REQUIRED_FILE_MISSING");
  await put(shipped, "migrations/0001_baseline.sql", "-- synthetic migration\n");
  await put(source, "lib/example.ts", "// altered\n");
  await rejects(verifyStandaloneAssets(source, shipped), "PREFLIGHT_SOURCE_MISMATCH");
  await put(source, "lib/example.ts", "// synthetic preflight source\n");
  await put(source, ".preflight/runner/run.mjs", "// altered runner\n");
  await rejects(verifyStandaloneAssets(source, shipped), "PREFLIGHT_RUNNER_MISMATCH");
  await put(source, ".preflight/runner/run.mjs", "// synthetic preflight runner\n");
  await put(shipped, "migrations/0001_baseline.sql", "-- altered SQL\n");
  await rejects(verifyStandaloneAssets(source, shipped), "SHIPPED_ASSET_MISMATCH");
});
test("rejects unexpected raw files and synthetic witness paths without reading their contents", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(shipped, "lib/unexpected.ts", "synthetic private marker");
  await rejects(verifyStandaloneAssets(source, shipped), "UNEXPECTED_RAW_ENTRY");
  await rm(path.join(shipped, "lib"), { recursive: true });
  await put(shipped, "synthetic-trace-witness/marker.txt", "synthetic marker");
  await rejects(verifyStandaloneAssets(source, shipped), "UNEXPECTED_RAW_ENTRY");
  await rm(path.join(shipped, "synthetic-trace-witness"), { recursive: true });
  await put(shipped, ".next/server/app/synthetic-trace-probe/route.js", "// synthetic\n");
  await rejects(verifyStandaloneAssets(source, shipped), "SYNTHETIC_TRACE_MARKER");
});
test("rejects a raw test script in standalone, matching the CI failure", async (t) => {
  const { source, shipped, put } = await fixture(t);
  const diagnostics = [];
  await put(shipped, "scripts/assemble-standalone-entry-chunks.test.mjs", "// synthetic raw test source\n");
  await rejects(verifyStandaloneAssets(source, shipped, { onUnexpectedRoot: diagnostic => diagnostics.push(diagnostic) }), "UNEXPECTED_RAW_ENTRY");
  assert.deepEqual(diagnostics, [{ category: "scripts", kind: "directory" }]);
});
test("diagnoses an unknown private-looking root without exposing its name or bytes", async (t) => {
  const { source, shipped, put } = await fixture(t);
  const diagnostics = [];
  const secret = "SYNTHETIC_PRIVATE_NAME_AND_CONTENT";
  await put(shipped, `${secret}.txt`, secret);
  await rejects(verifyStandaloneAssets(source, shipped, { onUnexpectedRoot: diagnostic => diagnostics.push(diagnostic) }), "UNEXPECTED_RAW_ENTRY");
  assert.deepEqual(diagnostics, [{ category: "other", kind: "file" }]);
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
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
  await rm(path.join(source, "lib/example.ts"));
  await symlink(path.join(root, "lib/db.ts"), path.join(source, "lib/example.ts"));
  await rejects(verifyStandaloneAssets(source, shipped), "REQUIRED_FILE_NOT_REGULAR");
});
test("rejects raw TypeScript inside a generated runtime tree", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(shipped, ".next/server/synthetic.tsx", "// raw source\n");
  await rejects(verifyStandaloneAssets(source, shipped), "RAW_TYPESCRIPT_IN_RUNTIME");
});
test("rejects an output from a different build", async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(shipped, ".next/BUILD_ID", "different-build-id\n");
  await rejects(verifyStandaloneAssets(source, shipped), "BUILD_ID_MISMATCH");
});

test("the build verifies standalone assets after completing chunk assembly", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const build = pkg.scripts.build;
  assert.equal(typeof build, "string");
  const assembled = build.indexOf("node scripts/assemble-standalone-entry-chunks.mjs");
  const verified = build.indexOf("node scripts/verify-standalone-assets.mjs");
  assert.ok(build.indexOf("npm run build:preflight") >= 0 && build.indexOf("npm run build:preflight") < assembled && assembled >= 0 && verified > assembled);
});

for (const tree of ["public", ".next/static"]) test(`rejects raw TypeScript and unsafe links from separately shipped ${tree}`, async (t) => {
  const { source, shipped, put } = await fixture(t);
  await put(source, `${tree}/synthetic.tsx`, "// synthetic only\n");
  await rejects(verifyStandaloneAssets(source, shipped), "RAW_TYPESCRIPT_IN_RUNTIME");
  await rm(path.join(source, tree, "synthetic.tsx"));
  await symlink(path.join(root, "lib"), path.join(source, tree, "outside"));
  await rejects(verifyStandaloneAssets(source, shipped), "UNSAFE_RUNTIME_SYMLINK");
  await rm(path.join(source, tree, "outside"));
  await put(source, `${tree}/synthetic-trace-witness`, "synthetic marker");
  await rejects(verifyStandaloneAssets(source, shipped), "SYNTHETIC_TRACE_MARKER");
});
test("rejects a symlinked ancestor of the separately shipped static tree", async (t) => {
  const { source, shipped } = await fixture(t);
  await rename(path.join(source, ".next"), path.join(source, "relocated-next"));
  await symlink("relocated-next", path.join(source, ".next"));
  await rejects(verifyStandaloneAssets(source, shipped), "UNSAFE_RUNTIME_SYMLINK");
});
