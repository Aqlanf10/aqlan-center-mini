import {afterAll,beforeAll,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {formatMoney} from "../../lib/money";
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
   if(captured.length===1)return route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({code:"invalid",message:"Synthetic input rejected before write"})});
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

it("a populated historical statement has stable totals after /api/payments distributed collection",async()=>{
 const f=await fixture();
 const shift=(await q("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id LIMIT 1")).rows[0].id;
 const old=(await q(`INSERT INTO invoices
   (invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
   VALUES($1,$2,15000,0,'YER','synthetic-history','2026-09-12T10:00:00+03:00') RETURNING id`,
   [`SPLIT-HIST-${f.planId}`,f.patientId])).rows[0].id;
 await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic earlier care',1,15000,15000)",[old]);
 await q(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,
   base_amount_minor,base_currency,method,created_by,created_at)
   VALUES($1,$2,$3,$4,'payment',15000,'YER',1,15000,'YER','cash','synthetic-history','2026-09-13T10:00:00+03:00')`,
   [`SPLIT-HIST-R-${f.planId}`,f.patientId,old,shift]);
 const path=`/api/reports?report=patient-statement&preset=custom&from=2026-09-01&to=2026-09-30&patientId=${f.patientId}`;
 const read=async()=>{
   const response=await fetch(baseUrl+path,{headers:{cookie:h.sessions.admin.cookie}});
   expect(response.status,await response.clone().text()).toBe(200);
   return (await response.json()).result;
 };
 const before=await read();
 expect(before.rows.length).toBeGreaterThan(0);
 const view=await preview(f.planId);
 const saved=await authedMutation(`/api/plans/${f.planId}/agreement-amendment`,h.sessions.admin,"POST",JSON.stringify({
   idempotencyKey:`stable-hist-upgrade-${f.planId}`,expectedSourceHash:view.sourceHash,
   newServiceId:f.newServiceId,newUnitMinor:80000,reason:"Historical cutoff witness"}));
 expect(saved.status,await saved.clone().text()).toBe(201);
 const collection=await authedMutation("/api/payments",h.sessions.admin,"POST",
  JSON.stringify({patientId:f.patientId,planId:f.planId,kind:"payment",amount:"620000",currency:"YER",method:"cash"}),
  {"Idempotency-Key":`stable-hist-collect-${f.planId}`});
 expect(collection.status,await collection.clone().text()).toBe(201);
 expect((await collection.json()).collection.receipts).toHaveLength(2);
 expect(await read()).toEqual(before);
});


it("real browser refreshes a payment-stale preview ONLY after same-key committed rejection proof",async()=>{
 const f=await fixture();
 const context=await browser.newContext({viewport:{width:1280,height:900},locale:"ar-YE",serviceWorkers:"block"});
 const [cookieName,...cookieParts]=h.sessions.admin.cookie.split("=");
 await context.addCookies([{name:cookieName,value:cookieParts.join("="),url:baseUrl}]);
 const page=await context.newPage();
 const editor=`/api/plans/${f.planId}/agreement-amendment`;
 try{
  await page.goto(`${baseUrl}/patients/${f.patientId}?tab=plans`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"ترقية خدمة الاتفاق بفرق مؤرخ"}).click();
  const fill=async()=>{
   await page.getByLabel("الخدمة الجديدة — اختيار صريح").selectOption(String(f.newServiceId));
   await page.getByLabel("سعر الوحدة الجديد (YER)").fill("80000");
   await page.getByLabel("سبب التعديل وموافقة المريض").fill("Signed synthetic upgrade with fresh debt evidence");
  };
  await fill();
  const later=await authedMutation(`/api/plans/${f.planId}`,h.sessions.admin,"POST",
    JSON.stringify({amount:"20000",currency:"YER"}),{"Idempotency-Key":`stale-between-preview-${f.planId}`});
  expect(later.status,await later.clone().text()).toBe(201);
  await page.getByRole("button",{name:"حفظ فرق التعديل المؤرخ"}).click();
  await page.getByRole("button",{name:"تحديث المعاينة وتصحيح الطلب المرفوض"}).waitFor();
  const rows=(await q("SELECT idempotency_key FROM agreement_delta_attempt_rejections WHERE plan_id=$1",[f.planId])).rows;
  expect(rows).toHaveLength(1);
  const prior=(await q("SELECT count(*)::int n FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows[0].n;
  expect(prior).toBe(0);
  // Refreshed attempt must have a fresh source hash, and a NEW key is allowed
  // only now that the stale attempt has its immutable rejection witness.
  await page.getByRole("button",{name:"تحديث المعاينة وتصحيح الطلب المرفوض"}).click();
  await fill();
  await page.getByRole("button",{name:"حفظ فرق التعديل المؤرخ"}).click();
  await expect.poll(async()=>Number((await q("SELECT count(*)::int n FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows[0].n)).toBe(1);
  expect((await q("SELECT count(*)::int n FROM invoices WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(2);
  const plans=await fetch(`${baseUrl}/api/patients/${f.patientId}/plans`,{headers:{Cookie:h.sessions.admin.cookie}});
  expect(plans.status,await plans.clone().text()).toBe(200);
  const payload=await plans.json();
  expect(payload.plans.find((p:{id:number})=>p.id===f.planId).approvedAgreement)
    .toMatchObject({totalMinor:800000,paidMinor:200000,remainingMinor:600000});
  const ledger=await fetch(`${baseUrl}/api/reports?report=patient-statement&preset=custom&from=2026-01-01&to=2099-12-31&patientId=${f.patientId}`,{headers:{cookie:h.sessions.admin.cookie}});
  expect(ledger.status,await ledger.clone().text()).toBe(200);
  const report=(await ledger.json()).result;
  expect(report.kpis.find((k:{key:string})=>k.key==="balance")?.minor).toBe(600000);
 }finally{await context.close();}
});
it("losing an ACTUAL amendment commit reply survives user switch and retries the saved request without a second difference invoice",async()=>{
 const f=await fixture();
 const context=await browser.newContext({viewport:{width:390,height:900},locale:"ar-YE",serviceWorkers:"block"});
 const login=async(cookie:string)=>{
  const [name,...v]=cookie.split("=");await context.clearCookies();
  await context.addCookies([{name,value:v.join("="),url:baseUrl}]);
 };
 await login(h.sessions.admin.cookie);
 const page=await context.newPage();
 const captured:{key:string;body:string}[]=[];
 let dropped=false;
 try{
  await page.route(`**/api/plans/${f.planId}/agreement-amendment`,async route=>{
   if(route.request().method()!=="POST")return route.continue();
   const body=route.request().postData()??"";
   captured.push({key:JSON.parse(body).idempotencyKey,body});
   if(!dropped){
    dropped=true;
    const committed=await route.fetch();
    expect(committed.status(),await committed.text()).toBe(201);
    await route.abort("failed");
   }else await route.continue();
  });
  await page.goto(`${baseUrl}/patients/${f.patientId}?tab=plans`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"ترقية خدمة الاتفاق بفرق مؤرخ"}).click();
  await page.getByLabel("الخدمة الجديدة — اختيار صريح").selectOption(String(f.newServiceId));
  await page.getByLabel("سعر الوحدة الجديد (YER)").fill("80000");
  await page.getByLabel("سبب التعديل وموافقة المريض").fill("Signed synthetic saved request with missing transport reply");
  await page.getByRole("button",{name:"حفظ فرق التعديل المؤرخ"}).click();
  await page.getByRole("button",{name:"إعادة الطلب المحفوظ نفسه"}).waitFor();
  expect(captured).toHaveLength(1);
  expect((await q("SELECT count(*)::int n FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows[0].n).toBe(1);
  const stored=await page.evaluate((id:number)=>sessionStorage.getItem(`aqlan:agreement-amendment:pending:${id}`),f.planId);
  expect(stored).toContain(captured[0].key);
  // Different role must not discard the original actor's recovery material.
  await login(h.sessions.doctorA.cookie);
  await page.reload({waitUntil:"domcontentloaded"});
  const denied=await authedMutation(`/api/plans/${f.planId}/agreement-amendment`,h.sessions.doctorA,"PUT",captured[0].body);
  expect(denied.status).toBe(403);
  expect(await page.evaluate((id:number)=>sessionStorage.getItem(`aqlan:agreement-amendment:pending:${id}`),f.planId)).toContain(captured[0].key);
  await login(h.sessions.admin.cookie);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"ترقية خدمة الاتفاق بفرق مؤرخ"}).click();
  await page.getByRole("button",{name:"إعادة الطلب المحفوظ نفسه"}).click();
  await expect.poll(()=>captured.length).toBe(2);
  expect(captured[1]).toEqual(captured[0]);
  const replay=await authedMutation(`/api/plans/${f.planId}/agreement-amendment`,h.sessions.admin,"PUT",captured[0].body);
  expect(replay.status,await replay.clone().text()).toBe(200);
  expect((await replay.json()).state).toBe("committed");
  expect((await q("SELECT count(*)::int n FROM agreement_delta_amendments WHERE plan_id=$1",[f.planId])).rows[0].n).toBe(1);
  expect((await q("SELECT count(*)::int n FROM invoices WHERE patient_id=$1",[f.patientId])).rows[0].n).toBe(2);
 }finally{await context.close();}
});
it("each PRINTED receipt proves its own original/difference invoice and cash amount (not just links)",async()=>{
 const f=await fixture(),view=await preview(f.planId);
 const saved=await authedMutation(`/api/plans/${f.planId}/agreement-amendment`,h.sessions.admin,"POST",JSON.stringify({
  idempotencyKey:`print-delta-${f.planId}`,expectedSourceHash:view.sourceHash,
  newServiceId:f.newServiceId,newUnitMinor:80000,reason:"Signed synthetic print proof"}));
 expect(saved.status,await saved.clone().text()).toBe(201);
 const receive=await authedMutation("/api/payments",h.sessions.admin,"POST",JSON.stringify({
  patientId:f.patientId,planId:f.planId,kind:"payment",amount:"620000",currency:"YER",method:"cash"
 }),{"Idempotency-Key":`print-split-${f.planId}`});
 expect(receive.status,await receive.clone().text()).toBe(201);
 const groups=(await receive.json()).collection;
 expect(groups.receipts).toHaveLength(2);
 const context=await browser.newContext({locale:"ar-YE",serviceWorkers:"block"});
 const [name,...cookie]=h.sessions.admin.cookie.split("=");
 await context.addCookies([{name,value:cookie.join("="),url:baseUrl}]);
 const page=await context.newPage();
 try{
  for(const [index,receipt] of groups.receipts.entries()){
   const allocation=groups.allocations[index];
   await page.goto(`${baseUrl}/print/receipt/${receipt.id}`,{waitUntil:"domcontentloaded"});
   const printed=await page.locator(".sheet").innerText();
   expect(printed).toContain(receipt.receiptNumber);
   expect(printed).toContain(`#${allocation.invoiceId}`);
   expect((await page.locator(".sheet .amount-box").innerText()).trim())
     .toBe(formatMoney(allocation.amountMinor,"YER"));
   expect(allocation.amountMinor).toBe(index===0?320000:300000);
  }
 }finally{await context.close();}
});
/** Every stored financial fact this collection can touch, plus the derived statement totals. */
async function financialState(patientId:number,planId:number){
 const stored=(await q(`SELECT jsonb_build_object(
   'payments',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE patient_id=$1),
   'invoices',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1),
   'items',(SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.id) FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.patient_id=$1),
   'installments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM plan_installments x WHERE plan_id=$2),
   'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY idempotency_key) FROM agreement_delta_collection_receipts g WHERE patient_id=$1),
   'amendments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM agreement_delta_amendments a WHERE plan_id=$2),
   'shift',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM cashier_shifts s WHERE status='open')) AS state`,[patientId,planId])).rows[0].state;
 const statement=await fetch(`${baseUrl}/api/reports?report=patient-statement&preset=custom&from=2026-01-01&to=2099-12-31&patientId=${patientId}`,{headers:{cookie:h.sessions.admin.cookie}});
 expect(statement.status,await statement.clone().text()).toBe(200);
 const plans=await fetch(`${baseUrl}/api/patients/${patientId}/plans`,{headers:{cookie:h.sessions.admin.cookie}});
 expect(plans.status,await plans.clone().text()).toBe(200);
 return {stored,statement:(await statement.json()).result,agreement:(await plans.json()).plans.find((p:{id:number})=>p.id===planId).approvedAgreement};
}
it("(#408 finding 2) split advisory: operation total, each receipt with its partial refund, both prints, confirmation whose reply is lost after commit, UI replay of the identical request, both new prints",async()=>{
 const f=await fixture(),view=await preview(f.planId);
 const saved=await authedMutation(`/api/plans/${f.planId}/agreement-amendment`,h.sessions.admin,"POST",JSON.stringify({
  idempotencyKey:`advisory-delta-${f.planId}`,expectedSourceHash:view.sourceHash,
  newServiceId:f.newServiceId,newUnitMinor:80000,reason:"Signed synthetic advisory journey"}));
 expect(saved.status,await saved.clone().text()).toBe(201);
 // 330000 = 320000 on the original invoice + 10000 on the difference invoice.
 const first=await authedMutation("/api/payments",h.sessions.admin,"POST",JSON.stringify({
  patientId:f.patientId,planId:f.planId,kind:"payment",amount:"330000",currency:"YER",method:"cash"}),{"Idempotency-Key":`advisory-first-${f.planId}`});
 expect(first.status,await first.clone().text()).toBe(201);
 const group=(await first.json()).collection as {receipts:{id:number;receiptNumber:string}[];allocations:{amountMinor:number}[]};
 expect(group.allocations.map(a=>a.amountMinor)).toEqual([320000,10000]);
 // Partial reversal of the first receipt keeps the group alive and must be visible per receipt.
 const refund=await authedMutation("/api/payments",h.sessions.admin,"POST",JSON.stringify({
  patientId:f.patientId,kind:"refund",reversalOfId:group.receipts[0].id,amount:"40000",currency:"YER",method:"cash",note:"Synthetic partial reversal"}),
  {"Idempotency-Key":`advisory-refund-${f.planId}`});
 expect(refund.status,await refund.clone().text()).toBe(201);
 const before=await financialState(f.patientId,f.planId);
 expect(before.stored.payments.length).toBe(4);
 const lastId=Math.max(...before.stored.payments.map((p:{id:number})=>p.id));
 const context=await browser.newContext({viewport:{width:1280,height:900},locale:"ar-YE",serviceWorkers:"block"});
 const [name,...cookie]=h.sessions.admin.cookie.split("=");
 await context.addCookies([{name,value:cookie.join("="),url:baseUrl}]);
 const page=await context.newPage();
 const posts:{key:string;body:string;review:string|undefined}[]=[];
 const replies:{status:number;body:Record<string,unknown>}[]=[];
 await page.route("**/api/payments",async route=>{
  const request=route.request();
  if(request.method()!=="POST")return route.continue();
  posts.push({key:request.headers()["idempotency-key"]??"",body:request.postData()??"",review:request.headers()["x-collection-similarity-review"]});
  const backend=await route.fetch();
  replies.push({status:backend.status(),body:await backend.json()});
  // The confirmation commits on the server, but its reply never reaches the browser.
  if(posts.length===2)return route.abort("failed");
  return route.fulfill({response:backend});
 });
 try{
  await page.goto(`${baseUrl}/patients/${f.patientId}?tab=plans`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"تحصيل قسط",exact:true}).click();
  await page.getByLabel("مبلغ القسط").fill("330000");
  await page.getByRole("button",{name:"سجّل القسط واطبع السند"}).click();
  const warning=page.getByRole("alertdialog",{name:"تنبيه سند قبض مشابه"});
  await warning.waitFor();
  expect(replies[0].status).toBe(409);
  const text=await warning.innerText();
  expect(text).toContain("عملية تحصيل واحدة موزعة على 2 سندات");
  expect(text).toContain(`إجمالي المدفوع ${formatMoney(330000,"YER")}`);
  const items=warning.getByRole("list",{name:"سندات العملية"}).getByRole("listitem");
  expect(await items.count()).toBe(2);
  const firstItem=await items.nth(0).innerText(),secondItem=await items.nth(1).innerText();
  expect(firstItem).toContain(`السند ${group.receipts[0].receiptNumber} · ${formatMoney(320000,"YER")}`);
  expect(firstItem).toContain(`مسترد ${formatMoney(40000,"YER")}`);
  expect(firstItem).not.toContain("(بالكامل)");
  expect(secondItem).toContain(`السند ${group.receipts[1].receiptNumber} · ${formatMoney(10000,"YER")}`);
  expect(secondItem).not.toContain("مسترد");
  // Each advisory link opens its own receipt print, with that receipt's own amount.
  for(const [index,receipt] of group.receipts.entries()){
   const link=warning.getByRole("link",{name:`مراجعة السند ${receipt.receiptNumber}`});
   expect(await link.getAttribute("href")).toBe(`/print/receipt/${receipt.id}`);
   const [print]=await Promise.all([context.waitForEvent("page"),link.click()]);
   await print.waitForLoadState("domcontentloaded");
   expect(await print.locator(".sheet").innerText()).toContain(receipt.receiptNumber);
   expect((await print.locator(".sheet .amount-box").innerText()).trim()).toBe(formatMoney(index===0?320000:10000,"YER"));
   await print.close();
  }
  // Advisory and prints wrote nothing anywhere: receipts, invoices, schedule, groups, shift and derived totals.
  expect(await financialState(f.patientId,f.planId)).toEqual(before);
  await warning.getByRole("button",{name:"تسجيل دفعة مستقلة"}).click();
  await page.getByRole("button",{name:"إعادة التحقق من العملية السابقة"}).waitFor();
  expect(replies[1].status).toBe(201);
  const committed=(await q("SELECT id,receipt_number,amount_minor::int AS amount FROM payments WHERE patient_id=$1 AND id>$2 ORDER BY id",[f.patientId,lastId])).rows;
  expect(committed.map(r=>r.amount)).toEqual([40000,290000]);
  const afterCommit=await financialState(f.patientId,f.planId);
  // Retry through the actual UI: the identical committed request under the same key.
  await page.getByRole("button",{name:"إعادة التحقق من العملية السابقة"}).click();
  const printLinks=page.getByTestId("approved-split-receipts").getByRole("link",{name:/طباعة السند/});
  await printLinks.first().waitFor();
  expect(posts).toHaveLength(3);
  expect(posts[0].review).toBeUndefined();expect(posts[1].review).toBeTruthy();
  expect(posts[1].key).toBe(posts[0].key);expect(posts[1].body).toBe(posts[0].body);
  // Same fingerprint (key + body). The recovery send carries no review header: a committed key replays
  // before any similarity check, and an uncommitted one would be asked to review again, never recorded unreviewed.
  expect({key:posts[2].key,body:posts[2].body}).toEqual({key:posts[1].key,body:posts[1].body});
  expect(posts[2].review).toBeUndefined();
  expect(replies[2].status).toBe(200);
  const replayed=replies[2].body as {paymentIds:number[];collection:{allocations:{paymentId:number;amountMinor:number}[]}};
  expect(replayed.paymentIds).toEqual(committed.map(r=>r.id));
  expect(replayed.collection.allocations.map(a=>[a.paymentId,a.amountMinor])).toEqual(committed.map(r=>[r.id,r.amount]));
  expect((replies[1].body as {collection:unknown}).collection).toEqual(replayed.collection);
  // The replay wrote nothing: state is exactly what the lost-reply commit left.
  expect(await financialState(f.patientId,f.planId)).toEqual(afterCommit);
  expect(afterCommit.stored.payments.length).toBe(6);
  // Both final receipt links, by actual clicks.
  expect(await printLinks.count()).toBe(2);
  for(const [index,row] of committed.entries()){
   const [print]=await Promise.all([context.waitForEvent("page"),printLinks.nth(index).click()]);
   await print.waitForLoadState("domcontentloaded");
   expect(new URL(print.url()).pathname).toBe(`/print/receipt/${row.id}`);
   expect(await print.locator(".sheet").innerText()).toContain(row.receipt_number);
   expect((await print.locator(".sheet .amount-box").innerText()).trim()).toBe(formatMoney(row.amount,"YER"));
   await print.close();
  }
 }finally{await context.close();}
});
