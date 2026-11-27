import { describe, expect, it } from "vitest";
import { patientTimelineDateTimeParts } from "../lib/patient-timeline-display-clock";

const eveningUtc = "2026-11-17T21:30:00.000Z";

describe("ordinary patient timeline display clock", () => {
  it.each(["visit", "plan", "invoice", "payment", "lab", "document", "diagnosis", "referral"])(
    "labels the saved %s instant on the following clinic day, without mutating the event",
    (kind) => {
      const event = Object.freeze({ kind, at: eveningUtc });
      expect(patientTimelineDateTimeParts(event, "Asia/Aden")).toEqual({ date: "2026-11-18", time: "00:30" });
      expect(event.at).toBe(eveningUtc);
    },
  );
  it("honors the already configured summary zone and explicit instant offsets", () => {
    expect(patientTimelineDateTimeParts({ kind: "invoice", at: eveningUtc }, "America/New_York"))
      .toEqual({ date: "2026-11-17", time: "16:30" });
    expect(patientTimelineDateTimeParts({ kind: "document", at: "2026-11-18T00:30:00+03:00" }, "UTC"))
      .toEqual({ date: "2026-11-17", time: "21:30" });
  });
  it("keeps existing civil-time and ortho labels and does not infer a source zone", () => {
    expect(patientTimelineDateTimeParts({ kind: "appointment", at: "2026-11-17T21:30:00" }, "Asia/Aden"))
      .toEqual({ date: "2026-11-17", time: "21:30" });
    for (const kind of ["ortho", "unknown-future-kind"]) {
      expect(patientTimelineDateTimeParts({ kind, at: eveningUtc }, "Asia/Aden"))
        .toEqual({ date: "2026-11-17", time: "21:30" });
    }
    expect(patientTimelineDateTimeParts({ kind: "visit", at: "2026-11-17T21:30:00" }, "Asia/Aden"))
      .toEqual({ date: "2026-11-17", time: "21:30" });
    expect(patientTimelineDateTimeParts({ kind: "visit", at: "2026-11-17" }, "Asia/Aden"))
      .toEqual({ date: "2026-11-17", time: "" });
  });
  it("falls back to the existing clinic default if the setting is not yet available or is invalid", () => {
    const event = { kind: "visit", at: eveningUtc };
    expect(patientTimelineDateTimeParts(event)).toEqual({ date: "2026-11-18", time: "00:30" });
    expect(patientTimelineDateTimeParts(event, "Invalid/Synthetic")).toEqual({ date: "2026-11-18", time: "00:30" });
  });
});
