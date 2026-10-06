import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REVIEWED_OVERRIDES } from "../scripts/dependency-security/reviewed-overrides.mjs";

const read = (name: string) => readFileSync(new URL("../" + name, import.meta.url));
const manifest = JSON.parse(read("package.json").toString());
const lock = JSON.parse(read("package-lock.json").toString());
const artifact = "vendor/braces-3.0.3-local.tgz";
const integrity = "sha512-" + createHash("sha512").update(read(artifact)).digest("base64");

describe("development-only braces artifact packaging", () => {
  it("pins the unchanged package identity as a local development dependency without overriding braces", () => {
    expect(manifest.dependencies).not.toHaveProperty("braces");
    expect(manifest.devDependencies.braces).toBe("file:" + artifact);
    expect(manifest.overrides).toEqual(REVIEWED_OVERRIDES);
    expect(JSON.parse(read("scripts/dependency-review/consumer-fixture/package.json").toString()).overrides).toEqual(REVIEWED_OVERRIDES);
    expect(lock.packages[""].devDependencies.braces).toBe(manifest.devDependencies.braces);
    const copies = Object.entries(lock.packages).filter(([name]) => name === "node_modules/braces" || name.endsWith("/node_modules/braces"));
    expect(copies.length).toBeGreaterThan(0);
    for (const [, entry] of copies as Array<[string, any]>) {
      expect(entry.version).toBe("3.0.3");
      expect(entry.dev).toBe(true);
      expect(entry.resolved).toBe("file:" + artifact);
      expect(entry.integrity).toBe(integrity);
    }
  });

  it("copies only the exact artifact before Docker npm ci and checks runtime after both builds", () => {
    const docker = read("Dockerfile").toString();
    const copy = `COPY ${artifact} ./${artifact}`;
    expect(docker.indexOf(copy)).toBeGreaterThan(-1);
    expect(docker.indexOf(copy)).toBeLessThan(docker.indexOf("RUN npm ci"));
    const runtimeCheck = docker.indexOf("RUN node scripts/verify-braces-runtime.mjs");
    expect(runtimeCheck).toBeGreaterThan(docker.indexOf("RUN npm run build\n"));
    expect(runtimeCheck).toBeGreaterThan(docker.indexOf("RUN npm run build:preflight"));
    expect(docker.slice(docker.indexOf("FROM node:22-alpine AS runner"))).not.toMatch(/COPY.*(?:vendor|__tests__|dependency-review)/);
  });

  it("limits the CommonJS import syntax allowance to the five named upstream modules", () => {
    const config = read("eslint.config.mjs").toString();
    const scoped = config.slice(config.indexOf("// These five integrity-pinned"));
    expect(scoped).toContain('"vendor/braces/index.js"');
    for (const name of ["compile", "expand", "parse", "stringify"]) expect(scoped).toContain(`"vendor/braces/lib/${name}.js"`);
    expect(scoped).toContain('rules: { "@typescript-eslint/no-require-imports": "off" }');
    expect(scoped).not.toMatch(/vendor\/\*|vendor\/braces\/\*|ignores:/);
    expect(scoped).not.toContain("nesting-guard.js");
  });
});
