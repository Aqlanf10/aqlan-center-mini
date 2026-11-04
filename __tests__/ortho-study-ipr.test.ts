import {describe,it,expect} from 'vitest';
import {makeStudyIprSnapshot,readStudyIprSnapshot,type StudyIprEntry} from '../lib/ortho-study-ipr';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import type {SpaceSavedContent} from '../lib/ortho-space-saved';
const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3};
function entry(id:number,content:SpaceSavedContent):StudyIprEntry{return{id,version:id,predecessorId:id===1?null:id-1,recordedPatientId:1,createdAt:'2026-11-04T00:00:00.000Z',createdBy:'Synthetic examiner',reason:'Synthetic evidence',contentHash:journeyContentHash(content),content};}
function fixture(amount:number|null=200){
 const plan:SpaceSavedContent={authored:{kind:'plan',arch:'upper',strategyRevisionId:4,baseline:{kind:'assessment_analysis',id:5,member:'upper',version:`sha256:${'a'.repeat(64)}`},gains:[],uses:[],contacts:[{teeth:[11,12],plannedUm:300,budgetGainUm:300,clinicianLimitUm:null,note:'Synthetic contact'}],rationale:'Synthetic plan',alternatives:'Synthetic alternatives'},baseline:{discrepancyMm:-2,estimated:false},adjustment:null};
 const ipr=(id:number,adjustmentId:number,performedUm:number|null,supersedesEntryId:number|null)=>entry(id,{authored:{kind:'ipr',arch:'upper',planEntryId:1,teeth:[11,12],adjustmentId,performedUm,measurementNote:'Synthetic measured source',supersedesEntryId,reviewReason:null},baseline:null,adjustment:{visitId:adjustmentId+10,occurredOn:'2026-11-04',recordedBy:'Synthetic doctor'}});
 return [entry(1,plan),ipr(2,6,100,null),ipr(3,7,amount,null),ipr(4,6,50,2)];
}
describe('immutable IPR study snapshot',()=>{
 it('keeps both events and the correction, but totals each current session only once',()=>{
  const snapshot=makeStudyIprSnapshot(scope,fixture());
  expect(snapshot.currentIds).toEqual([3,4]);expect(snapshot.totals).toEqual([{arch:'upper',contact:'11-12',performedUm:250}]);
  expect(readStudyIprSnapshot(JSON.parse(JSON.stringify(snapshot)),scope)).toEqual(snapshot);
  expect(snapshot.entries[1].content.authored).toMatchObject({performedUm:100});
 });
 it('preserves unknown performance rather than turning it into zero',()=>expect(makeStudyIprSnapshot(scope,fixture(null)).totals[0].performedUm).toBeNull());
 it('refuses injected totals, omitted correction ancestry and changed scope',()=>{
  const snapshot=makeStudyIprSnapshot(scope,fixture());
  expect(()=>readStudyIprSnapshot({...snapshot,totals:[{...snapshot.totals[0],performedUm:350}]},scope)).toThrow();
  expect(()=>readStudyIprSnapshot({...snapshot,entries:snapshot.entries.filter(e=>e.id!==2)},scope)).toThrow();
  expect(()=>readStudyIprSnapshot(snapshot,{...scope,orthoCaseId:99})).toThrow();
  expect(()=>readStudyIprSnapshot({...snapshot,projectionVersion:'unknown'},scope)).toThrow();
 });
});
