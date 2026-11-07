import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {createSessionToken,sessionCredentialVersion,type SessionPayload} from '../../lib/auth';
import {openPeriodontalFixture} from './_periodontal-fixture';
import {appendFacialAnalysis,getFacialAnalysis} from '../../lib/ortho-facial-store';
import {getFacialHistoryPage} from '../../lib/ortho-facial-history-store';
import {verifyFacialHistoryPage} from '../../lib/ortho-facial-history';
import {syntheticFace} from '../fixtures/ortho-facial-analysis';
import type {FacialRevision} from '../../lib/ortho-facial-records';
const media=vi.hoisted(()=>({bytes:Buffer.alloc(0),onRead:null as (()=>void)|null,token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:media.token}:undefined}),headers:async()=>new Headers()}));
vi.mock('@/lib/files',()=>({readFileByKeyBounded:async()=>{media.onRead?.();return media.bytes;}}));
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>,session:SessionPayload,patientId:number,orthoCaseId:number,clinicalCaseId:number,documentId:number,all:FacialRevision[];
const owner=()=>({patientId,orthoCaseId,clinicalCaseId,session});
const request=(anchor:FacialRevision)=>({...owner(),documentId,beforeRevisionId:anchor.id,beforeContentHash:anchor.contentHash});
beforeAll(async()=>{
 vi.stubEnv('SESSION_SECRET','synthetic-facial-history-only-at-least32');f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();
 const password='synthetic-history-password',userId=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('history-admin','Synthetic history',$1,'admin') RETURNING id",[password])).rows[0].id;
 session={userId,username:'history-admin',role:'admin',credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+3600000};media.token=createSessionToken(session);
 patientId=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic history patient') RETURNING id",[randomUUID()])).rows[0].id;
 orthoCaseId=(await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[patientId])).rows[0].id;
 clinicalCaseId=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 media.bytes=await sharp({create:{width:1000,height:1200,channels:3,background:'#667788'}}).png().toBuffer();const hash=createHash('sha256').update(media.bytes).digest('hex');
 documentId=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view) VALUES($1,$2,'Synthetic history image','image/png',$3,$4,'synthetic-only','synthetic','extraoral_frontal') RETURNING id",[patientId,orthoCaseId,media.bytes.length,hash])).rows[0].id;
 all=[];const content=syntheticFace();content.image.sha256=hash;
 for(let i=1;i<=65;i++){const saved=await appendFacialAnalysis({...owner(),command:{schemaVersion:1,clientRequestId:randomUUID(),documentId,expectedHeadId:all.at(-1)?.id??null,reason:`Synthetic revision ${i}`,content}});if(!saved.ok)throw Error(saved.code);all.push(saved.revision);}
},60000);
afterAll(async()=>{vi.useRealTimers();await f?.close();vi.unstubAllEnvs();});
it('documents the prior30-entry visibility boundary',async()=>{const latest=await getFacialAnalysis({...owner(),documentId});if(!latest.ok)throw Error(latest.code);expect(latest.history).toHaveLength(30);expect(latest.historyTruncated).toBe(true);expect(latest.history.some(r=>r.id===all[0].id)).toBe(process.env.FACIAL_HISTORY_RED_PROBE==='1');});
it('retrieves all older contiguous saved records across exact boundaries without modifying them',async()=>{
 const before=(await f.pool.query('SELECT id,content_sha256,command,results FROM ortho_facial_revisions ORDER BY version')).rows;
 const first=await getFacialHistoryPage(request(all[35]));if(!first.ok)throw Error(first.code);expect(first.history.map(r=>r.version)).toEqual(Array.from({length:30},(_,i)=>35-i));expect(first.hasMore).toBe(true);
 expect(await verifyFacialHistoryPage(first,{...owner(),actorId:session.userId!,documentId,anchor:all[35]})).toEqual(first);
 const second=await getFacialHistoryPage(request(first.history.at(-1)!));if(!second.ok)throw Error(second.code);expect(second.history.map(r=>r.version)).toEqual([5,4,3,2,1]);expect(second.hasMore).toBe(false);
 await verifyFacialHistoryPage(second,{...owner(),actorId:session.userId!,documentId,anchor:first.history.at(-1)!});
 expect((await f.pool.query('SELECT id,content_sha256,command,results FROM ortho_facial_revisions ORDER BY version')).rows).toEqual(before);
});
it('returns empty terminal only for version1, and exact30 terminal without false hasMore',async()=>{expect(await getFacialHistoryPage(request(all[0]))).toMatchObject({ok:true,history:[],hasMore:false});const page=await getFacialHistoryPage(request(all[30]));expect(page).toMatchObject({ok:true,hasMore:false});if(page.ok)expect(page.history).toHaveLength(30);});
it('refuses unknown cursor,wrong hash,foreign scope and invalid cursor scalar',async()=>{
 expect(await getFacialHistoryPage({...request(all[35]),beforeRevisionId:2147483647})).toMatchObject({ok:false,status:404});
 expect(await getFacialHistoryPage({...request(all[35]),beforeContentHash:'a'.repeat(64)})).toMatchObject({ok:false,status:409});
 expect(await getFacialHistoryPage({...request(all[35]),patientId:2147483647})).toMatchObject({ok:false});
 expect(await getFacialHistoryPage({...request(all[35]),beforeRevisionId:0})).toMatchObject({ok:false,status:400});
});
it('refuses changed original bytes without returning historical results',async()=>{const saved=media.bytes;media.bytes=Buffer.from('synthetic tamper');try{expect(await getFacialHistoryPage(request(all[35]))).toMatchObject({ok:false,status:409,code:'facial_image_integrity'});}finally{media.bytes=saved;}});
it('refuses revoked account and expiry during source decode',async()=>{
 await f.pool.query('UPDATE users SET is_active=false WHERE id=$1',[session.userId]);try{expect(await getFacialHistoryPage(request(all[35]))).toMatchObject({ok:false,status:401});}finally{await f.pool.query('UPDATE users SET is_active=true WHERE id=$1',[session.userId]);}
 media.onRead=()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(session.expiresAt+1);};try{expect(await getFacialHistoryPage(request(all[35]))).toMatchObject({ok:false,status:401});}finally{media.onRead=null;vi.useRealTimers();}
});
it('allows immutable historical paging after a newer append',async()=>{const before=await getFacialHistoryPage(request(all[35]));const saved=await appendFacialAnalysis({...owner(),command:{...all[64].command,clientRequestId:randomUUID(),expectedHeadId:all[64].id,reason:'Synthetic append'}});expect(saved.ok).toBe(true);expect(await getFacialHistoryPage(request(all[35]))).toEqual(before);});
it('uses current image grant and ownership without widening doctor access',async()=>{
 const original=session;session={...session,role:'doctor'};media.token=createSessionToken(session);await f.pool.query("UPDATE users SET role='doctor',permissions=$2 WHERE id=$1",[session.userId,JSON.stringify({canViewAllPatients:true,canViewXrays:false})]);
 try{expect(await getFacialHistoryPage(request(all[35]))).toMatchObject({ok:false,status:403});await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[session.userId,JSON.stringify({canViewAllPatients:true,canViewXrays:true})]);expect(await getFacialHistoryPage(request(all[35]))).toMatchObject({ok:true});await f.pool.query('UPDATE users SET permissions=$2 WHERE id=$1',[session.userId,JSON.stringify({canViewAllPatients:false,canViewXrays:true})]);expect(await getFacialHistoryPage(request(all[35]))).toMatchObject({ok:false,status:403});}finally{await f.pool.query("UPDATE users SET role='admin',permissions='{}' WHERE id=$1",[session.userId]);session=original;media.token=createSessionToken(session);}
});
it('refuses account revocation winning an observed user lock before returning any old page',async()=>{
 const blocker=await f.pool.connect(),pid=(await blocker.query('SELECT pg_backend_pid() AS id')).rows[0].id;await blocker.query('BEGIN');await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[session.userId]);
 const pending=getFacialHistoryPage(request(all[35]));
 try{let observed=false;for(let i=0;i<200;i++){const r=await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM users%' AND $1=ANY(pg_blocking_pids(pid))",[pid]);if(r.rowCount){observed=true;break;}await new Promise(r=>setTimeout(r,15));}expect(observed).toBe(true);await blocker.query('UPDATE users SET is_active=false WHERE id=$1',[session.userId]);await blocker.query('COMMIT');expect(await pending).toMatchObject({ok:false,status:401});}finally{await blocker.query('ROLLBACK');blocker.release();await pending;await f.pool.query('UPDATE users SET is_active=true WHERE id=$1',[session.userId]);}
});
