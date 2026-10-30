import { afterEach, describe, expect, it, vi } from "vitest";
import { isConfiguredPrescriptionOwner } from "@/lib/prescription-owner";
const owner = { id: 321, username: "synthetic", role: "admin", isActive: true, partyId: 44 };
afterEach(() => vi.unstubAllEnvs());
describe("trusted owner binding", () => {
  it("fails closed without valid binding and never uses admin/username as owner", () => {
    vi.stubEnv("PRESCRIPTION_OWNER_USER_ID", ""); vi.stubEnv("PRESCRIPTION_OWNER_BINDING_VERSION", "");
    expect(isConfiguredPrescriptionOwner({ ...owner, username: "admin" })).toBe(false);
  });
  it("requires exact immutable ID, version, active clinical admin identity", () => {
    vi.stubEnv("PRESCRIPTION_OWNER_USER_ID", "321"); vi.stubEnv("PRESCRIPTION_OWNER_BINDING_VERSION", "test-v1");
    expect(isConfiguredPrescriptionOwner(owner)).toBe(true);
    for (const patch of [{ id: 322 }, { isActive: false }, { partyId: null }, { role: "doctor" }, { role: "reception" }]) {
      expect(isConfiguredPrescriptionOwner({ ...owner, ...patch })).toBe(false);
    }
    vi.stubEnv("PRESCRIPTION_OWNER_BINDING_VERSION", ""); expect(isConfiguredPrescriptionOwner(owner)).toBe(false);
  });
});
