import {beforeEach,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {resolveClinicZone} from '../lib/clinicZone';
const state=vi.hoisted(()=>({zone:'Asia/Aden',instant:'2026-11-03T21:26:00.000Z',ageDate:'',record:null as Record<string,unknown>|null}));
const stored=()=>({id:42,patientId:123,status:'active',items:[],createdAt:state.instant,instructionsLang:'both',diagnosis:'Synthetic diagnosis',notes:'',prescribingDoctorName:'Synthetic clinician'});
vi.mock('@/lib/db',()=>({get CLINIC_TIME_ZONE(){return state.zone;},getPatient:async()=>({fullName:'Synthetic patient',patientNumber:'TEST',birthYear:2000,gender:'male'}),getPrescription:async()=>state.record,getPrescriptionPrintSettings:async()=>({'backup.schedule_timezone':'Pacific/Honolulu'})}));
vi.mock('@/lib/prescription-print-access',()=>({canPrintSavedPrescription:async()=>true}));
vi.mock('@/lib/patient-access',()=>({canAccessPatient:async()=>true}));
vi.mock('@/lib/patient',()=>({ageFromBirthYear:(_year:number,date:string)=>{state.ageDate=date;return 26;},ageText:()=>26,GENDER_LABEL:{male:'male'}}));
vi.mock('@/lib/reminders',()=>({friendlyDateLong:(date:string)=>date}));
vi.mock('@/components/PrintHeader',()=>({PrintHeader:()=>null,PrintFooter:()=>null}));
vi.mock('@/components/PrintButton',()=>({PrintButton:()=>null}));
vi.mock('@/lib/session',()=>({requireSession:async()=>({role:'doctor',username:'synthetic'})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
import Page from '../app/print/prescription/[id]/page';
beforeEach(()=>{state.zone='Asia/Aden';state.instant='2026-11-03T21:26:00.000Z';state.ageDate='';state.record=null;});
it.each([
 ['Asia/Aden','2026-11-03T20:59:59.999Z','2026-11-03'],
 ['Asia/Aden','2026-11-03T21:00:00.000Z','2026-11-04'],
 ['Asia/Aden','2026-11-03T21:26:00.000Z','2026-11-04'],
 ['Asia/Aden','2026-12-31T21:00:00.000Z','2027-01-01'],
 ['America/New_York','2026-03-08T04:59:59.999Z','2026-03-07'],
 ['America/New_York','2026-03-08T05:00:00.000Z','2026-03-08'],
 ['America/New_York','2026-03-08T07:00:00.000Z','2026-03-08'],
 ['America/New_York','2026-11-01T03:59:59.999Z','2026-10-31'],
 ['America/New_York','2026-11-01T04:00:00.000Z','2026-11-01'],
 ['America/New_York','2026-11-01T06:00:00.000Z','2026-11-01'],
 ['UTC','2026-11-03T21:26:00.000Z','2026-11-03'],
 ['Asia/Tokyo','2026-11-03T15:00:00.000Z','2026-11-04'],
])('saved page uses clinic calendar %s at %s',async(zone,instant,date)=>{
 state.zone=zone;state.instant=instant;state.record=stored();const before=JSON.stringify(state.record);
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({id:'123'}),searchParams:Promise.resolve({rx:'42',date:'1900-01-01'})}));
 expect(html).toContain(date);expect(state.ageDate).toBe(date);expect(html).not.toContain('1900-01-01');expect(JSON.stringify(state.record)).toBe(before);
});
it('uses the existing configured-zone resolver rather than backup scheduling or a new hardcode',()=>{
 expect(resolveClinicZone(' America/New_York ')).toBe('America/New_York');
 expect(resolveClinicZone('')).toBe('Asia/Aden');expect(resolveClinicZone('Invalid/Zone')).toBe('Asia/Aden');
});
it.each(['active','void'])('restores approved frame while retaining saved %s identity and all clinical text',async(status)=>{
 state.record={...stored(),status,voidReason:'SYN-VOID-REASON',items:[{name:'SYN-MED',dose:'100 mg/5 mL',form:'Suspension',selection:{amount:'7.5 mL (150 mg)'},frequency:'3 times daily',duration:'5 days',instructions:'تعليمات محفوظة كاملة',instructionsEn:'Complete saved instructions'}],notes:'SYN-NOTES'};
 const before=JSON.stringify(state.record);
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({id:'123'}),searchParams:Promise.resolve({rx:'42'})}));
 expect(html).toContain('sheet sheet-a5 prescription-approved-a5');expect(html).toContain('℞');expect(html).toContain('margin-top:12mm');expect(html).toContain('height:10mm');
 const header=html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1]??'';
 for(const value of ['Synthetic patient','TEST','Synthetic clinician','Rx #42','2026-11-04'])expect(header).toContain(value);
 for(const value of ['SYN-MED','100 mg/5 mL','7.5 mL (150 mg)','3 times daily','5 days','تعليمات محفوظة كاملة','Complete saved instructions','SYN-NOTES'])expect(html).toContain(value);
 if(status==='void'){expect(header).toContain('VOID');expect(html).toContain('SYN-VOID-REASON');}else expect(header).not.toContain('VOID');
 expect(JSON.stringify(state.record)).toBe(before);
});
