import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { BaseSequencer } from "vitest/node";
import { describe, expect, it } from "vitest";
const root = resolve(__dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const job = workflow.match(/^ {2}security_http:\n(?:(?!^ {2}\S)[\s\S])*/m)![0];
const originalInventory = ["inventory-procurement-http-ui.test.ts", "inventory-supplier-operational-http-ui.test.ts", "inventory-reference-closed-http-ui.test.ts"];

describe("complete isolated HTTP CI partition", () => {
 it("keeps the deadline, full runtime guards and independent failure collection", () => {
  expect(job).toContain("timeout-minutes: 75");
  expect(job).toMatch(/strategy:\n\s+fail-fast: false\n\s+matrix:\n\s+shard: \[1, 2\]/);
  expect(job).not.toMatch(/continue-on-error|passWithNoTests|allowFailure/);
  expect(job).toContain("node scripts/verify-braces-runtime.mjs\n");
  expect(job).toContain("node scripts/dependency-security/verify-lint-tooling-runtime.mjs\n");
  expect(job).toContain("image: postgres:18-alpine");
 });
 it("partitions only the complete normal suite and retains the explicit full inventory run", () => {
  const runs = job.split("\n").filter(line => line.includes("run: npm run test:security-http"));
  expect(runs).toHaveLength(2);
  expect(runs[0]).toBe("        run: npm run test:security-http -- --reporter=default --reporter=json --outputFile.json=${{ runner.temp }}/http-security-raw.json --includeTaskLocation --shard=${{ matrix.shard }}/2");
  expect(runs[1]).toBe("        run: npm run test:security-http -- --reporter=default --reporter=json --outputFile.json=${{ runner.temp }}/http-inventory-raw.json --includeTaskLocation");
  expect(job).toContain('INVENTORY_SCHEMA_TEST: "1"');
 });
 it("names every artifact by shard while preserving runner-local raw reports and sanitizers", () => {
  const names = [...job.matchAll(/^ {10}name: (.+)$/gm)].map(m => m[1]);
  expect(names.length).toBeGreaterThan(60); expect(new Set(names).size).toBe(names.length);
  expect(names.every(name => name.endsWith("-${{ matrix.shard }}"))).toBe(true);
  expect(job).toContain('node scripts/sanitize-http-test-report.mjs "${{ runner.temp }}/http-security-raw.json" "${{ runner.temp }}/http-security-locations.json"');
  expect(job).toContain('node scripts/sanitize-http-test-report.mjs "${{ runner.temp }}/http-inventory-raw.json" "${{ runner.temp }}/http-inventory-locations.json"');
  expect(job).not.toMatch(/path:.*raw\.json/);
 });
 it("keeps the fail-closed aggregate dependent on the whole HTTP matrix", () => {
  const aggregate = workflow.slice(workflow.indexOf("  required_completion:"));
  expect(aggregate).toContain("needs: [quality, postgres_integration, security_http, contract_print_visual]");
  expect(aggregate).toContain("HTTP_RESULT: ${{ needs.security_http.result }}");
  expect(aggregate).toContain('[ "$HTTP_RESULT" != "success" ]');
 });
 it("the installed runner assigns every normal test file exactly once across both shards", async () => {
  const files = readdirSync(resolve(root, "__tests__/security-http"), { recursive: true }).map(String)
   .filter(file => file.endsWith(".test.ts") && !originalInventory.includes(file))
   .map(file => ({ moduleId: resolve(root, "__tests__/security-http", file) }));
  expect(files.length).toBeGreaterThan(300);
  const partitions = await Promise.all([1, 2].map(index => new BaseSequencer({ config: { root, shard: { index, count: 2 } } } as ConstructorParameters<typeof BaseSequencer>[0])
   .shard(files as Parameters<BaseSequencer["shard"]>[0])));
  const union = partitions.flat().map(file => file.moduleId);
  expect(partitions.every(part => part.length > 0)).toBe(true);
  expect(new Set(union).size).toBe(files.length);
  expect(union.sort()).toEqual(files.map(file => file.moduleId).sort());
 });
});
