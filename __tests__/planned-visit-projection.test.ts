import { describe, expect, it } from "vitest";
import { projectPlannedVisitRebooking } from "../lib/planned-visit-projection";
import type { Role } from "../lib/roles";
const visit = { id: 1, canRebook: true, rebookBlockedReason: null, rebookGeneration: "a".repeat(32), rebookHasReferral: true, rebookReferralReceiverId: 8 };
describe("planned visit rebooking capability projection", () => {
  it.each(["admin", "reception"] as Role[])("allows %s without exposing internal referral authority", role => {
    const result = projectPlannedVisitRebooking(visit, { role });
    expect(result.canRebook).toBe(true); expect(result).not.toHaveProperty("rebookHasReferral"); expect(result).not.toHaveProperty("rebookReferralReceiverId");
    expect(visit.rebookReferralReceiverId).toBe(8);
    expect(result.rebookGeneration).toBe(visit.rebookGeneration);
  });
  it("allows only the receiving doctor to rebook a referral", () => {
    expect(projectPlannedVisitRebooking(visit, { role: "doctor", partyId: 8 }).canRebook).toBe(true);
    for (const partyId of [7, null, undefined]) expect(projectPlannedVisitRebooking(visit, { role: "doctor", partyId }).canRebook).toBe(false);
    expect(projectPlannedVisitRebooking({ ...visit, rebookHasReferral: false }, { role: "doctor", partyId: 7 }).canRebook).toBe(true);
  });
  it.each(["assistant", "cashier", "accountant"] as Role[])("never grants %s rebooking even when clinically eligible", role => {
    expect(projectPlannedVisitRebooking({ ...visit, rebookHasReferral: false }, { role }).canRebook).toBe(false);
  });
  it("does not turn a server clinical denial into an allowed action", () => {
    expect(projectPlannedVisitRebooking({ ...visit, canRebook: false, rebookBlockedReason: "الجلسة منجزة" }, { role: "admin" }))
      .toMatchObject({ canRebook: false, rebookBlockedReason: "الجلسة منجزة" });
  });
});
