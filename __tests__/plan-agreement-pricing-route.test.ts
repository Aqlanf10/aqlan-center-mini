import { beforeEach, describe, expect, it, vi } from "vitest";

// Real POST and real price-authority logic, synthetic session/catalog/DB boundaries.
// Writer-not-called assertions prove route no-write containment, not PG rollback.
const db = vi.hoisted(() => ({
  createPlanV2: vi.fn(), createPlan: vi.fn(), recordAudit: vi.fn(),
  listServices: vi.fn(), getSettings: vi.fn(), requireSession: vi.fn(),
  findUserByUsername: vi.fn(), doctorOwnsPatient: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ ...db, CLINIC_TIME_ZONE: "Asia/Aden" }));
vi.mock("@/lib/session", () => ({ requireSession: db.requireSession }));
import { POST } from "../app/api/plans/route";

const service = { id: 8, name: "Synthetic treatment", category: "general", priceMinor: 30000,
  priceSarMinor: 30000, priceUsdMinor: 30000, priceConfigured: true };
const item = { serviceId: 8, toothCode: 36, quantity: 1, unitPriceMinor: 30000, sessionCount: 2, billingRule: "on_completion" };
const parts = [{ dueDate: "2026-11-01", amountMinor: 10000 }, { dueDate: "2026-12-01", amountMinor: 10000 }];
const request = (overrides: Record<string, unknown> = {}) => ({
  mode: "v2", patientId: 91, title: "Synthetic agreement", currency: "SAR", startDate: "2026-11-01",
  billingMode: "installments", items: [item], total: "200", installments: parts, ...overrides,
});
const post = (body: unknown) => POST(new Request("http://localhost/api/plans", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
function noWrite() {
  expect(db.createPlanV2).not.toHaveBeenCalled();
  expect(db.createPlan).not.toHaveBeenCalled();
  expect(db.recordAudit).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  db.requireSession.mockResolvedValue({ role: "reception", username: "synthetic-reception" });
  db.listServices.mockResolvedValue([service]);
  db.getSettings.mockResolvedValue({ "billing.max_discount_percent": "10" });
  db.createPlanV2.mockResolvedValue({ ok: true, planId: 41 });
  db.createPlan.mockResolvedValue(42);
  db.recordAudit.mockResolvedValue(undefined);
});

describe("V2 explicit agreement total no-write containment", () => {
  it.each([undefined, "agreed", "items"])("refuses published-baseline 300/200 mismatch for mode %s", async (pricingMode) => {
    const response = await post(request({ pricingMode }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "agreement_pricing_unsupported" });
    noWrite();
  });
  it.each(["admin", "reception", "doctor"])("does not treat %s authority as permission to silently replace an agreement", async (role) => {
    db.requireSession.mockResolvedValue({ role, username: `synthetic-${role}`, partyId: 7 });
    db.findUserByUsername.mockResolvedValue({ partyId: 7, permissions: { canEditPlans: true } });
    db.doctorOwnsPatient.mockResolvedValue(true);
    const response = await post(request({ pricingMode: "agreed" }));
    expect(response.status).toBe(400); noWrite();
  });
  it("refuses an uplift and a lower explicit empty-item agreement mismatch", async () => {
    for (const body of [request({ total: "400" }), request({ items: [], total: "300", installments: [parts[0]] })]) {
      expect((await post(body)).status).toBe(400); noWrite();
    }
  });
  it.each([undefined, "items", "agreed"])("keeps clinical items and partial schedules when the explicit total matches (%s)", async (pricingMode) => {
    const response = await post(request({ pricingMode, total: "300", billingMode: "custom_schedule", installments: [parts[0]] }));
    expect(response.status).toBe(201);
    expect(db.createPlanV2).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      items: [expect.objectContaining({ serviceId: 8, toothCode: 36, unitPriceMinor: 30000, sessionCount: 2 })],
      installments: [parts[0]], billingMode: "custom_schedule", baseCurrency: "SAR",
    }));
    expect(db.recordAudit).toHaveBeenCalledOnce();
  });
  it("preserves legacy item-only QuickPlan payloads", async () => {
    expect((await post(request({ total: undefined, billingMode: "per_procedure", installments: undefined }))).status).toBe(201);
    expect(db.createPlanV2).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ serviceId: 8 })], installments: [] }));
  });
  it("preserves legacy item-priced partial custom schedules without an explicit total", async () => {
    expect((await post(request({ total: undefined, billingMode: "custom_schedule", installments: [parts[0]] }))).status).toBe(201);
    expect(db.createPlanV2).toHaveBeenCalledWith(expect.objectContaining({ installments: [parts[0]] }));
  });
  it("preserves QuickAgreement fallback installments with deterministic rounding", async () => {
    expect((await post(request({ items: [], total: "200.01", installments: undefined, count: 3, everyDays: 30 }))).status).toBe(201);
    const saved = db.createPlanV2.mock.calls[0][0];
    expect(saved.items).toEqual([]);
    expect(saved.installments.map((part: { amountMinor: number }) => part.amountMinor)).toEqual([6667, 6667, 6667]);
  });
  it("preserves the legacy empty-item schedule principal when no separate agreement was submitted", async () => {
    expect((await post(request({ items: [], total: undefined, billingMode: "custom_schedule", installments: [parts[0]] }))).status).toBe(201);
    expect(db.createPlanV2).toHaveBeenCalledWith(expect.objectContaining({ items: [], installments: [parts[0]] }));
  });
  it("compares the normalized values after existing route rounding", async () => {
    expect((await post(request({ total: "300.004", items: [{ ...item, quantity: 1.4, unitPriceMinor: 30000.4 }] }))).status).toBe(201);
    expect(db.createPlanV2).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ quantity: 1, unitPriceMinor: 30000 })] }));
  });
  it.each(["fixed", "", null])("rejects unknown mode %s without a write", async (pricingMode) => {
    const response = await post(request({ pricingMode, total: "300" }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "agreement_pricing_unsupported" }); noWrite();
  });
  it.each([undefined, "", "0", "bogus"])("rejects missing or invalid declared agreed amount %s", async (total) => {
    const response = await post(request({ pricingMode: "agreed", total }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_agreement_total" }); noWrite();
  });
  it("does not bypass existing line-discount caps by matching the declared total", async () => {
    const response = await post(request({ pricingMode: "agreed", items: [{ ...item, unitPriceMinor: 20000, priceReason: "Synthetic discount" }] }));
    expect(response.status).toBe(400); expect((await response.json()).message).toContain("يتجاوز الحد"); noWrite();
  });
  it("does not bypass the existing reason requirement even for an admin", async () => {
    db.requireSession.mockResolvedValue({ role: "admin", username: "synthetic-admin" });
    const response = await post(request({ pricingMode: "agreed", items: [{ ...item, unitPriceMinor: 20000 }] }));
    expect(response.status).toBe(400); expect((await response.json()).message).toContain("سبب الخصم"); noWrite();
  });
  it("retains the existing authorized line-price edit and audit path", async () => {
    db.requireSession.mockResolvedValue({ role: "admin", username: "synthetic-admin" });
    const response = await post(request({ pricingMode: "agreed", items: [{ ...item, unitPriceMinor: 20000, priceReason: "Approved synthetic discount" }] }));
    expect(response.status).toBe(201);
    expect(db.createPlanV2).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ unitPriceMinor: 20000 })] }));
    expect(db.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ أسعار_معدلة: expect.any(String) }) }));
  });
  it("does not bypass line-price uplift authority", async () => {
    const response = await post(request({ pricingMode: "agreed", total: "400", items: [{ ...item, unitPriceMinor: 40000, priceReason: "Synthetic uplift" }] }));
    expect(response.status).toBe(400); expect((await response.json()).message).toContain("للمدير وحده"); noWrite();
  });
  it("does not bypass authentication", async () => {
    db.requireSession.mockResolvedValue(null);
    expect((await post(request())).status).toBe(401); noWrite();
  });
  it("does not change the separate legacy financial or clinical routes", async () => {
    expect((await post({ patientId: 91, title: "Legacy", currency: "SAR", total: "200", count: 2 })).status).toBe(201);
    expect((await post({ patientId: 91, title: "Legacy clinical", mode: "clinical" })).status).toBe(201);
    expect(db.createPlanV2).not.toHaveBeenCalled(); expect(db.createPlan).toHaveBeenCalledTimes(2);
  });
});
