/** Step 1 of the ceph provenance branch: pure witness modules. Synthetic data only. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeAll, type LandmarkCode } from "../lib/ceph";
import { canonicalCephJson, cephContentHash } from "../lib/ceph-provenance/canonical-json";
import { CEPH_ENGINE_SOURCE_SHA256, CEPH_ENGINE_VERSION } from "../lib/ceph-provenance/engine-identity";
import { parseCephCompletionSnapshot, type CephCompletionSnapshot } from "../lib/ceph-provenance/snapshot";
import {
  buildCephCompletionWitness, cephSourceIdentity, decodeCephCompletionWitness, parseCephSourceIdentity, sameCephSourceIdentity,
  type CephReferenceSnapshot,
} from "../lib/ceph-provenance/witness";

const sha = (c: string) => c.repeat(64);
// Synthetic profile (face +x, y down) without ANS, so the legacy Kim indices substitute 3° (C2 flag).
const FACE: Record<string, { x: number; y: number }> = {
  S: { x: 300, y: 300 }, N: { x: 560, y: 260 }, Or: { x: 520, y: 330 }, Po: { x: 250, y: 350 }, A: { x: 580, y: 470 },
  B: { x: 560, y: 620 }, Pog: { x: 565, y: 680 }, Me: { x: 540, y: 720 }, Gn: { x: 560, y: 705 }, Go: { x: 330, y: 640 },
  U1A: { x: 540, y: 460 }, U1: { x: 590, y: 560 }, L1A: { x: 530, y: 650 }, L1: { x: 585, y: 550 }, OcclA: { x: 590, y: 555 },
  OcclP: { x: 400, y: 540 }, PNS: { x: 380, y: 440 },
};
const snapshot: CephCompletionSnapshot = {
  patientId: 7, documentId: 11, orthoCaseId: null, refSet: "builtin_default",
  calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1,
  landmarks: Object.entries(FACE).map(([code, p]) => ({ code: code as LandmarkCode, ...p, source: code === "A" ? "suggested" as const : "manual" as const })),
  diagnosis: { skeletal: null, dental: null, softTissue: null, note: null, finalDx: "اصطناعي" },
};
const sealed = computeAll(FACE as never, 0.1).filter((r) => r.value != null).map((r) => ({ code: r.code, value: r.value! }));
const reference: CephReferenceSnapshot = { key: "builtin_default", name: "مرجع اصطناعي", population: null, ageMin: null, ageMax: null, sex: null, version: "v1", values: [{ code: "SNA", mean: 82, sd: 3.5 }] };
const image = { documentId: 11, sha256: sha("a"), width: 800, height: 600 };
const base = {
  analysisId: 5, actor: { userId: 3, username: "synthetic.doctor", role: "doctor" }, sealedAt: "2026-11-18T08:00:00.000Z", approvedDraftVersion: sha("b"),
  snapshot, image, landmarkReviews: Object.keys(FACE).map((code) => ({ code, confirmedBy: "synthetic.doctor", confirmedAt: "2026-11-18T07:59:00.000000Z" })),
  referenceSet: reference, measurements: sealed,
};

describe("canonical hash", () => {
  it("sorts keys, keeps array order, normalizes -0 and refuses non-JSON", () => {
    expect(canonicalCephJson({ b: 1, a: [2, 1], c: -0 })).toBe('{"a":[2,1],"b":1,"c":0}');
    expect(cephContentHash({ a: 1, b: 2 })).toBe(cephContentHash({ b: 2, a: 1 }));
    expect(() => cephContentHash({ d: new Date() })).toThrow("invalid_json_value");
    expect(() => cephContentHash({ x: Number.NaN })).toThrow("invalid_json_value");
  });
});

describe("engine identity", () => {
  it("pins the exact legacy engine source: any change to lib/ceph.ts needs an explicit version change", () => {
    const source = readFileSync(new URL("../lib/ceph.ts", import.meta.url));
    expect(createHash("sha256").update(source).digest("hex"), `bump CEPH_ENGINE_VERSION (${CEPH_ENGINE_VERSION}) and the checksum together`).toBe(CEPH_ENGINE_SOURCE_SHA256);
  });
});

describe("snapshot", () => {
  it("canonicalizes landmark order and refuses unknown, duplicate or extra fields", () => {
    expect(parseCephCompletionSnapshot(snapshot)!.landmarks.map((p) => p.code)).toEqual(Object.keys(FACE).sort());
    expect(parseCephCompletionSnapshot({ ...snapshot, landmarks: [...snapshot.landmarks, snapshot.landmarks[0]] })).toBeNull();
    expect(parseCephCompletionSnapshot({ ...snapshot, extra: 1 })).toBeNull();
    expect(parseCephCompletionSnapshot({ ...snapshot, landmarks: [{ code: "ZZ", x: 1, y: 1, source: "manual" }] })).toBeNull();
    expect(parseCephCompletionSnapshot({ ...snapshot, mmPerPixel: 0 })).toBeNull();
  });
});

describe("source identity", () => {
  it("is exact and compares by content", () => {
    const id = cephSourceIdentity(image, "builtin_default", reference);
    expect(parseCephSourceIdentity(id)).toEqual(id);
    expect(sameCephSourceIdentity(id, { ...id })).toBe(true);
    expect(sameCephSourceIdentity(id, { ...id, imageSha256: sha("c") })).toBe(false);
    expect(parseCephSourceIdentity({ ...id, engineId: "other" })).toBeNull();
    expect(cephSourceIdentity(image, "builtin_default", null).referenceSetSha256).toBeNull();
  });
});

describe("witness", () => {
  it("records each value with engine, reference origin, completeness and the legacy-definition flag", () => {
    const w = buildCephCompletionWitness({ ...base, expectedSources: cephSourceIdentity(image, "builtin_default", reference) });
    expect(w.sourceIdentityMeaning).toBe("submitted_source_identity_matches_server_capture");
    expect(w.clinicalMeaning).toBe("clinician_attested_inputs_not_independent_clinical_validation");
    expect(w.measurements.map((m) => m.code)).toEqual(sealed.map((m) => m.code).sort());
    expect(w.measurements.find((m) => m.code === "SNA")).toMatchObject({ reference: { origin: "selected_reference_set", mean: 82, sd: 3.5, source: "builtin_default@v1" }, legacyDefinitionDiffers: false });
    expect(w.measurements.find((m) => m.code === "APDI")).toMatchObject({ reference: { origin: "builtin_definition_fallback" }, legacyDefinitionDiffers: true, completeness: "measured-with-assumption" });
    expect(w.snapshot.landmarks.find((p) => p.code === "A")!.source).toBe("suggested");
    expect(decodeCephCompletionWitness(w, cephContentHash(w))).not.toBeNull();
  });

  it("without client sources it is recorded as not confirmed as viewed", () => {
    expect(buildCephCompletionWitness({ ...base, expectedSources: null }).sourceIdentityMeaning).toBe("server_captured_at_completion_not_confirmed_as_viewed");
  });

  it("refuses when the reviewed sources differ from the server capture (image, reference or engine)", () => {
    const seen = cephSourceIdentity(image, "builtin_default", reference);
    for (const changed of [{ ...seen, imageSha256: sha("c") }, { ...seen, referenceSetSha256: sha("d") }, { ...seen, engineVersion: "old" }]) {
      expect(() => buildCephCompletionWitness({ ...base, expectedSources: changed })).toThrow("ceph_reviewed_sources_changed");
    }
  });

  it("decoding rejects any tampering: hash, value, reference, engine, meaning", () => {
    const w = buildCephCompletionWitness({ ...base, expectedSources: null });
    const h = cephContentHash(w);
    expect(decodeCephCompletionWitness(w, sha("0"))).toBeNull();
    const tamper = (f: (x: Record<string, any>) => void) => { const c = JSON.parse(JSON.stringify(w)); f(c); return decodeCephCompletionWitness(c, cephContentHash(c)); };
    expect(tamper((c) => { c.measurements.find((m: { code: string }) => m.code === "SNA").reference.mean = 99; })).toBeNull();
    expect(tamper((c) => { c.measurements[0].algorithm.engineVersion = "x"; })).toBeNull();
    expect(tamper((c) => { c.clinicalMeaning = "validated"; })).toBeNull();
    expect(tamper((c) => { c.sourceIdentity.imageSha256 = sha("e"); })).toBeNull();
    expect(tamper((c) => { c.recordedPatientId = 8; })).toBeNull();
    expect(decodeCephCompletionWitness(w, h)).not.toBeNull();
  });

  it("refuses scope mismatches and invalid values", () => {
    expect(() => buildCephCompletionWitness({ ...base, image: { ...image, documentId: 12 }, expectedSources: null })).toThrow("ceph_witness_scope_mismatch");
    expect(() => buildCephCompletionWitness({ ...base, measurements: [{ code: "NOPE", value: 1 }], expectedSources: null })).toThrow("ceph_witness_measurement_invalid");
    expect(() => buildCephCompletionWitness({ ...base, measurements: [{ code: "SNA", value: Number.NaN }], expectedSources: null })).toThrow("ceph_witness_measurement_invalid");
    const sna = sealed.find((m) => m.code === "SNA")!;
    expect(() => buildCephCompletionWitness({ ...base, measurements: [{ code: "SNA", value: sna.value + 0.1 }], expectedSources: null })).toThrow("ceph_witness_value_not_reproducible");
  });
});

describe("hash compatibility with #530 (owner review 6967467169)", () => {
  // Expected digests computed with #530's own journeyContentHash(canonicalJourneyJSON) taken verbatim from
  // review/ortho-ceph-current-source-20261107 @ f2a968da (lib/ortho-case-journey-json.ts + ortho-case-journey-hash.ts).
  // The neutral module must produce the same bytes: same key sort, kept array order, -0 → 0, same refusals.
  const VECTORS: [string, unknown, string][] = [
    ["key-order", { b: 1, a: 2, c: { z: [3, 2, 1], y: "ي" } }, "81e1096b06ac0c0dfa0dfac322accdb912a24d727be976ff1e1f5b8e9379034a"],
    ["array-order", [3, 1, 2], "51bda7ab4e44726cde71fcb6e4b515357059bb6b6dd5146d1fc50f73f11678c6"],
    ["negative-zero", { x: -0, y: [-0, 0] }, "443bbd8571ffe36b22c0771e64e2c92da4ecbdabaff64effda8604b4bd721869"],
    ["nested-null", { a: null, b: [null, { c: null }] }, "dcf65ed0b6d4f0928ee0bff437459c665617f48201243e8e083fc875add9153c"],
    ["unicode-text", { finalDx: "صنف هيكلي ثانٍ", note: "line\nbreak\t\"q\"" }, "bac820713878c1c9371ffbe94ce5ae37d846a15db36d1515d86d6b566b0274ed"],
    ["numbers", { a: 1.25, b: 1e-7, c: 123456789.123, d: -42 }, "04a7fbecf2be436edb264d8ee88092e02f3f2b041d353e04d4cb3377f67e88a6"],
    ["empty", {}, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
    ["empty-array", [], "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
    ["booleans", { t: true, f: false }, "c22848c47426fcf4d27e55573c22f1d23546315c251e8e4bc384820ba5fae568"],
    ["null-proto", Object.assign(Object.create(null), { b: 2, a: 1 }), "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
  ];
  it.each(VECTORS)("%s hashes to the same digest as #530", (_name, value, digest) => {
    expect(cephContentHash(value)).toBe(digest);
  });
  it.each([["NaN", { x: Number.NaN }], ["Infinity", { x: Number.POSITIVE_INFINITY }], ["undefined", { x: undefined }], ["Date", { x: new Date(0) }],
    ["function", { x: () => 1 }], ["bigint", { x: BigInt(1) }], ["Map", new Map()]] as const)("refuses %s exactly like #530", (_name, value) => {
    expect(() => cephContentHash(value)).toThrow("invalid_json_value");
  });
  it("key order never changes the digest; array order always does", () => {
    expect(cephContentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(cephContentHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(cephContentHash([1, 2])).not.toBe(cephContentHash([2, 1]));
  });
});

describe("retained rows (owner review 6968168056 point 3)", () => {
  it("records unknown historical rows verbatim and rejects any overlap with engine values or known landmarks", () => {
    const retained = { landmarks: [{ code: "SYN_OLD", x: 1, y: 2, source: "manual", confirmedBy: "SYN", confirmedAt: "2026-11-18T07:00:00.000000Z" }], measurements: [{ code: "SYN_STORED", value: 42.125 }] };
    const w = buildCephCompletionWitness({ ...base, expectedSources: null, retained });
    expect(w.retained).toEqual(retained);
    expect(decodeCephCompletionWitness(w, cephContentHash(w))).not.toBeNull();
    const bad = (f: (c: Record<string, any>) => void) => { const c = JSON.parse(JSON.stringify(w)); f(c); return decodeCephCompletionWitness(c, cephContentHash(c)); };
    expect(bad((c) => { c.retained.measurements.push({ code: "SNA", value: 1 }); })).toBeNull();
    expect(bad((c) => { c.retained.landmarks.push({ ...retained.landmarks[0], code: "S" }); })).toBeNull();
    expect(bad((c) => { delete c.retained; })).toBeNull();
  });
});
