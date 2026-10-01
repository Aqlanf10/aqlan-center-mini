import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * (TD-06 / TD-REG-018) أسعار المساعد الذكي من دليل المركز — بتحويلٍ صحيح، وبلا رقمٍ مخترع.
 *
 * كان «تقديري سعودي» = اليمني × سعر الصرف (140) ⇒ خدمةٌ بـ70,000 ر.ي تظهر بـ9,800,000 ر.س؛
 * وبلا سعر صرف يُستعمل 0.0038 المكتوب في الكود؛ والأسعار نفسها من الدليل الابتدائي في الكود
 * لا من دليل المركز؛ وتعذّر قراءة القاعدة يُبتلع فيُعرض الدليل الابتدائي أو قائمةٌ فارغة.
 */

const mocks = vi.hoisted(() => ({ listServices: vi.fn(), getSettings: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  listServices: mocks.listServices,
  getSettings: mocks.getSettings,
}));
vi.mock("../lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db")>()),
  listServices: mocks.listServices,
  getSettings: mocks.getSettings,
}));

const { getServicePricingAction } = await import("../lib/ai-tools/clinical-action-tools");
const { getServicePrices } = await import("../lib/ai-tools/management-tools");
const { foreignPriceMinor, PRICE_LIST_UNAVAILABLE, STARTER_CATALOG_NOTE } = await import("../lib/ai-tools/price-list");
const { formatMoney } = await import("../lib/money");

const context = {
  role: "admin", userRole: "admin", username: "owner", doctorPartyId: null,
  permissions: { canViewServicePrices: true }, isDbConnected: true, todayISO: "2026-10-01", clinicName: "مركز",
} as unknown as Parameters<typeof getServicePricingAction>[1];

const clinicService = (overrides: Record<string, unknown> = {}) => ({
  id: 1, name: "تقويم ثابت معدني", category: "orthodontics", priceMinor: 70_000, isActive: true, sortOrder: 1,
  priceConfigured: true, priceProvisional: false, priceSarMinor: null, priceUsdMinor: null, ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSettings.mockResolvedValue({ "finance.rate.SAR": "140", "finance.rate.USD": "530" });
});

describe("foreignPriceMinor", () => {
  it("divides the YER price by the configured rate (140 YER per SAR)", () => {
    expect(foreignPriceMinor({ priceMinor: 70_000, priceSarMinor: null, priceUsdMinor: null }, "SAR", { "finance.rate.SAR": "140" } as never))
      .toBe(50_000); // 500.00 ر.س
  });
  it("prefers the owner's own price in that currency", () => {
    expect(foreignPriceMinor({ priceMinor: 70_000, priceSarMinor: 45_000, priceUsdMinor: null }, "SAR", { "finance.rate.SAR": "140" } as never))
      .toBe(45_000);
  });
  it("no configured rate ⇒ no estimate (no hardcoded fallback)", () => {
    expect(foreignPriceMinor({ priceMinor: 70_000, priceSarMinor: null, priceUsdMinor: null }, "SAR", {} as never)).toBeNull();
  });
});

describe("get_service_pricing reads the clinic's price list", () => {
  it("shows the clinic's own price and a correct SAR estimate", async () => {
    mocks.listServices.mockResolvedValue([clinicService()]);
    const result = await getServicePricingAction({ serviceQuery: "تقويم" }, context);
    expect(result.success).toBe(true);
    expect(result.table?.rows).toEqual([["تقويم ثابت معدني", expect.any(String), formatMoney(70_000, "YER"), formatMoney(50_000, "SAR")]]);
    expect(JSON.stringify(result)).not.toContain("9,800,000");
    expect(result.textSummary).not.toContain(STARTER_CATALOG_NOTE);
  });

  it("no SAR rate configured ⇒ «—», never an invented rate", async () => {
    mocks.listServices.mockResolvedValue([clinicService()]);
    mocks.getSettings.mockResolvedValue({});
    const result = await getServicePricingAction({ serviceQuery: "تقويم" }, context);
    expect(result.table?.rows[0][3]).toBe("—");
  });

  it("settings unreadable ⇒ still the clinic prices, without a foreign estimate", async () => {
    mocks.listServices.mockResolvedValue([clinicService()]);
    mocks.getSettings.mockRejectedValue(new Error("connection reset"));
    const result = await getServicePricingAction({ serviceQuery: "تقويم" }, context);
    expect(result.success).toBe(true);
    expect(result.table?.rows[0][3]).toBe("—");
  });

  it("price list unreadable ⇒ an explicit failure, not the starter catalog", async () => {
    mocks.listServices.mockRejectedValue(new Error("connection reset"));
    const result = await getServicePricingAction({ serviceQuery: "تقويم" }, context);
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain(PRICE_LIST_UNAVAILABLE);
    expect(result.table).toBeUndefined();
  });

  it("offline (no database) ⇒ the starter catalog, labelled as such", async () => {
    const result = await getServicePricingAction({ serviceQuery: "تقويم" }, { ...context, isDbConnected: false });
    expect(result.success).toBe(true);
    expect(result.textSummary).toContain(STARTER_CATALOG_NOTE);
    expect(mocks.listServices).not.toHaveBeenCalled();
  });
});

describe("get_service_prices (management) — same contract", () => {
  it("clinic list when readable", async () => {
    mocks.listServices.mockResolvedValue([clinicService()]);
    const result = await getServicePrices({ keyword: "تقويم" }, context);
    expect(result.success).toBe(true);
    expect(result.textSummary).toContain("تقويم ثابت معدني");
  });

  it("unreadable ⇒ explicit failure (was: silent fallback to the starter catalog)", async () => {
    mocks.listServices.mockRejectedValue(new Error("connection reset"));
    const result = await getServicePrices({ keyword: "تقويم" }, context);
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain(PRICE_LIST_UNAVAILABLE);
  });
});
