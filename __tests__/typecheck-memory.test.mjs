import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectTypecheckMemory, TYPECHECK_HEAP_MIB } from "../scripts/typecheck-memory.mjs";
const mib = 1024 * 1024;
const capacity = { totalBytes: 7 * 1024 * mib, availableBytes: 6 * 1024 * mib, heapLimitBytes: 4144 * mib };

describe("full TypeScript runner capacity without coverage reduction", () => {
  it("admits the explicit 4 GiB heap with runner headroom", () => {
    expect(TYPECHECK_HEAP_MIB).toBe(4096);
    expect(inspectTypecheckMemory(capacity)).toEqual({ capacityMiB: 7168, availableMiB: 6144, heapLimitMiB: 4144, requestedHeapMiB: 4096 });
  });
  it.each([undefined, 0, 16 * 1024 * mib])("does not inflate host capacity from a missing/larger cgroup limit %s", constrainedBytes => {
    expect(inspectTypecheckMemory({ ...capacity, constrainedBytes }).capacityMiB).toBe(7168);
  });
  it.each([
    { constrainedBytes: 4 * 1024 * mib },
    { totalBytes: 5 * 1024 * mib },
    { availableBytes: 5 * 1024 * mib - 1 },
  ])("refuses insufficient physical/cgroup/available headroom %j", delta => {
    expect(() => inspectTypecheckMemory({ ...capacity, ...delta })).toThrow("TYPECHECK_RUNNER_MEMORY_INSUFFICIENT");
  });
  it.each([2048, 6144])("refuses a default or unexpectedly larger heap %s", heap => {
    expect(() => inspectTypecheckMemory({ ...capacity, heapLimitBytes: heap * mib })).toThrow("TYPECHECK_HEAP_CONFIGURATION_MISMATCH");
  });
  it.each([NaN, Infinity, 0, -1])("refuses unknown memory metrics %s", availableBytes => {
    expect(() => inspectTypecheckMemory({ ...capacity, availableBytes })).toThrow("TYPECHECK_MEMORY_METRICS_INVALID");
  });
  it.each([
    ["Verify full typecheck memory capacity", "Typecheck", "npm run typecheck"],
    ["Verify production build typecheck memory capacity", "Production build", "npm run build"],
  ])("rechecks capacity immediately before %s and scopes the same heap to its compiler", (guard, step, command) => {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const expected = `      - name: ${guard}
        env:
          NODE_OPTIONS: --max-old-space-size=4096
        run: node scripts/typecheck-memory.mjs

      - name: ${step}
        env:
          NODE_OPTIONS: --max-old-space-size=4096
        run: ${command}`;
    expect(ci.split(expected)).toHaveLength(2);
  });
  it("keeps complete source coverage and mandatory compiler/build gates", () => {
    const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    const config = JSON.parse(read("tsconfig.json"));
    expect(config.include).toEqual(["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"]);
    expect(config.exclude).toEqual(["node_modules"]);
    expect(config.compilerOptions.strict).toBe(true);
    expect(JSON.parse(read("package.json")).scripts.typecheck).toBe("tsc --noEmit");
    expect(JSON.parse(read("package.json")).scripts.build).toBe("next build");
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("run: node scripts/typecheck-memory.mjs");
    expect(ci).toMatch(/- name: Typecheck\n        env:\n          NODE_OPTIONS: --max-old-space-size=4096\n        run: npm run typecheck/);
    expect(ci).toContain("run: npm run build");
    expect(read("next.config.ts")).not.toMatch(/ignoreBuildErrors\s*:\s*true/);
  });
});
