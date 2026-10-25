import { describe, expect, it } from "vitest";
import { parseDoctorAvailabilityResponse } from "../lib/appointment-availability-contract";
const expected = { doctorId: 7, date: "2030-04-08", durationMinutes: 30 };
const response = () => ({ ...expected, purpose: "advisory_only", bookingGuaranteed: false, timeZone: "Asia/Aden", rosterStatus: "resolved",
  slots: [{ time: "12:00", status: "available", label: "مقترح" }] });
describe("qualified slot-response contract", () => {
  it("accepts qualified suggestions and a distinct empty unknown result", () => {
    expect(parseDoctorAvailabilityResponse(response(), expected)).toEqual(response());
    expect(parseDoctorAvailabilityResponse({ ...response(), rosterStatus: "unknown", slots: [] }, expected)?.rosterStatus).toBe("unknown");
  });
  it.each([null, {}, { slots: [] }, { ...response(), bookingGuaranteed: true }, { ...response(), purpose: undefined },
    { ...response(), doctorId: 8 }, { ...response(), date: "2030-04-09" }, { ...response(), durationMinutes: 60 },
    { ...response(), timeZone: "bad-zone" }, { ...response(), rosterStatus: "unknown" },
    { ...response(), slots: [{ time: "24:00", status: "available", label: "مقترح" }] },
    { ...response(), slots: [...response().slots, ...response().slots] },
    { ...response(), slots: [{ time: "12:00", status: "unknown", label: "مقترح" }] },
    { ...response(), slots: [{ time: "12:00", status: "available", label: "" }] },
  ])("rejects malformed or stale data instead of inventing available or empty slots: %j", body => {
    expect(parseDoctorAvailabilityResponse(body, expected)).toBeNull();
  });
});
