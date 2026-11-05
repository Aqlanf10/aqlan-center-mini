import { describe, expect, it } from "vitest";
import { patientOrthoBookingContext } from "./fixtures/patient-ortho-booking-context";
const origin = "http://127.0.0.1:3107";
const path = "/api/patients/939101/return-booking-context?kind=ortho_adjustment&sourceId=934101";
describe("bounded orthodontic return-booking fixture", () => {
  it("returns fixed source-bound evidence only for the owned synthetic adjustment", () => {
    expect(patientOrthoBookingContext(new URL(path, origin), "GET", origin)).toMatchObject({
      ok: true, patientId: 939101, source: { kind: "ortho_adjustment", id: 934101 },
      doctorId: 935101, fingerprint: "1".repeat(64),
    });
  });
  it.each([
    path.replace("939101", "939102"), path.replace("934101", "934999"),
    path.replace("ortho_adjustment", "ortho_case"), `${path}&doctorId=1`,
    `${path}&sourceId=934102`, path.replace("934101", "0934101"),
  ])("does not manufacture evidence for an unowned or malformed request %s", (request) => {
    expect(patientOrthoBookingContext(new URL(request, origin), "GET", origin)).toBeNull();
  });
  it("rejects writes and external origins", () => {
    expect(patientOrthoBookingContext(new URL(path, origin), "POST", origin)).toBeNull();
    expect(patientOrthoBookingContext(new URL(path, "https://outside.invalid"), "GET", origin)).toBeNull();
  });
});
