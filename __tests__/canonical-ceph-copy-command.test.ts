import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CanonicalCephCopyRefusal, parseCanonicalCephCopy } from "../lib/canonical-ceph-copy-command";

it("accepts only a positive safe study identity with an empty explicit request", () => {
  expect(parseCanonicalCephCopy("1", {})).toBe(1);
  expect(parseCanonicalCephCopy(String(Number.MAX_SAFE_INTEGER), {})).toBe(Number.MAX_SAFE_INTEGER);
});
it.each(["0", "01", "-1", "1.2", "1e2", " 1", "9007199254740992"])("rejects invalid study identity %s", raw => {
  expect(() => parseCanonicalCephCopy(raw, {})).toThrow(CanonicalCephCopyRefusal);
});
it.each([null, [], "", { actor: "owner" }, { patientId: 1 }, { documentId: 1 }, { force: true }, { measurements: [] }, { expectedStatus: "completed" }])("refuses malformed or authority-bearing request %#", body => {
  expect(() => parseCanonicalCephCopy("1", body)).toThrow(CanonicalCephCopyRefusal);
});
