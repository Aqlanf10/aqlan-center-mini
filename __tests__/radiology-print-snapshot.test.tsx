import { expect,it,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SETTING_DEFAULTS } from '../lib/settings';
vi.mock('../lib/session',()=>({readSessionPayload:async()=>({credentialVersion:'synthetic'})}));
vi.mock('../components/RadiologyPrintButton',()=>({RadiologyPrintButton:()=>null}));
vi.mock('../lib/radiology-request-service',()=>({readRadiologyRequest:async()=>({id:'11111111-1111-4111-8111-111111111111',patientId:7,visitId:null,createdAt:'2026-11-01T09:00:00Z',snapshot:{version:1,patientId:7,visitId:null,doctorId:5,centerId:'22222222-2222-4222-8222-222222222222',patientName:'Synthetic snapshot patient',doctorName:'Synthetic snapshot clinician',clinicName:'Synthetic snapshot clinic',clinicAddress:'',clinicPhone:'',centerName:'Synthetic center',centerAddress:'Synthetic destination',examination:'Synthetic exam',region:'Synthetic area',notes:'',timeZone:'Asia/Aden'}})}));
import RadiologyPrint from '../app/print/radiology-request/[key]/page';
it('uses the shared identity without inventing missing snapshot contacts or default lead clinician',async()=>{
 const html=renderToStaticMarkup(await RadiologyPrint({params:Promise.resolve({key:'11111111-1111-4111-8111-111111111111'}),searchParams:Promise.resolve({patientId:'7'})}));
 expect(html).toContain('print-brand-identity');expect(html).toContain('Synthetic snapshot clinic');expect(html).toContain('Synthetic snapshot clinician');
 expect(html).not.toContain('class="clinic-sub"');
 for(const key of ['clinic.lead_doctor','clinic.lead_doctor_title','clinic.lead_doctor_credentials','clinic.address','clinic.phone'] as const){if(SETTING_DEFAULTS[key])expect(html.includes(SETTING_DEFAULTS[key])).toBe(false);}
 expect(html.match(/class="print-brand-header radiology-brand"/g)).toHaveLength(1);
});
