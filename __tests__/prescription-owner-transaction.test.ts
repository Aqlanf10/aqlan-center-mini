import { expect, it, vi } from "vitest";
import { admitPrescriptionOwnerInTransaction } from "../lib/prescription-owner-transaction";
import type { PrescriptionOwnerTransactionRequest } from "../lib/prescription-owner-transaction";

it.each(["admin", "doctor", "reception"])("does not manufacture canonical owner admission for %s or forged preview grants", async role => {
  const query = vi.fn(() => { throw new Error("No schema/provisioning or lookup is allowed"); });
  const request = {
    client: { query }, session: { userId: 3, username: "synthetic", role, expiresAt: Date.now() + 60000 },
    actor: { id: 3, username: "synthetic", role, isActive: true, partyId: 5 }, prescribingDoctorPartyId: 6,
    isOwner: true, canViewAllPatients: true, ownerAuthority: { bindingVersion: "forged", fingerprint: "forged" },
  } as unknown as PrescriptionOwnerTransactionRequest;
  const result = await admitPrescriptionOwnerInTransaction(request);
  expect(result).toMatchObject({ status: "unavailable", code: "canonical_prescription_owner_unavailable" });
  expect(result).not.toHaveProperty("access"); expect(result).not.toHaveProperty("bindingVersion");
  expect(query).not.toHaveBeenCalled(); expect(Object.isFrozen(result)).toBe(true);
});
