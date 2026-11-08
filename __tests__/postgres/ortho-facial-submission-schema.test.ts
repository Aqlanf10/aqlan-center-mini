import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { ORTHO_FACIAL_SUBMISSION_SQL } from '../../lib/ortho-facial-submission-schema';
import { ProtectedOrthoFacialHistoryError } from '../../lib/clinic-reset';
let f:Awaited<ReturnType<typeof openPeriodontalFixture>>, actor:number;
beforeAll(async()=>{f=await openPeriodontalFixture(process.env,{pristine:true});await f.db.ensureSchema();actor=(await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-journal-schema','Synthetic','not-a-real-credential','admin') RETURNING id")).rows[0].id;});
afterAll(async()=>{await f?.close();});
async function scope(){
 const patient=(await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic journal') RETURNING id",[randomUUID()])).rows[0].id;
 const ortho=(await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[patient])).rows[0].id;
 const clinical=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic',$2,'synthetic') RETURNING id",[patient,ortho])).rows[0].id;
 const document=(await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'Synthetic','image/png',1,$3,'synthetic-key','synthetic') RETURNING id",[patient,ortho,'a'.repeat(64)])).rows[0].id;
 return {patient,ortho,clinical,document};
}
async function pending(o:Awaited<ReturnType<typeof scope>>){return (await f.pool.query(`INSERT INTO ortho_facial_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,document_id,actor_user_id,command_id,request_fingerprint,command,previous_version,state) VALUES($1,$1,$2,$3,$4,$5,$6,$7,'{}',0,'pending') RETURNING *`,[o.patient,o.ortho,o.clinical,o.document,actor,randomUUID(),'a'.repeat(64)])).rows[0];}
it('registers identical standalone runtime migration and CLI SQL',async()=>{
 expect(readFileSync('migrations/0116_ortho_facial_submissions.sql','utf8')).toBe(ORTHO_FACIAL_SUBMISSION_SQL);
 expect((await f.pool.query("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0116'")).rows).toEqual([{name:'ortho_facial_submissions',checksum:createHash('sha256').update(ORTHO_FACIAL_SUBMISSION_SQL).digest('hex'),adopted:false}]);
});
it('allows null-source cancellation tombstones but never null-source pending intent',async()=>{
 const o=await scope();
 const row=(await f.pool.query(`INSERT INTO ortho_facial_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,state,settled_at) VALUES($1,$1,$2,$3,$4,$5,$6,'cancelled',clock_timestamp()) RETURNING id`,[o.patient,o.ortho,o.clinical,actor,randomUUID(),'b'.repeat(64)])).rows[0];
 await f.pool.query('UPDATE ortho_facial_submissions SET acknowledged_at=clock_timestamp() WHERE id=$1',[row.id]);
 await expect(f.pool.query(`INSERT INTO ortho_facial_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,previous_version,state) VALUES($1,$1,$2,$3,$4,$5,$6,'{}',0,'pending')`,[o.patient,o.ortho,o.clinical,actor,randomUUID(),'c'.repeat(64)])).rejects.toMatchObject({code:'23514'});
});
it('preserves pending journal at reset before any clinical revision and blocks canonical merge',async()=>{
 const o=await scope(),target=await scope();await pending(o);let backup=false;
 await expect(f.db.resetClinicData({actor:'synthetic',actorRole:'admin'},async()=>{backup=true;return {ok:false,failure:'must not run'};})).rejects.toBeInstanceOf(ProtectedOrthoFacialHistoryError);expect(backup).toBe(false);
 expect(await f.db.mergeDuplicatePatient(o.patient,target.patient,{actor:'synthetic',actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history',counts:{orthoFacialSubmissions:1}});
 expect((await f.pool.query('SELECT count(*)::int n FROM ortho_facial_revisions')).rows[0].n).toBe(0);
});
it('rejects payload mutation, pending acknowledgement, parent drift and erasure',async()=>{
 const o=await scope(),r=await pending(o);
 for(const sql of ["UPDATE ortho_facial_submissions SET command='{\"changed\":true}' WHERE id=$1",'UPDATE ortho_facial_submissions SET acknowledged_at=clock_timestamp() WHERE id=$1','DELETE FROM ortho_facial_submissions WHERE id=$1'])await expect(f.pool.query(sql,[r.id])).rejects.toMatchObject({code:'55000'});
 await expect(f.pool.query("UPDATE clinical_cases SET specialty='general' WHERE id=$1",[o.clinical])).rejects.toThrow();
 await expect(f.pool.query('TRUNCATE ortho_facial_submissions')).rejects.toMatchObject({code:'55000'});
 await f.pool.query("UPDATE ortho_facial_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1",[r.id]);
 await f.pool.query('UPDATE ortho_facial_submissions SET command=NULL,acknowledged_at=clock_timestamp() WHERE id=$1',[r.id]);
 await expect(f.pool.query("UPDATE ortho_facial_submissions SET state='pending' WHERE id=$1",[r.id])).rejects.toMatchObject({code:'55000'});
});
it('requires committed receipt to match exact retained command and revision document',async()=>{
 const o=await scope(),r=await pending(o),client=await f.pool.connect();
 try{
  await client.query('BEGIN');
  const revision=(await client.query(`INSERT INTO ortho_facial_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,document_id,version,actor_user_id,created_by,command_id,request_fingerprint,content_sha256,command,results) VALUES($1,$1,$2,$3,$4,1,$5,'synthetic',$6,$7,$7,'{"changed":true}','{}') RETURNING id`,[o.patient,o.ortho,o.clinical,o.document,actor,r.command_id,r.request_fingerprint])).rows[0];
  await client.query("UPDATE ortho_facial_submissions SET state='committed',revision_id=$2,settled_at=clock_timestamp() WHERE id=$1",[r.id,revision.id]);
  await expect(client.query('COMMIT')).rejects.toMatchObject({code:'23514'});await client.query('ROLLBACK');
 }finally{client.release();}
 expect((await f.pool.query('SELECT state FROM ortho_facial_submissions WHERE id=$1',[r.id])).rows[0].state).toBe('pending');
});
