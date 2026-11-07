import { describe,expect,it } from "vitest";
import { syntheticFace } from "./fixtures/ortho-facial-analysis";
import { computeFacialResults } from "../lib/ortho-facial-analysis";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { readFacialRead, verifyFacialSaved } from "../lib/ortho-facial-records";
const command={schemaVersion:1 as const,clientRequestId:"synthetic-facial-review",documentId:6,expectedHeadId:null,reason:"Synthetic",content:syntheticFace()};
const results=computeFacialResults(command.content),scope={patientId:2,orthoCaseId:3,clinicalCaseId:4,actorId:5,command};
const revision={id:1,patientId:2,recordedPatientId:2,orthoCaseId:3,clinicalCaseId:4,documentId:6,actorId:5,version:1,createdBy:"Synthetic",createdAt:"2026-11-03T00:00:00.000Z",command,results,requestFingerprint:journeyContentHash(command),contentHash:journeyContentHash({content:command.content,results})};
const read={ok:true,patientId:2,orthoCaseId:3,clinicalCaseId:4,actorId:5,canWrite:true,selectedDocumentId:6,documents:[{id:6,title:"Synthetic",sha256:command.content.image.sha256,takenOn:null}],documentsTruncated:false,image:command.content.image,history:[revision],historyTruncated:false};
describe("source-bound facial read and write receipts",()=>{
 it("accepts an exact fresh or replayed saved command",async()=>{
  await expect(verifyFacialSaved({ok:true,replayed:false,revision},scope,201)).resolves.toEqual(revision);
  await expect(verifyFacialSaved({ok:true,replayed:true,revision},scope,200)).resolves.toEqual(revision);
  await expect(readFacialRead(read,scope,6)).resolves.toEqual(read);
 });
 it("refuses an unverified hash, actor, scope, image or recomputed result",async()=>{
  for(const bad of [{...revision,actorId:7},{...revision,clinicalCaseId:7},{...revision,patientId:7},{...revision,requestFingerprint:"b".repeat(64)},{...revision,contentHash:"b".repeat(64)},{...revision,results:{...results,measures:[]}},{...revision,command:{...command,reason:"changed"}}]) await expect(verifyFacialSaved({ok:true,replayed:false,revision:bad},scope,201)).rejects.toThrow();
  await expect(verifyFacialSaved({ok:true,replayed:false,revision},scope,200)).rejects.toThrow();
  for(const bad of [{...read,selectedDocumentId:7},{...read,image:{...read.image,width:1200}},{...read,documents:[]},{...read,history:[revision,revision]},{...read,history:[{...revision,documentId:7}]}])await expect(readFacialRead(bad,scope,6)).rejects.toThrow();
 });
});
it('does not label a tail missing version one as complete history',async()=>{
 const nextCommand={...command,clientRequestId:'synthetic-facial-next',expectedHeadId:1};
 const next={...revision,id:2,version:2,command:nextCommand,requestFingerprint:journeyContentHash(nextCommand)};
 await expect(readFacialRead({...read,history:[next],historyTruncated:false},scope,6)).rejects.toThrow();
 await expect(readFacialRead({...read,history:[revision],historyTruncated:true},scope,6)).rejects.toThrow();
});
