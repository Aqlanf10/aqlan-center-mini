import {afterAll,beforeAll,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {authedMutation,baseUrl,harness} from "./_server";
let browser:Browser,h:Awaited<ReturnType<typeof harness>>,client:Client,serial=0;
const q=(s:string,v:unknown[]=[])=>client.query(s,v);
beforeAll(async()=>{
 h=await harness();
 client=new Client({connectionString:h.seeded.dbUrl,ssl:false});await client.connect();
 await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 await q("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
},180000);
afterAll(async()=>{await browser?.close();await client?.end();});
async function fixture(){
 const marker=++serial;
 const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic delta HTTP patient') RETURNING id",[`UPG-HTTP-${Date.now()}-${marker}`])).rows[0].id as number;
 const originalServiceId=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,50000,TRUE,TRUE,'prostho') RETURNING id",[`Synthetic original service ${marker}`])).rows[0].id as number;
 const newServiceId=(await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES($1,80000,TRUE,TRUE,'prostho') RETURNING id",[`Synthetic upgraded service ${marker}`])).rows[0].id as number;
 const planId=(await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,consent_at,consent_by) VALUES($1,'Synthetic ten crowns',500000,'YER','2026-10-01',now(),'secadmin') RETURNING id",[patientId])).rows[0].id as number;
 await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,billing_rule,session_count) VALUES($1,$2,'Synthetic original service',10,50000,'once',1)",[planId,originalServiceId]);
 await q("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-10-01',250000),($1,2,'2099-12-01',250000)",[planId]);
 const approval=await authedMutation(`/api/plans/${planId}/financial-approval`,h.sessions.admin,"POST",
 JSON.stringify({expectedTotalMinor:500000,currency:"YER",source:{kind:"new"},reason:"Synthetic full original approval"}),{"Idempotency-Key":`approved-http-${planId}`});
 expect(approval.status,await approval.clone().text()).toBe(201);
 const paid=await authedMutation(`/api/plans/${planId}`,h.sessions.admin,"POST",
 JSON.stringify({amount:"180000",currency:"YER"}),{"Idempotency-Key":`deposit-http-${planId}`});
 expect(paid.status,await paid.clone().text()).toBe(201);
 return {patientId,planId,newServiceId};
}
async function preview(planId:number){
 const response=await fetch(`${baseUrl}/api/plans/${planId}/agreement-amendment`,{headers:{Cookie:h.sessions.admin.cookie}});
 expect(response.status,await response.clone().text()).toBe(200);
 return (await response.json()) as {sourceHash:string};
}
it("HTTP posts dated 300000 difference, repeats exact key, then collects total 620000 split across two invoices",async()=>{
 const f=await fixture(),view=await preview(f.planId);
 const key=`upgrade-http-${f.planId}`;
 const body=JSON.stringify({idempotencyKey:key,expectedSourceHash:view.sourceHash,newServiceId:f.newServiceId,newUnitMinor:80000,reason:"Signed synthetic zirconia upgrade"});
 const url=`/api/plans/${f.planId}/agreement-amendment`;
 const created=await authedMutation(url,h.sessions.admin,"POST",body);
 expect(created.status,await created.clone().text()).toBe(201);
 expect(await created.json()).toMatchObject({deltaMinor:300000,revisedAgreementMinor:800000,remainingMinor:620000,cashMovementMinor:0});
 const replay=await authedMutation(url,h.sessions.admin,"POST",body);
 expect(replay.status,await replay.clone().text()).toBe(200);
 expect(await replay.json()).toMatchObject({replayed:true,deltaMinor:300000});
 const deny=await authedMutation(url,h.sessions.doctorA,"POST",body);expect(deny.status).toBe(403);
 const changed=await authedMutation(url,h.sessions.admin,"POST",JSON.stringify({...JSON.parse(body),newUnitMinor:90000}));
 expect(changed.status).toBe(409);
 const collected=await authedMutation(`/api/plans/${f.planId}`,h.sessions.admin,"POST",
 JSON.stringify({amount:"620000",currency:"YER"}),{"Idempotency-Key":`last-http-${f.planId}`});
 expect(collected.status,await collected.clone().text()).toBe(201);
 expect((await collected.json()).paymentIds).toHaveLength(2);
 const repeated=await authedMutation(`/api/plans/${f.planId}`,h.sessions.admin,"POST",
 JSON.stringify({amount:"620000",currency:"YER"}),{"Idempotency-Key":`last-http-${f.planId}`});
 expect(repeated.status,await repeated.clone().text()).toBe(200);
 expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(3);
 expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(2);
});
it("browser confirmed 409 refusal can reset and refresh; interrupted responses preserve exact body and key",async()=>{
 const f=await fixture(),url=`/api/plans/${f.planId}/agreement-amendment`;
 const context=await browser.newContext({viewport:{width:390,height:900},locale:"ar-YE",serviceWorkers:"block"});
 const [name,...value]=h.sessions.admin.cookie.split("=");
 await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
 const page=await context.newPage();
 try{
  await page.goto(`${baseUrl}/patients/${f.patientId}?tab=plans`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"ترقية خدمة الاتفاق بفرق مؤرخ"}).click();
  await page.getByLabel("الخدمة الجديدة — اختيار صريح").selectOption(String(f.newServiceId));
  await page.getByLabel("سعر الوحدة الجديد (YER)").fill("80000");
  await page.getByLabel("سبب التعديل وموافقة المريض").fill("Synthetic reviewed upgrade");
  const captured:{key:string;body:string}[]=[];
  await page.route(`**${url}`,async route=>{
   if(route.request().method()!=="POST")return route.continue();
   captured.push({key:JSON.parse(route.request().postData()!).idempotencyKey,body:route.request().postData()!});
   if(captured.length===1)return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({code:"stale",message:"Synthetic source stale"})});
   if(captured.length===2)return route.abort("failed");
   return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({code:"stale",message:"Synthetic source stale"})});
  });
  await page.getByRole("button",{name:"حفظ فرق التعديل المؤرخ"}).click();
  await page.getByRole("button",{name:"تحديث المعاينة وتصحيح الطلب المرفوض"}).waitFor();
  await page.getByRole("button",{name:"تحديث المعاينة وتصحيح الطلب المرفوض"}).click();
  await page.getByLabel("الخدمة الجديدة — اختيار صريح").selectOption(String(f.newServiceId));
  await page.getByLabel("سعر الوحدة الجديد (YER)").fill("80000");
  await page.getByLabel("سبب التعديل وموافقة المريض").fill("Synthetic reviewed upgrade");
  await page.getByRole("button",{name:"حفظ فرق التعديل المؤرخ"}).click();
  await page.getByRole("button",{name:"إعادة الطلب المحفوظ نفسه"}).waitFor();
  await page.reload({waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"ترقية خدمة الاتفاق بفرق مؤرخ"}).click();
  await page.getByRole("button",{name:"إعادة الطلب المحفوظ نفسه"}).click();
  await expect.poll(()=>captured.length).toBe(3);
  expect(captured[2]).toEqual(captured[1]);expect(captured[0].key).not.toBe(captured[1].key);
  expect((await q("SELECT count(*)::int n FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows[0].n).toBe(0);
 }finally{await context.close();}
});

