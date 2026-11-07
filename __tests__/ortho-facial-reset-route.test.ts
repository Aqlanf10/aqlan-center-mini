import { expect,it,vi } from 'vitest';
import { POST } from '../app/api/settings/reset/route';
import { RESET_CONFIRM_PHRASE } from '../lib/clinic-reset';
const effects=vi.hoisted(()=>({remove:vi.fn(),backup:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:async()=>({username:'synthetic-admin',role:'admin'})}));
vi.mock('../lib/auth',()=>({verifyPassword:async()=>true}));
vi.mock('../lib/db',async()=>{
 const {ProtectedOrthoFacialHistoryError}=await import('../lib/clinic-reset');
 return {findUserByUsername:async()=>({passwordHash:'synthetic'}),clinicResetPreview:async()=>({}),resetClinicData:async()=>{throw new ProtectedOrthoFacialHistoryError();}};
});
vi.mock('../lib/files',()=>({removeFileByKey:effects.remove}));
vi.mock('../lib/manual-backup',()=>({runVerifiedManualBackup:effects.backup}));
it('reports protected facial history as a conflict without deleting files',async()=>{
 const result=await POST(new Request('http://localhost/api/settings/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phrase:RESET_CONFIRM_PHRASE,password:'synthetic-only'})}));
 if(!result)throw Error("Missing reset response");
 expect(result.status).toBe(409);expect(await result.json()).toMatchObject({code:'protected-ortho-facial-history'});
 expect(effects.remove).not.toHaveBeenCalled();expect(effects.backup).not.toHaveBeenCalled();
});
