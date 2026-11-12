import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { isCanonicalOrthoDecisions: valid } = await import("../lib/canonical-ortho-decisions-projection");
const { canonicalOrthoDecisionQuery: query } = await import("../lib/canonical-ortho-decisions");
const row = { adjustmentId: 1, patientId: 2, patientName: "SYN", doneOn: "2026-10-01", doctorName: null, legacy: false, decisionContext: null };
const feed = { projection: "ortho-pending-decisions", pending: [row], hasMore: false, limit: 300 };
it("accepts the bounded read-only review summary", () => { expect(valid(feed)).toBe(true); expect(valid({ ...feed, pending: [], hasMore: false })).toBe(true); });
it.each([null, {}, { ...feed, projection: "legacy" }, { ...feed, hasMore: "false" }, { ...feed, limit: 301 }, { ...feed, pending: Array(301).fill(row) }, { ...feed, pending: [null] }, { ...feed, pending: [{ ...row, adjustmentId: "1" }] }, { ...feed, pending: [{ ...row, patientId: 0 }] }, { ...feed, pending: [{ ...row, doneOn: "bad" }] }, { ...feed, pending: [{ ...row, legacy: null }] }])("rejects malformed queue %#", value => { expect(valid(value)).toBe(false); });
it.each(["scope=all", "patientId=1", "money=1", "visitId=1", "q=x&q=y"])("rejects caller-selected expansion %s", search => { expect(() => query(new URLSearchParams(search))).toThrow(); });

it("requires exact bounded choices and an opaque observed version for command previews", () => {
  const context = { expectedVersion: "a".repeat(64), choices: ["billed", "no_charge"] };
  expect(valid({ ...feed, pending: [{ ...row, decisionContext: context }] })).toBe(true);
  for (const decisionContext of [undefined, {}, { ...context, expectedVersion: "bad" }, { ...context, choices: [] }, { ...context, choices: ["billed", "billed"] }, { ...context, choices: ["force"] }]) expect(valid({ ...feed, pending: [{ ...row, decisionContext }] })).toBe(false);
});