it("the public /api/payments acknowledgment returns BOTH printable receipts and replays the exact allocations",async()=>{
 const f=await fixture(),view=await preview(f.planId);
 const body=JSON.stringify({idempotencyKey:`api-split-upgrade-${f.planId}`,expectedSourceHash:view.sourceHash,
  newServiceId:f.newServiceId,newUnitMinor:80000,reason:"Synthetic witnessed replacement"});
 const saved=await authedMutation(`/api/plans/${f.planId}/agreement-amendment`,h.sessions.admin,"POST",body);
 expect(saved.status,await saved.clone().text()).toBe(201);
 const key=`api-split-collection-${f.planId}`;
 const request=JSON.stringify({patientId:f.patientId,planId:f.planId,
  kind:"payment",amount:"620000",currency:"YER",method:"cash"});
 const collect=()=>authedMutation("/api/payments",h.sessions.admin,"POST",request,{"Idempotency-Key":key});
 const first=await collect();
 expect(first.status,await first.clone().text()).toBe(201);
 const payload=await first.json();
 expect(payload.collection).toMatchObject({kind:"approved_agreement_split_v1",
  patientId:f.patientId,planId:f.planId,currency:"YER",amountMinor:620000});
 expect(payload.collection.paymentIds).toHaveLength(2);
 expect(payload.collection.allocations.map((row:{amountMinor:number})=>row.amountMinor)).toEqual([320000,300000]);
 expect(payload.collection.receipts).toHaveLength(2);
 expect(payload.collection.receipts.map((row:{id:number})=>row.id)).toEqual(payload.collection.paymentIds);
 expect(payload.collection.receipts.every((row:{receiptNumber:string})=>row.receiptNumber.length>0)).toBe(true);
 expect(payload.collectionAmountMinor).toBe(620000);
 const again=await collect();
 expect(again.status,await again.clone().text()).toBe(200);
 const replay=await again.json();
 expect(replay.collection).toEqual(payload.collection);
 expect(replay.paymentIds).toEqual(payload.paymentIds);
 expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(3);
});

