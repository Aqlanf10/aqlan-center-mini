import { describe, expect, it } from "vitest";
import type { PrefixSnapshot } from "../lib/patient-numbering-policy";
import type { IndependentNumberingWatermark } from "../lib/restore/numbering-floor-policy";
import { reserveRestoredNumber, type IndependentReservationBackend, type IndependentReservationTransaction } from "../lib/restore/numbering-reservation";

const archive: PrefixSnapshot = {
  prefix: "P", allocatedThrough: 7027n, historicalThrough: 7027n,
  pendingNext: null, historyComplete: true, revision: "synthetic-r1",
};
const binding = { lineage: "synthetic_lineage_001", generation: "synthetic_generation_002" };

/** Synthetic model of a serial, independently committed store. Not durable. */
function model(initial: IndependentNumberingWatermark | null) {
  let watermark = initial, tail: Promise<void> = Promise.resolve();
  let conflict = false, loseResponse = false, writes = 0;
  const backend: IndependentReservationBackend = {
    async transaction<T>(expected: typeof binding, work: (tx: IndependentReservationTransaction) => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        if (watermark && (watermark.lineage !== expected.lineage || watermark.generation !== expected.generation)) {
          throw new Error("fenced");
        }
        let staged = watermark;
        const result = await work({
          readFresh: async () => staged,
          advance: async (prior, next) => {
            if (conflict || prior !== staged || next <= prior.reservedThrough) return false;
            staged = { ...prior, reservedThrough: next };
            return true;
          },
        });
        if (staged !== watermark) { watermark = staged; writes++; }
        if (loseResponse) { loseResponse = false; throw new Error("lost commit response"); }
        return result;
      } finally { release(); }
    },
  };
  return { backend, watermark: () => watermark, writes: () => writes,
    conflict: () => { conflict = true; }, loseResponse: () => { loseResponse = true; } };
}
const initial = (): IndependentNumberingWatermark => ({ ...binding, prefix: "P", reservedThrough: 7029n });

describe("independent reservation contract (synthetic model only)", () => {
  it("serializes concurrent reservations above restored and external high-water", async () => {
    const store = model(initial());
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      reserveRestoredNumber(archive, binding, store.backend)));
    expect(results).toEqual(["7030", "7031", "7032"].map(reserved => ({ ok: true, prefix: "P", reserved })));
    expect(store.watermark()?.reservedThrough).toBe(7032n);
  });
  it("does not expose a number on an ambiguous commit and never retries that number", async () => {
    const store = model(initial());
    store.loseResponse();
    expect(await reserveRestoredNumber(archive, binding, store.backend))
      .toEqual({ ok: false, reason: "watermark-reservation-unconfirmed" });
    expect(store.watermark()?.reservedThrough).toBe(7030n);
    expect(await reserveRestoredNumber(archive, binding, store.backend))
      .toEqual({ ok: true, prefix: "P", reserved: "7031" });
  });
  it("does not expose a number or advance on CAS conflict", async () => {
    const store = model(initial()); store.conflict();
    expect(await reserveRestoredNumber(archive, binding, store.backend))
      .toEqual({ ok: false, reason: "watermark-reservation-conflict" });
    expect(store.writes()).toBe(0);
  });
  it("fails closed without a backend or watermark", async () => {
    expect(await reserveRestoredNumber(archive, binding, null))
      .toEqual({ ok: false, reason: "independent-reservation-unavailable" });
    const store = model(null);
    expect(await reserveRestoredNumber(archive, binding, store.backend))
      .toEqual({ ok: false, reason: "independent-watermark-unavailable" });
    expect(store.writes()).toBe(0);
  });
  it("does not advance for an old generation", async () => {
    const store = model(initial());
    expect(await reserveRestoredNumber(archive, { ...binding, generation: "synthetic_generation_001" }, store.backend))
      .toEqual({ ok: false, reason: "watermark-reservation-unconfirmed" });
    expect(store.writes()).toBe(0);
  });
  it("honors the pending 7000 floor with no earlier reservation above it", async () => {
    const store = model({ ...initial(), reservedThrough: 42n });
    const start = { ...archive, allocatedThrough: 42n, historicalThrough: 42n, pendingNext: 7000n };
    expect(await reserveRestoredNumber(start, binding, store.backend))
      .toEqual({ ok: true, prefix: "P", reserved: "7000" });
    expect(await reserveRestoredNumber(start, binding, store.backend))
      .toEqual({ ok: true, prefix: "P", reserved: "7001" });
  });
});
