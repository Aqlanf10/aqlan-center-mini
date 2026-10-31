import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const consumers = ["eslint", "@eslint/config-array", "@typescript-eslint/typescript-estree"];

describe("reviewed minimatch resolution and consumer compatibility", () => {
  it("locks every installed copy to the official fixed development-only release", () => {
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith("/minimatch"));
    expect(copies.length).toBeGreaterThan(0);
    for (const [, pkg] of copies) {
      expect(pkg.version).toBe("11.0.3");
      expect(pkg.dev).toBe(true);
      expect(pkg.resolved).toBe("https://registry.npmjs.org/minimatch/-/minimatch-11.0.3.tgz");
    }
  });

  it.each(consumers)("supports the actual CommonJS and ESM API used by %s", async (consumer) => {
    const fromConsumer = createRequire(require.resolve(consumer));
    const commonjs = fromConsumer("minimatch");
    // Bare ESM import exercises the import export, not the CJS path returned by require.resolve.
    const esm = await import("minimatch");
    expect(fromConsumer.resolve("minimatch")).toBe(require.resolve("minimatch"));
    for (const api of [commonjs, esm]) {
      expect(typeof api.minimatch).toBe("function");
      expect(typeof api.Minimatch).toBe("function");
      expect(new api.Minimatch("**/*.{ts,tsx}", { dot: true }).match(".hidden/component.tsx")).toBe(true);
      expect(api.minimatch("src/component.tsx", "src/**")).toBe(true);
      expect(api.minimatch("node_modules/pkg/index.js", "**/node_modules/**", { dot: true })).toBe(true);
      expect(api.minimatch("src/component.test.ts", "**/!(*.test).ts")).toBe(false);
      expect(api.minimatch("src/component.ts", "**/!(*.test).ts")).toBe(true);
      expect(api.minimatch("README.md", "**/*.{ts,tsx}")).toBe(false);
    }
  });

  it("loads the real ESLint flat config with unchanged safety rules and ignore boundaries", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint();
    const config = await eslint.calculateConfigForFile("components/PrescriptionModal.tsx");
    for (const rule of ["react-hooks/rules-of-hooks", "react-hooks/refs", "react-hooks/immutability"]) {
      expect(config.rules[rule][0]).toBe(2);
    }
    expect(await eslint.isPathIgnored("node_modules/synthetic/file.ts")).toBe(true);
    expect(await eslint.isPathIgnored(".next/synthetic/file.ts")).toBe(true);
    expect(await eslint.isPathIgnored("components/PrescriptionModal.tsx")).toBe(false);
  });

  it.each([
    "import {useState} from 'react'; export function Parent({value}) { function Child(){const [x]=useState(value);return <span>{x}</span>;}return <Child/>;}",
    "import {useState} from 'react'; function makeChild(value){return function Child(){const [x]=useState(value);return <span>{x}</span>;};} export function Parent({value}){const Child=makeChild(value);return <Child/>;}",
  ])("still rejects render-time component creation after upstream factory-rule deprecation", async (source) => {
    const { ESLint } = await import("eslint");
    const [result] = await new ESLint().lintText(source, { filePath: "components/SyntheticRuleProbe.tsx" });
    expect(result.messages.some((message) => message.ruleId === "react-hooks/static-components" && message.severity === 2)).toBe(true);
  });

  it("accepts the corresponding module-level component with explicit props", async () => {
    const { ESLint } = await import("eslint");
    const source = "import {useState} from 'react'; function Child({value}){const [x]=useState(value);return <span>{x}</span>;}export function Parent({value}){return <Child value={value}/>;}";
    const [result] = await new ESLint().lintText(source, { filePath: "components/SyntheticRuleProbe.tsx" });
    expect(result.errorCount).toBe(0);
  });
});
