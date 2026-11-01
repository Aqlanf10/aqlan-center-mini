/** Slice 34: saved single-study read in a built application, synthetic only. */
import {afterAll,beforeAll,expect,it} from "vitest";
import {openCanonicalJourney,type CanonicalJourney} from "./_canonical-journey-harness";
import {seedCanonicalCeph} from "../fixtures/canonical-ceph";
import {mkdirSync} from "node:fs";
import {join} from "node:path";
const VIEW={"clinical.xrays.view":true};
const ACCOUNTS={
 owner:{username:"canon-cd-owner",password:"Canon#CephOwner1",role:"admin",display:"المالك التجريبي"},
 own:{username:"canon-cd-own",password:"Canon#CephOwn1",role:"doctor",doctor:true,display:"طبيب الصور التجريبي",patientScope:"own",grants:VIEW},
 all:{username:"canon-cd-all",password:"Canon#CephAll1",role:"reception",display:"متابعة الصور",patientScope:"all",grants:VIEW},
 denied:{username:"canon-cd-denied",password:"Canon#CephDenied1",role:"admin",display:"مدير دون منحة الصور",patientScope:"all",grants:{"clinical.ortho.view":true}},
 none:{username:"canon-cd-none",password:"Canon#CephNone1",role:"doctor",doctor:true,display:"بلا نطاق",patientScope:"none",grants:VIEW},
} as const;
type Key=keyof typeof ACCOUNTS;let journey:CanonicalJourney<Key>;
const ids={own:0,outside:0,completed:0,draft:0,foreign:0};
beforeAll(async()=>{
 journey=await openCanonicalJourney({portOffset:47,secret:"canonical-ceph-study-secret-0123456789abcdef",accounts:ACCOUNTS,ownerKey:"owner",async seed(q,_accounts,parties){
  for(const key of ["own","outside"] as const)ids[key]=(await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id",[`SYN-CD-${key}`,`مريض دراسة تجريبي ${key}`,key==="outside"?null:parties.own!])).rows[0].id;
  ids.completed=(await seedCanonicalCeph(q,{patientId:ids.own})).id;ids.draft=(await seedCanonicalCeph(q,{patientId:ids.own,status:"draft"})).id;ids.foreign=(await seedCanonicalCeph(q,{patientId:ids.outside})).id;
  await q.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'S',100.125,50.25,'manual','SYN recorder'),($1,'SYN_OLD_CODE',2,3,'manual','SYN old recorder')",[ids.completed]);
  await q.query("INSERT INTO ceph_diagnoses(analysis_id,skeletal,dental,soft_tissue,note,final_dx,created_by) VALUES($1,'SYN هيكلي','SYN سني','SYN أنسجة','SYN ملاحظة تشخيص','SYN استنتاج محفوظ','SYN recorder')",[ids.completed]);
 }});
},300_000);
afterAll(async()=>{await journey?.close();},60_000);
it("HTTP: canonical imaging viewer reads its saved study without a legacy session",async()=>{
 const session=await journey.login("own");expect(session.status).toBe(200);
 expect((await journey.api(`/api/patients/${ids.own}/ceph`,session.cookie)).status).toBe(200);
 const response=await journey.api(`/api/ceph/${ids.completed}`,session.cookie);expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({projection:"ceph-saved-study",analysis:{id:ids.completed,patientId:ids.own,status:"completed"}});
});
it("HTTP: owner/all/own read the exact clinical snapshot; independent grant and scope deny everyone else",async()=>{
 const path=`/api/ceph/${ids.completed}`;expect((await journey.api(path,"")).status).toBe(401);
 for(const key of ["denied","none"] as const){const session=await journey.login(key),r=await journey.api(path,session.cookie);expect(r.status).toBe(403);expect(r.headers.get("cache-control")).toContain("no-store");}
 for(const key of ["owner","all","own"] as const){const session=await journey.login(key),r=await journey.api(path,session.cookie);expect(r.status).toBe(200);const body=await r.json();expect(body.analysis.id).toBe(ids.completed);expect(body.diagnosis.finalDx).toBe("SYN استنتاج محفوظ");expect(body.measurements).toContainEqual({code:"ANB",value:3.125});expect(body.landmarks).toContainEqual({code:"SYN_OLD_CODE",x:2,y:3,source:"manual",confirmedBy:"SYN old recorder"});expect(JSON.stringify(body)).not.toMatch(/documentId|private image title|private.png|storage|orthoCaseId|invoice|price|phone/);}
 const own=await journey.login("own"),bodies=[];for(const id of [ids.foreign,2147483647]){const r=await journey.api(`/api/ceph/${id}`,own.cookie);expect(r.status).toBe(404);bodies.push(await r.json());}expect(bodies[0]).toEqual(bodies[1]);
 for(const query of ["image=1","patientId=1","full=1","includeDiscarded=1"]){const r=await journey.api(`${path}?${query}`,own.cookie);expect(r.status).toBe(400);expect(r.headers.get("cache-control")).toContain("no-store");}
 expect(await(await journey.api(`/api/ceph/${ids.draft}`,own.cookie)).json()).toMatchObject({measurementsState:"saved-unapproved",analysis:{status:"draft",findings:null}});
});
it("HTTP: reads and canonical rejected PATCH/DELETE preserve exact clinical rows, finance and audit",async()=>{
 const session=await journey.login("owner"),sql="SELECT (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ceph_analyses a) studies,(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ceph_measurements m) measures,(SELECT jsonb_agg(to_jsonb(d) ORDER BY analysis_id) FROM ceph_diagnoses d) diagnoses,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM audit_log)::int audits",before=(await journey.db.query(sql)).rows;
 expect((await journey.api(`/api/ceph/${ids.completed}`,session.cookie)).status).toBe(200);
 const patch=await journey.api(`/api/ceph/${ids.completed}`,session.cookie,{method:"PATCH",body:JSON.stringify({diagnosis:{finalDx:"SYN forbidden"}})});expect([401,403]).toContain(patch.status);
 const malformed=await journey.api(`/api/ceph/${ids.completed}`,session.cookie,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({diagnosis:{finalDx:"SYN forbidden"}})});expect(malformed.status).toBe(400);
 const completed=await journey.api(`/api/ceph/${ids.completed}`,session.cookie,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:"0".repeat(64),note:null})});expect(completed.status).toBe(409);expect((await completed.json()).code).toBe("ceph_discard_conflict");
 expect((await journey.db.query(sql)).rows).toEqual(before);expect(await journey.ddlLog()).toEqual([]);
});
async function openStudy(page:import("playwright").Page,key:Key="own",signed=false){
 if(!signed)await journey.browserLogin(page,key);await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
 await page.getByRole("button",{name:"عرض دراسات السيفالومتري"}).click();
 const item=page.getByTestId("canonical-ceph-studies").getByRole("listitem").filter({has:page.getByRole("heading",{name:"دراسة معتمدة — قبل العلاج",exact:true})});
 await item.getByRole("button",{name:"عرض الدراسة المحفوظة"}).click();const panel=page.getByTestId("canonical-ceph-study");await panel.getByText("SYN استنتاج محفوظ",{exact:true}).waitFor();return panel;
}
it("browser: 390px clinical read keeps saved unknown codes, has no editor/tracer/image and requests only the selected study",async()=>{
 const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});try{
 const page=await context.newPage(),calls:string[]=[];await journey.browserLogin(page,"own");page.on("request",r=>{const p=new URL(r.url()).pathname;if(p.startsWith("/api/"))calls.push(`${r.method()} ${p}`);});
 const panel=await openStudy(page,"own",true);expect(await panel.textContent()).toContain("SYN_OLD_CODE");expect(await panel.getByText("3.125",{exact:true}).count()).toBe(1);
 expect(await panel.locator("input,textarea,img,canvas,select").count()).toBe(0);expect(await panel.getByRole("button",{name:/حفظ|اعتماد|تعديل|رسم/}).count()).toBe(0);
 expect(calls.filter(c=>c.includes("/ceph"))).toEqual([`GET /api/patients/${ids.own}/ceph`,`GET /api/ceph/${ids.completed}`]);expect(calls.some(c=>/\/api\/(documents|images|plans|invoices)\//.test(c))).toBe(false);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"ceph-study-390.png"),fullPage:true});}
 }finally{await context.close();}
});
it("browser: wrong study ownership and network failures remove old diagnosis and measurements",async()=>{
 const context=await journey.browser.newContext();try{
 const page=await context.newPage(),panel=await openStudy(page);
 await page.route(`**/api/ceph/${ids.completed}`,async route=>{const r=await route.fetch(),body=await r.json();body.analysis.patientId=ids.outside;await route.fulfill({response:r,json:body});});
 await panel.getByRole("button",{name:"تحديث الدراسة"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("canonical-ceph-saved").count()).toBe(0);
 await page.unroute(`**/api/ceph/${ids.completed}`);await page.route(`**/api/ceph/${ids.completed}`,route=>route.abort());await panel.getByRole("button",{name:"تحديث الدراسة"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("canonical-ceph-saved").count()).toBe(0);
 }finally{await context.close();}
});
it("browser and HTTP: removing imaging authority clears the detail and rejects fresh sessions",async()=>{
 const context=await journey.browser.newContext(),original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.all])).rows[0].permissions;
 try{const stale=await journey.login("all"),page=await context.newPage(),panel=await openStudy(page,"all");
 await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.xrays.view}','false')::text WHERE id=$1",[journey.ids.all]);
 await panel.getByRole("button",{name:"تحديث الدراسة"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByTestId("canonical-ceph-saved").count()).toBe(0);
 expect((await journey.api(`/api/ceph/${ids.completed}`,stale.cookie)).status).toBe(401);const fresh=await journey.login("all");expect((await journey.api(`/api/ceph/${ids.completed}`,fresh.cookie)).status).toBe(403);
 }finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.all]);}
});
it("browser: delayed response cannot restore a closed study",async()=>{
 const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void;
 const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
 try{const page=await context.newPage(),panel=await openStudy(page);let first=true;
 await page.route(`**/api/ceph/${ids.completed}`,async route=>{if(!first){await route.continue();return;}first=false;try{const r=await route.fetch();reached();await held;await route.fulfill({response:r}).catch(()=>undefined);}finally{finished();}});
 await panel.getByRole("button",{name:"تحديث الدراسة"}).click();await ready;await page.getByRole("button",{name:"إغلاق الدراسة المحفوظة"}).click();release();await done;expect(await page.getByTestId("canonical-ceph-study").count()).toBe(0);
 }finally{release();await context.close();}
});
