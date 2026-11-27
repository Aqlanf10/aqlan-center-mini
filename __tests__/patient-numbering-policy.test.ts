import { describe, expect, it } from "vitest";
import {
  parseNumberingRequest,
  parseCanonicalPatientNumber,
  planPatientNumbering,
  PATIENT_NUMBER_MAX,
  type PrefixSnapshot,
} from "../lib/patient-numbering-policy";

const fresh = (prefix = "A"): PrefixSnapshot => ({
  prefix,
  allocatedThrough: 0n,
  pendingNext: null,
  historicalThrough: 0n,
  historyComplete: true,
  revision: "synthetic-r1",
});
const plan = (next: string, s = fresh(), revision = s.revision) =>
  planPatientNumbering({ prefix: s.prefix, next }, s, revision);

describe("source-only patient numbering policy; no authority or DB mutation", () => {
  it("normalizes 1-6 ASCII letters (including BRW) and previews the exact positive start", () => {
    expect(parseNumberingRequest(" a ", "37")).toEqual({ prefix: "A", next: "37" });
    expect(parseNumberingRequest(" brw ", "1500")).toEqual({ prefix: "BRW", next: "1500" });
    expect(plan("37")).toMatchObject({ ok: true, preview: "A-00037" });
    expect(plan("1500", fresh("BRW"))).toMatchObject({ ok: true, preview: "BRW-01500" });
    expect(plan("8200")).toMatchObject({ ok: true, preview: "A-08200" });
    expect(plan("100000")).toMatchObject({ ok: true, preview: "A-100000" });
  });

  it.each(["0", "-1", "+1", "1.1", "1e3", "01", "١٢", "9007199254740993.0", "9223372036854775808"])(
    "rejects invalid numeric input %s",
    (n) => {
      expect(parseNumberingRequest("A", n)).toBeNull();
    },
  );

  it.each(["ABCDEFG", "A1", "Å", "Ａ", "ا", "", "A-", "ſ", "ı", "bß", "ﬃ"])(
    "rejects invalid prefix %s",
    (p) => expect(parseNumberingRequest(p, "1")).toBeNull(),
  );

  it("keeps bigint precision and enforces portal-compatible bounds", () => {
    expect(plan("9007199254740993")).toMatchObject({ ok: true, preview: "A-9007199254740993" });
    expect(plan(PATIENT_NUMBER_MAX.toString())).toMatchObject({ ok: true });
  });

  it("preserves legacy P allocated high-water despite deleted rows", () => {
    expect(plan("7000", { ...fresh("P"), allocatedThrough: 900000n })).toEqual({
      ok: false,
      reason: "would-reuse-or-rewind",
    });
    expect(plan("900001", { ...fresh("P"), allocatedThrough: 900000n })).toMatchObject({ ok: true });
  });

  it("preserves a pending value across repeated planning without consuming it", () => {
    const s = { ...fresh("P"), pendingNext: 7000n };
    expect(plan("6999", s).ok).toBe(false);
    expect(plan("7000", s)).toEqual(plan("7000", s));
    expect(s.pendingNext).toBe(7000n);
  });

  it("fresh prefix can start low, used prefix cannot rewind on return", () => {
    expect(plan("1", fresh("BRW")).ok).toBe(true);
    expect(plan("1500", { ...fresh("BRW"), allocatedThrough: 1502n }).ok).toBe(false);
  });

  it("historical canonical number counts even without a counter", () => {
    expect(plan("50", { ...fresh("A"), historicalThrough: 50n }).ok).toBe(false);
    expect(parseCanonicalPatientNumber("A-00050")).toEqual({ prefix: "A", number: 50n });
    expect(parseCanonicalPatientNumber("BRW-01500")).toEqual({ prefix: "BRW", number: 1500n });
  });

  it("does not turn external import metadata or ambiguous identifiers into canonical records", () => {
    for (const value of ["external A-900000", "900000", "A-1", "a-00001", "A-000001", "P-00000", "brw-01500"]) {
      expect(parseCanonicalPatientNumber(value)).toBeNull();
    }
    expect(plan("1", { ...fresh(), historyComplete: false })).toEqual({ ok: false, reason: "history-unverified" });
  });

  it("rejects non-string stored identifiers instead of coercing them into history", () => {
    for (const value of [["P-07000"], { toString: () => "P-07000" }, null, undefined, 7000]) {
      expect(parseCanonicalPatientNumber(value)).toBeNull();
    }
    expect(parseCanonicalPatientNumber("P-07000")).toEqual({ prefix: "P", number: 7000n });
  });

  it("rejects stale preview after concurrent allocator or configuration revision", () => {
    expect(plan("38", { ...fresh(), revision: "synthetic-r2", allocatedThrough: 37n }, "synthetic-r1")).toEqual({
      ok: false,
      reason: "stale-preview",
    });
  });

  it("rejects mismatched prefix state and invalid snapshots", () => {
    expect(planPatientNumbering({ prefix: "B", next: "1" }, fresh("A"), "synthetic-r1").ok).toBe(false);
    expect(plan("1", { ...fresh(), allocatedThrough: -1n }).ok).toBe(false);
  });

  it.each(["false", 1, {}, null, undefined])("rejects nonboolean reconciliation evidence %j", (value) => {
    const s = { ...fresh("P"), historyComplete: value } as unknown as PrefixSnapshot;
    expect(plan("7000", s)).toEqual({ ok: false, reason: "history-unverified" });
  });

  it.each([
    ["allocatedThrough", "9000"],
    ["historicalThrough", NaN],
    ["allocatedThrough", undefined],
    ["historicalThrough", 9000],
    ["pendingNext", "7000"],
    ["pendingNext", undefined],
  ])("rejects malformed runtime watermark %s=%j", (field, value) => {
    const s = { ...fresh("P"), [String(field)]: value } as unknown as PrefixSnapshot;
    expect(plan("7000", s)).toEqual({ ok: false, reason: "invalid-snapshot" });
  });

  it.each([" ", "", 7, {}])("rejects invalid runtime revision %j even if expected matches", (value) => {
    const s = { ...fresh("P"), revision: value } as unknown as PrefixSnapshot;
    expect(plan("7000", s)).toEqual({ ok: false, reason: "stale-preview" });
  });

  it("still previews P-07000 then P-07001 without mutating the source snapshot", () => {
    const s = { ...fresh("P"), allocatedThrough: 6999n, historicalThrough: 42n };
    expect(plan("7000", s)).toMatchObject({ ok: true, preview: "P-07000" });
    expect(plan("7001", { ...s, allocatedThrough: 7000n })).toMatchObject({ ok: true, preview: "P-07001" });
    expect(s.allocatedThrough).toBe(6999n);
  });
});
