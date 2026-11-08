import {beforeEach,expect,it,vi} from 'vitest';
import {apiRouteVerdict} from '../lib/http-permissions';
const state=vi.hoisted(()=>({session:{userId:7,username:'Synthetic',role:'doctor'} as Record<string,unknown>|null,access:true,read:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:async()=>state.session}));vi.mock('../lib/patient-access',()=>({canAccessPatient:async()=>state.access}));
vi.mock('../lib/ortho-study-longitudinal-store',()=>({getStudyLongitudinalEligibility:state.read}));
import {GET} from '../app/api/ortho/[id]/case-study/longitudinal/route';
const context={params:Promise.resolve({id:'41'})};const request=(query='?patientId=19&revisionId=101')=>new Request(`http://localhost/api/ortho/41/case-study/longitudinal${query}`);
beforeEach(()=>{state.session={userId:7,username:'Synthetic',role:'doctor'};state.access=true;state.read.mockReset();state.read.mockResolvedValue({ok:true});});
it('registers read-only clinical scope and private no-store response',async()=>{
 expect(apiRouteVerdict('/api/ortho/41/case-study/longitudinal','GET')).toMatchObject({kind:'registered',access:['admin','reception','doctor']});expect(apiRouteVerdict('/api/ortho/41/case-study/longitudinal','POST').kind).not.toBe('registered');
 const response=await GET(request(),context);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(state.read).toHaveBeenCalledWith(expect.objectContaining({patientId:19,orthoCaseId:41,revisionId:101}));
});
it.each([null,'assistant','accountant','cashier'])('denies unsupported session %s before source access',async role=>{
 state.session=role===null?null:{userId:7,role};expect((await GET(request(),context)).status).toBe(role===null?401:403);expect(state.read).not.toHaveBeenCalled();
});
it('denies cross-patient and malformed/duplicate query scopes',async()=>{
 state.access=false;expect((await GET(request(),context)).status).toBe(403);state.access=true;
 for(const query of ['', '?patientId=19','?patientId=19&revisionId=0','?patientId=19&revisionId=101&revisionId=102','?patientId=19&revisionId=101&sourceId=91'])expect((await GET(request(query),context)).status).toBe(400);
 expect(state.read).not.toHaveBeenCalled();
});
