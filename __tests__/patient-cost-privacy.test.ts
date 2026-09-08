import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * خصوصية تكلفة مواد المريض (P0.13/P0.16): الطبيب بلا canViewCostPrices يرى
 * الكميات دون القيمة؛ والمدير يرى القيمة — وأثر ذلك في ربحية الحالة.
 */

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  canAccessPatient: vi.fn(),
  findUserByUsername: vi.fn(),
  issuedCostForPatient: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.canAccessPatient }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    findUserByUsername: mocks.findUserByUsername,
    issuedCostForPatient: mocks.issuedCostForPatient,
  };
});

import { GET as patientCost } from "../app/api/inventory/patient-cost/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAccessPatient.mockResolvedValue(true);
  mocks.issuedCostForPatient.mockResolvedValue({
    materialCostMinor: 3_500_000,
    issuedCount: 7,
    firstIssuedAt: "2026-08-01",
  });
});

describe("Doctor A يرى تكلفة مريض B — الحجب", () => {
  it("طبيب بلا canViewCostPrices: الكمية بلا قيمة", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 2, username: "dr.amjad", role: "doctor", partyId: 5 });
    mocks.findUserByUsername.mockResolvedValue({
      id: 2, username: "dr.amjad", isActive: true, partyId: 5,
      permissions: { canViewCostPrices: false },
    });
    const response = await patientCost(
      new Request("http://localhost/api/inventory/patient-cost?patientId=42"),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.issuedCount).toBe(7);
    expect(data.firstIssuedAt).toBe("2026-08-01");
    expect(data.materialCostMinor).toBeNull();
    expect(data.costHidden).toBe(true);
  });

  it("طبيب لا يملك المريض: 403 — العزل قبل الحجب", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 2, username: "dr.amjad", role: "doctor", partyId: 5 });
    mocks.canAccessPatient.mockResolvedValue(false);
    const response = await patientCost(
      new Request("http://localhost/api/inventory/patient-cost?patientId=77"),
    );
    expect(response.status).toBe(403);
  });

  it("المدير يرى القيمة كاملة", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 1, username: "owner", role: "admin" });
    const response = await patientCost(
      new Request("http://localhost/api/inventory/patient-cost?patientId=42"),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.materialCostMinor).toBe(3_500_000);
    expect(data.costHidden).toBeUndefined();
  });

  it("طبيب بمنحة صريحة (canViewCostPrices) يرى القيمة", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 2, username: "dr.amjad", role: "doctor", partyId: 5 });
    mocks.findUserByUsername.mockResolvedValue({
      id: 2, username: "dr.amjad", isActive: true, partyId: 5,
      permissions: { canViewCostPrices: true },
    });
    const response = await patientCost(
      new Request("http://localhost/api/inventory/patient-cost?patientId=42"),
    );
    const data = await response.json();
    expect(data.materialCostMinor).toBe(3_500_000);
  });
});
