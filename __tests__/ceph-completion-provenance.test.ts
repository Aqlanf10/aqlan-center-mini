import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CEPH_ENGINE_SOURCE_SHA256, buildCephCompletionWitness, decodeCephCompletionWitness, cephProvenanceHash, buildReviewedCephCompletionWitness, cephSourceIdentity, decodeCephCompletionWitnessV1, readCephCompletionSources } from "../lib/ceph-completion-provenance";
import { CEPH_ENGINE_VERSION } from "../lib/ceph-engine-identity";
import { MEASUREMENTS } from "../lib/ceph";
const snapshot = { patientId: 11, documentId: 22, refSet: "synthetic", calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1,
  landmarks: [{ code: "S" as const, x: 10, y: 20, source: "manual" as const }], diagnosis: null };
const input = () => ({ analysisId: 7, actor: { userId: 9, username: "synthetic-doctor" }, sealedAt: "2026-11-05T12:00:00.000Z", snapshot,
  image: { documentId: 22, sha256: "a".repeat(64), width: 800, height: 600 },
  landmarkReviews: [{ code: "S", confirmedBy: "reviewer", confirmedAt: "2026-11-05T11:00:00.000Z" }],
  referenceSet: { key: "synthetic", name: "Synthetic cohort", population: "not clinical", ageMin: 12, ageMax: 14, sex: null, version: "v2", active: true,
    values: [{ code: "SNA", mean: 85, sd: 3 }] }, measurements: [{ code: "SNA", value: 82 }, { code: "SNB", value: 80 }] });
describe("versioned immutable future ceph provenance", () => {
  it("pins calculation implementation, requiring deliberate identity maintenance when code changes", () => {
    expect(createHash("sha256").update(readFileSync(new URL("../lib/ceph.ts", import.meta.url))).digest("hex")).toBe(CEPH_ENGINE_SOURCE_SHA256);
  });
  it("captures per-measurement units/algorithm and exact selected and fallback reference origins", () => {
    const witness = buildCephCompletionWitness(input());
    expect(witness.measurements[0]).toMatchObject({ code: "SNA", unit: "°", algorithm: { id: "aqlan-ceph:SNA", version: CEPH_ENGINE_VERSION, sourceSha256: CEPH_ENGINE_SOURCE_SHA256 }, reference: { origin: "selected_reference_set", mean: 85, sd: 3, patientSpecificSuitability: "not_validated" } });
    expect(witness.measurements[1].reference).toMatchObject({ origin: "builtin_definition_fallback", mean: 80, sd: 2 });
    expect(decodeCephCompletionWitness(witness, cephProvenanceHash(witness))).toEqual(witness);
  });
  it("does not alias mutable input snapshots or current registry definitions", () => {
    const raw = input(), witness = buildCephCompletionWitness(raw), before = JSON.stringify(witness);
    raw.referenceSet.values[0].mean = 999; raw.snapshot.landmarks[0].x = 999; raw.measurements[0].value = 999;
    expect(JSON.stringify(witness)).toBe(before); snapshot.landmarks[0].x = 10;
  });
  it("keeps descriptive EI cohort evidence separate from applicable patient norms", () => {
    const raw = input(); raw.measurements = [{ code: "EI_KIM_1996", value: 150 }]; raw.referenceSet.values.push({ code: "EI_KIM_1996", mean: 0, sd: 1 });
    const row = buildCephCompletionWitness(raw).measurements[0];
    expect(row.reference).toMatchObject({ origin: "descriptive_cohort_only", mean: null, sd: null, patientSpecificSuitability: "not_validated" });
    expect(row.reference.populationReference).toEqual(MEASUREMENTS.find(m => m.code === "EI_KIM_1996")!.populationReference);
  });
  it("refuses corrupt, unknown schema and integrity mismatches without guessing provenance", () => {
    const witness = buildCephCompletionWitness(input()), hash = cephProvenanceHash(witness);
    expect(decodeCephCompletionWitness({ ...witness, schemaVersion: 2 }, hash)).toBeNull();
    expect(decodeCephCompletionWitness({ ...witness, measurements: [{ ...witness.measurements[0], unit: null }] }, hash)).toBeNull();
    expect(decodeCephCompletionWitness(witness, "0".repeat(64))).toBeNull();
    expect(decodeCephCompletionWitness({ ...witness, measurements: [witness.measurements[0], witness.measurements[0]] }, cephProvenanceHash({ ...witness, measurements: [witness.measurements[0], witness.measurements[0]] }))).toBeNull();
  });
});

