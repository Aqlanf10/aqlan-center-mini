import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../lib/ortho-case-study-store',()=>({getOrthoCaseStudy:state.read}));
import {getStudyLongitudinalEligibility} from '../lib/ortho-study-longitudinal-store';
import {syntheticLongitudinalStudy} from './fixtures/ortho-study-longitudinal';
const saved=syntheticLongitudinalStudy(),input={patientId:19,orthoCaseId:41,revisionId:101,session:{userId:7,username:'Synthetic',role:'doctor' as const,expiresAt:4102444800000}};
beforeEach(()=>state.read.mockReset());
it('uses only the canonical current-authority selected immutable revision reader',async()=>{
 state.read.mockResolvedValue({ok:true,patientId:19,orthoCaseId:41,clinicalCaseId:51,revision:saved});
 expect(await getStudyLongitudinalEligibility(input)).toMatchObject({ok:true,revisionId:101,stages:expect.any(Array)});expect(state.read).toHaveBeenCalledExactlyOnceWith(input);
});
it.each([401,403,409])('propagates canonical authority/source refusal %s without a fallback',async status=>{
 const failure={ok:false,status,code:'synthetic_source_denied'};state.read.mockResolvedValue(failure);expect(await getStudyLongitudinalEligibility(input)).toEqual(failure);
});
it('refuses missing or substituted selected versions',async()=>{
 for(const revision of [null,{...saved,id:102}]){state.read.mockResolvedValue({ok:true,...input,clinicalCaseId:51,revision});expect(await getStudyLongitudinalEligibility(input)).toMatchObject({ok:false,status:404});}
});
