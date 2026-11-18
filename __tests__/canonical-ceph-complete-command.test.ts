import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CanonicalCephCompleteRefusal, parseCanonicalCephComplete } from "../lib/canonical-ceph-complete-command";
const expectedVersion = "a".repeat(64);
it("accepts only an explicit observed draft identity", () => { expect(parseCanonicalCephComplete("1", { expectedVersion })).toEqual({ id: 1, expectedVersion, expectedSources: null }); });
// 0137: the reviewed sources are optional, but when present they must be an exact source identity.
const sources = { schemaVersion: 1, documentId: 9, imageSha256: "b".repeat(64), referenceSetKey: "builtin_default", referenceSetSha256: null, engineId: "aqlan-legacy-ceph", engineVersion: "2026-11-18.1", engineSourceSha256: "c".repeat(64) };
it("accepts exact reviewed sources and rejects malformed ones", () => {
  expect(parseCanonicalCephComplete("1", { expectedVersion, expectedSources: sources })).toEqual({ id: 1, expectedVersion, expectedSources: sources });
  for (const bad of [{ ...sources, engineId: "x" }, { ...sources, extra: 1 }, { ...sources, imageSha256: "z" }, null, []]) expect(() => parseCanonicalCephComplete("1", { expectedVersion, expectedSources: bad })).toThrow(CanonicalCephCompleteRefusal);
});
it.each(["0", "01", "-1", "1.2", "1e2", " 1", "2147483648", "9007199254740992"])("rejects invalid identity %s", id => { expect(() => parseCanonicalCephComplete(id, { expectedVersion })).toThrow(CanonicalCephCompleteRefusal); });
it.each([null, [], "", {}, { expectedVersion: [expectedVersion] }, { expectedVersion: {} }, { expectedVersion: "x".repeat(64) }, { expectedVersion, actor: "owner" }, { expectedVersion, force: true }, { expectedVersion, measurements: [] }, { expectedVersion, note: null }])("rejects malformed input or supplied results %#", body => { expect(() => parseCanonicalCephComplete("1", body)).toThrow(CanonicalCephCompleteRefusal); });
