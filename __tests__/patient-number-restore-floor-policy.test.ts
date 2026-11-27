import { describe, expect, it } from "vitest";
import { PATIENT_NUMBER_MAX, type PrefixSnapshot } from "../lib/patient-numbering-policy";
import { planRestoredNumberingFloor, type IndependentNumberingWatermark } from "../lib/restore/numbering-floor-policy";

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

describe("restore numbering floor (planning only, no storage or cutover)", () => {
  it("plans P-07030 after restoring an archive ending at P-07027", () => {
    expect(planRestoredNumberingFloor(archive, binding, witness)).toMatchObject({
      ok: true,
      next: "7030",
      preview: "P-07030",
    });
  });

  it("plans BRW-01503 after restoring an archive ending at BRW-01500 when 1501 committed and 1502 rolled back", () => {
    const brwArchive: PrefixSnapshot = {
      prefix: "BRW",
      allocatedThrough: 1500n,
      historicalThrough: 1500n,
      pendingNext: null,
      historyComplete: true,
      revision: "synthetic-brw-r1",
    };
    const brwWitness: IndependentNumberingWatermark = {
      ...binding,
      prefix: "BRW",
      reservedThrough: 1502n,
    };
    expect(planRestoredNumberingFloor(brwArchive, binding, brwWitness)).toMatchObject({
      ok: true,
      prefix: "BRW",
      next: "1503",
      preview: "BRW-01503",
    });
  });

  it("skips numbers reserved before a crash even if no patient row exists", () => {
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: 7100n })).toMatchObject({
      ok: true,
      next: "7101",
    });
  });

  it("does not lower an unissued pending floor", () => {
    expect(planRestoredNumberingFloor({ ...archive, pendingNext: 7200n }, binding, witness)).toMatchObject({
      ok: true,
      next: "7200",
    });
  });

  it("starts at 7000 when that number was pending and no higher number was reserved", () => {
    expect(
      planRestoredNumberingFloor(
        { ...archive, allocatedThrough: 42n, historicalThrough: 42n, pendingNext: 7000n },
        binding,
        { ...witness, reservedThrough: 42n },
      ),
    ).toMatchObject({ ok: true, preview: "P-07000" });
  });

  it("does not accept missing evidence", () => {
    expect(planRestoredNumberingFloor(archive, binding, null)).toEqual({
      ok: false,
      reason: "independent-watermark-unavailable",
    });
  });

  it.each([
    { ...witness, lineage: "synthetic_lineage_999" },
    { ...witness, generation: "synthetic_generation_001" },
    { ...witness, prefix: "BRW" },
  ])("rejects incorrect lineage, generation or prefix", (wrong) => {
    expect(planRestoredNumberingFloor(archive, binding, wrong)).toEqual({
      ok: false,
      reason: "watermark-binding-mismatch",
    });
  });

  it("rejects evidence behind historical rows or allocated counter", () => {
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: 7026n })).toEqual({
      ok: false,
      reason: "watermark-behind-archive",
    });
    expect(planRestoredNumberingFloor({ ...archive, historicalThrough: 7030n }, binding, witness)).toEqual({
      ok: false,
      reason: "watermark-behind-archive",
    });
  });

  it("rejects unreconciled history", () => {
    expect(planRestoredNumberingFloor({ ...archive, historyComplete: false }, binding, witness)).toEqual({
      ok: false,
      reason: "history-unverified",
    });
  });

  it.each(["false", "true", 1, undefined, null])("rejects non-boolean history evidence %s", (value) => {
    const malformed = { ...archive, historyComplete: value } as unknown as PrefixSnapshot;
    expect(planRestoredNumberingFloor(malformed, binding, witness)).toEqual({
      ok: false,
      reason: "history-unverified",
    });
  });

  it.each([123, true, " ", "", null, undefined])("rejects malformed archive revision %s", (value) => {
    const malformed = { ...archive, revision: value } as unknown as PrefixSnapshot;
    expect(planRestoredNumberingFloor(malformed, binding, witness).ok).toBe(false);
  });

  it("rejects exhausted numbers and preserves integer precision", () => {
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: PATIENT_NUMBER_MAX })).toEqual({
      ok: false,
      reason: "numbering-exhausted",
    });
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: 9007199254740993n })).toMatchObject(
      { ok: true, next: "9007199254740994" },
    );
  });

  it("rejects negative, out-of-bounds or zero pending state", () => {
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: -1n }).ok).toBe(false);
    expect(planRestoredNumberingFloor(archive, binding, { ...witness, reservedThrough: PATIENT_NUMBER_MAX + 1n }).ok).toBe(
      false,
    );
    expect(planRestoredNumberingFloor({ ...archive, pendingNext: 0n }, binding, witness).ok).toBe(false);
  });
});
