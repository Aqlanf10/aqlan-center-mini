import {expect,it} from 'vitest';
import {selectSpaceBaselineRefs} from '../lib/ortho-space-source-selection';
import type {SpacePlan} from '../lib/ortho-space-ledger';
const plan:SpacePlan={kind:'plan',arch:'upper',strategyRevisionId:1,baseline:{kind:'assessment_analysis',id:1,member:'upper',version:`sha256:${'a'.repeat(64)}`},gains:[],uses:[],contacts:[],rationale:'Synthetic',alternatives:'Synthetic'};
it('accepted1000-entry history plus exact replay keeps one selected versioned root',()=>{
 const plans=Array.from({length:1000},()=>structuredClone(plan));
 expect(selectSpaceBaselineRefs([...plans,structuredClone(plan)])).toEqual([plan.baseline]);
});
it('keeps distinct assessment member/version identity and detaches returned refs',()=>{
 const other={...plan,baseline:{...plan.baseline,member:'lower'}};
 const selected=selectSpaceBaselineRefs([plan,other]);expect(selected).toHaveLength(2);selected[0].member='changed';expect(plan.baseline.member).toBe('upper');
});
