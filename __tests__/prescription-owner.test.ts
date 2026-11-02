import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrescriptionOwnerAuthority } from "@/lib/prescription-owner";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities } from "@/lib/staff-capabilities";
const mocked = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/staff-owner-authority", () => ({ loadCanonicalOwnerAuthority: mocked.load }));
const owner = { id: 321, username: "synthetic", role: "admin", isActive: true, partyId: 44 };
beforeEach(() => mocked.load.mockResolvedValue(null));
describe("shared canonical owner adapter", () => {
  it("fails closed without canonical authority; admin and old env cannot grant ownership", async () => {
    expect(await getPrescriptionOwnerAuthority(owner)).toBeNull();
  });
  it("requires opaque shared access matching actor and exact clinician linkage", async () => {
    const context = ownerContextFromTrustedBinding({ ownerUserId: 321, bindingVersion: "test-v1" });
    const access = resolveStaffCapabilities({ subject: { userId: 321, role: "admin", isActive: true, clinicianPartyId: 44 }, permissionDocument: { schemaVersion: 1, revision: 1, patientScope: "all", appointmentScope: "all", grants: {} } }, context);
    mocked.load.mockResolvedValue({ access, bindingVersion: "test-v1" });
    expect(await getPrescriptionOwnerAuthority(owner)).toMatchObject({ bindingVersion: "test-v1" });
    for (const patch of [{ id: 322 }, { isActive: false }, { partyId: null }, { partyId: 45 }, { role: "doctor" }]) {
      expect(await getPrescriptionOwnerAuthority({ ...owner, ...patch })).toBeNull();
    }
    mocked.load.mockResolvedValue({ access: { ...access }, bindingVersion: "test-v1" });
    expect(await getPrescriptionOwnerAuthority(owner)).toBeNull();
  });
});
