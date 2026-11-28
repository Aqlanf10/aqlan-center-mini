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

describe("source-only patient numbering policy; multi-letter prefixes & portal bounds", () => {
  it("normalizes 1 to 6 ASCII letters (including P, A, BRW) and previews padded output", () => {
    expect(parseNumberingRequest(" a ", "37")).toEqual({ prefix: "A", next: "37" });
    expect(plan("37")).toMatchObject({ ok: true, preview: "A-00037" });
    expect(plan("8200")).toMatchObject({ ok: true, preview: "A-08200" });
    expect(plan("100000")).toMatchObject({ ok: true, preview: "A-100000" });

    // Owner Charter §14 explicit multi-letter prefix example: BRW-07429
    expect(parseNumberingRequest(" brw ", "7429")).toEqual({ prefix: "BRW", next: "7429" });
    expect(plan("7429", fresh("BRW"))).toMatchObject({ ok: true, prefix: "BRW", next: "7429", preview: "BRW-07429" });
    expect(parseCanonicalPatientNumber("BRW-07429")).toEqual({ prefix: "BRW", number: 7429n });
  });

  it.each(["0", "-1", "+1", "1.1", "1e3", "01", "١٫٢", "١e٢", "０１", "9007199254740993.0", "9223372036854775808"])(
    "rejects invalid numeric input %s",
    (n) => {
      expect(parseNumberingRequest("A", n)).toBeNull();
    },
  );

  it.each(["ABCDEFG", "A1", "BRW1", "ß", "ſ", "ı", "Å", "Ａ", "ا", "", "A-", "BR-W"])(
    "rejects invalid prefix %s",
    (p) => expect(parseNumberingRequest(p, "1")).toBeNull(),
  );

  it("keeps bigint precision and enforces 20-character portal-compatible bounds", () => {
    expect(plan("9007199254740993")).toMatchObject({ ok: true, preview: "A-9007199254740993" });
    expect(plan(PATIENT_NUMBER_MAX.toString())).toMatchObject({ ok: true });
    // BRW + "-" + 16 digits = 20 chars (allowed); 17 digits = 21 chars (rejected)
    expect(parseNumberingRequest("BRW", "9999999999999999")).toEqual({ prefix: "BRW", next: "9999999999999999" });
    expect(parseNumberingRequest("BRW", "99999999999999999")).toBeNull();
  });

  it("accepts an owner-selected clean P series below the legacy default without allowing reuse", () => {
    expect(parseNumberingRequest("brw", "١٥٠٠")).toEqual({ prefix: "BRW", next: "1500" });
    expect(plan("۱۵۰۰", fresh("P"))).toMatchObject({ ok: true, next: "1500", preview: "P-01500" });
    expect(plan("1500", { ...fresh("P"), allocatedThrough: 1500n })).toMatchObject({ ok: false, reason: "would-reuse-or-rewind" });
    expect(plan("1500", { ...fresh("P"), historicalThrough: 1700n })).toMatchObject({ ok: false, reason: "would-reuse-or-rewind" });
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
    expect(plan("1", fresh("B")).ok).toBe(true);
    expect(plan("1", { ...fresh("B"), allocatedThrough: 37n }).ok).toBe(false);
    expect(plan("7428", { ...fresh("BRW"), allocatedThrough: 7429n }).ok).toBe(false);
    expect(plan("7430", { ...fresh("BRW"), allocatedThrough: 7429n })).toMatchObject({ ok: true, preview: "BRW-07430" });
  });

  it("historical canonical number counts even without a counter", () => {
    expect(plan("50", { ...fresh("A"), historicalThrough: 50n }).ok).toBe(false);
    expect(parseCanonicalPatientNumber("A-00050")).toEqual({ prefix: "A", number: 50n });
  });

  it("does not turn external import metadata or ambiguous identifiers into canonical records", () => {
    for (const value of ["external A-900000", "900000", "A-1", "a-00001", "A-000001", "P-00000", "brw-07429"]) {
      expect(parseCanonicalPatientNumber(value)).toBeNull();
    }
    expect(plan("1", { ...fresh(), historyComplete: false })).toEqual({ ok: false, reason: "history-unverified" });
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
});
