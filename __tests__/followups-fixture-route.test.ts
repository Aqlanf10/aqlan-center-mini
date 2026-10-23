import { describe, expect, it } from "vitest";
import { emptyFollowupsFixtureRead } from "./helpers/followups-fixture-route";

const origin = "http://127.0.0.1:3217";
const path = "/api/appointment-followups?limit=25";
const read = (suffix = path, method = "GET", base = origin) =>
  emptyFollowupsFixtureRead(new URL(suffix, base), method, origin, null);

describe("explicitly scoped synthetic follow-up pages", () => {
  it("returns the real queue envelope with no patient rows or next-page invitation", () => {
    expect(read()).toEqual({ timeZone: "Asia/Aden", items: [], hasMore: false, nextCursor: null });
  });
  it("serves only the explicitly bound synthetic patient, never the board or another patient", () => {
    const scoped = (query: string) => emptyFollowupsFixtureRead(new URL(`/api/appointment-followups?${query}`, origin), "GET", origin, 98301);
    expect(scoped("limit=25&patientId=98301")).toEqual(read());
    for (const query of ["limit=25", "limit=25&patientId=98302", "limit=25&patientId=98301&patientId=98301",
      "limit=25&patientId=98301&cursor=unexpected", "limit=25&patientId=98301&extra=1", "limit=100&patientId=98301"]) {
      expect(scoped(query)).toBeNull();
    }
    expect(emptyFollowupsFixtureRead(new URL(`${path}&patientId=98301`, origin), "POST", origin, 98301)).toBeNull();
    expect(emptyFollowupsFixtureRead(new URL(`${path}&patientId=98301`, "https://synthetic.invalid"), "GET", origin, 98301)).toBeNull();
  });
  it.each(["POST", "PATCH", "DELETE", "HEAD", "OPTIONS"])("refuses %s instead of allowing a new transport", method => {
    expect(read(path, method)).toBeNull();
  });
  it.each([
    "/api/appointment-followups", "/api/appointment-followups?limit=100",
    "/api/appointment-followups?limit=025", "/api/appointment-followups?limit=25&limit=25",
    "/api/appointment-followups?limit=25&patientId=98301", "/api/appointment-followups?limit=25&patientId=98302",
    "/api/appointment-followups?limit=25&cursor=unexpected", "/api/appointment-followups?limit=25&unknown=1",
    "/api/appointment-followups/1?limit=25", "/api/patients/98301?limit=25", "/api/unknown?limit=25",
  ])("keeps unadvertised pages, patient scopes and unknown APIs rejected: %s", suffix => {
    expect(read(suffix)).toBeNull();
  });
  it("rejects an external origin even with the exact API path and query", () => {
    expect(read(path, "GET", "https://synthetic.invalid")).toBeNull();
  });
});
