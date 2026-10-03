import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { extractOfficialBracesFixture, loadOfficialBracesFixture, OFFICIAL_BRACES_ARCHIVE, verifyFixtureDirectory } from "../scripts/dependency-review/braces-fixture.mjs";

const candidate = fileURLToPath(new URL("../vendor/braces/", import.meta.url));
const provenance = JSON.parse(readFileSync(new URL("../vendor/braces-provenance.json", import.meta.url), "utf8"));
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const baseline = loadOfficialBracesFixture();
afterAll(() => baseline.cleanup());

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe("local braces patch provenance", () => {
  it("attests every candidate file and refuses an unrecorded addition", () => {
    const actual = Object.fromEntries(files(candidate).map((path) => [relative(candidate, path), sha256(path)]));
    expect(actual).toEqual(provenance.patch.source_sha256);
  });

  it("preserves original identity, package metadata, API entry point and MIT license", () => {
    for (const path of ["package.json", "index.js", "LICENSE", "README.md", "lib/constants.js", "lib/utils.js"]) {
      expect(sha256(join(candidate, path)), path).toBe(provenance.upstream.source_sha256[path]);
    }
    expect(provenance.upstream.name).toBe("braces");
    expect(provenance.upstream.version).toBe("3.0.3");
    expect(provenance.upstream.integrity).toBe(
      "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==",
    );
  });

  it("uses only separately verified archive contents for differential tests", () => {
    expect(baseline.directory).not.toContain("node_modules");
    for (const [path, hash] of Object.entries(provenance.upstream.source_sha256)) {
      expect(sha256(join(baseline.directory, path)), path).toBe(hash);
    }
    expect(() => baseline.module.parse("{".repeat(129) + "a,b" + "}".repeat(129))).not.toThrow();
    expect(verifyFixtureDirectory(baseline.directory)).toEqual(provenance.upstream.source_sha256);
  });

  it("rejects a modified official archive before extracting or executing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "aqlan-braces-corrupt-fixture-"));
    try {
      const bytes = readFileSync(OFFICIAL_BRACES_ARCHIVE);
      bytes[bytes.length - 1] ^= 1;
      const path = join(directory, "braces.tgz");
      writeFileSync(path, bytes);
      expect(() => extractOfficialBracesFixture(path)).toThrow(/archive integrity mismatch/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects modified or unrecorded extracted source files", () => {
    const fixture = extractOfficialBracesFixture();
    try {
      writeFileSync(join(fixture.directory, "index.js"), "module.exports = {};\n");
      expect(() => verifyFixtureDirectory(fixture.directory)).toThrow(/source hash mismatch/);
      writeFileSync(join(fixture.directory, "unrecorded.js"), "module.exports = {};\n");
      expect(() => verifyFixtureDirectory(fixture.directory)).toThrow(/inventory mismatch/);
    } finally {
      fixture.cleanup();
    }
  });
});
