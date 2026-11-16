import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CanonicalCephCompleteRefusal, parseCanonicalCephComplete } from "../lib/canonical-ceph-complete-command";
const expectedVersion = "a".repeat(64);
it("accepts only an explicit observed draft identity", () => { expect(parseCanonicalCephComplete("1", { expectedVersion })).toEqual({ id: 1, expectedVersion }); });
it.each(["0", "01", "-1", "1.2", "1e2", " 1", "2147483648", "9007199254740992"])("rejects invalid identity %s", id => { expect(() => parseCanonicalCephComplete(id, { expectedVersion })).toThrow(CanonicalCephCompleteRefusal); });
it.each([null, [], "", {}, { expectedVersion: [expectedVersion] }, { expectedVersion: {} }, { expectedVersion: "x".repeat(64) }, { expectedVersion, actor: "owner" }, { expectedVersion, force: true }, { expectedVersion, measurements: [] }, { expectedVersion, note: null }])("rejects malformed input or supplied results %#", body => { expect(() => parseCanonicalCephComplete("1", body)).toThrow(CanonicalCephCompleteRefusal); });
