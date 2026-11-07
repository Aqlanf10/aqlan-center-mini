import {expect,it} from 'vitest';
import {parseStudySubmissionBody,verifyStudySubmissionRecovery,verifyStudySubmissionAcknowledgment} from '../lib/ortho-study-submission-contract';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import {CASE_TEMPLATE_IDENTITY,CASE_TEMPLATE_VERSION} from '../lib/ortho-case-template';
import type {StudySaveExpectation} from '../lib/ortho-case-study-editor-response';
const scope={patientId:19,orthoCaseId:41,clinicalCaseId:51},actorId=7;
const expected:StudySaveExpectation={scope,actorId,previousVersion:0,command:{schemaVersion:1,clientRequestId:'synthetic_submission_0001',expectedHead:null,baseDocumentedRevision:null,documentedFrom:null,kind:'draft',reason:'Synthetic',content:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:journeyContentHash(CASE_TEMPLATE_IDENTITY)},identityDisclosure:'case_only',sources:[],groups:[],mediaUses:[],comment:'Synthetic text',panels:[{instanceId:'cover1',layoutKey:'cover',state:'not_recorded',included:true,sourceKeys:[],images:[],comment:''}]}}};
const identity={id:1,commandId:expected.command.clientRequestId,requestFingerprint:journeyContentHash(expected.command)};
const envelope=(recovery:unknown)=>({ok:true,scope,actorId,recovery});
it.each(['pending','committed'])('accepts exact server %s intent and hash only',async state=>{
 const raw=envelope({state,identity,expected});expect(await verifyStudySubmissionRecovery(raw,scope,actorId)).toEqual(raw);
 for(const wrong of [{...expected,actorId:8},{...expected,scope:{...scope,patientId:20}},{...expected,previousVersion:1},{...expected,command:{...expected.command,reason:'Tampered'}}])await expect(verifyStudySubmissionRecovery(envelope({state,identity,expected:wrong}),scope,actorId)).rejects.toThrow();
});
it('accepts absence, cancellation, and bounded blocked metadata without authored payload',async()=>{
 for(const recovery of [null,{state:'cancelled',identity},{state:'blocked',identity:null,canCancel:false},{state:'blocked',identity,canCancel:true}])expect(await verifyStudySubmissionRecovery(envelope(recovery),scope,actorId)).toEqual(envelope(recovery));
 for(const recovery of [{state:'blocked',identity,canCancel:false},{state:'blocked',identity:null,canCancel:true},{state:'cancelled',identity,expected},{state:'blocked',identity,canCancel:true,command:expected.command}])await expect(verifyStudySubmissionRecovery(envelope(recovery),scope,actorId)).rejects.toThrow();
});
it('rejects extra keys, foreign context and malformed identity',async()=>{
 const recovery={state:'pending',identity,expected},raw=envelope(recovery);
 for(const wrong of [{...raw,actorId:8},{...raw,scope:{...scope,clinicalCaseId:52}},{...raw,extra:true},envelope({...recovery,identity:{...identity,id:0}}),envelope({...recovery,identity:{...identity,requestFingerprint:'f'.repeat(64)}}),envelope({...recovery,expected:{...expected,extra:true}})])await expect(verifyStudySubmissionRecovery(wrong,scope,actorId)).rejects.toThrow();
});
it('requires exact current actor and command fingerprint for a committed acknowledgment',async()=>{
 const raw={ok:true,scope,actorId,identity,state:'committed',acknowledged:true};expect(await verifyStudySubmissionAcknowledgment(raw,scope,actorId,expected.command)).toBe(true);
 for(const wrong of [{...raw,actorId:8},{...raw,state:'cancelled'},{...raw,acknowledged:false},{...raw,extra:true},{...raw,scope:{...scope,patientId:20}},{...raw,identity:{...identity,commandId:'another_command_0001'}},{...raw,identity:{...identity,requestFingerprint:'f'.repeat(64)}}])expect(await verifyStudySubmissionAcknowledgment(wrong,scope,actorId,expected.command)).toBe(false);
});

it('requires actor and bridge binding on first arrival, with no legacy or extra-key fallback',()=>{
 const raw={patientId:19,clinicalCaseId:51,actorId:7,command:expected.command};expect(parseStudySubmissionBody(raw)).toEqual(raw);
 for(const wrong of [{patientId:19,command:expected.command},{...raw,clinicalCaseId:0},{...raw,actorId:'7'},{...raw,extra:true}])expect(parseStudySubmissionBody(wrong)).toBeNull();
});
