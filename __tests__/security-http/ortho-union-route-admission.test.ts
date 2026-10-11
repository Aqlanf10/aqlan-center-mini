import { beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); });
const routes = ["/api/ortho/intake", "/api/ortho/1/assessment", "/api/ortho/1/case-decisions", "/api/ortho/1/retention-events", "/api/ortho/1/case-study", "/api/ortho/1/case-study/sources", "/api/ortho/1/case-study/editor", "/api/ortho/1/case-study/review"];
describe("all eight composed routes admit the current clinical session before data or body", () => {
  it.each(routes)("%s denies unauthenticated and financial-only reads privately", async path => {
    for (const response of [await fetch(`${baseUrl}${path}`), await authedGet(path, h.sessions.cashier)]) {
      expect([401, 403]).toContain(response.status);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).not.toMatch(/SELECT|password_hash|stack|ortho_case_study_revisions/);
    }
  });
  it.each(routes.filter(path => !path.endsWith("/sources") && !path.endsWith("/review")))("%s refuses reception writes before malformed body parsing", async path => {
    const response = await authedMutation(path, h.sessions.reception, "POST", "{ malformed");
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
