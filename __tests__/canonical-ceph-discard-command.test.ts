import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CanonicalCephDiscardRefusal, parseCanonicalCephDiscard } from "../lib/canonical-ceph-discard-command";
const version = "a".repeat(64);
it("preserves explicit optional notes with no clinical rewrite or truncation", () => {
  expect(parseCanonicalCephDiscard("1", { expectedVersion: version, note: "  SYN note  " })).toEqual({ id: 1, expectedVersion: version, note: "SYN note" });
  expect(parseCanonicalCephDiscard("1", { expectedVersion: version, note: " " }).note).toBeNull();
  expect(parseCanonicalCephDiscard("1", { expectedVersion: version, note: "x".repeat(4000) }).note).toHaveLength(4000);
});
it.each(["0", "01", "-1", "1.2", "1e2", " 1", "9007199254740992"])("rejects invalid identity %s", id => {
  expect(() => parseCanonicalCephDiscard(id, { expectedVersion: version, note: null })).toThrow(CanonicalCephDiscardRefusal);
});
it.each([null, [], "", { note: null }, { expectedVersion: version }, { expectedVersion: [version], note: null }, { expectedVersion: version, note: {} }, { expectedVersion: version, note: "x".repeat(4001) }, { expectedVersion: "x".repeat(64), note: null }, { expectedVersion: version, note: null, actor: "owner" }, { expectedVersion: version, note: null, force: true }])("refuses malformed or authority-bearing input %#", body => {
  expect(() => parseCanonicalCephDiscard("1", body)).toThrow(CanonicalCephDiscardRefusal);
});
