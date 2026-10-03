import { describe, expect, it } from "vitest";
import { canSign } from "../lib/clinical";
import { canonicalPerioSites, changedPerioSites, checkPerioAddendum, checkPerioDraft, checkPerioRevision, hasMeaningfulPerio, samePerioDraft, summarizePerio, validProbingDepth, type PerioObservation } from "../lib/periodontics";
const site = (change: Partial<PerioObservation> = {}): PerioObservation => ({ toothCode: 11, site: "MB", probingDepthMm: null, bleedingOnProbing: null, ...change });
const draft = { doctorId: 1, caseId: null, sites: [site()] };
describe("periodontal capture without inferred diagnosis", () => {
  it.each([null, 0, 0.01, 0.29, 1.01, 5.55, 99.99])("preserves valid millimetre value %s", (value) => expect(validProbingDepth(value)).toBe(true));
  it.each([undefined, "", "0", "4.2", false, true, {}, NaN, Infinity, -Infinity, -0.1, 100, 0.001, 1.111, 99.999, 1e-8])("rejects coercion, excess precision or out-of-range value %s", (value) => expect(validProbingDepth(value)).toBe(false));
  it("requires explicit context and tri-state values", () => {
    expect(checkPerioDraft(draft)).toEqual({ ok: true, value: draft });
    for (const change of [{ doctorId: null }, { doctorId: "1" }, { caseId: undefined }, { caseId: "1" }, { sites: undefined }, { sites: {} }]) expect(checkPerioDraft({ ...draft, ...change }).ok).toBe(false);
    for (const change of [{ probingDepthMm: undefined }, { bleedingOnProbing: undefined }, { bleedingOnProbing: 0 }, { bleedingOnProbing: "false" }, { toothCode: 19 }, { toothCode: 56 }, { site: "M" }]) expect(checkPerioDraft({ ...draft, sites: [{ ...site(), ...change }] }).ok).toBe(false);
    expect(checkPerioDraft({ ...draft, sites: [site(), site()] }).ok).toBe(false);
  });
  it("accepts permanent and primary FDI sites, preserving numeric zero and negative BOP", () => {
    const input = { ...draft, sites: [site({ toothCode: 55, site: "DL", probingDepthMm: 0, bleedingOnProbing: false })] };
    expect(checkPerioDraft(input)).toEqual({ ok: true, value: input });
  });
  it("counts PD and BOP independently; absence is never a healthy or negative result", () => {
    expect(summarizePerio([])).toEqual({ recordedDepthSites: 0, recordedBleedingSites: 0, bleedingSites: 0, bleedingPercent: null });
    expect(summarizePerio([site({ probingDepthMm: 0 }), site({ bleedingOnProbing: false }), site({ bleedingOnProbing: true })]))
      .toEqual({ recordedDepthSites: 1, recordedBleedingSites: 2, bleedingSites: 1, bleedingPercent: 50 });
    expect(summarizePerio([site({ bleedingOnProbing: false })]).bleedingPercent).toBe(0);
    expect(hasMeaningfulPerio([site()])).toBe(false);
    expect(hasMeaningfulPerio([site({ probingDepthMm: 0 })])).toBe(true);
    expect(hasMeaningfulPerio([site({ bleedingOnProbing: false })])).toBe(true);
    expect(Object.keys(summarizePerio([site({ probingDepthMm: 99.99 })]))).not.toContain("severity");
  });
  it("canonicalizes site order without inventing observations", () => {
    const sites = [site({ site: "DL" }), site({ toothCode: 12 }), site()];
    expect(canonicalPerioSites(sites).map((row) => `${row.toothCode}:${row.site}`)).toEqual(["11:MB", "11:DL", "12:MB"]);
    expect(samePerioDraft({ ...draft, sites }, { ...draft, sites: [...sites].reverse() })).toBe(true);
    expect(samePerioDraft(draft, { ...draft, doctorId: 2 })).toBe(false);
    expect(samePerioDraft(draft, { ...draft, sites: [site({ bleedingOnProbing: false })] })).toBe(false);
  });
  it("requires exact numeric revision or explicit create null", () => {
    for (const value of [null, 1, 2]) expect(checkPerioRevision(value).ok).toBe(true);
    for (const value of [undefined, "1", 0, 1.1, NaN, Infinity]) expect(checkPerioRevision(value).ok).toBe(false);
  });
  it("bounds correction text and retry keys without silent truncation", () => {
    expect(checkPerioAddendum({ text: "  correction  ", requestKey: "perio:request-001" })).toEqual({ ok: true, value: { text: "correction", requestKey: "perio:request-001" } });
    for (const input of [{ text: "", requestKey: "perio:request-001" }, { text: "x".repeat(4001), requestKey: "perio:request-001" }, { text: "x", requestKey: "short" }]) expect(checkPerioAddendum(input).ok).toBe(false);
  });
  it("allows recorded periodontal work to sign without a priced procedure", () => {
    const input = { status: "open" as const, procedures: [], diagnosis: null, treatmentDone: null };
    expect(canSign(input).ok).toBe(false);
    expect(canSign({ ...input, hasPerioRecord: true })).toEqual({ ok: true });
    expect(canSign({ ...input, status: "signed", hasPerioRecord: true }).ok).toBe(false);
  });
  it("audits changed values even with equal counts, distinguishing removed rows from explicit null", () => {
    const before = [site({ probingDepthMm: 0, bleedingOnProbing: false }), site({ site: "B", probingDepthMm: 2, bleedingOnProbing: true }), site({ site: "DB" })];
    const after = [site({ probingDepthMm: 1, bleedingOnProbing: false }), site({ site: "B" }), site({ site: "DL", probingDepthMm: 0, bleedingOnProbing: true })];
    expect(summarizePerio(before)).toEqual(summarizePerio(after));
    expect(changedPerioSites(before, after)).toEqual([
      { toothCode: 11, site: "MB", before: { probingDepthMm: 0, bleedingOnProbing: false }, after: { probingDepthMm: 1, bleedingOnProbing: false } },
      { toothCode: 11, site: "B", before: { probingDepthMm: 2, bleedingOnProbing: true }, after: { probingDepthMm: null, bleedingOnProbing: null } },
      { toothCode: 11, site: "DB", before: { probingDepthMm: null, bleedingOnProbing: null }, after: null },
      { toothCode: 11, site: "DL", before: null, after: { probingDepthMm: 0, bleedingOnProbing: true } },
    ]);
    expect(changedPerioSites(after, [...after].reverse())).toEqual([]);
  });
});
