import { expect, it } from "vitest";
import { resolveCephComparisonOrder } from "../lib/cephCompare";

// Integration with staging's comparison contract: only the persisted image acquisition date
// (xrayDate) establishes chronology. Registration time, id and phase never break a tie or fill
// a missing date; an unresolved order is reported, not guessed (the earlier createdAt/id
// fallback of chronologicalOrder was retired by that contract).
const earlierImage = { id: 7, xrayDate: "2024-01-15", createdAt: "2025-01-01T12:00:00Z" };
const laterImage = { id: 8, xrayDate: "2025-01-15", createdAt: "2024-01-01T12:00:00Z" };
it.each([[earlierImage, laterImage], [laterImage, earlierImage]])("orders the persisted xrayDate before registration time (%j then %j)", (first, second) => {
  expect(resolveCephComparisonOrder(first, second)).toMatchObject({ state: "resolved", before: earlierImage, after: laterImage,
    ordering: { mode: "acquisition_date", chronology: "known" } });
});
it("does not invent chronology from creation time or id when dates are missing, equal or invalid", () => {
  const a = { id: 10, xrayDate: null, createdAt: "2024-01-01T12:00:00Z" }, b = { ...a, id: 2, createdAt: "2025-01-01T12:00:00Z" };
  expect(resolveCephComparisonOrder(a, b)).toEqual({ state: "unresolved", reason: "missing_date" });
  expect(resolveCephComparisonOrder({ ...a, xrayDate: "2024-03-01" }, { ...b, xrayDate: "2024-03-01" })).toEqual({ state: "unresolved", reason: "equal_dates" });
  expect(resolveCephComparisonOrder({ ...a, xrayDate: "2024-02-30" }, { ...b, xrayDate: "2024-03-01" })).toEqual({ state: "unresolved", reason: "invalid_date" });
});
it("refuses unsafe or identical identities instead of comparing them", () => {
  expect(resolveCephComparisonOrder({ id: Number.MAX_SAFE_INTEGER + 2, xrayDate: "2024-01-01" }, { id: 1, xrayDate: "2025-01-01" })).toEqual({ state: "invalid" });
  expect(resolveCephComparisonOrder({ id: 3, xrayDate: "2024-01-01" }, { id: 3, xrayDate: "2025-01-01" })).toEqual({ state: "invalid" });
});
