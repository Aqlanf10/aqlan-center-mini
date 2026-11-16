/** M2 slice 68: the request fingerprint behind the lab-order request key. It must cover
 * nested fields (the shade specification) and ignore key order; money and posting
 * fields are refused before any fingerprint. No database. */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { parseCanonicalLabCreate, stableJson } = await import("../lib/canonical-lab-create");
import { labShadeSelectionForCode } from "../lib/lab-shades";

const base = { requestKey: "0123456789abcdef-key", patientId: 7, workType: "Crown", partyId: 3, doctorId: 4, sentDate: "2031-04-01", dueDate: "2031-04-08", toothNumbers: "16" };
const shade = (code: string) => ({ version: 1, teeth: [{ toothCode: 16, cervical: null, body: labShadeSelectionForCode(code), incisal: null }] });

describe("lab create fingerprint", () => {
  it("stable JSON sorts keys at every depth", () => {
    expect(stableJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it("is independent of key order and of the request key itself", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(parseCanonicalLabCreate(reordered).fingerprint).toBe(parseCanonicalLabCreate(base).fingerprint);
    expect(parseCanonicalLabCreate({ ...base, requestKey: "another-key-0123456789" }).fingerprint).toBe(parseCanonicalLabCreate(base).fingerprint);
  });
  it("changes with any shaping field, nested shade included", () => {
    const a = parseCanonicalLabCreate({ ...base, shadeSpecification: shade("A2") }).fingerprint;
    const b = parseCanonicalLabCreate({ ...base, shadeSpecification: shade("A3") }).fingerprint;
    expect(labShadeSelectionForCode("A2")).not.toBeNull();
    expect(a).not.toBe(b);
    for (const change of [{ toothNumbers: "17" }, { dueDate: "2031-04-09" }, { priority: "urgent" }, { details: "x" }, { partyId: 9 }]) {
      expect(parseCanonicalLabCreate({ ...base, ...change }).fingerprint).not.toBe(parseCanonicalLabCreate(base).fingerprint);
    }
  });
  it("refuses money and posting fields by name", () => {
    for (const field of ["cost", "costCurrency", "expenseCategoryId", "expenseAccountCode", "payableAccountCode", "isPosted"]) {
      expect(() => parseCanonicalLabCreate({ ...base, [field]: field === "isPosted" ? true : "1" })).toThrow(expect.objectContaining({ code: "lab_money_not_canonical", field }));
    }
    // Empty values are absent, as in the legacy route.
    expect(() => parseCanonicalLabCreate({ ...base, cost: "", isPosted: null })).not.toThrow();
  });
});
