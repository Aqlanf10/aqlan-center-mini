import { expect, it } from "vitest";
import { chronologicalOrder } from "../lib/cephCompare";

// Exact date-field shape returned by getCephAnalysisForCompare. Stored imaging
// dates can precede a later import/registration date; ordering must not reverse them.
const earlierImage = { id: 7, xrayDate: "2024-01-15", createdAt: "2025-01-01T12:00:00Z" };
const laterImage = { id: 8, xrayDate: "2025-01-15", createdAt: "2024-01-01T12:00:00Z" };
it.each([[earlierImage, laterImage], [laterImage, earlierImage]])("orders the persisted xrayDate before registration time (%j then %j)", (first, second) => {
  expect(chronologicalOrder(first, second)).toEqual([earlierImage, laterImage]);
});
it("uses numeric ID order for PostgreSQL BIGINT strings when dates tie", () => {
  // The existing database reader declares number, but pg returns BIGINT IDs as
  // strings; exercise that actual runtime shape without changing serialized IDs.
  const a = { id: "10", xrayDate: null, createdAt: "2025-01-01T12:00:00Z" };
  const b = { ...a, id: "2" };
  expect(chronologicalOrder(a, b).map(s => String(s.id))).toEqual(["2", "10"]);
});
it("preserves the existing takenOn contract and creation/id tie breaks", () => {
  const a = { id: 10, takenOn: "2023-01-01", xrayDate: "2025-01-01", createdAt: "2024-01-01T12:00:00Z" };
  const b = { ...a, id: 2, takenOn: "2024-01-01", xrayDate: "2022-01-01" };
  expect(chronologicalOrder(b, a)).toEqual([a, b]);
  expect(chronologicalOrder({ ...a, takenOn: null, xrayDate: null }, { ...b, takenOn: null, xrayDate: null }).map(s => s.id)).toEqual([2, 10]);
});
it("compares large decimal PostgreSQL IDs without loss of precision", () => {
  const a = { id: "9007199254740993", createdAt: "2025-01-01T12:00:00Z" }, b = { ...a, id: "9007199254740992" };
  expect(chronologicalOrder(a, b)).toEqual([b, a]);
});
