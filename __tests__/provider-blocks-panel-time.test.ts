import { describe, expect, it } from "vitest";
import { clinicWallTimeToIso } from "../components/appointments/ProviderBlocksPanel";
import { CLINIC_ZONE_FALLBACK } from "../lib/clinicZone";

describe("provider block panel: clinic wall time to instant", () => {
  it("converts the clinic's wall clock (Asia/Aden, UTC+3) and round-trips through the zone", () => {
    expect(CLINIC_ZONE_FALLBACK).toBe("Asia/Aden");
    expect(clinicWallTimeToIso("2031-03-10", "09:00")).toBe("2031-03-10T06:00:00.000Z");
    expect(clinicWallTimeToIso("2031-03-10", "00:30")).toBe("2031-03-09T21:30:00.000Z");
    const back = new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_ZONE_FALLBACK, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(clinicWallTimeToIso("2031-12-31", "23:45")));
    expect(back).toBe("2031-12-31, 23:45");
  });
});
