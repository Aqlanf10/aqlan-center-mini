import { describe, expect, it } from "vitest";
import { readInvoiceSelectionPreview, selectInvoiceItem, selectInvoicePlan, selectionForOwner } from "../components/dental/invoice-selection-state";
const choices = [{ id: 11, compatible: true }, { id: 22, compatible: false }];
const items = [{ id: 101, planId: 11, clinicalCaseId: 31 }, { id: 102, planId: 22, clinicalCaseId: null }];
const rows = [{ key: "row-a", clinical: true, planItemId: null as number | null }];
function payload() {
  return { existingPlanId: null as number | null, planChoices: choices,
    lines: [{ line: 0, kind: "clinical", specialtyLabel: "ترميمي", item: { mode: "new", id: null as number | null },
      case: { mode: "none", id: null, title: null, options: [] }, financialReviewRequired: false,
      refusal: "ambiguous_item" as string | null, refusalMessage: "اختر البند" as string | null, itemCandidates: items }] };
}
describe("current-owner canonical invoice selections", () => {
  it("never auto-selects the first compatible plan or candidate", () => {
    const owner = {};
    expect(selectionForOwner(null, owner).existingPlanId).toBeNull();
    expect(selectionForOwner(null, owner).itemIds.size).toBe(0);
    expect(readInvoiceSelectionPreview(payload(), rows, null)?.selections.itemChoices.get("row-a")).toEqual(items);
  });
  it("expires identities for changed patient/context/FDI generation, including A to B to A", () => {
    const a = { scope: "A" }, b = { scope: "B" }, secondA = { scope: "A" };
    const selected = selectInvoiceItem(null, a, "row-a", 101, items)!;
    expect(selectionForOwner(selected, a).itemIds.get("row-a")).toBe(101);
    for (const owner of [b, secondA]) expect(selectionForOwner(selected, owner).itemIds.size).toBe(0);
  });
  it("rejects incompatible/unknown plans and wrong-plan items without broadening", () => {
    const owner = {};
    expect(selectInvoicePlan(null, owner, 22, choices)).toBeNull();
    expect(selectInvoicePlan(null, owner, 999, choices)).toBeNull();
    const selected = selectInvoicePlan(null, owner, 11, choices)!;
    expect(selectInvoiceItem(selected, owner, "row-a", 102, items)).toBeNull();
    expect(selectInvoiceItem(selected, owner, "row-a", 101, items)?.itemIds.get("row-a")).toBe(101);
  });
  it("plan changes clear previous per-row item choices", () => {
    const owner = {};
    const selected = selectInvoiceItem(null, owner, "row-a", 101, items)!;
    expect(selectInvoicePlan(selected, owner, 11, choices)?.itemIds.size).toBe(0);
  });
  it("refuses malformed candidates, stale plan echoes and a successful response rebound to another item", () => {
    const base = payload();
    expect(readInvoiceSelectionPreview({ ...base, existingPlanId: 11 }, rows, null)).toBeNull();
    expect(readInvoiceSelectionPreview({ ...base, planChoices: [{ id: true, compatible: true }] }, rows, null)).toBeNull();
    expect(readInvoiceSelectionPreview({ ...base, lines: [{ ...base.lines[0], itemCandidates: [{ id: 101, planId: "11", clinicalCaseId: null }] }] }, rows, null)).toBeNull();
    const ready = { ...base, lines: [{ ...base.lines[0], item: { mode: "existing", id: 102 }, refusal: null, refusalMessage: null }] };
    expect(readInvoiceSelectionPreview(ready, [{ ...rows[0], planItemId: 101 }], null)).toBeNull();
    expect(readInvoiceSelectionPreview(ready, [{ ...rows[0], planItemId: 102 }], null)).not.toBeNull();
    expect(readInvoiceSelectionPreview({ ...base, existingPlanId: 22,
      lines: [{ ...base.lines[0], refusal: null, refusalMessage: null }] }, rows, 22)).toBeNull();
  });
  it("rejects coerced discriminants and contradictory successful mode/ID relationships without explicit selections", () => {
    const base = payload();
    const line = { ...base.lines[0], refusal: null, refusalMessage: null };
    const decode = (changes: Record<string, unknown>) => readInvoiceSelectionPreview({ ...base,
      lines: [{ ...line, ...changes }] }, rows, null);
    expect(decode({})).not.toBeNull();
    for (const mode of [["new"], { toString: () => "new" }, true, 1])
      expect(decode({ item: { mode, id: null } })).toBeNull();
    for (const mode of [["none"], { toString: () => "none" }, true, 1])
      expect(decode({ case: { ...line.case, mode } })).toBeNull();
    for (const item of [{ mode: "new", id: 101 }, { mode: "existing", id: null },
      { mode: "existing", id: 999 }])
      expect(decode({ item })).toBeNull();
    for (const mode of ["new", "bridge", "choose", "none"])
      expect(decode({ case: { ...line.case, mode, id: 31 } })).toBeNull();
    expect(decode({ case: { ...line.case, mode: "existing", id: null } })).toBeNull();
    expect(decode({ case: { ...line.case, mode: "choose" } })).toBeNull();
    expect(decode({ item: { mode: "existing", id: 101 },
      case: { ...line.case, mode: "existing", id: 31 } })).not.toBeNull();
    expect(decode({ item: { mode: "existing", id: 101 },
      case: { ...line.case, mode: "existing", id: 32 } })).toBeNull();
    // Existing filling/sealant can retain case 31 while needsCase=false gives
    // canonical case:none. Candidate lineage remains intact for the reader.
    const restorative = decode({ item: { mode: "existing", id: 101 } });
    expect(restorative?.selections.itemChoices.get("row-a")?.[0].clinicalCaseId).toBe(31);
    expect(decode({ case: { ...line.case, mode: "bridge" } })).not.toBeNull();
  });
});
