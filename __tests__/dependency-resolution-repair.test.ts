import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const parserIntegrity = "sha512-7qASPzhKF2l2KLboRZux8CCTRMdGiV08vWmyKzPz22qZ7ZjQBOeY7rNzNoCLSUiftJ7HUq0GERHmxw/t0dCdMw==";
const sourceMapIntegrity = "sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==";
const parserPaths = [
  "node_modules/postcss-nested/node_modules/postcss-selector-parser",
  "node_modules/tailwindcss/node_modules/postcss-selector-parser",
];
const overrides = {
  "tailwindcss@3.4.19": { "postcss-selector-parser": "7.1.6" },
  "postcss-nested@6.2.0": { "postcss-selector-parser": "7.1.6" },
};

describe.each(["", "scripts/dependency-review/consumer-fixture/"])("official dependency repair: %s", (prefix) => {
  const manifest = read(prefix + "package.json");
  const lock = read(prefix + "package-lock.json");
  it("pins the existing Tailwind version without a major toolchain migration", () => {
    expect(manifest.devDependencies.tailwindcss).toBe("3.4.19");
    expect(lock.packages[""].devDependencies.tailwindcss).toBe("3.4.19");
    expect(lock.packages["node_modules/tailwindcss"].version).toBe("3.4.19");
    expect(lock.packages["node_modules/postcss-nested"].version).toBe("6.2.0");
    expect(manifest.overrides).toEqual(overrides);
  });
  it("contains only the two exact official patched parser copies", () => {
    const copies = Object.keys(lock.packages).filter(path => path.endsWith("/postcss-selector-parser"));
    expect(copies.sort()).toEqual(parserPaths);
    for (const path of copies) {
      expect(lock.packages[path]).toEqual({
        version: "7.1.6",
        resolved: "https://registry.npmjs.org/postcss-selector-parser/-/postcss-selector-parser-7.1.6.tgz",
        integrity: parserIntegrity,
        dev: true,
        license: "MIT",
        dependencies: { cssesc: "^3.0.0", "util-deprecate": "^1.0.2" },
        engines: { node: ">=4" },
      });
    }
  });
  it("patches the original source-map package without adding a new direct dependency", () => {
    const copies = Object.keys(lock.packages).filter(path => path.endsWith("/source-map-js"));
    expect(copies).toEqual(["node_modules/source-map-js"]);
    expect(lock.packages[copies[0]]).toEqual({
      version: "1.2.2",
      resolved: "https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.2.tgz",
      integrity: sourceMapIntegrity,
      ...(prefix ? { dev: true } : {}),
      license: "BSD-3-Clause",
      engines: { node: ">=0.10.0" },
    });
    expect(manifest.dependencies?.["source-map-js"]).toBeUndefined();
    expect(manifest.devDependencies["source-map-js"]).toBeUndefined();
  });
  it("preserves the existing local braces artifact disposition", () => {
    expect(manifest.devDependencies.braces).toBe(prefix ? "file:braces-local-candidate.tgz" : "file:vendor/braces-3.0.3-local.tgz");
    expect(lock.packages["node_modules/braces"].version).toBe("3.0.3");
    expect(lock.packages["node_modules/braces"].dev).toBe(true);
    expect(manifest.overrides).not.toHaveProperty("braces");
  });
});
