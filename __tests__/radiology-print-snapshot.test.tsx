import { beforeEach,expect,it,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SETTING_DEFAULTS } from '../lib/settings';
const fx=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:fx.session}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('SYNTHETIC_NOT_FOUND');}}));
vi.mock('../components/RadiologyPrintButton',()=>({RadiologyPrintButton:()=>null}));
vi.mock('../lib/radiology-request-service',()=>({readRadiologyRequest:fx.read}));
const record={id:'11111111-1111-4111-8111-111111111111',patientId:7,visitId:null,createdAt:'2026-11-01T09:00:00Z',snapshot:{version:1,patientId:7,visitId:null,doctorId:5,centerId:'22222222-2222-4222-8222-222222222222',patientName:'Synthetic snapshot patient',doctorName:'Synthetic snapshot clinician',clinicName:'Synthetic snapshot clinic',clinicAddress:'',clinicPhone:'',centerName:'Synthetic center',centerAddress:'Synthetic destination',examination:'Synthetic exam',region:'Synthetic area',notes:'',timeZone:'Asia/Aden'}};
const currentSession={username:'synthetic-clinician',credentialVersion:'synthetic'};
const props=()=>({params:Promise.resolve({key:record.id}),searchParams:Promise.resolve({patientId:'7'})});
beforeEach(()=>{fx.session.mockReset().mockResolvedValue(currentSession);fx.read.mockReset().mockResolvedValue(record);});
import RadiologyPrint from '../app/print/radiology-request/[key]/page';
it('uses the shared identity without inventing missing snapshot contacts or default lead clinician',async()=>{
 const html=renderToStaticMarkup(await RadiologyPrint({params:Promise.resolve({key:'11111111-1111-4111-8111-111111111111'}),searchParams:Promise.resolve({patientId:'7'})}));
 expect(html).toContain('print-brand-identity');expect(html).toContain('Synthetic snapshot clinic');expect(html).toContain('Synthetic snapshot clinician');
 expect(html).not.toContain('class="clinic-sub"');
 for(const key of ['clinic.lead_doctor','clinic.lead_doctor_title','clinic.lead_doctor_credentials','clinic.address','clinic.phone'] as const){if(SETTING_DEFAULTS[key])expect(html.includes(SETTING_DEFAULTS[key])).toBe(false);}
 expect(html.match(/class="print-brand-header radiology-brand"/g)).toHaveLength(1);
});

it('awaits the HTML bootstrap before starting the clinical read transaction',async()=>{
 let release!:(value:typeof currentSession)=>void;
 fx.session.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 const pending=RadiologyPrint(props());
 await Promise.resolve();expect(fx.read).not.toHaveBeenCalled();
 release(currentSession);await pending;
 expect(fx.read).toHaveBeenCalledExactlyOnceWith(currentSession,record.id,7);
});
it.each([null,{credentialVersion:''}])('does not read when bootstrap has no current credential',async session=>{
 fx.session.mockResolvedValueOnce(session);
 await expect(RadiologyPrint(props())).rejects.toThrow('SYNTHETIC_NOT_FOUND');
 expect(fx.read).not.toHaveBeenCalled();
});
it('does not read if HTML bootstrap rejects',async()=>{
 fx.session.mockRejectedValueOnce(new Error('synthetic bootstrap failure'));
 await expect(RadiologyPrint(props())).rejects.toThrow('synthetic bootstrap failure');
 expect(fx.read).not.toHaveBeenCalled();
});
it.each(['missing receipt','revoked grant','changed patient scope'])('still fails closed for %s after bootstrap',async reason=>{
 fx.read.mockRejectedValueOnce(new Error(reason));
 await expect(RadiologyPrint(props())).rejects.toThrow('SYNTHETIC_NOT_FOUND');
 expect(fx.read).toHaveBeenCalledExactlyOnceWith(currentSession,record.id,7);
});
