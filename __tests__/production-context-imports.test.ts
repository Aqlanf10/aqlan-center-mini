import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps Docker typechecked source independent of the excluded test tree", () => {
  const root = process.cwd();
  // This is a boundary check, not a replacement implementation of dockerignore.
  expect(readFileSync(resolve(root, ".dockerignore"), "utf8").split(/\r?\n/)).toContain("__tests__");
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const isTestSource = (path: string) => relative(root, path).split(sep).includes("__tests__");
  const pending = parsed.fileNames.filter(file => !isTestSource(file));
  const seen = new Set<string>();
  const violations: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.sys.readFile(file);
    if (source === undefined) continue;
    for (const entry of ts.preProcessFile(source, true, true).importedFiles) {
      const target = ts.resolveModuleName(entry.fileName, file, parsed.options, ts.sys).resolvedModule;
      if (!target || target.isExternalLibraryImport) continue;
      if (isTestSource(target.resolvedFileName)) {
        violations.push(`${relative(root, file)} -> ${entry.fileName}`);
      } else {
        pending.push(target.resolvedFileName);
      }
    }
  }
  expect(violations, "Docker excludes __tests__; move shared build dependencies outside that tree").toEqual([]);
});
