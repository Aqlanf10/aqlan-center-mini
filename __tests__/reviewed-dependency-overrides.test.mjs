import { describe, expect, it } from "vitest";
import { REVIEWED_OVERRIDES, validateReviewedOverrides } from "../scripts/dependency-security/reviewed-overrides.mjs";
import { validateRootManifest } from "../scripts/dependency-security/installed-braces.mjs";

const manifest = () => ({ name: "synthetic", version: "1.0.0",
  devDependencies: { braces: "file:vendor/braces-3.0.3-local.tgz" },
  overrides: structuredClone(REVIEWED_OVERRIDES) });
const lock = (root) => ({ lockfileVersion: 3, packages: { "": root } });

describe("reviewed official parser dependency resolution", () => {
  it("admits only the exact version-scoped pair in root validation", () => {
    const root = manifest();
    expect(() => validateRootManifest(root, lock(root))).not.toThrow();
  });
  it("is key-order independent without admitting changed semantics", () => {
    const root = manifest();
    root.overrides = Object.fromEntries(Object.entries(root.overrides).reverse());
    expect(() => validateReviewedOverrides(root)).not.toThrow();
  });
  it.each([
    ["missing overrides", (root) => { delete root.overrides; }],
    ["null overrides", (root) => { root.overrides = null; }],
    ["empty overrides", (root) => { root.overrides = {}; }],
    ["array overrides", (root) => { root.overrides = []; }],
    ["global parser override", (root) => { root.overrides = { "postcss-selector-parser": "7.1.6" }; }],
    ["braces override", (root) => { root.overrides.braces = "3.0.3"; }],
    ["additional consumer", (root) => { root.overrides["another@1.0.0"] = { "postcss-selector-parser": "7.1.6" }; }],
    ["additional child", (root) => { root.overrides["tailwindcss@3.4.19"].braces = "3.0.3"; }],
    ["missing nested consumer", (root) => { delete root.overrides["postcss-nested@6.2.0"]; }],
    ["unscoped consumer", (root) => { root.overrides.tailwindcss = root.overrides["tailwindcss@3.4.19"]; delete root.overrides["tailwindcss@3.4.19"]; }],
    ["consumer version range", (root) => { root.overrides["tailwindcss@^3.4.19"] = root.overrides["tailwindcss@3.4.19"]; delete root.overrides["tailwindcss@3.4.19"]; }],
    ["changed consumer version", (root) => { root.overrides["tailwindcss@3.4.20"] = root.overrides["tailwindcss@3.4.19"]; delete root.overrides["tailwindcss@3.4.19"]; }],
    ["parser range", (root) => { root.overrides["tailwindcss@3.4.19"]["postcss-selector-parser"] = "^7.1.6"; }],
    ["older parser", (root) => { root.overrides["tailwindcss@3.4.19"]["postcss-selector-parser"] = "6.1.4"; }],
    ["newer unreviewed parser", (root) => { root.overrides["tailwindcss@3.4.19"]["postcss-selector-parser"] = "7.1.7"; }],
    ["registry alias", (root) => { root.overrides["tailwindcss@3.4.19"]["postcss-selector-parser"] = "npm:postcss-selector-parser@7.1.6"; }],
    ["file substitution", (root) => { root.overrides["tailwindcss@3.4.19"]["postcss-selector-parser"] = "file:parser.tgz"; }],
  ])("fails closed for %s", (_name, change) => {
    const root = manifest(); change(root);
    expect(() => validateRootManifest(root, lock(root))).toThrow(/unreviewed dependency overrides/);
  });
  it("still rejects workspaces", () => {
    const root = { ...manifest(), workspaces: [] };
    expect(() => validateRootManifest(root, lock(root))).toThrow(/unreviewed workspaces/);
  });
});
