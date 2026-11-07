import {describe,it,expect} from 'vitest';
import {buildComparison,type StagePhoto} from '../lib/ortho-photos';
const photo=(id:number,date:string|null,uploadedAt='2026-11-06T00:00:00Z'):StagePhoto=>({id,stage:'progress',view:'intraoral_frontal',takenOn:date,uploadedAt});
describe('acquisition evidence, never upload chronology',()=>{
 it('does not choose an undated image as latest based on upload time',()=>{
  expect(buildComparison([photo(1,'2020-01-01'),photo(2,null)]).find(c=>c.stage==='progress')?.featured).toBeNull();
 });
});

describe('representative selection limits',()=>{
 it('preserves earliest initial and latest later acquisition dates without input order dependence',()=>{
  const rows=[photo(5,'2024-01-01'),photo(9,'2025-01-01'),{...photo(3,'2023-01-01'),stage:'initial' as const},{...photo(4,'2024-01-01'),stage:'initial' as const}];
  const result=buildComparison(rows);expect(result[0].featured?.id).toBe(3);expect(result[1].featured?.id).toBe(9);
  expect(buildComparison([...rows].reverse())).toEqual(result);
 });
 it('never substitutes changed upload timestamps for acquisition dates',()=>{
  const rows=[photo(1,'2020-01-01'),photo(2,null)];
  const chosen=(r:StagePhoto[])=>buildComparison(r).map(c=>[c.featured?.id,c.selection]);
  expect(chosen(rows)).toEqual(chosen(rows.map(p=>({...p,uploadedAt:'1900-01-01T00:00:00Z'}))));
 });
 it('requires explicit choice for tied winning dates, not arbitrary id chronology',()=>{
  const c=buildComparison([photo(100,'2024-01-01'),photo(2,'2024-01-01')])[1];
  expect(c.featured).toBeNull();expect(c.selection).toBe('ambiguous_date');expect(c.candidates.map(p=>p.id)).toEqual([2,100]);
 });
 it('labels a sole unknown acquisition date; invalid date cannot become dated evidence',()=>{
  expect(buildComparison([photo(1,null)])[1].selection).toBe('single_unknown_date');
  expect(buildComparison([photo(1,'2023-02-29'),photo(2,'2024-01-01')])[1].featured).toBeNull();
 });
 it('preserves view preference, not cross-view temporal claims',()=>{
  const c=buildComparison([photo(1,'2020-01-01'),{...photo(2,'2026-01-01'),view:'profile'}])[1];
  expect(c.featured?.id).toBe(1);expect(c.candidates).toHaveLength(2);
 });
 it('does not assign unknown stage to progress or mutate inputs',()=>{
  const rows=[{...photo(1,null),stage:null}];const original=structuredClone(rows);
  expect(buildComparison(rows).every(c=>c.count===0)).toBe(true);expect(rows).toEqual(original);
 });
});
