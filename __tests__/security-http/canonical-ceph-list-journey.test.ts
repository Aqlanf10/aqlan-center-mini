/** Slice 33 built-server evidence, with independently granted imaging reads. */
import {afterAll,beforeAll,expect,it} from "vitest";
import {openCanonicalJourney,type CanonicalJourney} from "./_canonical-journey-harness";
import {seedCanonicalCeph} from "../fixtures/canonical-ceph";
import {mkdirSync} from "node:fs";
import {join} from "node:path";
const VIEW={"clinical.xrays.view":true};
const ACCOUNTS={
 owner:{username:"canon-cl-owner",password:"Canon#CephOwner1",role:"admin",display:"المالك التجريبي"},
 own:{username:"canon-cl-own",password:"Canon#CephOwn1",role:"doctor",doctor:true,display:"طبيب الصور التجريبي",patientScope:"own",grants:VIEW},
 all:{username:"canon-cl-all",password:"Canon#CephAll1",role:"reception",display:"متابعة الصور",patientScope:"all",grants:VIEW},
 denied:{username:"canon-cl-denied",password:"Canon#CephDenied1",role:"admin",display:"مدير دون منحة الصور",patientScope:"all",grants:{"clinical.ortho.view":true}},
 none:{username:"canon-cl-none",password:"Canon#CephNone1",role:"doctor",doctor:true,display:"بلا نطاق",patientScope:"none",grants:VIEW},
} as const;
type Key=keyof typeof ACCOUNTS;let journey:CanonicalJourney<Key>;
const ids={own:0,outside:0,empty:0,completed:0,draft:0};
beforeAll(async()=>{
 journey=await openCanonicalJourney({portOffset:46,secret:"canonical-ceph-list-secret-0123456789abcdef",accounts:ACCOUNTS,ownerKey:"owner",async seed(q,_accounts,parties){
  for(const key of ["own","outside","empty"] as const)ids[key]=(await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id",[`SYN-CL-${key}`,`مريض سيفالو تجريبي ${key}`,key==="outside"?null:parties.own!])).rows[0].id;
  ids.completed=(await seedCanonicalCeph(q,{patientId:ids.own})).id;
  ids.draft=(await seedCanonicalCeph(q,{patientId:ids.own,status:"draft"})).id;
  await seedCanonicalCeph(q,{patientId:ids.outside});
 }});
},300_000);
afterAll(async()=>{await journey?.close();},60_000);
it("HTTP: canonical imaging viewer reads its saved study summaries without a legacy session",async()=>{
 const session=await journey.login("own");expect(session.status).toBe(200);
 expect((await journey.api(`/api/patients/${ids.own}`,session.cookie)).status).toBe(200);
 const response=await journey.api(`/api/patients/${ids.own}/ceph`,session.cookie);expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({projection:"ceph-summary",patientId:ids.own,hasMore:false});
 expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: independent grant, scope, empty file and strict query; no image identity or hidden clinical content",async()=>{
 const path=`/api/patients/${ids.own}/ceph`;expect((await journey.api(path,"")).status).toBe(401);
 for(const key of ["denied","none"] as const){const session=await journey.login(key),r=await journey.api(path,session.cookie);expect(r.status).toBe(403);expect(r.headers.get("cache-control")).toContain("no-store");}
 for(const key of ["owner","all","own"] as const){const session=await journey.login(key),r=await journey.api(path,session.cookie);expect(r.status).toBe(200);const body=await r.json();expect(body.analyses.map((a:{id:number})=>a.id)).toEqual([ids.draft,ids.completed]);expect(body.analyses[1].findings).toEqual({anb:3.125,fma:26.75,wits:-1.125});expect(JSON.stringify(body)).not.toMatch(/documentId|private.png|storage|SYN saved clinical note|machine|diagnosis|calibration|orthoCase|invoice/);}
 const own=await journey.login("own"),bodies=[];for(const id of [ids.outside,2147483647]){const r=await journey.api(`/api/patients/${id}/ceph`,own.cookie);expect(r.status).toBe(404);bodies.push(await r.json());}expect(bodies[0]).toEqual(bodies[1]);
 expect(await(await journey.api(`/api/patients/${ids.empty}/ceph`,own.cookie)).json()).toMatchObject({analyses:[],hasMore:false});
 for(const query of ["includeImages=1","status=discarded","patientId=1","limit=999"]){const r=await journey.api(`${path}?${query}`,own.cookie);expect(r.status).toBe(400);expect(r.headers.get("cache-control")).toContain("no-store");}
});
it("HTTP: the read and rejected writer do not change saved studies, money, schema or audit",async()=>{
 const session=await journey.login("owner"),sql="SELECT (SELECT count(*) FROM ceph_analyses)::int studies,(SELECT count(*) FROM ceph_measurements)::int measures,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM audit_log)::int audits",before=(await journey.db.query(sql)).rows;
 expect((await journey.api(`/api/patients/${ids.own}/ceph`,session.cookie)).status).toBe(200);
 const response=await journey.api(`/api/patients/${ids.own}/ceph`,session.cookie,{method:"POST",body:JSON.stringify({documentId:1})});expect([401,403]).toContain(response.status);
 expect((await journey.db.query(sql)).rows).toEqual(before);expect(await journey.ddlLog()).toEqual([]);
});
async function openStudies(page:import("playwright").Page,key:Key="own",signed=false){
 if(!signed)await journey.browserLogin(page,key);await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
 await page.getByRole("button",{name:"عرض دراسات السيفالومتري"}).click();const panel=page.getByTestId("canonical-ceph-studies");await panel.getByText("3.125",{exact:true}).waitFor();return panel;
}
it("browser: mobile saved-value list with draft warning and no tracer, image, financial or writer calls",async()=>{
 const context=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"});try{
 const page=await context.newPage(),calls:string[]=[];await journey.browserLogin(page,"own");page.on("request",r=>{const p=new URL(r.url()).pathname;if(p.startsWith("/api/"))calls.push(`${r.method()} ${p}`);});
 const panel=await openStudies(page,"own",true);await panel.getByText("المسودة ليست نتيجة معتمدة.",{exact:true}).waitFor();expect(await panel.getByRole("listitem").count()).toBe(2);
 expect(await panel.locator("img,canvas,input,textarea").count()).toBe(0);expect(await panel.textContent()).not.toMatch(/SYN saved clinical note|SYN machine|private/);
 expect(calls.filter(c=>c.includes("/ceph"))).toEqual([`GET /api/patients/${ids.own}/ceph`]);expect(calls.some(c=>/\/api\/(documents|images|plans|invoices|ceph)\//.test(c))).toBe(false);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 if(process.env.HR_EVIDENCE_DIR){mkdirSync(process.env.HR_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.HR_EVIDENCE_DIR,"ceph-list-390.png"),fullPage:true});}
 }finally{await context.close();}
});
it("browser: a role label without imaging grant has no entrance",async()=>{
 const context=await journey.browser.newContext();try{const page=await context.newPage();await journey.browserLogin(page,"denied");await page.goto(`${journey.baseUrl}/patients/${ids.own}`);await page.getByRole("button",{name:"عرض حالات التقويم"}).waitFor();expect(await page.getByRole("button",{name:"عرض دراسات السيفالومتري"}).count()).toBe(0);}finally{await context.close();}
});
it("browser: foreign/malformed payload and failed refresh retire saved results without a false empty list",async()=>{
 const context=await journey.browser.newContext();try{
 const page=await context.newPage(),panel=await openStudies(page);
 await page.route(`**/api/patients/${ids.own}/ceph`,async route=>{const r=await route.fetch(),body=await r.json();body.analyses[0].patientId=ids.outside;await route.fulfill({response:r,json:body});});
 await panel.getByRole("button",{name:"تحديث الدراسات"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByRole("listitem").count()).toBe(0);
 await page.unroute(`**/api/patients/${ids.own}/ceph`);await page.route(`**/api/patients/${ids.own}/ceph`,route=>route.abort());await panel.getByRole("button",{name:"تحديث الدراسات"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByRole("listitem").count()).toBe(0);
 }finally{await context.close();}
});
it("browser and HTTP: revoked imaging grant clears data and cannot be recovered by fresh login",async()=>{
 const context=await journey.browser.newContext(),original=(await journey.db.query("SELECT permissions FROM users WHERE id=$1",[journey.ids.all])).rows[0].permissions;
 try{
 const stale=await journey.login("all"),page=await context.newPage(),panel=await openStudies(page,"all");
 await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.xrays.view}','false')::text WHERE id=$1",[journey.ids.all]);
 await panel.getByRole("button",{name:"تحديث الدراسات"}).click();await panel.getByRole("alert").waitFor();expect(await panel.getByRole("listitem").count()).toBe(0);
 expect((await journey.api(`/api/patients/${ids.own}/ceph`,stale.cookie)).status).toBe(401);const fresh=await journey.login("all");expect((await journey.api(`/api/patients/${ids.own}/ceph`,fresh.cookie)).status).toBe(403);
 }finally{await context.close();await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2",[original,journey.ids.all]);}
});
it("browser: a delayed reply cannot restore the closed list",async()=>{
 const context=await journey.browser.newContext();let release!:()=>void,reached!:()=>void,finished!:()=>void;
 const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;}),done=new Promise<void>(r=>{finished=r;});
 try{const page=await context.newPage(),panel=await openStudies(page);let first=true;
 await page.route(`**/api/patients/${ids.own}/ceph`,async route=>{if(!first){await route.continue();return;}first=false;try{const r=await route.fetch();reached();await held;await route.fulfill({response:r}).catch(()=>undefined);}finally{finished();}});
 await panel.getByRole("button",{name:"تحديث الدراسات"}).click();await ready;await page.getByRole("button",{name:"إغلاق الدراسات"}).click();release();await done;expect(await page.getByTestId("canonical-ceph-studies").count()).toBe(0);
 await page.getByRole("button",{name:"عرض دراسات السيفالومتري"}).click();await panel.getByText("3.125",{exact:true}).waitFor();
 }finally{release();await context.close();}
});