it("real browser PatientPlans retains the committed split when the reply is lost and another user is denied",async()=>{
 const f=await fixture(),view=await preview(f.planId);
 const change=await authedMutation(`/api/plans/${f.planId}/agreement-amendment`,h.sessions.admin,"POST",
   JSON.stringify({idempotencyKey:`browser-upgrade-${f.planId}`,expectedSourceHash:view.sourceHash,
     newServiceId:f.newServiceId,newUnitMinor:80000,reason:"Browser synthetic upgrade"}));
 expect(change.status,await change.clone().text()).toBe(201);
 const context=await browser.newContext({viewport:{width:1280,height:900},locale:"ar-YE",serviceWorkers:"block"});
 const login=async(cookie:string)=>{
  const [name,...parts]=cookie.split("=");
  await context.clearCookies();
  await context.addCookies([{name,value:parts.join("="),url:baseUrl}]);
 };
 await login(h.sessions.admin.cookie);
 const page=await context.newPage();
 const captured:{key:string;body:string}[]=[];let firstCommitted=false;
 try{
  await page.route("**/api/payments",async route=>{
   if(route.request().method()!=="POST")return route.continue();
   const key=route.request().headers()["idempotency-key"]??"",body=route.request().postData()??"";
   captured.push({key,body});
   if(!firstCommitted){
    firstCommitted=true;
    const backend=await route.fetch();
    expect(backend.status(),await backend.text()).toBe(201);
    // Server writes all receipts, but the browser loses the acknowledgement.
    await route.abort("failed");
   }else await route.continue();
  });
  await page.goto(`${baseUrl}/patients/${f.patientId}?tab=plans`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"تحصيل قسط",exact:true}).click();
  await page.getByLabel("مبلغ القسط").fill("620000");
  await page.getByRole("button",{name:"سجّل القسط واطبع السند"}).click();
  await expect.poll(()=>captured.length).toBe(1);
  expect(JSON.parse(captured[0].body)).toMatchObject({planId:f.planId,amount:"620000",currency:"YER"});
  await page.getByRole("button",{name:"إعادة التحقق من العملية السابقة"}).waitFor();
  expect((await q("SELECT count(*)::int n FROM payments WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(3);
  // Switching identity cannot erase the original user's durable IndexedDB record.
  await login(h.sessions.doctorA.cookie);
  await page.reload({waitUntil:"domcontentloaded"});
  const denied=await authedMutation("/api/payments",h.sessions.doctorA,"POST",captured[0].body,
    {"Idempotency-Key":captured[0].key});
  expect(denied.status).toBe(403);
  await login(h.sessions.admin.cookie);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"إعادة التحقق من العملية السابقة"}).click();
  await expect.poll(()=>captured.length).toBe(2);
  expect(captured[1]).toEqual(captured[0]);
  await page.getByTestId("approved-split-receipts").getByRole("link",{name:/طباعة السند/}).first().waitFor();
  expect(await page.getByTestId("approved-split-receipts").getByRole("link",{name:/طباعة السند/}).count()).toBe(2);
  expect((await q("SELECT count(*)::int n FROM payments WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(3);
 }finally{await context.close();}
});
