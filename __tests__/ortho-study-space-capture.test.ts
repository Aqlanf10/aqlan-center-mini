import {it,expect} from 'vitest';
import {readStudyDraftContent} from '../lib/ortho-case-study';
import {CASE_TEMPLATE_VERSION} from '../lib/ortho-case-template';
import {STUDY_TEMPLATE_HASH} from '../lib/ortho-case-study-template';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import {readStudySpaceCapture,type StudySpaceCapture} from '../lib/ortho-study-space-capture';
import type {StudySourceSelection} from '../lib/ortho-case-study';
function fixture(){
 const content={authored:{kind:'plan' as const,arch:'upper' as const,strategyRevisionId:8,baseline:{kind:'assessment_analysis' as const,id:9,member:'synthetic',version:'sha256:'+'a'.repeat(64)},gains:[],uses:[],contacts:[],rationale:'Saved rationale',alternatives:'Saved alternatives'},baseline:{discrepancyMm:0,estimated:false},adjustment:null};
 const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3};
 const capture:StudySpaceCapture={captureVersion:1,...scope,headId:10,headVersion:1,history:[{...scope,id:10,recordedPatientId:1,schemaVersion:1,version:1,predecessorId:null,createdBy:'Synthetic',createdAt:'2026-11-06T00:00:00Z',reason:'Saved reason',recordingContext:'current',caseStatusAtCapture:'assessment',contentHash:journeyContentHash(content),content}]};
 const selection:StudySourceSelection={key:'space',kind:'space_ledger',id:10,version:1,contentHash:journeyContentHash(capture)};
 const draft={template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:[selection],panels:[],groups:[],mediaUses:[],comment:''};return {capture,selection,draft,scope};
}
it('accepts one versioned saved space source without changing the template',()=>{const {draft}=fixture();expect(readStudyDraftContent(draft)).toEqual(draft);});
it('rejects two prefix aliases even with distinct keys',()=>{const {draft,selection}=fixture();draft.sources.push({...selection,key:'second'});expect(()=>readStudyDraftContent(draft)).toThrow('duplicate_study_space_ledger');});
it('strictly round-trips captured facts and pins entire prefix not only head content',()=>{const {capture,selection,scope}=fixture();expect(readStudySpaceCapture(capture,selection,scope)).toEqual(capture);expect(()=>readStudySpaceCapture(capture,{...selection,contentHash:capture.history[0].contentHash},scope)).toThrow();});
it.each(['recorded','scope','version','head','lineage','content','extra','projection'] as const)('rejects fabricated %s even after recomputing envelope hash',kind=>{const {capture,selection,scope}=fixture();const raw=capture as unknown as Record<string,unknown>;if(kind==='recorded')capture.history[0].recordedPatientId=8;if(kind==='scope')capture.patientId=8;if(kind==='version')capture.history[0].version=2;if(kind==='head')capture.headId=12;if(kind==='lineage')capture.history[0].predecessorId=10;if(kind==='content')capture.history[0].content.baseline!.discrepancyMm=999;if(kind==='extra')raw.liveBaseline=3;if(kind==='projection')raw.ipr={current:[],totals:[]};expect(()=>readStudySpaceCapture(raw,{...selection,contentHash:journeyContentHash(raw)},scope)).toThrow();});
it('rejects null version for prefix and preserves old sources unchanged',()=>{const {draft,selection}=fixture();expect(()=>readStudyDraftContent({...draft,sources:[{...selection,version:null}]})).toThrow();const old={...draft,sources:[{key:'doc',kind:'document',id:1,version:null,contentHash:'a'.repeat(64)}]};expect(readStudyDraftContent(old)).toEqual(old);});
