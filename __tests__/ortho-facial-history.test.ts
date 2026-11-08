import {expect,it} from 'vitest';
import {verifyFacialHistoryPage,FACIAL_HISTORY_LIMITS,type FacialHistoryPage} from '../lib/ortho-facial-history';
import {syntheticFace} from './fixtures/ortho-facial-analysis';
import {computeFacialResults} from '../lib/ortho-facial-analysis';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import type {FacialRevision} from '../lib/ortho-facial-records';
// Independently authored test roles; not identifiers, dates or notes from a patient record.
const SYN = {
  patient: 21001, orthoCase: 22001, clinicalCase: 23001, actor: 24001,
  document: 25001, revisionBase: 26000, submission: 27001,
  timestamp: '2001-02-03T04:05:06.000Z',
};

const scope={patientId:SYN.patient,orthoCaseId:SYN.orthoCase,clinicalCaseId:SYN.clinicalCase},content=syntheticFace(),results=computeFacialResults(content);
function revision(version:number):FacialRevision {const command={schemaVersion:1 as const,clientRequestId:`synthetic_history_${version}`,documentId:SYN.document,expectedHeadId:version===1?null:SYN.revisionBase+version-1,reason:'SYNTHETIC HISTORY REASON 1',content};return {...scope,id:SYN.revisionBase+version,version,documentId:SYN.document,recordedPatientId:SYN.patient,actorId:SYN.actor,createdBy:'SYNTHETIC HISTORY CREATEDBY 1',createdAt: SYN.timestamp,command,results,requestFingerprint:journeyContentHash(command),contentHash:journeyContentHash({content,results})};}
const expected={...scope,actorId:SYN.actor,documentId:SYN.document,anchor:revision(36)};
const page=():FacialHistoryPage=>({ok:true,...scope,actorId:SYN.actor,documentId:SYN.document,image:content.image,anchor:revision(36),history:Array.from({length:30},(_,i)=>revision(35-i)),hasMore:true});
it('verifies exact30 contiguous page and terminal page without changing historical data',async()=>{const raw=page(),before=structuredClone(raw);expect(await verifyFacialHistoryPage(raw,expected)).toEqual(before);expect(raw).toEqual(before);const terminal={...page(),anchor:revision(6),history:[5,4,3,2,1].map(revision),hasMore:false};expect(await verifyFacialHistoryPage(terminal,{...expected,anchor:revision(6)})).toEqual(terminal);});
it.each(['actor','scope','document','anchor','gap','duplicate','hash','image','falseTerminal','falseMore'] as const)('rejects%s rather than displaying a partial historical page',async kind=>{const raw=structuredClone(page());if(kind==='actor')raw.actorId=SYN.actor + 101;if(kind==='scope')raw.clinicalCaseId=SYN.clinicalCase + 101;if(kind==='document')raw.documentId=SYN.document + 101;if(kind==='anchor')raw.anchor=revision(37);if(kind==='gap')raw.history.splice(2,1);if(kind==='duplicate')raw.history[1]=raw.history[0];if(kind==='hash')raw.history[0].contentHash='b'.repeat(64);if(kind==='image')raw.image.width++;if(kind==='falseTerminal')raw.hasMore=false;if(kind==='falseMore')raw.history.pop();await expect(verifyFacialHistoryPage(raw,expected)).rejects.toThrow();});
it('accepts empty page only anchored at version1',async()=>{const raw={...page(),anchor:revision(1),history:[],hasMore:false};expect(await verifyFacialHistoryPage(raw,{...expected,anchor:revision(1)})).toEqual(raw);await expect(verifyFacialHistoryPage({...page(),history:[],hasMore:false},expected)).rejects.toThrow();});
it('enforces row and whole response byte budgets before revision decoding',async()=>{const raw=page();raw.history[0]={...raw.history[0],createdBy:'ع'.repeat(FACIAL_HISTORY_LIMITS.rowBytes)};await expect(verifyFacialHistoryPage(raw,expected)).rejects.toThrow();await expect(verifyFacialHistoryPage({...page(),extra:'x'.repeat(FACIAL_HISTORY_LIMITS.pageBytes)},expected)).rejects.toThrow();});
it('rejects rowcount31 rather than silently truncating',async()=>{const raw=page();raw.history.push(revision(5));await expect(verifyFacialHistoryPage(raw,expected)).rejects.toThrow();});
