import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/session',()=>({requireSession:mocks.session}));
vi.mock('@/lib/ortho-session-billing-review',async()=>{const actual=await vi.importActual<typeof import('../lib/ortho-session-billing-review')>('../lib/ortho-session-billing-review');return {...actual,getSessionBillingReview:mocks.read};});
import {GET} from '../app/api/patients/[id]/ortho-billing-decisions/route';
import {SessionBillingReviewError} from '../lib/ortho-session-billing-review';
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue({userId:4,role:'admin'});mocks.read.mockResolvedValue({entries:[]});});
const get=(query='orthoCaseId=2',id='1')=>GET(new Request(`http://localhost/api/patients/${id}/ortho-billing-decisions?${query}`),{params:Promise.resolve({id})});
it('uses server session and exact query with private no-store',async()=>{const r=await get();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(mocks.read).toHaveBeenCalledWith({patientId:1,orthoCaseId:2,session:{userId:4,role:'admin'}});});
it.each(['','orthoCaseId=2&actorId=7','orthoCaseId=2&orthoCaseId=2','orthoCaseId=0','orthoCaseId=2.5'])('rejects invalid pins %s',async q=>{expect((await get(q)).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();});
it.each([401,403,404,409] as const)('withholds payload on %s',async status=>{mocks.read.mockRejectedValue(new SessionBillingReviewError(status,'private details'));const r=await get();expect(r.status).toBe(status);expect(await r.text()).not.toContain('private details');});
it('denies absent session',async()=>{mocks.session.mockResolvedValue(null);expect((await get()).status).toBe(401);expect(mocks.read).not.toHaveBeenCalled();});

import {restrictedRouteAllowed} from '../lib/role-routes';
it.each(['cashier','accountant'])('limits %s proxy allowance to ledger-granted reads',role=>{const path='/api/patients/1/ortho-billing-decisions';expect(restrictedRouteAllowed(role,path,'GET',{viewPatientLedger:true})).toBe(true);expect(restrictedRouteAllowed(role,path,'POST',{viewPatientLedger:true})).toBe(false);expect(restrictedRouteAllowed(role,path+'/','GET',{viewPatientLedger:false})).toBe(false);});
