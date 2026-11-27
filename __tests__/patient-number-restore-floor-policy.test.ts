import { describe, expect, it } from "vitest";
import { PATIENT_NUMBER_MAX, type PrefixSnapshot } from "../lib/patient-numbering-policy";
import { planRestoredNumberingFloor, type IndependentNumberingWatermark } from "../lib/restore/numbering-floor-policy";
import { reserveRestoredNumber, type IndependentReservationBackend } from "../lib/restore/numbering-reservation";

const archive: PrefixSnapshot = {
  prefix: "P",
  allocatedThrough: 7027n,
  historicalThrough: 7027n,
  pendingNext: null,
  historyComplete: true,
  revision: "synthetic-r1",
};
const binding = { lineage: "synthetic_lineage_001", generation: "synthetic_generation_002" };
const witness: IndependentNumberingWatermark = { ...binding, prefix: "P", reservedThrough: 7029n };

describe("restore numbering floor & independent reservation (#602 + multi-letter BRW)", () => {
  it("plans P-07030 after restoring an archive ending at P-07027 when witness is at 7029", () => {
    expect(planRestoredNumberingFloor(archive, binding, witness)).toMatchObject({
      ok: true,
      next: "7030",
      preview: "P-07030",
    });
  });

  it("supports multi-letter prefix BRW-07430 across independent watermark reservation", async () => {
    const brwArchive: PrefixSnapshot = {
      prefix: "BRW",
      allocatedThrough: 7428n,
      historicalThrough: 7428n,
      pendingNext: null,
      historyComplete: true,
      revision: "synthetic-brw-r1",
    };
    let current = 7429n;
    const backend: IndependentReservationBackend = {
      async transaction(b, work) {
        return work({
          async readFresh(prefix) {
            return { ...b, prefix, reservedThrough: current };
          },
          async advance(prev, next) {
            if (prev.reservedThrough !== current || next <= current) return false;
            current = next;
            return true;
          },
        });
      },
    };
    expect(await reserveRestoredNumber(brwArchive, binding, backend)).toEqual({
      ok: true,
      reserved: "7430",
      prefix: "BRW",
    });
    expect(current).toBe(7430n);
  });

  it("fails closed on missing witness, stale witness, binding mismatch, or exhaustion", () => {
    expect(planRestoredNumberingFloor(archive, binding, null)).toEqual({
      ok: false,
      reason: "independent-watermark-unavailable",
    });
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: 7026n })).toEqual({
      ok: false,
      reason: "watermark-behind-archive",
    });
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, generation: "wrong_generation_001" })).toEqual({
      ok: false,
      reason: "watermark-binding-mismatch",
    });
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: PATIENT_NUMBER_MAX })).toEqual({
      ok: false,
      reason: "numbering-exhausted",
    });
  });
});
