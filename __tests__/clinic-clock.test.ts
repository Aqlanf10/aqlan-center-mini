import { afterEach, describe, expect, it, vi } from "vitest";
import { formatClinicDate, formatClinicTimestamp } from "../lib/clinic-clock";

afterEach(() => { vi.unstubAllEnvs(); });

describe("stored financial instants in the resolved clinic zone", () => {
  it.each(["UTC", "Pacific/Honolulu"])("ignores host TZ=%s at Aden midnight", (hostZone) => {
    vi.stubEnv("TZ", hostZone);
    expect(formatClinicTimestamp("2000-02-02T20:59:00.000Z", "Asia/Aden"))
      .toBe("الأربعاء 02/02/2000 · 11:59 مساءً");
    expect(formatClinicTimestamp("2000-02-02T21:00:00.000Z", "Asia/Aden"))
      .toBe("الخميس 03/02/2000 · 12:00 صباحًا");
    expect(formatClinicTimestamp("2000-02-02T22:00:00.000Z", "Asia/Aden"))
      .toBe("الخميس 03/02/2000 · 1:00 صباحًا");
  });

  it("honors a configured non-default zone and previous calendar day", () => {
    expect(formatClinicTimestamp("2000-02-02T02:00:00.000Z", "America/New_York"))
      .toBe("الثلاثاء 01/02/2000 · 9:00 مساءً");
  });

  it("uses the existing invalid-zone fallback, not the host zone", () => {
    expect(formatClinicTimestamp("2000-02-02T22:00:00.000Z", "invalid-zone"))
      .toBe("الخميس 03/02/2000 · 1:00 صباحًا");
  });

  it("does not invent the current time for an invalid stored instant", () => {
    expect(formatClinicTimestamp("", "Asia/Aden")).toBe("—");
    expect(formatClinicTimestamp("not-an-instant", "Asia/Aden")).toBe("—");
  });
});


describe("financial date labels", () => {
  it.each(["UTC", "Asia/Aden", "Pacific/Honolulu"])("is independent of host %s", host => {
    vi.stubEnv("TZ", host);
    expect(formatClinicDate("2026-10-29T23:31:00Z", "Asia/Aden")).toBe("الجمعة 30/10/2026");
    expect(formatClinicDate("2026-10-29T23:31:00Z", "UTC")).toBe("الخميس 29/10/2026");
    expect(formatClinicTimestamp("2026-10-29T23:31:00Z", "Asia/Aden")).toBe("الجمعة 30/10/2026 · 2:31 صباحًا");
    for (const zone of ["UTC", "Asia/Aden", "America/New_York"])
      expect(formatClinicDate("2026-10-29", zone)).toBe("الخميس 29/10/2026");
  });
  it("does not fabricate missing or invalid dates", () => {
    for (const value of ["", "bad"]) expect(formatClinicDate(value, "Asia/Aden")).toBe("—");
  });
});
