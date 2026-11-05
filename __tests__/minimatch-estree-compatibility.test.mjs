import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fromEstree = createRequire(require.resolve("@typescript-eslint/typescript-estree"));
const minimatch = fromEstree("minimatch").minimatch;
const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

describe("reviewed minimatch fix with the staging lint toolchain", () => {
  it("pins the shared estree and ESLint copy to the official development-only package", () => {
    const manifest = read("package.json");
    const lock = read("package-lock.json");
    const fixedPath = "node_modules/minimatch";
    const copies = Object.keys(lock.packages).filter((path) => path.endsWith("/minimatch"));
    expect(copies).toEqual([fixedPath]);
    expect(lock.packages[fixedPath]).toMatchObject({
      version: "11.0.3",
      resolved: "https://registry.npmjs.org/minimatch/-/minimatch-11.0.3.tgz",
      integrity: "sha512-iny/40PEGkNJQ5/Pv6z3nm6FbRAby32GeZRjCUJk2WnNDbgPSTcdI+DDvLqsgBdD4cD5sMtMheqPPnehCCa8Nw==",
      dev: true,
      engines: { node: "18 || 20 || >=22" },
    });
    expect(fromEstree("minimatch/package.json").version).toBe("11.0.3");
    expect(lock.packages["node_modules/@isaacs/nonrecursive-glob-match"].dev).toBe(true);
    expect(lock.packages["node_modules/eslint"].version).toBe("10.14.0");
    expect(lock.packages["node_modules/eslint-plugin-react-hooks"].version).toBe("7.1.1");
    expect(manifest.engines.node).toBe(">=22.13 <23");
    expect(fromEstree.resolve("minimatch")).toContain(`${fixedPath}/`);
  });

  it.each(["eslint", "@eslint/config-array", "@typescript-eslint/typescript-estree"])(
    "preserves the named minimatch API used by %s", (consumer) => {
      const fromConsumer = createRequire(require.resolve(consumer));
      const { minimatch: match, Minimatch } = fromConsumer("minimatch");
      expect(fromConsumer.resolve("minimatch")).toBe(require.resolve("minimatch"));
      expect(typeof match).toBe("function");
      expect(typeof Minimatch).toBe("function");
      expect(new Minimatch("**/*.{ts,tsx}", { dot: true }).match(".hidden/component.tsx")).toBe(true);
      expect(match("src/component.tsx", "src/**")).toBe(true);
      expect(match("README.md", "**/*.{ts,tsx}")).toBe(false);
    },
  );

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
    const directory = mkdtempSync(join(tmpdir(), "aqlan-estree-compat-"));
    try {
      writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { allowJs: true }, include: ["included.ts"],
      }));
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
  }, 30_000); // A cold TypeScript project service can exceed Vitest's 5s default.

  it("loads the staging ESLint safety rules and keeps ignored paths excluded", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint();
    const config = await eslint.calculateConfigForFile("components/PrescriptionModal.tsx");
    expect(config.rules["react-hooks/rules-of-hooks"][0]).toBe(2);
    // Hooks 7 replaced the deprecated factory rule with static-components.
    expect(config.rules["react-hooks/static-components"][0]).toBe(2);
    expect(await eslint.isPathIgnored("node_modules/synthetic/file.ts")).toBe(true);
    expect(await eslint.isPathIgnored(".next/synthetic/file.ts")).toBe(true);
    expect(await eslint.isPathIgnored("components/PrescriptionModal.tsx")).toBe(false);
    const [result] = await eslint.lintText(
      "import {useState} from 'react'; export function Component({ready}) { if (ready) useState(0); return null; }",
      { filePath: "components/SyntheticRuleProbe.tsx" },
    );
    expect(result.messages.some((message) => message.ruleId === "react-hooks/rules-of-hooks" && message.severity === 2)).toBe(true);
  });
});
