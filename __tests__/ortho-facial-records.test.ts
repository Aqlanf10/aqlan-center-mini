import { describe,expect,it } from "vitest";
import { syntheticFace } from "./fixtures/ortho-facial-analysis";
import { computeFacialResults } from "../lib/ortho-facial-analysis";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { readFacialRead, verifyFacialSaved } from "../lib/ortho-facial-records";
// Independently authored test roles; not identifiers, dates or notes from a patient record.
const SYN = {
  patient: 21001, orthoCase: 22001, clinicalCase: 23001, actor: 24001,
  document: 25001, revisionBase: 26000, submission: 27001,
  timestamp: '2001-02-03T04:05:06.000Z',
};

const command={schemaVersion:1 as const,clientRequestId:'synthetic_facial_records_001',documentId:SYN.document,expectedHeadId:null,reason:'SYNTHETIC RECORDS REASON 1',content:syntheticFace()};
const results=computeFacialResults(command.content),scope={patientId:SYN.patient,orthoCaseId:SYN.orthoCase,clinicalCaseId:SYN.clinicalCase,actorId:SYN.actor,command};
const revision={id:SYN.revisionBase+1,patientId:SYN.patient,recordedPatientId:SYN.patient,orthoCaseId:SYN.orthoCase,clinicalCaseId:SYN.clinicalCase,documentId:SYN.document,actorId:SYN.actor,version:1,createdBy:'SYNTHETIC RECORDS CREATEDBY 1',createdAt: SYN.timestamp,command,results,requestFingerprint:journeyContentHash(command),contentHash:journeyContentHash({content:command.content,results})};
const read={ok:true,patientId:SYN.patient,orthoCaseId:SYN.orthoCase,clinicalCaseId:SYN.clinicalCase,actorId:SYN.actor,canWrite:true,selectedDocumentId:SYN.document,documents:[{id:SYN.document,title:'SYNTHETIC RECORDS TITLE 1',sha256:command.content.image.sha256,takenOn:null}],documentsTruncated:false,image:command.content.image,history:[revision],historyTruncated:false};
describe("source-bound facial read and write receipts",()=>{
 it("accepts an exact fresh or replayed saved command",async()=>{
  await expect(verifyFacialSaved({ok:true,replayed:false,revision},scope,201)).resolves.toEqual(revision);
  await expect(verifyFacialSaved({ok:true,replayed:true,revision},scope,200)).resolves.toEqual(revision);
  await expect(readFacialRead(read,scope,SYN.document)).resolves.toEqual(read);
 });
 it("refuses an unverified hash, actor, scope, image or recomputed result",async()=>{
  for(const bad of [{...revision,actorId:SYN.actor + 101},{...revision,clinicalCaseId:SYN.clinicalCase + 101},{...revision,patientId:SYN.patient + 101},{...revision,requestFingerprint:"b".repeat(64)},{...revision,contentHash:"b".repeat(64)},{...revision,results:{...results,measures:[]}},{...revision,command:{...command,reason:'SYNTHETIC RECORDS REASON 2'}}]) await expect(verifyFacialSaved({ok:true,replayed:false,revision:bad},scope,201)).rejects.toThrow();
  await expect(verifyFacialSaved({ok:true,replayed:false,revision},scope,200)).rejects.toThrow();
  for(const bad of [{...read,selectedDocumentId:SYN.document + 101},{...read,image:{...read.image,width:1200}},{...read,documents:[]},{...read,history:[revision,revision]},{...read,history:[{...revision,documentId:SYN.document + 101}]}])await expect(readFacialRead(bad,scope,SYN.document)).rejects.toThrow();
 });
});
it('does not label a tail missing version one as complete history',async()=>{
 const nextCommand={...command,clientRequestId:'synthetic_facial_records_002',expectedHeadId:SYN.revisionBase+1};
 const next={...revision,id:SYN.revisionBase+2,version:2,command:nextCommand,requestFingerprint:journeyContentHash(nextCommand)};
 await expect(readFacialRead({...read,history:[next],historyTruncated:false},scope,SYN.document)).rejects.toThrow();
 await expect(readFacialRead({...read,history:[revision],historyTruncated:true},scope,SYN.document)).rejects.toThrow();
});
