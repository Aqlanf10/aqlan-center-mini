import {beforeEach,describe,expect,it,vi} from 'vitest';
import {HTTP_PERMISSIONS,apiRouteVerdict,rolesAlwaysDenied} from '../lib/http-permissions';
import {admitJourney} from '../lib/ortho-journey-route';
import {ROLES,type Role} from '../lib/roles';
const state=vi.hoisted(()=>({session:null as {username:string;role:Role}|null}));
vi.mock('../lib/session',()=>({requireSession:async()=>state.session}));
vi.mock('../lib/patient-access',()=>({canAccessPatient:vi.fn()}));
const paths=['problem-sources/recovery','space-ledger','space-ledger/recovery','retention-ledger','retention-ledger/recovery','retention-ledger/documents'];
beforeEach(()=>{state.session=null;});
describe('journey ledger registration preserves route admission authority',()=>{
 it.each(paths)('registers exact methods and canonical role sets for %s',async suffix=>{
  const pattern=`/api/ortho/[id]/${suffix}`,path=`/api/ortho/17/${suffix}`,readRoles=['admin','reception','doctor'],writeRoles=['admin','doctor'];
  const readOnly=suffix.endsWith('/documents');
  expect(HTTP_PERMISSIONS[pattern]).toEqual(readOnly?{GET:readRoles}:{GET:readRoles,POST:writeRoles});
  expect(apiRouteVerdict(path,'GET')).toEqual({kind:'registered',pattern,access:readRoles});
  expect(apiRouteVerdict(path,'HEAD')).toEqual({kind:'registered',pattern,access:readRoles});
  expect(rolesAlwaysDenied(readRoles as Role[],ROLES)).toEqual(['cashier','accountant','assistant']);
  for(const role of ROLES){
   state.session={username:'synthetic',role};
   expect((await admitJourney(false)).ok).toBe(readRoles.includes(role));
   if(!readOnly)expect((await admitJourney(true)).ok).toBe(writeRoles.includes(role));
  }
  if(!readOnly){expect(apiRouteVerdict(path,'POST')).toEqual({kind:'registered',pattern,access:writeRoles});expect(rolesAlwaysDenied(writeRoles as Role[],ROLES)).toEqual(['reception','cashier','accountant','assistant']);}
  for(const method of readOnly?['POST','PUT','PATCH','DELETE']:['PUT','PATCH','DELETE'])expect(apiRouteVerdict(path,method)).toEqual({kind:'method-not-allowed',pattern,allow:readOnly?['GET','HEAD','OPTIONS']:['GET','HEAD','POST','OPTIONS']});
  expect(apiRouteVerdict(path,'OPTIONS')).toEqual({kind:'registered',pattern,access:null});
  expect(apiRouteVerdict(`${path}/extra`,'GET')).toEqual({kind:'unknown-route'});
 });
 it('continues requiring a staff session for reads and writes',async()=>{for(const write of [false,true]){const admitted=await admitJourney(write);expect(admitted.ok).toBe(false);if(!admitted.ok)expect(admitted.response.status).toBe(401);}});
});
