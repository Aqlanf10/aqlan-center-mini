import {describe,it,expect} from 'vitest';
import {readPhotoComparison,PHOTO_COMPARISON_LIMITS} from '../lib/ortho-photo-comparison';
const scope={patientId:7,orthoCaseId:9};
const doc=(patch:Record<string,unknown>={})=>({id:1,patientId:7,orthoCaseId:9,isImage:true,title:'  المصدر <script>  ',note:'\nالوصف الأصلي  ',takenOn:'2024-02-29',uploadedAt:'2026-11-06T00:00:00.000Z',removedAt:null,photoStage:'progress',photoView:'intraoral_frontal',...patch});
const read=(rows:unknown[])=>readPhotoComparison({documents:rows,storageReady:true,storageMessage:null},scope);
describe('strict photo comparison inventory projection',()=>{
 it('preserves explicit unknown stage/date and exact source text independently',()=>{
  const result=read([doc({photoStage:null,takenOn:null})]);expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.columns.every(c=>c.count===0)).toBe(true);expect(result.unassigned[0]).toMatchObject({id:1,stage:null,takenOn:null,title:'  المصدر <script>  ',note:'\nالوصف الأصلي  '});
 });
 it('distinguishes valid empty inventory from invalid input',()=>{
  expect(read([]).ok).toBe(true);expect(readPhotoComparison({},scope).ok).toBe(false);
 });
 it('filters legitimate other case, unlinked, nonimage, archived and removed inventory',()=>{
  const result=read([doc(),doc({id:2,orthoCaseId:10}),doc({id:3,orthoCaseId:null}),doc({id:4,isImage:false}),doc({id:5,photoStage:'archived'}),doc({id:6,removedAt:'2026-11-05T00:00:00.000Z'})]);
  expect(result.ok).toBe(true);if(!result.ok)return;expect(result.columns[1].candidates.map(p=>p.id)).toEqual([1]);expect(result.excludedCount).toBe(5);
 });
 it.each(['2023-02-29','1900-02-29','2024-04-31','0000-01-01','2024-2-1','2024-01-01T00:00:00Z',''])('refuses invalid acquisition date %s',takenOn=>expect(read([doc({takenOn})]).ok).toBe(false));
 it.each(['0001-01-01','2000-02-29','9999-12-31'])('accepts explicit valid date %s without current-clock assumptions',takenOn=>expect(read([doc({takenOn})]).ok).toBe(true));
 it.each([{patientId:8},{orthoCaseId:-1},{id:0},{photoStage:'constructor'},{photoStage:'__proto__'},{photoStage:'legacy_unknown'},{photoView:'constructor'},{photoView:'selfie'},{isImage:'true'},{takenOn:undefined},{uploadedAt:'2026-02-30T00:00:00.000Z'},{removedAt:'invalid'},{note:42}])('refuses malformed/foreign metadata %j',patch=>expect(read([doc(patch)]).ok).toBe(false));
 it('refuses duplicates, including duplicates outside selected case',()=>{
  expect(read([doc(),doc()]).ok).toBe(false);expect(read([doc({orthoCaseId:10}),doc()]).ok).toBe(false);
 });
 it('does not interpret unrelated legacy acquisition metadata as comparator enums',()=>{
  const result=read([doc(),doc({id:2,orthoCaseId:10,photoStage:'legacy_stage',photoView:'general',takenOn:'unknown'}),doc({id:3,isImage:false,photoView:'general',photoStage:'legacy'}),doc({id:4,removedAt:'2026-11-05T00:00:00.000Z',photoView:'old_view'}),doc({id:5,photoStage:'archived',photoView:'old_view'})]);
  expect(result.ok).toBe(true);if(result.ok){expect(result.columns[1].count).toBe(1);expect(result.excludedCount).toBe(4);}
 });
 it('checks scope even for documents subsequently filtered out',()=>expect(read([doc({patientId:8,orthoCaseId:10,isImage:false})]).ok).toBe(false));
 it('refuses invalid requested scope',()=>expect(readPhotoComparison({documents:[]},{patientId:0,orthoCaseId:9}).ok).toBe(false));
 it('bounds rows and bytes without partial successful results',()=>{
  expect(read(Array.from({length:PHOTO_COMPARISON_LIMITS.rows+1},(_,i)=>doc({id:i+1}))).ok).toBe(false);
  expect(read([doc({note:'ع'.repeat(PHOTO_COMPARISON_LIMITS.bytes)})]).ok).toBe(false);
 });
 it('returns detached metadata and leaves frozen input intact',()=>{
  const row=Object.freeze(doc()),rows=Object.freeze([row]);const input=Object.freeze({documents:rows});
  const before=JSON.stringify(input),result=readPhotoComparison(input,scope);expect(result.ok).toBe(true);if(!result.ok)return;
  result.columns[1].candidates[0].title='changed';expect(JSON.stringify(input)).toBe(before);
 });
});
