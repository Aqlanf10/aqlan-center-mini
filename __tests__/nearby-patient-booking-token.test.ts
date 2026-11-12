import { describe, expect, it } from "vitest";
import { acceptsNearbyConfirmation, nearbyConfirmationToken, type NearbyBookingProposal } from "../lib/nearby-patient-booking";
const proposal: NearbyBookingProposal = { actor: "reception", scope: "create", patientId: 12, date: "2026-12-31", time: "16:00", durationMinutes: 15, serviceId: 1, doctorId: 2, chairNo: null, excludeId: null };
const snapshot = [{ id: 7, scheduledDate: "2027-01-01", scheduledTime: "17:00", status: "booked" }];
describe("nearby booking confirmation", () => {
  it("requires exact actor, patient, proposal, and live snapshot", () => {
    const token = nearbyConfirmationToken(proposal, snapshot, 1000);
    expect(acceptsNearbyConfirmation(token, proposal, snapshot, 2000)).toBe(true);
    for (const change of [{ actor: "other" }, { actor: "" }, { patientId: 13 }, { time: "16:15" }, { date: "2027-01-01" }, { scope: "reschedule:7" }, { durationMinutes: 30 }, { doctorId: 3 }, { serviceId: 2 }, { excludeId: 8 }]) {
      expect(acceptsNearbyConfirmation(token, { ...proposal, ...change }, snapshot, 2000)).toBe(false);
    }
    expect(acceptsNearbyConfirmation(token, proposal, [...snapshot, { id: 8 }], 2000)).toBe(false);
    expect(acceptsNearbyConfirmation(token, proposal, [{ ...snapshot[0], status: "arrived" }], 2000)).toBe(false);
  });
  it("rejects expiration, tampering, malformed values, and future issued tokens", () => {
    const token = nearbyConfirmationToken(proposal, snapshot, 1000);
    for (const bad of [null, true, "", token + "x", "x.y", token + ".z", "x".repeat(5000)]) expect(acceptsNearbyConfirmation(bad, proposal, snapshot, 2000)).toBe(false);
    expect(acceptsNearbyConfirmation(token, proposal, snapshot, 601000)).toBe(false);
    expect(acceptsNearbyConfirmation(token, proposal, snapshot, 0)).toBe(false);
  });
});
