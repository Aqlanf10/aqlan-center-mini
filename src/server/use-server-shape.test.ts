import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard: Next.js requires "use server" modules to export ONLY
 * async functions. A stray `export const` crashes every server action in
 * the compiled chunk at runtime (HTTP 500) — this test fails at CI time
 * instead, before anything reaches production.
 */

function collectServerActionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      found.push(...collectServerActionFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      const content = readFileSync(full, "utf8");
      if (content.startsWith('"use server"') || content.startsWith("'use server'")) {
        found.push(full);
      }
    }
  }
  return found;
}

const SRC_ROOT = join(__dirname, "../../");

describe('"use server" module shape', () => {
  const files = collectServerActionFiles(SRC_ROOT);

  it("found server-action files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.replace(SRC_ROOT, "")} exports only async functions`, () => {
      const content = readFileSync(file, "utf8");
      const illegalExports: string[] = [];

      // Strip block comments and strings crudely, then scan export statements.
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const exportMatches = stripped.matchAll(/^export\s+(?!\s)(.+)$/gm);

      for (const match of exportMatches) {
        const decl = (match[1] ?? "").trim();
        if (decl.startsWith("type ")) continue; // types are erased at runtime
        if (decl.startsWith("async function")) continue;
        if (/^function\b/.test(decl)) {
          illegalExports.push(`sync function: export ${decl.slice(0, 50)}`);
          continue;
        }
        // const / let / var / class / enum / anything else
        illegalExports.push(`non-function: export ${decl.slice(0, 50)}`);
      }

      expect(illegalExports, `illegal exports in ${file}`).toEqual([]);
    });
  }
});
