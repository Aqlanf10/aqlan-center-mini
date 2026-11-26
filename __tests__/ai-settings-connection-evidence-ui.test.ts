import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "app/settings/ai/page.tsx"), "utf8");

// Source-level regression guards only; a delayed-response browser journey is still required.
describe("AI settings connection evidence UI", () => {
  it("renders saved provider evidence instead of caching the test POST response", () => {
    expect(source).not.toMatch(/\b(?:testResults|setTestResults)\b/);
    expect(source).toContain("{p.lastTestAt ? (");
    expect(source).toContain("p.lastTestOk ?");
  });
  it("discards out-of-order provider list responses", () => {
    expect(source).toContain("const revision = ++loadRevision.current");
    expect(source).toContain("if (revision !== loadRevision.current) return;");
    expect(source).toContain("if (revision === loadRevision.current) setLoading(false)");
  });
  it("does not keep a stale provider list when refreshing fails", () => {
    expect(source).toMatch(/catch \(err\) \{\s*if \(revision !== loadRevision\.current\) return;\s*setProviders\(\[\]\)/);
  });
  it("switches the standard OpenAI endpoint in both directions", () => {
    expect(source).toMatch(/next === "openai-responses"[^\n]+\n\s*setFormEndpoint\("\/responses"\)/);
    expect(source).toMatch(/next === "openai-compatible"[^\n]+\n\s*setFormEndpoint\("\/chat\/completions"\)/);
  });
});
