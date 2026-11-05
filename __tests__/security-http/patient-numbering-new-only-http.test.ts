import {afterAll,beforeAll,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {authedMutation,harness} from "./_server";
let h:Awaited<ReturnType<typeof harness>>, db:Client, patientId:number;
const alias=`SYN-NEWONLY-${randomUUID()}`;
const snapshot=async()=>({
 patient:(await db.query("SELECT id,patient_number,patient_number_version::text FROM patients WHERE id=$1",[patientId])).rows,
 retired:(await db.query("SELECT * FROM retired_patient_numbers WHERE patient_id=$1",[patientId])).rows,
 edits:(await db.query("SELECT * FROM audit_log WHERE action='patient.number.change' AND entity_id=$1 ORDER BY id",[String(patientId)])).rows,
});
beforeAll(async()=>{
 h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
 patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic new-only identity') RETURNING id",[alias])).rows[0].id;
},120_000);
afterAll(async()=>{await db?.end();});
it("authenticates before refusing the deferred mutation, with no identity/history/audit changes",async()=>{
 const before=await snapshot(),path=`/api/patients/${patientId}/number`;
 const body=JSON.stringify({patientNumber:"150",expectedPatientNumber:alias,expectedVersion:"1",reason:"Synthetic forbidden edit",actor:"forged",session:{role:"admin"}});
 expect((await authedMutation(path,{cookie:""},"PATCH",body)).status).toBe(401);
 expect((await authedMutation(path,h.sessions.reception,"PATCH",body)).status).toBe(403);
 const admin=await authedMutation(path,h.sessions.admin,"PATCH",body);
 expect(admin.status).toBe(403);expect(await admin.json()).toMatchObject({code:"number_edit_deferred"});
 const csrf=await authedMutation(path,h.sessions.admin,"PATCH",body,{Origin:"https://untrusted.invalid","Sec-Fetch-Site":"cross-site"});
 expect(csrf.status).toBe(403);expect(await csrf.json()).not.toMatchObject({code:"number_edit_deferred"});
 expect(await snapshot()).toEqual(before);
});
it("generic demographics cannot smuggle a number change",async()=>{
 const before=await snapshot();
 const response=await authedMutation(`/api/patients/${patientId}`,h.sessions.admin,"PATCH",JSON.stringify({patientNumber:"P-00150",patient_number:"P-00150",patient_number_version:999}));
 expect(response.status).toBe(200);
 expect(await snapshot()).toEqual(before);
});
