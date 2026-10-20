import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real HTTP handler and JSON parser without opening a database.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), createMovement: vi.fn(), visitPatient: vi.fn(), patientAccess: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  AUTO_MATERIAL_REASON_PREFIX: "خصم تلقائي — ",
  createInventoryMovement: mocks.createMovement,
  visitPatientOf: mocks.visitPatient,
}));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.patientAccess }));
import { POST } from "../app/api/inventory/[id]/movements/route";

function request(supplier: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return POST(new Request("http://test.invalid/api/inventory/7/movements", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "in", qty: 2, unitCost: "100", ...supplier, ...extra }),
  }), { params: Promise.resolve({ id: "7" }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  mocks.createMovement.mockResolvedValue({ ok: true, balance: 2, movement: {
    id: 9, itemId: 7, kind: "in", qty: 2, partyId: 42, payableId: 11,
    unitCostMinor: 100, expiryDate: null, reason: null, visitId: null,
    createdBy: "synthetic-admin", createdAt: "2026-10-20T00:00:00.000Z",
  } });
});

describe("inventory movement supplier ID HTTP boundary", () => {
  it.each([
    true, false, [], [42], ["42"], [null], {}, { id: 42 },
    0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    "0", "-1", "1.5", "2147483648", "9007199254740993", "9".repeat(400),
    "not-an-id", "NaN", "Infinity", " ", "\t", " 42", "42 ", "42\n",
    "+42", "4.2e1", "0x2a", "0b101010", "0o52", "42.0", "٤٢", "42x",
  ].map(value => ({ value })))("rejects malformed supplied ID $value before calling the writer", async ({ value }) => {
    const response = await request({ supplierPartyId: value });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "رقم المورّد غير صالح." });
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it("rejects JSON numeric overflow before calling the writer", async () => {
    const response = await POST(new Request("http://test.invalid/api/inventory/7/movements", {
      method: "POST", headers: { "content-type": "application/json" },
      body: '{"kind":"in","qty":2,"unitCost":"100","supplierPartyId":1e309}',
    }), { params: Promise.resolve({ id: "7" }) });
    expect(response.status).toBe(400);
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it.each([1, 42, 2147483647, "1", "42", "00042", "2147483647"])(
    "passes valid integer ID %s to the writer exactly once", async value => {
      expect((await request({ supplierPartyId: value })).status).toBe(201);
      expect(mocks.createMovement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        itemId: 7, kind: "in", qty: 2, unitCostMinor: 100, supplierPartyId: Number(value),
      }));
    },
  );

  it.each([
    { label: "omitted", supplier: {} },
    { label: "null", supplier: { supplierPartyId: null } },
    { label: "empty string", supplier: { supplierPartyId: "" } },
  ])("preserves intentional no-supplier purchase when $label", async ({ supplier }) => {
    expect((await request(supplier)).status).toBe(201);
    expect(mocks.createMovement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      supplierPartyId: null, unitCostMinor: 100,
    }));
  });

  it.each(["doctor", "cashier", "accountant", "assistant"])("preserves %s purchase denial", async role => {
    mocks.session.mockResolvedValue({ username: "synthetic-user", role });
    expect((await request({ supplierPartyId: 42 })).status).toBe(403);
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it.each(["admin", "reception"])("preserves %s purchase permission", async role => {
    mocks.session.mockResolvedValue({ username: "synthetic-user", role });
    expect((await request({ supplierPartyId: "42" })).status).toBe(201);
    expect(mocks.createMovement).toHaveBeenCalledTimes(1);
  });

  it("preserves logged-out denial before parsing the supplier", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await request({ supplierPartyId: true })).status).toBe(401);
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it("preserves a doctor's stock-only issue but not supplier billing", async () => {
    mocks.session.mockResolvedValue({ username: "synthetic-doctor", role: "doctor" });
    expect((await request({}, { kind: "out" })).status).toBe(201);
    expect(mocks.createMovement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "out", supplierPartyId: null, unitCostMinor: null,
    }));
    mocks.createMovement.mockClear();
    expect((await request({ supplierPartyId: 42 }, { kind: "out" })).status).toBe(403);
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });
});
