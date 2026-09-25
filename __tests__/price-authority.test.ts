import { describe, expect, it } from "vitest";
import { decideProcedurePrice } from "../lib/price-authority";

const base = {
  serviceName: "حشوة", catalogMinor: 15000, priceConfigured: true, requestedMinor: 15000,
  role: "doctor", reason: null as string | null, maxDiscountPercent: 0,
};

describe("procedure price authority (P1-6)", () => {
  it("the catalog price passes untouched", () => {
    expect(decideProcedurePrice(base)).toEqual({ ok: true, unitPriceMinor: 15000, override: null });
  });

  it("audit repro: a doctor cannot bill a 15,000 procedure at 1", () => {
    const decision = decideProcedurePrice({ ...base, requestedMinor: 1, reason: "مريض قريب" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toContain("يتجاوز الحد المسموح (0٪)");
  });

  it("a doctor cannot raise the price (it would inflate the commission)", () => {
    const decision = decideProcedurePrice({ ...base, requestedMinor: 20000, reason: "حالة صعبة" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toContain("للمدير وحده");
  });

  it("a doctor may discount within the configured limit, with a reason", () => {
    const allowed = decideProcedurePrice({ ...base, requestedMinor: 13500, reason: "خصم عائلي", maxDiscountPercent: 10 });
    expect(allowed).toEqual({
      ok: true, unitPriceMinor: 13500,
      override: { kind: "discount", catalogMinor: 15000, requestedMinor: 13500, discountPercent: 10, reason: "خصم عائلي" },
    });
    expect(decideProcedurePrice({ ...base, requestedMinor: 13000, reason: "خصم", maxDiscountPercent: 10 }).ok).toBe(false);
    const noReason = decideProcedurePrice({ ...base, requestedMinor: 13500, maxDiscountPercent: 10 });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.message).toContain("اكتب سبب الخصم");
  });

  it("the admin may deviate either way, but always with a reason", () => {
    expect(decideProcedurePrice({ ...base, role: "admin", requestedMinor: 1 }).ok).toBe(false);
    expect(decideProcedurePrice({ ...base, role: "admin", requestedMinor: 1, reason: "إعفاء بقرار المدير" }).ok).toBe(true);
    const increase = decideProcedurePrice({ ...base, role: "admin", requestedMinor: 18000, reason: "مواد خاصة" });
    expect(increase.ok && increase.override?.kind).toBe("increase");
  });

  it("an unpriced catalog service accepts the typed price and flags it for the audit", () => {
    const decision = decideProcedurePrice({ ...base, catalogMinor: 0, priceConfigured: false, requestedMinor: 7000 });
    expect(decision).toMatchObject({ ok: true, unitPriceMinor: 7000, override: { kind: "unpriced" } });
  });
});
