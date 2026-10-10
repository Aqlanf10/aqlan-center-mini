import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { linkageEvidence, missingLinkageEvidence } from "../scripts/verify-unified-linkage-artifacts.mjs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
function step(name: string): string {
  const marker = `      - name: ${name}\n`;
  expect(workflow.split(marker)).toHaveLength(2);
  const start = workflow.indexOf(marker), end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}
const complete = new Set(linkageEvidence.flatMap(suite => [suite.marker, ...suite.files]));

describe("synthetic linkage evidence has fail-closed bounded retention", () => {
  it("requires both started markers and all eight PNGs after successful HTTP", () => {
    expect(missingLinkageEvidence("success", new Set())).toHaveLength(10);
    expect(missingLinkageEvidence("success", complete)).toEqual([]);
    for (const path of complete) {
      const partial = new Set(complete); partial.delete(path);
      expect(missingLinkageEvidence("success", partial)).toEqual([path]);
    }
  });
  it("does not require unstarted suites after earlier failures, skips or cancellation", () => {
    for (const outcome of ["failure", "skipped", "cancelled", ""]) {
      expect(missingLinkageEvidence(outcome, new Set())).toEqual([]);
      expect(missingLinkageEvidence(outcome, new Set(["artifacts/unrelated.png"]))).toEqual([]);
    }
  });
  it("requires every PNG in a started suite even when HTTP fails", () => {
    for (const suite of linkageEvidence) {
      expect(missingLinkageEvidence("failure", new Set([suite.marker]))).toEqual(suite.files);
      const present = new Set([suite.marker, suite.files[0], "artifacts/unrelated.png"]);
      expect(missingLinkageEvidence("failure", present)).toEqual(suite.files.slice(1));
      expect(missingLinkageEvidence("failure", new Set([suite.marker, ...suite.files]))).toEqual([]);
    }
  });
  it("keeps mandatory HTTP and strict schema gates unchanged", () => {
    const http = step("HTTP security integration tests");
    expect(http).toContain("id: linkage_http\n");
    expect(http).toContain("run: npm run test:security-http\n");
    expect(http).not.toContain("continue-on-error"); expect(http).not.toContain("        if:");
    const generate = step("Generate current schema contract on PostgreSQL 18");
    const start = generate.indexOf("        env:\n"); expect(start).toBeGreaterThan(-1);
    expect(createHash("sha256").update(generate.slice(start)).digest("hex"))
      .toBe("019316d19e8562c0b4536d9aceccdeb66a2c5e9f25b38bcc605799742689c677");
  });
  it("validates after an attempted HTTP step without suppressing upload after validation failure", () => {
    const verify = step("Verify unified linkage evidence completeness");
    expect(verify).toContain("if: always() && steps.linkage_http.outcome != 'skipped' && steps.linkage_http.outcome != ''");
    expect(verify).toContain("LINKAGE_HTTP_OUTCOME: ${{ steps.linkage_http.outcome }}");
    expect(verify).toContain("run: node scripts/verify-unified-linkage-artifacts.mjs");
    expect(verify).not.toContain("continue-on-error");
    const names = ["unified-linkage-ui", "invoice-explicit-selection-ui"];
    for (const [index, name] of names.entries()) {
      const upload = step(`Upload ${name} synthetic evidence`);
      expect([...upload.matchAll(/^ {12}(.+)$/gm)].map(match => match[1])).toEqual(linkageEvidence[index].files);
      expect(upload).toContain("if: always() && hashFiles(");
      expect(upload).toContain("if-no-files-found: error\n");
      expect(upload).toContain("retention-days: 7\n");
      expect(upload).not.toContain("continue-on-error");
      expect(upload).not.toContain("started.txt");
      expect(upload).not.toContain("*");
    }
  });
  it("writes only a fixed synthetic started marker before asynchronous fixture work", () => {
    const paths = ["unified-linkage-context-browser.test.ts", "invoice-explicit-selection-ui-journey.test.ts"];
    for (const [index, path] of paths.entries()) {
      const source = readFileSync(`__tests__/security-http/${path}`, "utf8");
      const marker = source.indexOf(`await writeFile("${linkageEvidence[index].marker}", "synthetic-suite-started\\n")`);
      expect(marker).toBeGreaterThan(-1);
      expect(marker).toBeLessThan(source.indexOf("await harness()"));
    }
  });
});
