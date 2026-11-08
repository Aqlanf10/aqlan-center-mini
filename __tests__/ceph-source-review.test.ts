import { describe, expect, it } from "vitest";
import { CEPH_ENGINE_SOURCE_SHA256, CEPH_ENGINE_VERSION } from "../lib/ceph-engine-identity";
import { parseCephSourceIdentity, sameCephSourceIdentity, type CephSourceIdentity } from "../lib/ceph-source-review";
const identity: CephSourceIdentity = {schemaVersion:1,documentId:22,imageSha256:"a".repeat(64),referenceSetKey:"builtin_default",
  referenceSetSha256:"b".repeat(64),engineVersion:CEPH_ENGINE_VERSION,engineSourceSha256:CEPH_ENGINE_SOURCE_SHA256};
describe("browser-safe viewed source identity", () => {
  it("copies exact bounded fields and ignores property order for equality", () => {
    const result = parseCephSourceIdentity(identity); expect(result).toEqual(identity); expect(result).not.toBe(identity);
    expect(sameCephSourceIdentity(identity,Object.fromEntries(Object.entries(identity).reverse()))).toBe(true);
  });
  it.each([null,undefined,[],{}, {...identity,extra:true}, {...identity,schemaVersion:2}, {...identity,documentId:"22"},
    {...identity,documentId:Number.MAX_SAFE_INTEGER+1}, {...identity,documentId:0}, {...identity,imageSha256:"A".repeat(64)},
    {...identity,imageSha256:"bad"}, {...identity,referenceSetSha256:null}, {...identity,engineSourceSha256:""},
    {...identity,engineVersion:" "}, {...identity,referenceSetKey:"x".repeat(201)}, {...identity,engineVersion:"x".repeat(201)}])("rejects malformed identity %#", value => {
      expect(parseCephSourceIdentity(value)).toBeNull(); expect(sameCephSourceIdentity(value,value)).toBe(false);
    });
  it.each(["documentId","imageSha256","referenceSetKey","referenceSetSha256","engineVersion","engineSourceSha256"] as const)("detects changed %s", key => {
    const changed = {...identity,[key]:key==="documentId" ? 23 : key.endsWith("Sha256") ? "c".repeat(64) : "different"};
    expect(sameCephSourceIdentity(identity,changed)).toBe(false);
  });
});

import { buildCephCompletionWitness, buildReviewedCephCompletionWitness, cephProvenanceHash, cephSourceIdentity } from "../lib/ceph-completion-provenance";
import { cephCompletionNotice, CEPH_VERSIONED_NOTICE, CEPH_REVIEWED_SOURCE_NOTICE } from "../lib/cephPresentation";
it("distinguishes unchanged v1 server capture from v2 submitted source matching without claiming byte verification", () => {
  const input: Parameters<typeof buildCephCompletionWitness>[0] = {
    analysisId:1,actor:{userId:1,username:"synthetic"},sealedAt:"2026-11-05T00:00:00.000Z",
    snapshot:{patientId:1,documentId:22,refSet:"saved",calibration:{x1:0,y1:0,x2:10,y2:0,mm:1},mmPerPixel:0.1,landmarks:[],diagnosis:null},
    image:{documentId:22,sha256:"a".repeat(64),width:null,height:null},landmarkReviews:[],
    referenceSet:{key:"saved",name:"Saved",population:null,ageMin:null,ageMax:null,sex:null,version:"v1",active:true,values:[]},
    measurements:[{code:"SNA",value:82}],
  };
  const v1=buildCephCompletionWitness(input), before=JSON.stringify(v1);
  const v2=buildReviewedCephCompletionWitness(input,cephSourceIdentity(input.image,input.referenceSet));
  expect(cephCompletionNotice({state:"versioned",witness:v1,witnessSha256:cephProvenanceHash(v1)})).toBe(CEPH_VERSIONED_NOTICE);
  expect(cephCompletionNotice({state:"versioned",witness:v2,witnessSha256:cephProvenanceHash(v2)})).toBe(CEPH_REVIEWED_SOURCE_NOTICE);
  expect(CEPH_REVIEWED_SOURCE_NOTICE).toContain("ليست إعادة فحص لبايتات الملف");
  expect(CEPH_REVIEWED_SOURCE_NOTICE).toContain("تحققًا سريريًا مستقلًا");
  expect(JSON.stringify(v1)).toBe(before);
});
