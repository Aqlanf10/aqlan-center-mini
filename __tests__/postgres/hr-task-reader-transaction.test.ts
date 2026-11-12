import {beforeAll,afterAll,expect,it,vi} from "vitest";
import {openLegacyStaffFixture} from "./_legacy-staff-fixture";
import {assertRealPostgresUrl,stubPostgresEnv} from "./_setup";
import {createSessionToken,readSessionToken,sessionCredentialVersion,type SessionPayload} from "../../lib/auth";
import {getTaskForSession,linkReadableForSession} from "../../lib/hr";
assertRealPostgresUrl();stubPostgresEnv();const db=await import("../../lib/db");
let fixture:Awaited<ReturnType<typeof openLegacyStaffFixture>>,session:SessionPayload,taskId:number,patientId:number;
const savedUrl=process.env.DATABASE_URL,label="Synthetic restricted patient";
beforeAll(async()=>{
 fixture=await openLegacyStaffFixture({...process.env});process.env.DATABASE_URL=fixture.url;await db.resetPoolForTesting();await db.ensureSchema();
 const user=(await db.getPool().query<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES('task-reader','Synthetic doctor','synthetic','doctor',$1) RETURNING id",[JSON.stringify({canViewAllPatients:true})])).rows[0];
 session=readSessionToken(createSessionToken({userId:user.id,username:"task-reader",role:"doctor",credentialVersion:sessionCredentialVersion("synthetic"),expiresAt:Date.now()+3600000}))!;
 patientId=(await db.getPool().query<{id:number}>("INSERT INTO patients(patient_number,full_name) VALUES('TASK-READ-1',$1) RETURNING id",[label])).rows[0].id;
 taskId=(await db.getPool().query<{id:number}>("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by) VALUES('Synthetic task',$1,'Synthetic doctor','task-reader') RETURNING id",[user.id])).rows[0].id;
 await db.getPool().query("INSERT INTO hr_task_links(task_id,link_kind,link_id,link_label,linked_by) VALUES($1,'patient',$2,$3,'task-reader')",[taskId,patientId,label]);
 await db.getPool().query("INSERT INTO hr_task_events(task_id,actor_user_id,actor_display_name,action,field,new_value,link_id) VALUES($1,$2,'Synthetic doctor','link','patient',$3,$4)",[taskId,user.id,label,patientId]);
});
afterAll(async()=>{try{await db.resetPoolForTesting();await fixture?.close();}finally{process.env.DATABASE_URL=savedUrl;}});
it("doctor with actual patient permission sees labels through an owned transaction",async()=>{
 const result=await getTaskForSession(session,taskId);expect(result?.links[0]).toMatchObject({readable:true,label});expect(result?.events[0].newValue).toBe(label);
 expect(await linkReadableForSession(session,"patient",patientId)).toBe(true);
});
it("revoking patient visibility still hides linked labels and historical event values",async()=>{
 await db.getPool().query("UPDATE users SET permissions=NULL WHERE id=$1",[session.userId]);
 try{const result=await getTaskForSession(session,taskId);expect(result).not.toBeNull();expect(result?.links[0]).toMatchObject({readable:false,label:""});expect(result?.events[0].newValue).toBeNull();expect(JSON.stringify(result)).not.toContain(label);}
 finally{await db.getPool().query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({canViewAllPatients:true}),session.userId]);}
});
it("caller-owned transaction is neither nested nor committed by task/link reads",async()=>{
 const client=await db.getPool().connect();let temporary=0;
 try{await client.query("BEGIN");temporary=(await client.query<{id:number}>("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by) VALUES('Uncommitted caller task',$1,'Synthetic doctor','task-reader') RETURNING id",[session.userId])).rows[0].id;
  const before=(await client.query<{xid:string}>("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
  const queries=vi.spyOn(client,"query");
  expect((await getTaskForSession(session,temporary,client))?.task.id).toBe(temporary);expect(await linkReadableForSession(session,"patient",patientId,client)).toBe(true);
  expect((await client.query<{xid:string}>("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid).toBe(before);
  expect(queries.mock.calls.map(([sql])=>sql).some(sql=>/^(BEGIN|COMMIT|ROLLBACK)(?:\s|$)/i.test(sql))).toBe(false);queries.mockRestore();
  await client.query("ROLLBACK");
 }finally{await client.query("ROLLBACK");client.release();}
 expect((await db.getPool().query("SELECT id FROM hr_tasks WHERE id=$1",[temporary])).rows).toEqual([]);
});
