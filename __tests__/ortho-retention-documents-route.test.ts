import {beforeEach,describe,it,expect,vi} from 'vitest';
import {GET} from '../app/api/ortho/[id]/retention-ledger/documents/route';
const state=vi.hoisted(()=>({session:{username:'synthetic',role:'doctor'} as {username:string;role:string}|null,access:vi.fn(),get:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:async()=>state.session}));
vi.mock('../lib/patient-access',()=>({canAccessPatient:state.access}));
vi.mock('../lib/ortho-retention-event-store',()=>({getRetentionDocumentChoices:state.get}));
const context={params:Promise.resolve({id:'2'})};
const read=(q='?patientId=1')=>GET(new Request(`http://localhost/api/ortho/2/retention-ledger/documents${q}`),context);
beforeEach(()=>{state.session={username:'synthetic',role:'doctor'};state.access.mockReset().mockResolvedValue(true);state.get.mockReset().mockResolvedValue({ok:true,items:[],nextCursor:null});});
describe('scoped retention documentary picker',()=>{
 it('authenticates before lookup',async()=>{state.session=null;const r=await read();expect(r.status).toBe(401);expect(state.get).not.toHaveBeenCalled();expect(r.headers.get('cache-control')).toBe('private, no-store');});
 it.each(['','?patientId=1&afterId=0','?patientId=1&afterId=01','?patientId=1&afterId=','?patientId=1&afterId=1&afterId=2','?patientId=1&url=private'])('rejects invalid scope/cursor %s',async q=>{expect((await read(q)).status).toBe(400);expect(state.get).not.toHaveBeenCalled();});
 it('binds current session and path with strict optional cursor',async()=>{const r=await read('?patientId=1&afterId=7');expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(state.get).toHaveBeenCalledWith({ok:true,session:state.session,patientId:1,orthoCaseId:2,afterId:7});});
 it('does not fabricate a cursor',async()=>{await read();expect(state.get).toHaveBeenCalledWith({ok:true,session:state.session,patientId:1,orthoCaseId:2});});
 it('denies access before reading document metadata',async()=>{state.access.mockResolvedValue(false);expect((await read()).status).toBe(403);expect(state.get).not.toHaveBeenCalled();});
 it('preserves image permission denial from locked authority',async()=>{state.get.mockResolvedValue({ok:false,status:403,code:'retention_images_restricted'});expect((await read()).status).toBe(403);});
 it('does not replace failed picker with empty success',async()=>{state.get.mockRejectedValue(Error('synthetic secret'));const r=await read();expect(r.status).toBe(500);expect(await r.text()).not.toContain('synthetic secret');});
});
