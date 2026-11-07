import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { openPeriodontalFixture } from './_periodontal-fixture';
import { ORTHO_PROBLEM_SOURCE_SUBMISSION_SQL } from '../../lib/ortho-problem-source-submission-schema';
import { ProtectedOrthoProblemHistoryError } from '../../lib/clinic-reset';
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
async function pending(o:Awaited<ReturnType<typeof scope>>){return (await f.pool.query(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state) VALUES($1,$1,$2,$3,$4,$5,$6,'{}','pending') RETURNING *`,[o.patient,o.ortho,o.clinical,actor,randomUUID(),'a'.repeat(64)])).rows[0];}
it('registers identical standalone runtime migration and CLI SQL',async()=>{
 expect(readFileSync('migrations/0118_ortho_problem_source_submissions.sql','utf8')).toBe(ORTHO_PROBLEM_SOURCE_SUBMISSION_SQL);
 expect((await f.pool.query("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0118'")).rows).toEqual([{name:'ortho_problem_source_submissions',checksum:createHash('sha256').update(ORTHO_PROBLEM_SOURCE_SUBMISSION_SQL).digest('hex'),adopted:false}]);
});
it('allows cancellation-before-arrival tombstones but never payload-free pending intent',async()=>{
 const o=await scope();
 const row=(await f.pool.query(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,state,settled_at) VALUES($1,$1,$2,$3,$4,$5,$6,'cancelled',clock_timestamp()) RETURNING id`,[o.patient,o.ortho,o.clinical,actor,randomUUID(),'b'.repeat(64)])).rows[0];
 await f.pool.query('UPDATE ortho_problem_source_submissions SET acknowledged_at=clock_timestamp() WHERE id=$1',[row.id]);
 await expect(f.pool.query(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state) VALUES($1,$1,$2,$3,$4,$5,$6,NULL,'pending')`,[o.patient,o.ortho,o.clinical,actor,randomUUID(),'c'.repeat(64)])).rejects.toMatchObject({code:'23514'});
});
it('preserves pending journal at reset before any clinical revision and blocks canonical merge',async()=>{
 const o=await scope(),target=await scope();await pending(o);let backup=false;
 await expect(f.db.resetClinicData({actor:'synthetic',actorRole:'admin'},async()=>{backup=true;return {ok:false,failure:'must not run'};})).rejects.toBeInstanceOf(ProtectedOrthoProblemHistoryError);expect(backup).toBe(false);
 expect(await f.db.mergeDuplicatePatient(o.patient,target.patient,{actor:'synthetic',actorRole:'admin'})).toMatchObject({ok:false,reason:'source_has_clinical_command_history',counts:{orthoProblemSubmissions:1}});

});
it('rejects payload mutation, pending acknowledgement, parent drift and erasure',async()=>{
 const o=await scope(),r=await pending(o);
 for(const sql of ["UPDATE ortho_problem_source_submissions SET command='{\"changed\":true}' WHERE id=$1",'UPDATE ortho_problem_source_submissions SET acknowledged_at=clock_timestamp() WHERE id=$1','DELETE FROM ortho_problem_source_submissions WHERE id=$1'])await expect(f.pool.query(sql,[r.id])).rejects.toMatchObject({code:'55000'});
 await expect(f.pool.query("UPDATE clinical_cases SET specialty='general' WHERE id=$1",[o.clinical])).rejects.toThrow();
 await expect(f.pool.query('TRUNCATE ortho_problem_source_submissions')).rejects.toMatchObject({code:'55000'});
 await f.pool.query("UPDATE ortho_problem_source_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1",[r.id]);
 await f.pool.query('UPDATE ortho_problem_source_submissions SET command=NULL,acknowledged_at=clock_timestamp() WHERE id=$1',[r.id]);
 await expect(f.pool.query("UPDATE ortho_problem_source_submissions SET state='pending' WHERE id=$1",[r.id])).rejects.toMatchObject({code:'55000'});
 await expect(f.pool.query("UPDATE clinical_cases SET specialty='general' WHERE id=$1",[o.clinical])).rejects.toMatchObject({code:'23514'});
 await expect(f.pool.query('UPDATE ortho_problem_source_submissions SET patient_id=$2 WHERE id=$1',[r.id,(await scope()).patient])).rejects.toMatchObject({code:'55000'});
});
async function committedAttempt(change:Record<string,unknown>={},reverse=false){
 const o=await scope(),client=await f.pool.connect(),key=randomUUID();
 const source={kind:'clinical_diagnosis',id:1,member:'skeletal',version:`sha256:${'a'.repeat(64)}`};
 const command={schemaVersion:1,commandId:key,source,expectedReviewId:null,action:'create',problemId:null,label:'Synthetic problem',reason:'Synthetic review',clinicianReviewed:true,...change};
 try{
  await client.query('BEGIN');
  const problem=(await client.query("INSERT INTO patient_problems(patient_id,label,specialty,case_id,noted_by) VALUES($1,'Synthetic problem','orthodontics',$2,'synthetic') RETURNING id",[o.patient,o.clinical])).rows[0].id;
  const reviewId=(await client.query("SELECT nextval('ortho_problem_source_reviews_id_seq') id")).rows[0].id;
  const insertReview=()=>client.query(`INSERT INTO ortho_problem_source_reviews(id,patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,actor_user_id,created_by,source_identity,source_version,source_snapshot,problem_label,reason,command_id,request_fingerprint)
   VALUES($1,$2,$2,$3,$4,$5,$6,'synthetic','clinical_diagnosis:skeletal',$7,$8,'Synthetic problem','Synthetic review',$9,$10)`,[reviewId,o.patient,o.ortho,o.clinical,problem,actor,source.version,JSON.stringify({ref:source}),key,'a'.repeat(64)]);
  if(!reverse)await insertReview();
  await client.query(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,review_id,settled_at)
   VALUES($1,$1,$2,$3,$4,$5,$6,$7,'committed',$8,clock_timestamp())`,[o.patient,o.ortho,o.clinical,actor,key,'a'.repeat(64),JSON.stringify(command),reviewId]);
  if(reverse)await insertReview();
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
it('supports review-first and journal-first physical restore order',async()=>{await committedAttempt();await committedAttempt({},true);await committedAttempt({label:'\t\n\u00a0Synthetic problem\ufeff'});});
it.each([
 {reason:'Different reason'}, {source:{kind:'clinical_diagnosis',id:2,member:'skeletal',version:`sha256:${'a'.repeat(64)}`}},
 {expectedReviewId:123}, {label:'Different label'}, {action:'link',problemId:123,label:null}, {clinicianReviewed:false},
])('rejects retained command semantics inconsistent with exact review: %j',async change=>{
 await expect(committedAttempt(change)).rejects.toMatchObject({code:'23514'});
});
it('allows only one unacknowledged outcome per case',async()=>{
 const o=await scope();await pending(o);await expect(pending(o)).rejects.toMatchObject({code:'23505'});
});
it('rejects reuse of patient actor command identity in another case',async()=>{
 const o=await scope(),r=await pending(o);
 await f.pool.query("UPDATE ortho_problem_source_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1",[r.id]);
 await f.pool.query('UPDATE ortho_problem_source_submissions SET command=NULL,acknowledged_at=clock_timestamp() WHERE id=$1',[r.id]);
 const ortho=(await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id",[o.patient])).rows[0].id;
 const clinical=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic second',$2,'synthetic') RETURNING id",[o.patient,ortho])).rows[0].id;
 await expect(f.pool.query(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,state,settled_at)
 VALUES($1,$1,$2,$3,$4,$5,$6,'cancelled',clock_timestamp())`,[o.patient,ortho,clinical,actor,r.command_id,r.request_fingerprint])).rejects.toMatchObject({code:'23505'});
});
it.each([
 ['pending', 'review'], ['pending', 'journal'], ['cancelled', 'review'], ['cancelled', 'journal'],
] as const)('serializes concurrent cross-case %s journal and review when %s settles first',async(state,firstWriter)=>{
 const o=await scope(),key=randomUUID();
 const ortho=(await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id",[o.patient])).rows[0].id;
 const clinical=(await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic concurrent',$2,'synthetic') RETURNING id",[o.patient,ortho])).rows[0].id;
 const problem=(await f.pool.query("INSERT INTO patient_problems(patient_id,label,specialty,case_id,noted_by) VALUES($1,'Synthetic concurrent problem','orthodontics',$2,'synthetic') RETURNING id",[o.patient,o.clinical])).rows[0].id;
 const review=await f.pool.connect(),journal=await f.pool.connect();
 const first=firstWriter==='review'?review:journal,second=firstWriter==='review'?journal:review;
 let outcome:Promise<unknown>|undefined;
 try{
  await review.query('BEGIN');await journal.query('BEGIN');
  await review.query(`INSERT INTO ortho_problem_source_reviews(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,actor_user_id,created_by,source_identity,source_version,source_snapshot,problem_label,reason,command_id,request_fingerprint)
   VALUES($1,$1,$2,$3,$4,$5,'synthetic','clinical_diagnosis:skeletal',$6,'{}','Synthetic concurrent problem','Synthetic review',$7,$8)`,[o.patient,o.ortho,o.clinical,problem,actor,`sha256:${'a'.repeat(64)}`,key,'a'.repeat(64)]);
  await journal.query(`INSERT INTO ortho_problem_source_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,settled_at)
   VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='cancelled' THEN clock_timestamp() ELSE NULL END)`,[o.patient,ortho,clinical,actor,key,'a'.repeat(64),state==='pending'?'{}':null,state]);
  // Run one deferred check but retain its transaction fence while the other
  // transaction attempts COMMIT. Both inserted rows are still uncommitted.
  await first.query('SET CONSTRAINTS ALL IMMEDIATE');
  const secondPid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  let settled=false;
  outcome=second.query('COMMIT').then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  let blocked=false;
  for(let i=0;i<100&&!settled;i++){
   blocked=(await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) blocked",[secondPid])).rows[0].blocked;
   if(blocked)break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(blocked).toBe(true);expect(settled).toBe(false);
  await first.query('COMMIT');
  expect(await outcome).toMatchObject({code:'23514'});
  const counts=(await f.pool.query(`SELECT (SELECT count(*)::int FROM ortho_problem_source_reviews WHERE patient_id=$1 AND command_id=$2) reviews,
   (SELECT count(*)::int FROM ortho_problem_source_submissions WHERE patient_id=$1 AND command_id=$2) journals`,[o.patient,key])).rows[0];
  expect(counts).toEqual(firstWriter==='review'?{reviews:1,journals:0}:{reviews:0,journals:1});
 }finally{
  // Release the first fence before awaiting the second query, including failures.
  await first.query('ROLLBACK');if(outcome)await outcome;await second.query('ROLLBACK');review.release();journal.release();
 }
});
