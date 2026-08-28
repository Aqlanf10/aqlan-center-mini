import { describe, expect, it } from "vitest";

import { ALLOWED_TRANSITIONS } from "@/server/appointments/transitions";

const ALL_STATUSES = [
  "SCHEDULED",
  "CONFIRMED",
  "ARRIVED",
  "IN_TREATMENT",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;

describe("ALLOWED_TRANSITIONS state machine", () => {
  it("allows the happy path SCHEDULED → … → COMPLETED", () => {
    expect(ALLOWED_TRANSITIONS.SCHEDULED).toContain("CONFIRMED");
    expect(ALLOWED_TRANSITIONS.CONFIRMED).toContain("ARRIVED");
    expect(ALLOWED_TRANSITIONS.ARRIVED).toContain("IN_TREATMENT");
    expect(ALLOWED_TRANSITIONS.IN_TREATMENT).toContain("COMPLETED");
  });

  it("allows skipping confirmation (walk-in: SCHEDULED → ARRIVED)", () => {
    expect(ALLOWED_TRANSITIONS.SCHEDULED).toContain("ARRIVED");
  });

  it("COMPLETED is terminal (no COMPLETED → ARRIVED etc.)", () => {
    expect(ALLOWED_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it("CANCELLED is terminal (no CANCELLED → IN_TREATMENT)", () => {
    expect(ALLOWED_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("NO_SHOW is terminal (no direct NO_SHOW → IN_TREATMENT; resolve via reschedule)", () => {
    expect(ALLOWED_TRANSITIONS.NO_SHOW).toEqual([]);
  });

  it("IN_TREATMENT cannot go back to ARRIVED or CONFIRMED", () => {
    expect(ALLOWED_TRANSITIONS.IN_TREATMENT).not.toContain("ARRIVED");
    expect(ALLOWED_TRANSITIONS.IN_TREATMENT).not.toContain("CONFIRMED");
    expect(ALLOWED_TRANSITIONS.IN_TREATMENT).not.toContain("NO_SHOW");
  });

  it("covers every appointment status", () => {
    for (const status of ALL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
  });
});
