import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0-B: the laboratory dispatch is a clinical print, not an administrative
 * patient card. Synthetic sessions only; no database connection or patient data.
 */
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  canAccessPatient: vi.fn(),
  getLabOrderById: vi.fn(),
  getSettingsSafe: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.canAccessPatient }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db")>()),
  getLabOrderById: mocks.getLabOrderById,
  getSettingsSafe: mocks.getSettingsSafe,
}));

import LabOrderPrintPage from "../app/print/lab/[id]/page";

const params = { params: Promise.resolve({ id: "321" }) };
const syntheticOrder = { id: 321, patientId: 77 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    userId: 1, username: "synthetic-doctor", role: "doctor", partyId: 2,
  });
  mocks.getLabOrderById.mockResolvedValue(syntheticOrder);
  mocks.canAccessPatient.mockResolvedValue(false);
  mocks.getSettingsSafe.mockResolvedValue({});
});

describe("P0-B laboratory-dispatch print confidentiality", () => {
  it.each(["reception", "assistant", "cashier", "accountant"])(
    "denies %s before querying even the laboratory order",
    async (role) => {
      mocks.requireSession.mockResolvedValue({
        userId: 3, username: "synthetic-frontdesk", role,
      });
      await expect(LabOrderPrintPage(params)).rejects.toThrow();
      expect(mocks.getLabOrderById).not.toHaveBeenCalled();
      expect(mocks.canAccessPatient).not.toHaveBeenCalled();
      expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
    },
  );

  it("denies unauthenticated printing without reading an order", async () => {
    mocks.requireSession.mockResolvedValue(null);
    await expect(LabOrderPrintPage(params)).rejects.toThrow();
    expect(mocks.getLabOrderById).not.toHaveBeenCalled();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });

  it("keeps the doctor's per-patient authorization and withholds settings on denial", async () => {
    await expect(LabOrderPrintPage(params)).rejects.toThrow();
    expect(mocks.getLabOrderById).toHaveBeenCalledTimes(1);
    expect(mocks.getLabOrderById).toHaveBeenCalledWith(321);
    expect(mocks.canAccessPatient).toHaveBeenCalledWith(
      expect.objectContaining({ role: "doctor" }), 77,
    );
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });

  it("fails closed when the doctor ownership check throws", async () => {
    mocks.canAccessPatient.mockRejectedValue(new Error("synthetic lookup failure"));
    await expect(LabOrderPrintPage(params)).rejects.toThrow();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });

  it("allows the administrator through the role gate, retaining the order lookup", async () => {
    mocks.requireSession.mockResolvedValue({
      userId: 9, username: "synthetic-admin", role: "admin",
    });
    mocks.getLabOrderById.mockResolvedValue(null);
    await expect(LabOrderPrintPage(params)).rejects.toThrow();
    expect(mocks.getLabOrderById).toHaveBeenCalledTimes(1);
    expect(mocks.getLabOrderById).toHaveBeenCalledWith(321);
  });
});
