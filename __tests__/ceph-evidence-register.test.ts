/** C0 contract: every legacy cephalometric measurement has an evidence record; nothing unverified is presented
 * as a norm; the known definition defects are recorded; verified norms carry population, stratum, table and the
 * enlargement convention. Record-only — no calculation is exercised here. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CEPH_REFERENCES } from "../lib/ceph-evidence/references";
import { MEASUREMENT_EVIDENCE } from "../lib/ceph-evidence/measurement-register";

const legacySource = readFileSync(new URL("../lib/ceph.ts", import.meta.url), "utf8");
const legacyCodes = [...legacySource.matchAll(/^\s+\{ code: "([A-Z0-9_]+)",.*group: "[a-zA-Z]+"/gm)].map(match => match[1]);
const byCode = new Map(MEASUREMENT_EVIDENCE.map(entry => [entry.code, entry]));
const referenceIds = new Set<string>(CEPH_REFERENCES.map(reference => reference.id));

describe("C0 cephalometric evidence register", () => {
  it("covers every legacy measurement exactly once, and nothing that is not one", () => {
    expect(legacyCodes.length).toBe(49);
    expect([...byCode.keys()].sort()).toEqual([...legacyCodes].sort());
    expect(MEASUREMENT_EVIDENCE).toHaveLength(byCode.size);
  });

  it("cites only references that are in the reference list, each with a stated access level", () => {
    for (const entry of MEASUREMENT_EVIDENCE) for (const id of entry.references) expect(referenceIds.has(id), `${entry.code} → ${id}`).toBe(true);
    for (const reference of CEPH_REFERENCES) expect(["full-text", "abstract", "citation-only", "unlocated"]).toContain(reference.access);
  });

  it("takes verified norms only from a source that was read in full, with population, stratum, table and enlargement", () => {
    for (const entry of MEASUREMENT_EVIDENCE) for (const norm of entry.verifiedNorms ?? []) {
      expect(CEPH_REFERENCES.find(reference => reference.id === norm.reference)?.access, entry.code).toBe("full-text");
      expect(norm.population.length).toBeGreaterThan(10);
      expect(norm.stratum.length).toBeGreaterThan(3);
      expect(norm.table).toMatch(/Table/);
      expect(typeof norm.includesEnlargement).toBe("boolean");
    }
  });

  it("never marks a legacy default as verified: it is unverified, contradicted, or not a population norm", () => {
    for (const entry of MEASUREMENT_EVIDENCE) expect(["unverified", "conflicts-source", "not-a-population-norm"]).toContain(entry.norm);
  });

  it("records the definition defects found in the legacy formulas", () => {
    expect(byCode.get("SNGOGN")).toMatchObject({ definition: "conflicts-source" });
    expect(byCode.get("SNGOGN")!.findings.join(" ")).toMatch(/Go–Me/);
    expect(legacySource).toMatch(/code: "SNGOGN".*needs: \["S", "N", "Me", "Go"\]/);
    const wits = byCode.get("WITS")!;
    expect(wits.definition).toBe("conflicts-source");
    expect(wits.findings.join(" ")).toMatch(/NaN instead of 0/);
    expect(wits.findings.join(" ")).toMatch(/mirrored image can reverse the sign/);
    expect(byCode.get("LAFH")).toMatchObject({ definition: "conflicts-source", norm: "conflicts-source" });
    expect(byCode.get("FMIA")).toMatchObject({ norm: "not-a-population-norm" });
  });

  it("keeps the legacy Wits defects visible in the code they describe (so the record cannot drift silently)", () => {
    const wits = legacySource.slice(legacySource.indexOf('case "WITS": {'), legacySource.indexOf('case "CONV": {'));
    expect(wits).toContain("if (dir.x < 0)");
    expect(wits).toContain("if (len === 0) return NaN;");
  });

  it("does not rely on commercial software as a source", () => {
    for (const reference of CEPH_REFERENCES) expect(reference.citation).not.toMatch(/WebCeph|Dolphin|OrisCeph/i);
    for (const code of ["OVERJET", "OVERBITE"]) expect(byCode.get(code)!.references).toEqual([]);
  });
});