describe("source-bound v2 does not promote v1 evidence",()=>{
  const identity=()=>{const v1=buildCephCompletionWitness(input());return cephSourceIdentity(v1.image,v1.referenceSet);};
  it("preserves the frozen v1 discriminator and exact bytes",()=>{
    const v1=buildCephCompletionWitness(input()), before=JSON.stringify(v1);
    expect(decodeCephCompletionWitnessV1(v1,cephProvenanceHash(v1))).toEqual(v1);
    expect(decodeCephCompletionWitness(v1,cephProvenanceHash(v1))).toEqual(v1);
    expect(v1.schemaVersion).toBe(1);expect(v1.sourceIdentityMeaning).toBe("server_captured_at_completion_not_confirmed_as_viewed");
    expect(JSON.stringify(v1)).toBe(before);
  });
  it("stores matching submitted identity only in the new v2 envelope",()=>{
    const viewed=identity(),v2=buildReviewedCephCompletionWitness(input(),viewed);
    expect(v2).toMatchObject({schemaVersion:2,sourceIdentityMeaning:"submitted_source_identity_matches_server_capture",sourceReview:{schemaVersion:1,identity:viewed}});
    expect(decodeCephCompletionWitness(v2,cephProvenanceHash(v2))).toEqual(v2);
    expect(decodeCephCompletionWitnessV1(v2,cephProvenanceHash(v2))).toBeNull();
    viewed.imageSha256="b".repeat(64);expect(v2.sourceReview.identity.imageSha256).toBe("a".repeat(64));
  });
  it.each(["reference_contents","reference_metadata","image","engine_version","engine_source"])("rejects unseen changed %s",kind=>{
    const viewed=identity(),current=input();
    if(kind==="reference_contents")current.referenceSet.values[0].mean+=1;
    if(kind==="reference_metadata")current.referenceSet.population="different cohort";
    if(kind==="image")current.image.sha256="b".repeat(64);
    if(kind==="engine_version")viewed.engineVersion="unseen-version";
    if(kind==="engine_source")viewed.engineSourceSha256="b".repeat(64);
    expect(()=>buildReviewedCephCompletionWitness(current,viewed)).toThrow("ceph_reviewed_sources_changed");
  });
  it("rejects discriminator-only promotion and identity corruption even with a recalculated envelope hash",()=>{
    const v1=buildCephCompletionWitness(input());
    const promoted={...v1,schemaVersion:2,sourceIdentityMeaning:"submitted_source_identity_matches_server_capture"};
    expect(decodeCephCompletionWitness(promoted,cephProvenanceHash(promoted))).toBeNull();
    const v2=buildReviewedCephCompletionWitness(input(),identity());
    const wrong={...v2,sourceReview:{schemaVersion:1,identity:{...v2.sourceReview.identity,referenceSetSha256:"b".repeat(64)}}};
    expect(decodeCephCompletionWitness(wrong,cephProvenanceHash(wrong))).toBeNull();
  });
  it("returns the same exact reference snapshot whose identity is supplied, independent of DB collation order",async()=>{
    const raw=input(),reference={...raw.referenceSet,values:[{code:"SNB",mean:80,sd:2},...raw.referenceSet.values]};
    let calls=0;
    const client={query:async()=>{calls++;return {rows:[{document_id:22,sha256:"a".repeat(64),width:800,height:600,reference}],rowCount:1};}} as unknown as Parameters<typeof readCephCompletionSources>[0];
    const sources=await readCephCompletionSources(client,
      {patientId:11,documentId:22,refSet:"synthetic"});
    expect(calls).toBe(1);expect(sources.state).toBe("available");
    if(sources.state!=="available")throw new Error(sources.reason);
    expect(sources.referenceSet.values.map(v=>v.code)).toEqual(["SNA","SNB"]);
    expect(sources.identity.referenceSetSha256).toBe(cephProvenanceHash(sources.referenceSet));
  });
});
