import {expect,it} from 'vitest';
import {apiRouteVerdict} from '../lib/http-permissions';
it('admits only reads for saved-print/history and issuance recovery endpoints',()=>{
 const saved='/api/patients/41/prescriptions/saved', command='/api/prescriptions/commands/11111111-1111-4111-8111-111111111111';
 for(const method of ['GET','HEAD']) {
  expect(apiRouteVerdict(saved,method)).toEqual({kind:'registered',pattern:'/api/patients/[id]/prescriptions/saved',access:['admin','reception','doctor']});
  expect(apiRouteVerdict(command,method)).toEqual({kind:'registered',pattern:'/api/prescriptions/commands/[key]',access:['admin','doctor']});
 }
 for(const path of [saved,command]) for(const method of ['POST','PATCH','DELETE']) expect(apiRouteVerdict(path,method).kind).toBe('method-not-allowed');
});
