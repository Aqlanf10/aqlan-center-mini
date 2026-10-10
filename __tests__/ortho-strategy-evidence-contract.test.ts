import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
function step(name: string): string {
  const marker = `      - name: ${name}\n`;
  expect(workflow.split(marker)).toHaveLength(2);
  const start = workflow.indexOf(marker), end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

describe("strategy evidence retention does not mask mandatory CI failures", () => {
  it("keeps the exact existing PostgreSQL18 generation and strict comparison body", () => {
    const generate = step("Generate current schema contract on PostgreSQL 18");
    expect(generate).toContain("        id: current_schema_contract\n");
    const start = generate.indexOf("        env:\n");
    expect(start).toBeGreaterThan(-1);
    expect(createHash("sha256").update(generate.slice(start)).digest("hex"))
      .toBe("019316d19e8562c0b4536d9aceccdeb66a2c5e9f25b38bcc605799742689c677");
    expect(generate).not.toContain("continue-on-error");
    expect(generate).not.toContain("        if:");
  });
  it("retains only the generated catalog after a completed generator and fails on a missing expected file", () => {
    const upload = step("Upload PostgreSQL 18 schema contract");
    expect(upload).toContain("if: ${{ always() && (steps.current_schema_contract.outcome == 'success' || steps.current_schema_contract.outcome == 'failure') }}");
    expect(upload).toContain("path: /tmp/current-schema-contract.pg18.json\n");
    expect(upload).toContain("if-no-files-found: error\n");
    expect(upload).not.toContain("continue-on-error");
  });
  it("uses an exact synthetic scene allowlist without traces, storage or broad uploads", () => {
    const upload = step("Upload Ortho strategy synthetic UI evidence");
    const paths = [...upload.matchAll(/^            (.+)$/gm)].map(match => match[1]);
    const expected = ["blank-explicit-draft", "retrospective-revision", "bridge-prerequisite", "visit-readonly"]
      .flatMap(scene => [390, 1280].flatMap(width => ["png", "json"].map(extension =>
        `.settings-ui-artifacts/ortho-strategy-${scene}-${width}.${extension}`)));
    expect(paths).toEqual(expected); expect(new Set(paths).size).toBe(16);
    expect(upload).toContain("include-hidden-files: true\n");
    expect(upload).toContain("if-no-files-found: error\n");
    expect(upload).toContain("retention-days: 7\n");
  });
});
