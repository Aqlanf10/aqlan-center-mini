import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCanonicalOrthoPlanLink as parse, CanonicalOrthoPlanLinkRefusal } from "../lib/canonical-ortho-plan-link-command";
const expectedVersion = "a".repeat(64);
it("accepts an exact positive plan identity or explicit unlink with a current observation", () => {
  expect(parse("1", { expectedVersion, planId: 12 })).toEqual({ id: 1, expectedVersion, planId: 12 });
  expect(parse("1", { expectedVersion, planId: null }).planId).toBeNull();
});
it.each(["0", "01", "-1", "1.2", "1e2", "2147483648"])("rejects malformed case identity %s", id => {
  expect(() => parse(id, { expectedVersion, planId: null })).toThrow(CanonicalOrthoPlanLinkRefusal);
});
it.each([null, [], {}, { expectedVersion }, { expectedVersion, planId: "12" }, { expectedVersion, planId: [12] }, { expectedVersion, planId: {} }, { expectedVersion, planId: 0 }, { expectedVersion, planId: -1 }, { expectedVersion, planId: 1.5 }, { expectedVersion, planId: 2147483648 }, { expectedVersion, planId: null, phase: "working" }, { expectedVersion, planId: 12, actor: "owner" }, { expectedVersion: [expectedVersion], planId: null }, { expectedVersion: "x", planId: null }, { expectedVersion, planId: NaN }, { expectedVersion, planId: Infinity }].map(body => ({ body })))("rejects coerced, mixed or unobserved input %#", ({ body }) => {
  expect(() => parse("1", body)).toThrow(CanonicalOrthoPlanLinkRefusal);
});
