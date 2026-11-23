import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0-B: Laboratory dispatch is a clinical print, never a reception receipt.
 * Synthetic records only. Nonclinical callers must fail before fetching even
 * an order's patient ID; doctors still pass through patient-scope authorization.
 */
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getLabOrderById: vi.fn(),
  getSettingsSafe: vi.fn(),
  canAccessPatient: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.canAccessPatient }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getLabOrderById: mocks.getLabOrderById,
    getSettingsSafe: mocks.getSettingsSafe,
  };
});

import LabOrderPrintPage from "../app/print/lab/[id]/page";

const print = (id: string) => LabOrderPrintPage({ params: Promise.resolve({ id }) });
const session = (role: string) => ({
  userId: 55, username: "synthetic-user", role,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(session("doctor"));
  mocks.getLabOrderById.mockResolvedValue(null);
  mocks.canAccessPatient.mockResolvedValue(false);
});

describe("P0-B laboratory dispatch print boundary", () => {
  it.each(["reception", "assistant", "cashier", "accountant"])(
    "%s cannot fetch or print a clinical lab order even with a valid order ID",
    async (role) => {
      mocks.requireSession.mockResolvedValue(session(role));
      await expect(print("321")).rejects.toThrow();
      expect(mocks.getLabOrderById).not.toHaveBeenCalled();
      expect(mocks.canAccessPatient).not.toHaveBeenCalled();
      expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
    },
  );

  it("a missing session does not resolve an order", async () => {
    mocks.requireSession.mockResolvedValue(null);
    await expect(print("321")).rejects.toThrow();
    expect(mocks.getLabOrderById).not.toHaveBeenCalled();
  });

  it.each(["321.0", "3.21e2", "0x141", "+321", "0321", "9007199254740993", "P-07000", "", "-321"])(
    "rejects a noncanonical order URL %s before any clinical read",
    async (id) => {
      await expect(print(id)).rejects.toThrow();
      expect(mocks.getLabOrderById).not.toHaveBeenCalled();
      expect(mocks.canAccessPatient).not.toHaveBeenCalled();
    },
  );

  it.each(["doctor", "admin"])(
    "%s can reach an order lookup without a broad nonclinical grant",
    async (role) => {
      mocks.requireSession.mockResolvedValue(session(role));
      await expect(print("321")).rejects.toThrow(); // synthetic order not found
      expect(mocks.getLabOrderById).toHaveBeenCalledWith(321);
    },
  );

  it("a doctor without patient scope cannot read order settings or render it", async () => {
    mocks.getLabOrderById.mockResolvedValue({ id: 321, patientId: 77 });
    mocks.canAccessPatient.mockResolvedValue(false);
    await expect(print("321")).rejects.toThrow();
    expect(mocks.canAccessPatient).toHaveBeenCalledWith(
      expect.objectContaining({ role: "doctor" }), 77,
    );
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });

  it("scope errors fail closed before order rendering", async () => {
    mocks.getLabOrderById.mockResolvedValue({ id: 321, patientId: 77 });
    mocks.canAccessPatient.mockRejectedValue(new Error("synthetic scope lookup failure"));
    await expect(print("321")).rejects.toThrow();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });
});
