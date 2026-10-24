import { describe, expect, it } from "vitest";
import { mkdtemp, chmod, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateReferenceCreateSql, validatePrivateOutputDirectory, validatePrivateReferenceConfig, type PrivateReferenceConfig } from "../lib/ortho-private-reference";
const config = (): PrivateReferenceConfig => ({ format: 1, disposableCluster: true,
  cluster: { systemIdentifier: "1234567890123456789", versionNum: "180006", version: "synthetic build", bootstrapRole: "ci" },
  databaseOwner: "reference_owner", initializerRole: "reference_owner",
  locale: { encoding: "UTF8", provider: "libc", lcCollate: "C", lcCtype: "C", locale: null, rules: null, storedVersion: null, actualVersion: null },
  environmentWitness: { imageDigest: `example.invalid/synthetic@sha256:${"a".repeat(64)}`, platform: "linux/amd64", libc: "synthetic", localeData: "synthetic", icu: null, approvalId: "synthetic-review" } });
describe("private reference configuration", () => {
  it("creates a separate template0 database without forcing catalog versions or security", () => {
    const sql = privateReferenceCreateSql(`aqlan_ortho_reference_${"a".repeat(32)}`, config());
    expect(sql).toContain('OWNER "reference_owner" TEMPLATE template0');
    expect(sql).not.toMatch(/COLLATION_VERSION|REFRESH|GRANT|ALTER|UPDATE|search_path/i);
  });
  it.each(["unknown", "role", "version", "provider", "image", "notDisposable"])("rejects %s", defect => {
    const input = config();
    if (defect === "unknown") Object.assign(input, { sql: "SELECT 1" });
    if (defect === "role") input.initializerRole = "ci -c role=other";
    if (defect === "version") input.locale.actualVersion = "unmatched";
    if (defect === "provider") input.locale.locale = "unexpected";
    if (defect === "image") input.environmentWitness.imageDigest = "floating:tag";
    if (defect === "notDisposable") Object.assign(input, { disposableCluster: false });
    expect(() => validatePrivateReferenceConfig(input)).toThrow("PRIVATE_REFERENCE_CONFIG");
  });
  it("quotes locale values and rejects uncontrolled database names", () => {
    const input = config(); input.locale.lcCollate = "locale'quoted";
    expect(privateReferenceCreateSql(`aqlan_ortho_reference_${"b".repeat(32)}`, input)).toContain("'locale''quoted'");
    expect(() => privateReferenceCreateSql("postgres", input)).toThrow();
  });
  it("requires private real directories outside all git checkouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "private-reference-unit-"));
    try {
      await expect(validatePrivateOutputDirectory(root)).resolves.toBe(root);
      await chmod(root, 0o755);
      await expect(validatePrivateOutputDirectory(root)).rejects.toThrow();
      await chmod(root, 0o700);
      const alias = root + "-alias";
      await symlink(root, alias);
      try { await expect(validatePrivateOutputDirectory(alias)).rejects.toThrow(); } finally { await rm(alias); }
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/test");
      await expect(validatePrivateOutputDirectory(root)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
