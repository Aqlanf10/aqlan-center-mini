import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCanonicalPlanCaseInput } from "../lib/canonical-plan-case-command";
const valid = () => ({ caseId: 2, priority: 3, expectedCaseId: 1, expectedPriority: null });
it("accepts explicit current-state comparisons and null detach/priority", () => {
  expect(parseCanonicalPlanCaseInput("9", valid())).toEqual({ itemId: 9, ...valid() });
  expect(parseCanonicalPlanCaseInput("9", { caseId: null, priority: null, expectedCaseId: null, expectedPriority: 999 })).toMatchObject({ itemId: 9, caseId: null, priority: null });
});
it.each(["0", "-1", "1e0", "1.0", "2147483648", " 1", "1 "])("refuses an ambiguous or unrepresentable identifier %s", value => {
  expect(() => parseCanonicalPlanCaseInput(value, valid())).toThrow();
});
it.each([null, [], {}, { caseId: null, priority: null }, { ...valid(), actor: "owner" }, { ...valid(), price: 1 }, { ...valid(), caseId: "2" }, { ...valid(), caseId: 0 },
  { ...valid(), priority: 1000 }, { ...valid(), priority: 1.5 }, { ...valid(), expectedPriority: "3" }, { ...valid(), expectedCaseId: -1 }])("refuses malformed, incomplete or privilege-expanding data %#", value => {
  expect(() => parseCanonicalPlanCaseInput("9", value)).toThrow();
});
