import { describe, expect, it } from "vitest";
import { parseCaseOverrideRequest } from "../lib/commission-override-input";
import { movementCostsAtIndexes, issuedCostMinor } from "../lib/inventoryCost";
import { restrictedRouteAllowed } from "../lib/role-routes";

describe("(F-11) طلب النسبة الخاصة", () => {
  const valid = { doctorId: 3, caseId: 5, action: "set", percent: 25, reason: "اتفاق خاص مع الطبيب", effectiveDate: "2024-05-01" };
  it("يقبل الصحيح", () => {
    expect(parseCaseOverrideRequest(valid)).toEqual({
      ok: true,
      value: { doctorId: 3, caseId: 5, planId: null, action: "set", percent: 25, reason: "اتفاق خاص مع الطبيب", effectiveDate: "2024-05-01", supersedesId: null },
    });
  });
  it.each([
    [{ ...valid, reason: " " }, "اكتب سبب النسبة الخاصة."],
    [{ ...valid, percent: 120 }, "النسبة بين 0 و100."],
    [{ ...valid, planId: 2 }, "اختر حالةً واحدة أو خطةً واحدة."],
    [{ ...valid, caseId: null }, "اختر حالةً واحدة أو خطةً واحدة."],
    [{ ...valid, doctorId: 0 }, "اختر الطبيب."],
    [{ ...valid, action: "void", percent: null }, "اختر النسبة الخاصة التي تُلغى."],
    [{ ...valid, effectiveDate: "2024-13-45" }, "تاريخ السريان غير صالح."],
    // يومٌ لا وجود له يمرّ من Date.parse (يُطبَّع إلى ٣ مارس) ثم يرفضه ‎::date‎ في القاعدة بـ500 — يُردّ هنا بـ400.
    [{ ...valid, effectiveDate: "2026-02-31" }, "تاريخ السريان غير صالح."],
    [{ ...valid, action: "delete" }, "الفعل غير معروف."],
  ])("يرفض %j برسالة عربية", (input, message) => {
    expect(parseCaseOverrideRequest(input)).toEqual({ ok: false, message });
  });
  it("الإلغاء لا يحمل نسبة", () => {
    const parsed = parseCaseOverrideRequest({ ...valid, action: "void", percent: 99, supersedesId: 4 });
    expect(parsed.ok && parsed.value.percent).toBe(null);
  });
});

describe("(F-4) قيمة الحركات بالمتوسّط قبلها", () => {
  const moves = [
    { kind: "in" as const, qty: 10, unitCostMinor: 100 },
    { kind: "in" as const, qty: 10, unitCostMinor: 200 },
    { kind: "out" as const, qty: 2, unitCostMinor: 999999 },
    { kind: "in" as const, qty: 1, isReturn: true },
    { kind: "out" as const, qty: 3 },
  ];
  it("الصرف يطابق issuedCostMinor ولا يقرأ ثمن الصرف المكتوب، والردّ سالب", () => {
    const costs = movementCostsAtIndexes(moves, () => true);
    expect(costs.get(2)).toBe(300);
    expect(costs.get(3)).toBe(-150);
    expect(costs.get(4)).toBe(450);
    expect(costs.has(0)).toBe(false);
    expect(Math.round((costs.get(2) ?? 0) + (costs.get(4) ?? 0))).toBe(issuedCostMinor(moves, () => true));
  });
});

describe("(COMM-DETAIL-1) باب كشف العمولة المطبوع", () => {
  it("المحاسب بصلاحية العمولات يصل، ومن دونها لا، والكاشير أبدًا", () => {
    expect(restrictedRouteAllowed("accountant", "/print/commission-statement/4", "GET")).toBe(true);
    expect(restrictedRouteAllowed("accountant", "/print/commission-statement/4", "GET", { viewCommissions: false })).toBe(false);
    expect(restrictedRouteAllowed("cashier", "/print/commission-statement/4", "GET")).toBe(false);
    expect(restrictedRouteAllowed("accountant", "/api/finance/commission-overrides", "GET")).toBe(false);
    expect(restrictedRouteAllowed("accountant", "/api/finance/commission-overrides", "POST")).toBe(false);
  });
});
