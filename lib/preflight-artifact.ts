import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { checksumOf, loadMigrationFiles } from "./migration-files";

export interface PreflightArtifactManifest {
  format: "aqlan-read-only-preflight-artifact";
  formatVersion: 1;
  nodeMajor: 22;
  bundleSha256: string;
  noticesSha256: string;
  bundledPackages: { name: string; version: string; license: string; licenseSha256: string }[];
  migrations: { version: string; name: string; filename: string; checksum: string }[];
}

/** Integrity against the delivered inventory, not signed build attestation. */
export async function validatePreflightArtifact(root: string): Promise<void> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as PreflightArtifactManifest;
    const sha = /^[a-f0-9]{64}$/;
    if (manifest.format !== "aqlan-read-only-preflight-artifact" || manifest.formatVersion !== 1
      || manifest.nodeMajor !== 22 || !sha.test(manifest.bundleSha256) || !sha.test(manifest.noticesSha256)
      || !Array.isArray(manifest.migrations) || !manifest.migrations.length
      || !Array.isArray(manifest.bundledPackages) || !manifest.bundledPackages.length) throw new Error("Invalid manifest.");
    if (manifest.bundledPackages.some((pkg) => !pkg || typeof pkg.name !== "string" || !pkg.name
      || typeof pkg.version !== "string" || !pkg.version || typeof pkg.license !== "string"
      || !sha.test(pkg.licenseSha256))) throw new Error("Invalid dependency provenance.");
    const expected = manifest.migrations;
    if (expected.some((file) => !/^\d{4}$/.test(file.version) || !/^[a-z0-9_]+$/.test(file.name)
      || file.filename !== `${file.version}_${file.name}.sql` || !sha.test(file.checksum))
      || new Set(expected.map((file) => file.filename)).size !== expected.length) throw new Error("Invalid inventory.");
    const entries = await readdir(path.join(root, "migrations"), { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    if (entries.some((entry) => !entry.isFile()) || JSON.stringify(names) !== JSON.stringify(expected.map((file) => file.filename).sort())) {
      throw new Error("Incomplete migration assets.");
    }
    const actual = (await loadMigrationFiles(path.join(root, "migrations")))
      .map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)
      || checksumOf(await readFile(path.join(root, "runner/run.mjs"), "utf8")) !== manifest.bundleSha256
      || checksumOf(await readFile(path.join(root, "THIRD_PARTY_NOTICES.txt"), "utf8")) !== manifest.noticesSha256) {
      throw new Error("Artifact checksum mismatch.");
    }
  } catch {
    throw Object.assign(new Error("Packaged preflight integrity check failed."), { code: "PREFLIGHT_ARTIFACT_INVALID" });
  }
}
