import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Retained from main's minimatch-estree-compatibility test (reviewed on #483): the real
// TypeScript-ESLint parser allowlist and its dot-aware matching, independent of the ESLint
// version and of package paths. The toolchain/lock pins live in the reviewed override tests.
const require = createRequire(import.meta.url);
const fromEstree = createRequire(require.resolve("@typescript-eslint/typescript-estree"));
const minimatch = fromEstree("minimatch").minimatch;

describe("typescript-estree allowlist matching", () => {
  it("resolves a fixed minimatch major for the parser", () => {
    expect(Number(fromEstree("minimatch/package.json").version.split(".")[0])).toBeGreaterThanOrEqual(10);
  });

  it.each([
    ["config.js", "*.js", true],
    [".config.js", "*.js", true],
    ["src/config.ts", "src/*.{ts,tsx}", true],
    ["src/config.test.ts", "src/!(*.test).ts", false],
    ["src/config.ts", "src/!(*.test).ts", true],
    ["other.js", "config.js", false],
    ["src/config.js", "*.js", false],
  ])("retains the estree dot-aware match for %s against %s", (file, pattern, accepted) => {
    expect(minimatch(file, pattern, { dot: true })).toBe(accepted);
  });

  it.each([
    ["config.js", "*.js", true],
    [".config.js", "*.js", true],
    ["other.js", "config.js", false],
  ])("enforces the real parser project-service allowlist for %s", (file, pattern, accepted) => {
    const parser = require("@typescript-eslint/typescript-estree");
    const directory = mkdtempSync(join(tmpdir(), "aqlan-estree-allowlist-"));
    try {
      writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true }, include: ["included.ts"] }));
      writeFileSync(join(directory, "included.ts"), "export {};\n");
      const parse = () => parser.parseAndGenerateServices("const value = 1;", {
        filePath: join(directory, file), tsconfigRootDir: directory,
        projectService: { allowDefaultProject: [pattern] },
      });
      if (accepted) expect(parse().services.program).toBeDefined();
      else expect(parse).toThrow(/which does not match 'other.js'/);
    } finally {
      parser.clearCaches();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
