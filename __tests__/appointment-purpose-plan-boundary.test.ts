import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../lib/db',()=>({CLINIC_TIME_ZONE:'Asia/Aden',getSettings:vi.fn(),listPatientPlans:vi.fn(),listPatientPlannedVisits:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:vi.fn()}));
vi.mock('../lib/patient-access',()=>({canAccessPatient:vi.fn(),canViewPatientMoney:vi.fn()}));
vi.mock('../lib/appointment-purpose-read',()=>({readPatientPlannedVisitPurposes:vi.fn()}));
import {GET} from '../app/api/patients/[id]/plans/route';
import {getSettings,listPatientPlans,listPatientPlannedVisits} from '../lib/db';
import {requireSession} from '../lib/session';
import {canAccessPatient,canViewPatientMoney} from '../lib/patient-access';
import {readPatientPlannedVisitPurposes} from '../lib/appointment-purpose-read';
const context={params:Promise.resolve({id:'19'})};
const get=()=>GET(new Request('http://example.test/api/patients/19/plans'),context);
const session=(role:string)=>({username:'synthetic',role,userId:1,expiresAt:Date.now()+60000});
beforeEach(()=>{
 vi.resetAllMocks();
 vi.mocked(getSettings).mockResolvedValue({} as never);
 vi.mocked(listPatientPlans).mockResolvedValue([]);
 vi.mocked(listPatientPlannedVisits).mockResolvedValue([]);
 vi.mocked(canViewPatientMoney).mockResolvedValue(false);
 vi.mocked(canAccessPatient).mockResolvedValue(true);
 vi.mocked(readPatientPlannedVisitPurposes).mockResolvedValue({ok:true,byPlannedVisit:new Map()});
});
describe('purpose projection is not an assistant same-day patient-access grant',()=>{
 it('denies assistant even if generic today-visit access would have returned true; no plan query runs',async()=>{
  vi.mocked(requireSession).mockResolvedValue(session('assistant') as never);
  const response=await get();
  expect(response.status).toBe(403);
  expect(canAccessPatient).not.toHaveBeenCalled();
  expect(listPatientPlans).not.toHaveBeenCalled();
  expect(listPatientPlannedVisits).not.toHaveBeenCalled();
  expect(readPatientPlannedVisitPurposes).not.toHaveBeenCalled();
 });
 it.each(['admin','reception','doctor'])('preserves %s path under existing scope policy',async role=>{
  vi.mocked(requireSession).mockResolvedValue(session(role) as never);
  const response=await get();expect(response.status).toBe(200);
  expect(canAccessPatient).toHaveBeenCalledWith(expect.objectContaining({role}),19,role==='doctor'?'canViewPlans':undefined);
  expect(readPatientPlannedVisitPurposes).toHaveBeenCalledTimes(1);
 });
 it('denies doctor without canViewPlans before the new purpose reader',async()=>{
  vi.mocked(requireSession).mockResolvedValue(session('doctor') as never);
  vi.mocked(canAccessPatient).mockResolvedValue(false);
  const response=await get();expect(response.status).toBe(403);
  expect(readPatientPlannedVisitPurposes).not.toHaveBeenCalled();
 });
});
