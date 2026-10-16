import { describe, expect, it } from "vitest";
import { parseInvoiceInput } from "../lib/invoice-input";

const body = () => ({ patientId: 1, currency: "YER", items: [{ description: "Synthetic line", price: "100", quantity: 1 }] });
const parse = (input: Record<string, unknown>) => parseInvoiceInput(input, new Map(), new Set());
describe("invoice explicit identity parsing", () => {
  it.each([true, false, [], [1], {}, "1", "", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2147483648])(
    "rejects noncanonical existingPlanId %j", (existingPlanId) => {
      expect(parse({ ...body(), existingPlanId }).ok).toBe(false);
    },
  );
  it.each([true, false, [], [1], {}, "1", "", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2147483648])(
    "rejects noncanonical planItemId %j", (planItemId) => {
      const input = body();
      expect(parse({ ...input, items: [{ ...input.items[0], planItemId }] }).ok).toBe(false);
    },
  );
  it("normalizes omitted and null identities without selecting anything", () => {
    for (const input of [body(), { ...body(), existingPlanId: null, items: [{ ...body().items[0], planItemId: null }] }]) {
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (result.ok) { expect(result.existingPlanId).toBeNull(); expect(result.items[0].planItemId).toBeNull(); }
    }
  });
  it("preserves exact syntactically valid IDs, including stale IDs for semantic writer rejection", () => {
    const input = body();
    const result = parse({ ...input, existingPlanId: 17, items: [{ ...input.items[0], planItemId: 2147483647 }] });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.existingPlanId).toBe(17); expect(result.items[0].planItemId).toBe(2147483647); }
    // The real PostgreSQL suite proves stale/wrong-owner values refuse without writes.
  });
});
