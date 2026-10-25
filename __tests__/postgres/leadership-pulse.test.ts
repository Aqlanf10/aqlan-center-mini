import {afterAll,beforeAll,beforeEach,expect,it,vi} from "vitest";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import {validatePostgresTestTarget} from "./_safe-target";
import {readLeadershipPulse} from "../../lib/leadership-pulse-db";
assertRealPostgresUrl();const target=validatePostgresTestTarget({...process.env},{allowDatabaseUrlFallback:true});stubPostgresEnv();
const db=await import("../../lib/db");const q=async(sql:string,params:unknown[]=[]) => (await db.getPool().query(sql,params)).rows;
let admin:number,other:number,patient:number;
const read=(view:"day"|"tasks"="day",page=0,day="2026-10-25")=>readLeadershipPulse(db.getPool(),{view,page,day},"Asia/Aden",{role:"admin",userId:admin});
beforeAll(async()=>{await dropPublicSchema(target.testUrl.toString());await db.ensureSchema();const users=await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ('pulse-admin','Synthetic admin','unused','admin'),('pulse-other','Synthetic other','unused','doctor') RETURNING id");[admin,other]=users.map(r=>Number(r.id));});
beforeEach(async()=>{await q("TRUNCATE visits,appointments,patients,hr_tasks RESTART IDENTITY CASCADE");patient=Number((await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-PULSE','Synthetic pulse patient') RETURNING id"))[0].id);});
afterAll(async()=>{await db.resetPoolForTesting();});
it("honors clinic midnight, current visit states, separate appointment cancellation and exact page count",async()=>{
 await q(`INSERT INTO visits(patient_name,patient_id,status,arrived_at) VALUES ('Inside',$1,'waiting','2026-10-24T21:00:00Z'),('Outside',$1,'waiting','2026-10-24T20:59:59Z'),('Done',$1,'done','2026-10-25T12:00:00Z')`,[patient]);
 await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,'2026-10-25','14:00','no_show'),($1,'2026-10-25','15:00','cancelled')",[patient]);
 const r=await read();expect(r.counts).toEqual({arrived:2,waiting:1,called:0,inChair:0,done:1,appointments:2,noShow:1,cancelled:1});expect(r.items.map(i=>i.title)).toEqual(["Inside"]);expect(r.items[0]).toMatchObject({assignee:null,dueAt:null,latestAction:null});
});
it("does not mistake a truncated latest-300 task list for the whole overdue population",async()=>{
 await q(`INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,status,due_at,updated_at)
 SELECT 'Old task '||n,$1,'Synthetic','synthetic','planned','2000-01-01'::timestamptz+n*INTERVAL '1 minute','2000-01-01' FROM generate_series(1,321) n`,[admin]);
 await q("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,is_private,due_at) VALUES ('PRIVATE-OTHER',$1,'Other','synthetic',TRUE,'1999-01-01')",[other]);
 await q("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,is_private,due_at) VALUES ('OWN-PRIVATE-VISIBLE',$1,'Owner','synthetic',TRUE,'2199-01-01')",[admin]);
 const r=await read("tasks");expect(r.total).toBe(322);expect(r.counts.overdue).toBe(321);expect(r.items).toHaveLength(10);expect(r.items[0].title).toBe("Old task 1");expect(JSON.stringify(r)).not.toContain("PRIVATE-OTHER");
 const clamped=await read("tasks",999);expect(clamped.page).toBe(32);expect(clamped.items).toHaveLength(2);expect(clamped.items.some(i=>i.title==="OWN-PRIVATE-VISIBLE")).toBe(true);expect(clamped.hasMore).toBe(false);
});
it("keeps unknown due dates, real assignment and latest actor distinct; terminal tasks excluded",async()=>{
 const staff=Number((await q("INSERT INTO hr_staff(full_name,created_by) VALUES ('Assigned staff','synthetic') RETURNING id"))[0].id);
 const task=Number((await q("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,assignee_staff_id,assignee_label,status) VALUES ('Blocked without due',$1,'Owner','synthetic',$2,'Assigned staff','blocked') RETURNING id",[admin,staff]))[0].id);
 await q("INSERT INTO hr_task_events(task_id,actor_user_id,actor_display_name,action) VALUES ($1,$2,'Different actor','comment')",[task,other]);
 await q("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,status,due_at,completed_at) VALUES ('Terminal',$1,'Owner','synthetic','completed','2000-01-01',NOW())",[admin]);
 const r=await read("tasks");expect(r.counts).toEqual({open:1,overdue:0,blocked:1,unassigned:0});expect(r.items[0]).toMatchObject({assignee:"Assigned staff",dueAt:null,latestAction:{actor:"Different actor",action:"comment"}});
});
it("makes one SELECT per source and changes no source records",async()=>{
 const tables=["visits","appointments","hr_tasks","hr_task_events","audit_log"];
 const snapshot=async()=>Promise.all(tables.map(t=>q(`SELECT * FROM ${t} ORDER BY id`)));
 const before=await snapshot();const pool=db.getPool(),spy=vi.spyOn(pool,"query");
 await readLeadershipPulse(pool,{view:"day",day:"2026-10-25",page:0},"Asia/Aden",{role:"admin",userId:admin});expect(spy).toHaveBeenCalledTimes(1);spy.mockRestore();expect(await snapshot()).toEqual(before);
});
it("bounds task enrichment at a larger synthetic population without an event N+1",async()=>{
 await q(`INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,due_at) SELECT 'Scale '||n,$1,'Synthetic','synthetic','2000-01-01' FROM generate_series(1,20000) n`,[admin]);
 await q(`INSERT INTO hr_task_events(task_id,actor_user_id,actor_display_name,action) SELECT t.id,$1,'Synthetic event','comment' FROM hr_tasks t CROSS JOIN generate_series(1,5) n`,[admin]);
 const spy=vi.spyOn(db.getPool(),"query"),started=performance.now();const r=await read("tasks");const elapsed=performance.now()-started;
 const queryCount=spy.mock.calls.length;spy.mockRestore();expect(queryCount).toBe(1);expect(elapsed).toBeLessThan(5000);
 expect(r.total).toBe(20000);expect(r.items).toHaveLength(10);expect(r.items.every(i=>i.latestAction?.actor==="Synthetic event")).toBe(true);
 console.log(JSON.stringify({fixture:"leadership-task-scale",tasks:20000,events:100000,queries:queryCount,rows:r.items.length,elapsedMs:Math.round(elapsed)}));
});
