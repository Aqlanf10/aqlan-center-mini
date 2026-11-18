/** C2 — every missing value says why; values that the legacy formula only partly measured are flagged; the
 * legacy value itself is never changed. Synthetic landmarks only (a hand-placed profile, face to +x, y down). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEASUREMENTS, measure, type LandmarkCode, type LandmarkMap } from "../lib/ceph";
import { availabilityMessageAr, explainAll, explainMeasurement } from "../lib/ceph-availability";

const L: LandmarkMap = {
  S: { x: 300, y: 300 }, N: { x: 560, y: 260 }, Or: { x: 520, y: 330 }, Po: { x: 250, y: 350 }, A: { x: 580, y: 470 },
  B: { x: 560, y: 620 }, Pog: { x: 565, y: 680 }, Me: { x: 540, y: 720 }, Gn: { x: 560, y: 705 }, Go: { x: 330, y: 640 },
  U1A: { x: 540, y: 460 }, U1: { x: 590, y: 560 }, L1A: { x: 530, y: 650 }, L1: { x: 585, y: 550 }, OcclA: { x: 590, y: 555 },
  OcclP: { x: 400, y: 540 }, D: { x: 550, y: 660 }, Co: { x: 280, y: 380 }, ANS: { x: 600, y: 430 }, PNS: { x: 380, y: 440 },
  Prn: { x: 680, y: 420 }, Sn: { x: 630, y: 470 }, Ls: { x: 640, y: 530 }, Li: { x: 630, y: 600 }, PogS: { x: 615, y: 700 },
  Ar: { x: 290, y: 420 }, Ba: { x: 260, y: 470 },
};
const SCALE = 0.1;
const without = (map: LandmarkMap, ...codes: string[]): LandmarkMap => {
  const next = { ...map } as Record<string, unknown>;
  for (const code of codes) delete next[code];
  return next as LandmarkMap;
};
const codes = Object.keys(L) as LandmarkCode[];
const legacySource = readFileSync(new URL("../lib/ceph.ts", import.meta.url), "utf8");

describe("C2 availability never contradicts the legacy value", () => {
  it("on the full synthetic profile every measurement is computed, with exactly the legacy value", () => {
    for (const def of MEASUREMENTS) {
      const a = explainMeasurement(def.code, L, SCALE);
      expect(a.status, def.code).toBe("measured");
      expect(a.status === "measured" && a.value).toBe(measure(def.code, L, SCALE));
    }
  });

  it("for every single missing landmark and with or without a scale: a number iff the legacy gives one, the same number, else a reason", () => {
    for (const scale of [SCALE, Number.NaN]) for (const gone of [null, ...codes]) {
      const map = gone ? without(L, gone) : L;
      for (const def of MEASUREMENTS) {
        const legacy = measure(def.code, map, scale);
        const a = explainMeasurement(def.code, map, scale);
        if (Number.isFinite(legacy)) expect(a.status !== "not-computable" && a.value, `${def.code} −${gone}`).toBe(legacy);
        else {
          expect(a.status, `${def.code} −${gone}`).toBe("not-computable");
          expect(availabilityMessageAr(a)).toBeTruthy();
        }
      }
    }
  });
});

describe("C2 reasons", () => {
  it("names exactly the missing landmarks", () => {
    expect(explainMeasurement("ANB", without(L, "A", "B"), SCALE)).toEqual({ status: "not-computable", reason: "missing-landmarks", missing: ["A", "B"] });
    expect(availabilityMessageAr(explainMeasurement("ANB", without(L, "A"), SCALE))).toBe("نقاط ناقصة: A.");
  });

  it("asks for calibration only for measurements whose legacy formula needs the scale", () => {
    const all = explainAll(L, Number.NaN);
    for (const def of MEASUREMENTS) {
      const a = all.get(def.code)!;
      if (def.unit === "°" || def.unit === "") expect(a.status, def.code).not.toBe("not-computable");
      else expect(a, def.code).toEqual({ status: "not-computable", reason: "missing-calibration" });
    }
    // Recorded quirk: the two ratios (%) also require the scale in the legacy formula.
    expect(MEASUREMENTS.filter((d) => d.unit === "%").map((d) => all.get(d.code))).toEqual([
      { status: "not-computable", reason: "missing-calibration" }, { status: "not-computable", reason: "missing-calibration" }]);
  });

  it("reports invalid coordinates instead of computing on them", () => {
    expect(explainMeasurement("SNA", { ...L, S: { x: Number.NaN, y: 1 } }, SCALE)).toEqual({ status: "not-computable", reason: "invalid-landmark-coordinates", invalid: ["S"] });
  });

  it("reports degenerate geometry (coincident points) rather than a number", () => {
    expect(explainMeasurement("SNA", { ...L, S: L.N }, SCALE)).toEqual({ status: "not-computable", reason: "degenerate-geometry" });
  });

  it("rejects an unknown measurement code", () => {
    expect(explainMeasurement("NOPE", L, SCALE)).toEqual({ status: "not-computable", reason: "unknown-measurement" });
  });

  it("a not-computable message never contains a measured number (landmark names like U1A aside)", () => {
    const names = new RegExp(codes.join("|"), "g");
    for (const gone of codes) for (const [code, a] of explainAll(without(L, gone), Number.NaN)) {
      if (a.status === "not-computable") expect(availabilityMessageAr(a)!.replace(names, ""), code).not.toMatch(/\d/);
    }
  });
});

describe("C2 legacy substitutions are flagged, not hidden", () => {
  it("APDI without ANS: the legacy value uses an assumed 3° palatal tilt — kept, but flagged with the missing landmark", () => {
    const map = without(L, "ANS");
    const a = explainMeasurement("APDI", map, SCALE);
    expect(a).toMatchObject({ status: "measured-with-assumption", assumptions: ["palatal-plane-tilt-assumed-3deg"], missing: ["ANS"] });
    expect(a.status !== "not-computable" && a.value).toBe(measure("FH_AB", map, SCALE) + 3);
    for (const code of ["ODI", "CF", "EXT_INDEX"]) expect(explainMeasurement(code, map, SCALE).status, code).toBe("measured-with-assumption");
    expect(availabilityMessageAr(a)).toMatch(/غير مقيسة بالكامل.*3°.*ANS/);
  });

  it("EXT_INDEX without the nasolabial landmarks: neutral adjustment assumed — flagged", () => {
    expect(explainMeasurement("EXT_INDEX", without(L, "Prn"), SCALE)).toMatchObject({
      status: "measured-with-assumption", assumptions: ["nasolabial-adjustment-assumed-zero"], missing: ["Prn"] });
  });

  it("no other measurement silently changes when a landmark it does not declare is missing", () => {
    const flagged = new Set(["APDI", "ODI", "CF", "EXT_INDEX"]);
    for (const def of MEASUREMENTS.filter((d) => !flagged.has(d.code))) for (const gone of codes.filter((c) => !def.needs.includes(c))) {
      expect(measure(def.code, without(L, gone), SCALE), `${def.code} −${gone}`).toBe(measure(def.code, L, SCALE));
    }
  });

  it("pins the substitutions in the legacy source, so the flag list cannot drift from the formulas", () => {
    expect(legacySource.match(/const ppTilt = Number\.isFinite\(pp\) \? pp : 3\.0;/g)).toHaveLength(2);
    expect(legacySource).toContain("const nasoAdj = Number.isFinite(naso) ? (naso - 95) * 0.5 : 0;");
  });
});

describe("C2 in the tracer", () => {
  const tracer = readFileSync(new URL("../components/CephTracer.tsx", import.meta.url), "utf8");
  it("shows the reason under both measurement tables and on the summary card, and computes no replacement value", () => {
    expect(tracer.match(/<CephReason code=\{r\.code\} text=\{reasonFor\(r\.code, activeVal\)\} \/>/g)).toHaveLength(2);
    expect(tracer).toContain("title={reasonFor(r.code, activeVal) ?? undefined}");
    expect(tracer).toContain("explainAll(points, scale ?? NaN)");
    expect(tracer).not.toMatch(/availability\.get\([^)]*\)\??\.value/);
  });

  it("records the legacy substitutions in the C0 evidence register", async () => {
    const { MEASUREMENT_EVIDENCE } = await import("../lib/ceph-evidence/measurement-register");
    for (const code of ["APDI", "ODI", "CF", "EXT_INDEX"]) {
      expect(MEASUREMENT_EVIDENCE.find((e) => e.code === code)!.findings.join(" "), code).toMatch(/fixed 3° palatal-plane tilt/);
    }
  });
});

describe("legacy definition warnings beside the shown value", () => {
  it("every legacy code with a recorded definition difference has a warning; others have none", async () => {
    const { legacyDefinitionWarningAr, LEGACY_DEFINITION_VERSIONS } = await import("../lib/ceph-evidence/definition-versions");
    for (const v of LEGACY_DEFINITION_VERSIONS) expect(legacyDefinitionWarningAr(v.legacyCode), v.legacyCode).toMatch(/يخالف المصدر/);
    expect(LEGACY_DEFINITION_VERSIONS.map((v) => v.legacyCode).sort()).toEqual(["APDI", "CF", "EXT_INDEX", "FH_AB", "ODI", "PP_FH", "SNGOGN", "WITS"]);
    expect(legacyDefinitionWarningAr("SNA")).toBeNull();
    expect(legacyDefinitionWarningAr("APDI")).toMatch(/معكوسة/);
  });
  it("the tracer uses the shared note", () => {
    const tracer = readFileSync(new URL("../components/CephTracer.tsx", import.meta.url), "utf8");
    expect(tracer).toContain("measurementNoteAr(code, activeVal, availability.get(code), Boolean(completed && stamped))");
  });
});

describe("one shared measurement note for screen and print", () => {
  it("explains a missing draft value, a missing approved value, and flags shown values without touching them", async () => {
    const { measurementNoteAr } = await import("../lib/ceph-availability");
    const noA = without(L, "A");
    expect(measurementNoteAr("ANB", null, explainMeasurement("ANB", noA, SCALE), false)).toBe("نقاط ناقصة: A.");
    expect(measurementNoteAr("ANB", null, explainMeasurement("ANB", noA, SCALE), true)).toBe("لا قيمة في اللقطة المعتمدة — نقاط ناقصة: A.");
    expect(measurementNoteAr("SNA", 82, explainMeasurement("SNA", L, SCALE), false)).toBeNull();
    const apdi = measurementNoteAr("APDI", 98, explainMeasurement("APDI", without(L, "ANS"), SCALE), true)!;
    expect(apdi).toMatch(/غير مقيسة بالكامل/);
    expect(apdi).toMatch(/يخالف المصدر/);
    expect(measurementNoteAr("FH_AB", 97.6, explainMeasurement("FH_AB", L, SCALE), false)).toMatch(/مكمّل/);
  });

  it("the approved print page shows the same note under both measurement tables", () => {
    const print = readFileSync(new URL("../app/print/ceph/[id]/page.tsx", import.meta.url), "utf8");
    expect(print.match(/measurementNoteAr\(r\.code, r\.value, availability\.get\(r\.code\), fromApprovedSnapshot\)/g)).toHaveLength(2);
    expect(print).toContain("const availability = explainAll(points, study.analysis.mmPerPixel ?? NaN);");
  });
});
