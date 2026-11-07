import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:state.session}));
vi.mock('../lib/patient-access',()=>({canAccessPatient:vi.fn()}));
import {admitJourney} from '../lib/ortho-journey-route';
beforeEach(()=>state.session.mockReset());
it('the recognized route wrapper always requires a current session and refuses unauthenticated reads',async()=>{
 state.session.mockResolvedValue(null);const result=await admitJourney(false);
 expect(state.session).toHaveBeenCalledOnce();expect(result.ok).toBe(false);if(!result.ok)expect(result.response.status).toBe(401);
});
it.each(['cashier','accountant','assistant','patient'])('refuses unsupported %s even for read-only media routes',async role=>{
 state.session.mockResolvedValue({userId:7,role});const result=await admitJourney(false);
 expect(state.session).toHaveBeenCalledOnce();expect(result.ok).toBe(false);if(!result.ok)expect(result.response.status).toBe(403);
});
it('allows reception reads but never documentation writes',async()=>{
 state.session.mockResolvedValue({userId:7,role:'reception'});
 expect((await admitJourney(false)).ok).toBe(true);const write=await admitJourney(true);expect(write.ok).toBe(false);if(!write.ok)expect(write.response.status).toBe(403);
});
