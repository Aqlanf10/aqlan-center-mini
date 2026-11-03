import {beforeEach,it,expect,vi} from 'vitest';
import {NextResponse} from 'next/server';
import {issuePrescriptionTransaction} from '../lib/prescription-issuance';
import * as dose from '../lib/medication-dose-provenance';
import fixtures from './legacy-dose-issued-fixtures.json';
import type {PrescriptionDraft} from '../lib/prescription';
const state=vi.hoisted(()=>({receipt:null as any,denySession:false,denyPatient:false,saves:[] as any[],issueCalls:0}));
const query=vi.hoisted(()=>vi.fn(async(sql:string,args:any[]=[])=>{
 if(sql.startsWith('INSERT INTO prescription_issuance_commands')){state.receipt??={actor_user_id:args[1],actor_username:args[2],patient_id:args[3],visit_id:args[4],payload_sha256:args[5],prescription_id:null};return {rows:[]};}
 if(sql.includes('SELECT * FROM prescription_issuance_commands'))return {rows:[state.receipt]};
 if(sql.startsWith('SELECT id, kind'))return {rows:[{id:3,kind:'doctor',is_active:true,name:'Verified clinician'}]};
 if(sql.startsWith('SELECT patient_id'))return {rows:[{patient_id:1}]};
 if(sql.startsWith('SELECT medical_alert'))return {rows:[{medical_alert:null}]};
 if(sql.startsWith('UPDATE prescription_issuance_commands')){state.receipt.prescription_id=args[1];return {rows:[]};}
 throw Error('Unhandled synthetic SQL: '+sql);
}));
vi.mock('../lib/db',()=>({ensureSchema:vi.fn(async()=>{}),getPool:()=>({}),findUserByUsername:vi.fn(async()=>({role:'doctor',partyId:3})),getPrescription:vi.fn(async()=>({id:77,createdAt:'2026-11-03',status:'active',patientId:1,prescribingDoctorPartyId:3})),savePrescription:vi.fn(async(draft:any)=>{state.saves.push(structuredClone(draft));return {id:77,createdAt:'2026-11-03'};})}));
vi.mock('../lib/transactions',()=>({withTransaction:async(_pool:unknown,fn:any)=>fn({query})}));
vi.mock('../lib/session',()=>({revalidateSessionInTransaction:async(session:any)=>state.denySession?null:session}));
vi.mock('../lib/patient-access',()=>({canAccessPatient:async()=>!state.denyPatient}));
vi.mock('../lib/prescription-owner-transaction',()=>({admitPrescriptionOwnerInTransaction:async()=>({message:'Owner unavailable',code:'owner_unavailable'})}));
const session=()=>({userId:9,username:'synthetic-doctor',role:'doctor',expiresAt:Date.now()+60000}) as any;
const draft=()=>structuredClone(fixtures.rows[0].draft) as PrescriptionDraft;
const run=(d=draft())=>issuePrescriptionTransaction({session:session(),key:'11111111-1111-4111-8111-111111111111',draft:d},async({persist})=>{state.issueCalls++;return NextResponse.json(await persist(),{status:201});});
beforeEach(()=>{vi.restoreAllMocks();state.receipt=null;state.denySession=false;state.denyPatient=false;state.saves=[];state.issueCalls=0;query.mockClear();});
it('actual issuer checks old calculation, saves original provenance, then replays without issuing again',async()=>{const d=draft(),before=JSON.stringify(d);expect((await run(d)).status).toBe(201);expect(state.saves).toHaveLength(1);expect(state.saves[0].items).toEqual(d.items);expect(JSON.stringify(d)).toBe(before);const spy=vi.spyOn(dose,'medicationDoseProvenanceProblem').mockReturnValue('new future policy rejection');const response=await run(d);expect(response.status).toBe(201);expect((await response.json()).replayed).toBe(true);expect(spy).not.toHaveBeenCalled();expect(state.saves).toHaveLength(1);expect(state.issueCalls).toBe(1);});
it('retains fresh session and patient access checks before compatibility or replay',async()=>{state.denySession=true;expect((await run()).status).toBe(403);expect(state.saves).toHaveLength(0);state.denySession=false;state.denyPatient=true;expect((await run()).status).toBe(403);expect(state.saves).toHaveLength(0);state.denyPatient=false;expect((await run()).status).toBe(201);state.denySession=true;expect((await run()).status).toBe(403);expect(state.saves).toHaveLength(1);});
it('keeps same-command conflict checks and rejects altered payloads',async()=>{expect((await run()).status).toBe(201);const d=draft();d.items[0].instructions='Altered';const response=await run(d);expect(response.status).toBe(409);expect((await response.json()).code).toBe('issuance_command_conflict');expect(state.saves).toHaveLength(1);});
it('rejects a changed legacy reference before save and does not bypass ordinary safety callback',async()=>{const d=draft();d.items[0].selection!.doseReview={version:1,mode:'reference-only',profileId:'amoxicillin-sdcep',referenceVersion:'2026-11-01.expansion.1'};expect((await run(d)).status).toBe(409);expect(state.saves).toHaveLength(0);state.receipt=null;const response=await issuePrescriptionTransaction({session:session(),key:'11111111-1111-4111-8111-111111111111',draft:draft()},async()=>NextResponse.json({code:'critical_safety_block'},{status:409}));expect(response.status).toBe(409);expect(state.saves).toHaveLength(0);});
it('ordinary legacy manual reference-only issuance does not acquire calculated provenance',async()=>{const d=draft(),old=d.items[0].selection!.doseReview!;d.items[0].selection!.doseReview={version:old.version,mode:'reference-only',profileId:old.profileId,referenceVersion:old.referenceVersion};d.items[0].instructions='Clinician-authored manual instructions';expect((await run(d)).status).toBe(201);expect(state.saves[0].items[0]).toEqual(d.items[0]);expect(state.saves[0].items[0].selection.doseReview).not.toHaveProperty('input');});
it('compatibility cannot bypass expired authority or a different prescribing doctor',async()=>{const expired={...session(),expiresAt:Date.now()-1};const response=await issuePrescriptionTransaction({session:expired,key:'11111111-1111-4111-8111-111111111111',draft:draft()},async({persist})=>NextResponse.json(await persist(),{status:201}));expect(response.status).toBe(403);expect(state.saves).toHaveLength(0);state.receipt=null;const d=draft();d.prescribingDoctorPartyId=4;expect((await run(d)).status).toBe(403);expect(state.saves).toHaveLength(0);});
it('existing receipt cannot replay under a different actor even when dose compatibility holds',async()=>{expect((await run()).status).toBe(201);const response=await issuePrescriptionTransaction({session:{...session(),userId:10,username:'another-doctor'},key:'11111111-1111-4111-8111-111111111111',draft:draft()},async({persist})=>NextResponse.json(await persist(),{status:201}));expect(response.status).toBe(409);expect(state.saves).toHaveLength(1);});
