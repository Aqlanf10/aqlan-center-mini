import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), findUserByUsername: vi.fn(), listLabOrders: vi.fn(),
  listLabNames: vi.fn(), listLabServices: vi.fn(), labCounts: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({
  ...boundary, createLabOrder: vi.fn(), getSettings: vi.fn(), listParties: vi.fn(), recordAudit: vi.fn(),
}));
import { GET } from "../app/api/lab/route";

const orders = [
  { id: 12, patientId: 101, status: "delivered", costMinor: 6789, costCurrency: "USD", baseAmountMinor: 36058, exchangeRate: 531.125 },
  { id: 11, patientId: 101, status: "cancelled", costMinor: 4500, costCurrency: "SAR", baseAmountMinor: 6356, exchangeRate: 141.25 },
  { id: 10, patientId: 101, status: "sent", costMinor: 1200, costCurrency: "YER", baseAmountMinor: 1200, exchangeRate: 1 },
];
const request = (query = "") => new Request(`http://test.invalid/api/lab${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-reader", role: "admin" });
  boundary.listLabOrders.mockResolvedValue(orders);
  boundary.listLabNames.mockResolvedValue([{ labName: "Synthetic lab", labPhone: null }]);
  boundary.listLabServices.mockResolvedValue([{ id: 701, name: "Synthetic service" }]);
  boundary.labCounts.mockResolvedValue({ outstanding: 3 });
});

describe("patient lab GET canonical query boundary", () => {
  it.each(["101", "0101", "101.0", "1.01e2", " 101 "])(
    "passes the existing numeric patient filter %s to the canonical query", async (value) => {
      const response = await GET(request(`?patientId=${encodeURIComponent(value)}`));
      expect(response.status).toBe(200);
      expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
      expect(await response.json()).toEqual({ orders, labs: [{ labName: "Synthetic lab", labPhone: null }] });
      expect(boundary.listLabServices).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "0", "-0", " ", "no-patient", "NaN", "Infinity", "101.5"])(
    "preserves global-list fallback for %s", async (value) => {
      const response = await GET(request(value === undefined ? "" : `?patientId=${encodeURIComponent(value)}`));
      expect(response.status).toBe(200);
      expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith(undefined);
      expect((await response.json()).orders).toEqual(orders);
    },
  );

  it.each([-1, -2_147_483_648, 2_147_483_647])("keeps integer filtering for %s", async (patientId) => {
    boundary.listLabOrders.mockResolvedValue([]);
    const response = await GET(request(`?patientId=${patientId}`));
    expect(response.status).toBe(200);
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId });
    expect((await response.json()).orders).toEqual([]);
  });

  it.each(["2147483648", "-2147483649", "9007199254740992", "1e100"])(
    "preserves empty integer-filter results without PostgreSQL overflow for %s", async (value) => {
      const response = await GET(request(`?patientId=${value}&services=1`));
      expect(response.status).toBe(200);
      expect(boundary.listLabOrders).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({ orders: [], labs: [{ labName: "Synthetic lab", labPhone: null }], labServices: [{ id: 701, name: "Synthetic service" }] });
    },
  );

  it("retains the optional services envelope", async () => {
    const response = await GET(request("?patientId=101&services=1"));
    expect(await response.json()).toEqual({ orders, labs: [{ labName: "Synthetic lab", labPhone: null }], labServices: [{ id: 701, name: "Synthetic service" }] });
    expect(boundary.listLabServices).toHaveBeenCalledOnce();
  });

  it.each(["?summary=1&patientId=101", "?summary=1&patientId=2147483648&services=1"])(
    "keeps summary precedence and global counts for %s", async (query) => {
      const response = await GET(request(query));
      expect(await response.json()).toEqual({ outstanding: 3 });
      expect(boundary.labCounts).toHaveBeenCalledOnce();
      expect(boundary.listLabOrders).not.toHaveBeenCalled();
      expect(boundary.listLabNames).not.toHaveBeenCalled();
      expect(boundary.listLabServices).not.toHaveBeenCalled();
    },
  );

  it.each(["admin", "reception"])("preserves the %s currency/cost projection", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-reader", role });
    const response = await GET(request("?patientId=101"));
    expect((await response.json()).orders).toEqual(orders);
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves doctor cost visibility = %s", async (canViewCostPrices) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-doctor", role: "doctor" });
    boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices } });
    const response = await GET(request("?patientId=101"));
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
    expect((await response.json()).orders).toEqual(canViewCostPrices
      ? orders : orders.map((order) => ({ ...order, costMinor: null, costCurrency: null })));
    // This bounded fix preserves the existing two-field mask; it does not redesign financial DTOs.
    expect(orders.map((order) => order.costCurrency)).toEqual(["USD", "SAR", "YER"]);
  });

  it("keeps doctor costs masked when the user lookup fails", async () => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-doctor", role: "doctor" });
    boundary.findUserByUsername.mockRejectedValue(new Error("Synthetic lookup failure"));
    expect((await (await GET(request("?patientId=101"))).json()).orders)
      .toEqual(orders.map((order) => ({ ...order, costMinor: null, costCurrency: null })));
  });

  it("retains unauthenticated admission without reads", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await GET(request("?patientId=101"))).status).toBe(401);
    expect(boundary.listLabOrders).not.toHaveBeenCalled();
    expect(boundary.listLabNames).not.toHaveBeenCalled();
  });

  it.each(["listLabOrders", "listLabNames", "listLabServices"] as const)(
    "retains the 500 boundary for %s failure", async (reader) => {
      boundary[reader].mockRejectedValue(new Error("Synthetic reader failure"));
      const response = await GET(request("?patientId=101&services=1"));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: "تعذّر تحميل أعمال المختبر." });
    },
  );
});
