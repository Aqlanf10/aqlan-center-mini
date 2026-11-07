import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { getFacialAnalysis } from "../../lib/ortho-facial-store";
import { saveJournaledFacial as appendFacialAnalysis, getFacialSubmissionRecovery, transitionFacialSubmission } from "../../lib/ortho-facial-submission-store";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { syntheticFace } from "../fixtures/ortho-facial-analysis";
import { putFile } from "../../lib/files";
const request=vi.hoisted(()=>({token:""}));
vi.mock("next/headers",()=>({cookies:async()=>({get:(name:string)=>name==="aqlan_flow_session"?{value:request.token}:undefined}),headers:async()=>new Headers()}));
let f:Awaited<ReturnType<typeof openBackupTimestampFixture>>,db:typeof import("../../lib/db"),directory:string;
let owner:{actorId:number;patientId:number;orthoCaseId:number;clinicalCaseId:number;session:SessionPayload};
let command:Parameters<typeof appendFacialAnalysis>[0]["command"],saved:Awaited<ReturnType<typeof appendFacialAnalysis>>,latest:Awaited<ReturnType<typeof appendFacialAnalysis>>,documentId:number,storageKey:string,bytes:Buffer;
const prior={url:process.env.DATABASE_URL,seed:process.env.SKIP_SEED,documents:process.env.DOCUMENTS_DIR};
beforeAll(async()=>{
 vi.stubEnv("SESSION_SECRET","synthetic-facial-backup-secret-at-least-32-characters");
 f=await openBackupTimestampFixture(process.env);directory=await mkdtemp(join(tmpdir(),"facial-backup-"));process.env.DOCUMENTS_DIR=join(directory,"original-documents");
 process.env.DATABASE_URL=f.source.options.connectionString!;process.env.SKIP_SEED="true";
 db=await import("../../lib/db");await db.resetPoolForTesting();await db.ensureSchema();
 const user=(await f.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-face-backup','Synthetic backup clinician','synthetic-hash','admin') RETURNING id")).rows[0].id;
 const session:SessionPayload={userId:user,username:"synthetic-face-backup",role:"admin",expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion("synthetic-hash")};request.token=createSessionToken(session);
 const patientId=(await f.source.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-FACE-BACKUP','Synthetic face backup') RETURNING id")).rows[0].id;
 const orthoCaseId=(await f.source.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[patientId])).rows[0].id;
 const clinicalCaseId=(await f.source.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patientId,orthoCaseId])).rows[0].id;owner={actorId:user,patientId,orthoCaseId,clinicalCaseId,session};
 bytes=await sharp({create:{width:1000,height:1200,channels:3,background:"#667788"}}).png().toBuffer();const stored=await putFile(bytes,"png");storageKey=stored.key;
 documentId=(await f.source.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view) VALUES($1,$2,'Synthetic face','image/png',$3,$4,$5,'synthetic','extraoral_frontal') RETURNING id",[patientId,orthoCaseId,stored.sizeBytes,stored.sha256,stored.key])).rows[0].id;
 const content=syntheticFace();content.image.sha256=stored.sha256;
 command={schemaVersion:1,clientRequestId:"synthetic_facial_backup_0001",documentId,expectedHeadId:null,reason:"Synthetic original review",content};
 saved=await appendFacialAnalysis({...owner,command});if(!saved.ok)throw Error(saved.code);
 await transitionFacialSubmission({...owner,commandId:"synthetic_facial_backup_0001",requestFingerprint:journeyContentHash(command),action:"acknowledge"});
 latest=await appendFacialAnalysis({...owner,command:{...(command as object),clientRequestId:"synthetic_facial_backup_0002",expectedHeadId:saved.revision.id,reason:"Synthetic second review"}});if(!latest.ok)throw Error(latest.code);
 await f.source.query("CREATE INDEX synthetic_facial_reverse ON ortho_facial_revisions(ortho_case_id,document_id,version DESC);CLUSTER ortho_facial_revisions USING synthetic_facial_reverse;DROP INDEX synthetic_facial_reverse");
 expect((await f.source.query("SELECT version FROM ortho_facial_revisions")).rows.map(r=>r.version)).toEqual([2,1]);
 const client=await f.source.connect();try{
  let sql="";for await(const line of db.backupSqlLines(client))sql+=line;await writeFile(join(directory,"backup.sql"),sql);
  const blocks:Uint8Array[]=[];for await(const block of fullBackupBlocks({source:client,readDocument:async key=>readFile(join(process.env.DOCUMENTS_DIR!,key))}))blocks.push(block);
  await writeFile(join(directory,"backup.tar.gz"),gzipSync(Buffer.concat(blocks)));
 }finally{client.release();}
});
afterAll(async()=>{try{await db?.resetPoolForTesting();}finally{
 for(const [name,value] of [["DATABASE_URL",prior.url],["SKIP_SEED",prior.seed],["DOCUMENTS_DIR",prior.documents]] as const){if(value===undefined)delete process.env[name];else process.env[name]=value;}
 await f?.close();if(directory)await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();
}});
async function verify(pool:Pool){
 if(!saved.ok||!latest.ok)throw Error("Synthetic fixture missing");
 const rows=async(p:Pool)=>(await p.query("SELECT to_jsonb(r)::text value FROM ortho_facial_revisions r ORDER BY version")).rows;
 expect(await rows(pool)).toEqual(await rows(f.source));
 const journal=async(p:Pool)=>(await p.query("SELECT to_jsonb(s)::text value FROM ortho_facial_submissions s ORDER BY id")).rows;
 expect(await journal(pool)).toEqual(await journal(f.source));
 expect(await getFacialSubmissionRecovery(owner)).toMatchObject({ok:true,recovery:{state:'committed',expected:{command:latest.revision.command}}});
 expect(await appendFacialAnalysis({...owner,command})).toEqual({...saved,replayed:true});
 expect(await getFacialAnalysis({...owner,documentId})).toMatchObject({ok:true,history:[latest.revision,saved.revision]});
 expect(await readFile(join(process.env.DOCUMENTS_DIR!,storageKey))).toEqual(bytes);
 expect(await rows(pool)).toEqual(await rows(f.source));
}
it("restores exact reverse-physical facial revisions through supported SQL restore with durable committed recovery",async()=>{
 process.env.DATABASE_URL=f.sqlTarget.options.connectionString!;await db.resetPoolForTesting();await db.ensureSchema();
 const result=await promisify(execFile)(process.execPath,["scripts/restore.mjs",join(directory,"backup.sql")],{env:{...process.env}});expect(result.stdout).toContain("تمت الاستعادة");await verify(f.sqlTarget);
});
it("restores original photo bytes, reverse facial history and old replay through full archive restore with durable committed recovery",async()=>{
 const stagingDir=join(directory,"restored-documents");
 expect(await stagedRestore({archivePath:join(directory,"backup.tar.gz"),targetUrl:f.archiveTarget.options.connectionString!,stagingDir})).toMatchObject({ok:true,errors:[],validationErrors:[]});
 process.env.DATABASE_URL=f.archiveTarget.options.connectionString!;process.env.DOCUMENTS_DIR=stagingDir;await db.resetPoolForTesting();await verify(f.archiveTarget);
});
