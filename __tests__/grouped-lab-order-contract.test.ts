/** 0136 contract rules without a database: the grouped kind, its instructions, one unit per tooth from either jaw,
 * the unchanged per-tooth prescription (T8), and the exact multi-doctor cost split. Synthetic values only. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeLabWorkGroups, parseLabWorkDraft, type LabWorkSourceRow } from "../lib/lab-work-intent-contract";
import { validateLabPrescription } from "../lib/lab-prescription-input";
import { comparableGroupedLabWeights, splitGroupedLabCost } from "../lib/grouped-lab-cost-split";
import { groupedLabPricingWarning } from "../components/LabWorkDraftFields";

const prescription = { partyId: 7, shade: "A2", stumpShade: "", toothNumbers: "", dueDate: "2026-12-01", impressionType: "physical", priority: "normal" };
const row = (tooth: number, labWork: unknown, extra: Partial<LabWorkSourceRow> = {}): LabWorkSourceRow =>
  ({ serviceId: 3, toothCode: tooth, quantity: 1, planItemId: null, doctorId: 9, category: "crown", labWork, ...extra });
const grouped = (intentId: string, instructions?: string) => ({ intentId, memberId: randomUUID(), expectedRevision: 0, groupKind: "grouped", prescription,
  ...(instructions === undefined ? {} : { instructions }) });

describe("0136 grouped lab contract", () => {
  it("both jaws and more than five teeth stay one group with one member per tooth", () => {
    const intentId = randomUUID();
    const teeth = [14, 15, 24, 25, 26, 36, 37, 46];
    const command = normalizeLabWorkGroups(teeth.map(tooth => row(tooth, grouped(intentId, "حواف رفيعة"))));
    expect(command.groups).toHaveLength(1);
    expect(command.groups[0]).toMatchObject({ groupKind: "grouped", instructions: "حواف رفيعة" });
    expect(command.groups[0].members.map(member => member.toothCode).sort((a, b) => a - b)).toEqual(teeth);
  });

  it("refuses a repeated tooth, a multi-unit member, a bridge line and differing instructions inside one group", () => {
    const intentId = randomUUID();
    expect(() => normalizeLabWorkGroups([row(14, grouped(intentId)), row(14, grouped(intentId))])).toThrow();
    expect(() => normalizeLabWorkGroups([row(14, grouped(intentId), { quantity: 2 })])).toThrow();
    expect(() => normalizeLabWorkGroups([row(14, grouped(intentId), { category: "bridge" })])).toThrow();
    expect(() => normalizeLabWorkGroups([row(14, grouped(intentId, "أ")), row(15, grouped(intentId, "ب"))])).toThrow();
  });

  it("instructions belong to a grouped entry only, trimmed, at most 600 characters", () => {
    expect(parseLabWorkDraft(grouped(randomUUID(), "  تعليمات  "))?.instructions).toBe("تعليمات");
    expect(parseLabWorkDraft(grouped(randomUUID(), "   "))?.instructions).toBeUndefined();
    expect(() => parseLabWorkDraft(grouped(randomUUID(), "س".repeat(601)))).toThrow();
    expect(() => parseLabWorkDraft({ ...grouped(randomUUID(), "x"), groupKind: "single" })).toThrow();
  });

  it("T8: the per-tooth prescription (original lab form) accepts exactly its old keys — no instructions, no lab service", () => {
    expect(validateLabPrescription(prescription, false)).toMatchObject({ partyId: 7, shade: "A2" });
    expect(() => validateLabPrescription({ ...prescription, instructions: "x" }, false)).toThrow();
    expect(() => validateLabPrescription({ ...prescription, labServiceId: 1 }, false)).toThrow();
    const single = parseLabWorkDraft({ intentId: randomUUID(), memberId: randomUUID(), expectedRevision: 0, groupKind: "single", prescription });
    expect(single && Object.keys(single).sort()).toEqual(["expectedRevision", "groupKind", "intentId", "memberId", "prescription"]);
  });

  it("splits a multi-doctor order exactly by tooth price, equal shares when no price is known", () => {
    expect(splitGroupedLabCost(1000, [{ doctorId: 1, weight: 200 }, { doctorId: 2, weight: 200 }, { doctorId: 1, weight: 200 }, { doctorId: 2, weight: 200 }, { doctorId: 1, weight: 200 }]))
      .toEqual([{ doctorId: 1, costMinor: 600 }, { doctorId: 2, costMinor: 400 }]);
    const uneven = splitGroupedLabCost(1000, [{ doctorId: 1, weight: 0 }, { doctorId: 2, weight: 0 }, { doctorId: 3, weight: 0 }]);
    expect(uneven.reduce((sum, part) => sum + part.costMinor, 0)).toBe(1000);
    expect(splitGroupedLabCost(900, [{ doctorId: null, weight: 5 }])).toEqual([]);
  });

  it("holds monetary weights with mixed, mismatched or partial currencies", () => {
    const prices = [{ doctorId: 1, weight: 100, currency: "YER" }, { doctorId: 2, weight: 10, currency: "USD" }];
    expect(comparableGroupedLabWeights(prices, "YER")).toBeNull();
    expect(comparableGroupedLabWeights(prices.map(p => ({ ...p, currency: "USD" })), "YER")).toBeNull();
    expect(comparableGroupedLabWeights([prices[0], { doctorId: 2, weight: null, currency: null }], "YER")).toBeNull();
    expect(comparableGroupedLabWeights(prices.map(p => ({ ...p, currency: "YER" })), "YER"))
      .toEqual([{ doctorId: 1, weight: 100 }, { doctorId: 2, weight: 10 }]);
    expect(comparableGroupedLabWeights(prices.map(p => ({ ...p, weight: null, currency: null })), "YER"))
      .toEqual([{ doctorId: 1, weight: 0 }, { doctorId: 2, weight: 0 }]);
  });

  it("every pending pricing state has an Arabic warning; the priced and manual states have none", () => {
    for (const state of ["missing_rule", "missing_mapping", "currency_mismatch", "mixed_currency"]) expect(groupedLabPricingWarning(state)).toMatch(/^تحذير: .*معلّقة/);
    expect(groupedLabPricingWarning("rule")).toBeNull();
    expect(groupedLabPricingWarning("manual")).toBeNull();
    expect(groupedLabPricingWarning(undefined)).toBeNull();
  });
});
