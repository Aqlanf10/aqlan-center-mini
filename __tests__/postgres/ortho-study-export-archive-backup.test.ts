import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { syntheticStudyCommand } from '../fixtures/ortho-case-study';
import { saveConfirmedStudy } from '../helpers/ortho-study-submit';
import { reserveStudyExport, claimStudyExport, publishStudyExport, readStudyExportArtifact } from '../../lib/ortho-study-export-archive-store';
import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
const request=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='aqlan_flow_session'?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openBackupTimestampFixture>>,db:typeof import('../../lib/db'),directory='';
const bytes=Buffer.from('Synthetic archive backup byte payload, no patient data');
const sha256=createHash('sha256').update(bytes).digest('hex');
const reference={storageKey:`${sha256.slice(0,2)}/${sha256.slice(2,4)}/${sha256}.pptx`,sha256,sizeBytes:bytes.length};
let scope:{session:SessionPayload;patientId:number;orthoCaseId:number;clinicalCaseId:number},readyId=0,expiredId=0;
const snapshot=async(pool:typeof f.source)=>({jobs:(await pool.query('SELECT to_jsonb(j)::text row FROM ortho_study_export_jobs j ORDER BY id')).rows,artifacts:(await pool.query('SELECT to_jsonb(a)::text row FROM ortho_study_export_artifacts a ORDER BY job_id')).rows});
beforeAll(async()=>{
 vi.stubEnv('SESSION_SECRET','synthetic-archive-backup-secret-at-least32');f=await openBackupTimestampFixture(process.env);db=await import('../../lib/db');await db.resetPoolForTesting();
 vi.stubEnv('DATABASE_URL',f.source.options.connectionString!);vi.stubEnv('SKIP_SEED','true');vi.stubEnv('NODE_ENV','test');vi.stubEnv('DATABASE_ENVIRONMENT','test');await db.ensureSchema();
 directory=await mkdtemp(join(tmpdir(),'synthetic-ortho-archive-backup-'));
 const username=randomUUID(),password='Synthetic password';const user=(await f.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic operator',$2,'admin') RETURNING id",[username,password])).rows[0];
 const session:SessionPayload={userId:user.id,username,role:'admin',credentialVersion:sessionCredentialVersion(password),expiresAt:Date.now()+600000};request.token=createSessionToken(session);
 const patientId=(await f.source.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic archive backup') RETURNING id",[randomUUID()])).rows[0].id;
 const orthoCaseId=(await f.source.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.source.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic archive',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;
 scope={session,patientId,orthoCaseId,clinicalCaseId};const saved=await saveConfirmedStudy({...scope,command:syntheticStudyCommand()});if(!saved.ok)throw Error(saved.code);
 for(const state of ['ready','queued','expired'] as const){
  const command={schemaVersion:1 as const,clientRequestId:randomUUID(),revisionId:saved.revision.id,revisionHash:saved.revision.contentHash,format:'text-pptx' as const};
  const r=await reserveStudyExport({...scope,command});if(!r.ok)throw Error(r.code);
  if(state==='queued')continue;
  const c=await claimStudyExport({...scope,jobId:r.job.id,expectedGeneration:0});if(!c.ok||!c.lease)throw Error('Synthetic claim');
  if(state==='ready'){const p=await publishStudyExport({...scope,lease:c.lease,artifact:{...reference,pageCount:1,renditions:[]}});if(!p.ok)throw Error(p.code);readyId=r.job.id;}
  else {
   // A valid stale running receipt may be restored after a crash. Insert a separate
   // historical receipt; do not disable its mutation/lease transition triggers.
   const historical={...command,clientRequestId:randomUUID()};
   const e=await f.source.query(`INSERT INTO ortho_study_export_jobs(patient_id,ortho_case_id,clinical_case_id,actor_user_id,revision_id,revision_sha256,command_id,command,request_fingerprint,format,render_binding,state,generation,lease_token,lease_expires_at,created_at,updated_at)
    SELECT patient_id,ortho_case_id,clinical_case_id,actor_user_id,revision_id,revision_sha256,$2,$3::jsonb,$4,format,render_binding,'running',1,$5,clock_timestamp()-INTERVAL '1 minute',clock_timestamp()-INTERVAL '2 minutes',clock_timestamp()-INTERVAL '2 minutes' FROM ortho_study_export_jobs WHERE id=$1 RETURNING id`,[r.job.id,historical.clientRequestId,JSON.stringify(historical),journeyContentHash(historical),randomUUID()]);expiredId=e.rows[0].id;
  }
 }
 const client=await f.source.connect();try{const blocks:Uint8Array[]=[];
  for await(const block of fullBackupBlocks({source:client,readDocument:async key=>{expect(key).toBe(reference.storageKey);return bytes;}}))blocks.push(block);
  await writeFile(join(directory,'backup.tar.gz'),gzipSync(Buffer.concat(blocks)));
 }finally{client.release();}
});
afterAll(async()=>{try{await db?.resetPoolForTesting();}finally{vi.unstubAllEnvs();await f?.close();if(directory)await rm(directory,{recursive:true,force:true});}});
it('restores queued/running/ready receipts, exact manifests and private bytes, then reclaims expired work safely',async()=>{
 await db.resetPoolForTesting();const restored=await stagedRestore({archivePath:join(directory,'backup.tar.gz'),targetUrl:f.archiveTarget.options.connectionString!,stagingDir:join(directory,'documents')});
 expect(restored.errors).toEqual([]);expect(restored.ok).toBe(true);
 expect(await snapshot(f.archiveTarget)).toEqual(await snapshot(f.source));
 expect(await readFile(join(directory,'documents',reference.storageKey))).toEqual(bytes);
 vi.stubEnv('DATABASE_URL',f.archiveTarget.options.connectionString!);await db.resetPoolForTesting();
 expect(await readStudyExportArtifact({...scope,jobId:readyId})).toMatchObject({ok:true,reference});
 const before=(await f.archiveTarget.query('SELECT lease_token FROM ortho_study_export_jobs WHERE id=$1',[expiredId])).rows[0].lease_token;
 const claim=await claimStudyExport({...scope,jobId:expiredId,expectedGeneration:1});expect(claim).toMatchObject({ok:true,job:{state:'running',generation:2}});
 if(!claim.ok||!claim.lease)throw Error('Expected reclaim');expect(claim.lease.token).not.toBe(before);
 expect(await publishStudyExport({...scope,lease:{...claim.lease,generation:1,token:before},artifact:{...reference,pageCount:1,renditions:[]}})).toMatchObject({ok:false,code:'study_export_lease_changed'});
});
