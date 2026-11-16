import { beforeEach, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({session:{username:'current-admin',role:'admin'} as {username:string;role:string}|null,write:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:async()=>mock.session}));
// The catalog precheck reads the current account (owner decision 6839071994): an active administrator here.
vi.mock('../lib/db',()=>({getSettings:async()=>({}),readStoredSettings:async()=>new Map(),saveSettingsAudited:mock.write,
 findUserByUsername:async(username:string)=>mock.session&&username===mock.session.username?{id:1,username,role:mock.session.role,isActive:true,permissions:{}}:null}));
import { PATCH, POST } from '../app/api/settings/route';
import { MEDICATION_CATALOG_KEY as KEY, EMPTY_MEDICATION_CATALOG } from '../lib/medication-catalog';
const req=(body:unknown)=>new Request('https://synthetic.test/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{mock.session={username:'current-admin',role:'admin'};mock.write.mockReset().mockResolvedValue({ok:true,changed:[KEY]});});
it.each([undefined,'old-admin',''])('rejects absent/mismatching catalogue principal %s before any writer',async expected=>{
 const patch=await PATCH(req({[KEY]:EMPTY_MEDICATION_CATALOG,__versions:{[KEY]:null},__reason:'test',__expectedActor:expected}));expect(patch.status).toBe(409);
 const reset=await POST(req({action:'reset',keys:[KEY],__versions:{[KEY]:null},reason:'test',__expectedActor:expected}));expect(reset.status).toBe(409);expect(mock.write).not.toHaveBeenCalled();
});
it('keeps server session as audit identity, never supplied protocol metadata',async()=>{
 const response=await PATCH(req({[KEY]:EMPTY_MEDICATION_CATALOG,__versions:{[KEY]:null},__reason:'test',__expectedActor:'current-admin'}));expect(response.status).toBe(200);
 expect(mock.write).toHaveBeenCalledWith(expect.objectContaining({actor:'current-admin',actorRole:'admin',session:mock.session,values:{[KEY]:EMPTY_MEDICATION_CATALOG}}));expect(mock.write.mock.calls[0][0].values).not.toHaveProperty('__expectedActor');
});
it('matching principal does not bypass a revoked credential session or settings permission',async()=>{
 mock.session=null;expect((await PATCH(req({[KEY]:EMPTY_MEDICATION_CATALOG,__expectedActor:'current-admin'}))).status).toBe(401);
 mock.session={username:'current-admin',role:'doctor'};expect((await PATCH(req({[KEY]:EMPTY_MEDICATION_CATALOG,__expectedActor:'current-admin'}))).status).toBe(403);expect(mock.write).not.toHaveBeenCalled();
});
it('allows matched generic reset protocol to reach the same guarded writer',async()=>{expect((await POST(req({action:'reset',keys:[KEY],__versions:{[KEY]:null},reason:'test',__expectedActor:'current-admin'}))).status).toBe(200);expect(mock.write).toHaveBeenCalledWith(expect.objectContaining({mode:'reset',session:mock.session}));});
it('does not require new protocol metadata for unrelated settings',async()=>{expect((await PATCH(req({'clinic.name':'Synthetic clinic',__versions:{'clinic.name':null}}))).status).toBe(200);});

it.each([null,[],"text",42])('rejects malformed settings body without writer calls: %j',async body=>{expect((await PATCH(req(body))).status).toBe(400);expect((await POST(req(body))).status).toBe(400);expect(mock.write).not.toHaveBeenCalled();});

it('returns a permission refusal when in-transaction session authority was revoked after admission',async()=>{mock.write.mockRejectedValueOnce(new Error('MEDICATION_CATALOG_AUTHORITY_REQUIRED'));expect((await PATCH(req({[KEY]:EMPTY_MEDICATION_CATALOG,__versions:{[KEY]:null},__reason:'test',__expectedActor:'current-admin'}))).status).toBe(403);});

it('retains catalogue session authority in mixed PATCH and reset batches',async()=>{
 const values={[KEY]:EMPTY_MEDICATION_CATALOG,'clinic.name':'Synthetic clinic'};
 const versions={[KEY]:null,'clinic.name':null};
 expect((await PATCH(req({...values,__versions:versions,__reason:'test',__expectedActor:'current-admin'}))).status).toBe(200);
 expect(mock.write).toHaveBeenLastCalledWith(expect.objectContaining({values,session:mock.session}));
 expect((await POST(req({action:'reset',keys:Object.keys(values),__versions:versions,reason:'test',__expectedActor:'current-admin'}))).status).toBe(200);
 expect(mock.write).toHaveBeenLastCalledWith(expect.objectContaining({mode:'reset',session:mock.session}));
});
