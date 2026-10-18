import {afterAll,beforeAll,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {formatMoney} from "../../lib/money";
import {mkdirSync} from "node:fs";
import {authedMutation,baseUrl,harness} from "./_server";
let browser:Browser;let h:Awaited<ReturnType<typeof harness>>;let db:Client;let serial=0;
beforeAll(async()=>{
 h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
 await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.USD','530'),('finance.rate.SAR','140') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 await db.query("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});mkdirSync(".settings-ui-artifacts",{recursive:true});
},180000);
afterAll(async()=>{await browser?.close();await db?.end();});
async function fixture(){
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic approved principal UI') RETURNING id",[`AP-UI-${Date.now()}-${++serial}`])).rows[0].id;
 const planId=(await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,consent_at,consent_by) VALUES($1,'Synthetic complete agreement',150000,'USD','2026-10-01',now(),'secadmin') RETURNING id",[patientId])).rows[0].id;
 await db.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-10-01',75000),($1,2,'2099-12-01',75000)",[planId]);
 return{patientId,planId};
}
it.each([{role:"admin" as const,width:1280},{role:"reception" as const,width:390}])("$role at $width approves full principal, collects without another invoice and prints both balances",async({role,width})=>{
 const {patientId,planId}=await fixture();const context=await browser.newContext({viewport:{width,height:844},locale:"ar-YE",serviceWorkers:"block"});
 const [name,...value]=h.sessions[role].cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 try{
  await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"اعتماد أصل الاتفاق المالي",exact:true}).click();
  await page.getByLabel("سبب الاعتماد أو دليل المطابقة").fill("Synthetic explicit financial approval");
  const approval=page.waitForResponse(r=>r.url().endsWith(`/plans/${planId}/financial-approval`)&&r.request().method()==="POST");
  await page.getByRole("button",{name:"تأكيد المبلغ والمصدر واعتماد الالتزام",exact:true}).click();expect((await approval).status()).toBe(201);
  await page.getByTestId("approved-agreement").waitFor();
  const paid=await authedMutation(`/api/plans/${planId}`,h.sessions[role],"POST",JSON.stringify({amount:"500",currency:"USD"}),{"Idempotency-Key":`ui-collect-${role}-${planId}`});expect(paid.status,await paid.clone().text()).toBe(201);
  const again=await authedMutation(`/api/plans/${planId}`,h.sessions[role],"POST",JSON.stringify({amount:"500",currency:"USD"}),{"Idempotency-Key":`ui-collect-${role}-${planId}`});expect(again.status).toBe(200);
  expect((await again.json()).paymentId).toBe((await paid.json()).paymentId);
  await page.reload();const panel=page.getByTestId("approved-agreement");await panel.waitFor();expect(await panel.innerText()).toContain("المستحق حتى اليوم");
  const plan=await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments",[patientId]);expect(plan.rows[0]).toEqual({invoices:1,payments:1});
  const print=await context.newPage();await print.goto(`${baseUrl}/print/plan/${planId}`,{waitUntil:"domcontentloaded"});expect(await print.getByTestId("approved-agreement-print").innerText()).toContain("كامل المتبقي");
  expect(await print.getByTestId("approved-agreement-print").innerText()).toContain(formatMoney(25000,"USD"));
  const geometry=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth}));expect(geometry.document).toBeLessThanOrEqual(geometry.width+1);expect(errors).toEqual([]);
  await page.screenshot({path:`.settings-ui-artifacts/approved-agreement-${role}-${width}.png`,fullPage:true});
 }finally{await context.close();}
});
it("HTTP denies doctor approval and requires replay keys",async()=>{
 const {planId}=await fixture();const body=JSON.stringify({expectedTotalMinor:150000,currency:"USD",source:{kind:"new"},reason:"Synthetic approval"});
 expect((await authedMutation(`/api/plans/${planId}/financial-approval`,h.sessions.doctorA,"POST",body,{"Idempotency-Key":"doctor-denied-approval"})).status).toBe(403);
 expect((await authedMutation(`/api/plans/${planId}/financial-approval`,h.sessions.admin,"POST",body)).status).toBe(400);
});
it("general payment endpoint allocates to the approved source and does not bill another installment",async()=>{
 const {patientId,planId}=await fixture();
 const approval=await authedMutation(`/api/plans/${planId}/financial-approval`,h.sessions.admin,"POST",JSON.stringify({expectedTotalMinor:150000,currency:"USD",source:{kind:"new"},reason:"Synthetic source approval"}),{"Idempotency-Key":`general-approval-${planId}`});expect(approval.status).toBe(201);
 const response=await authedMutation("/api/payments",h.sessions.cashier,"POST",JSON.stringify({patientId,planId,kind:"payment",amount:"500",currency:"USD",method:"cash"}),{"Idempotency-Key":`general-collection-${planId}`});
 expect(response.status,await response.clone().text()).toBe(201);const receipt=await response.json();expect(receipt.invoiceId).toBeGreaterThan(0);
 expect((await db.query("SELECT count(*)::int AS count FROM invoices WHERE patient_id=$1",[patientId])).rows[0].count).toBe(1);
});
it.each([390,1280].flatMap(width=>["active","completed"].map(status=>({width,status}))))("real collection at $width on $status survives lost reply, refusal and reload with one receipt",async({width,status})=>{
 const {patientId,planId}=await fixture();
 const approval=await authedMutation(`/api/plans/${planId}/financial-approval`,h.sessions.admin,"POST",JSON.stringify({expectedTotalMinor:150000,currency:"USD",source:{kind:"new"},reason:"Synthetic recovery approval"}),{"Idempotency-Key":`recovery-approval-${planId}`});expect(approval.status).toBe(201);
 await db.query("UPDATE treatment_plans SET status=$2 WHERE id=$1",[planId,status]);
 const context=await browser.newContext({viewport:{width,height:1000},locale:"ar-YE",serviceWorkers:"block"});const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
 const page=await context.newPage();page.on("dialog",dialog=>void dialog.accept());const requests:{key:string;body:string}[]=[];
 try{
  await page.route("**/api/**",async route=>{
   const request=route.request();if(request.method()!=="POST"||![/\/api\/payments$/,new RegExp(`/api/plans/${planId}$`)].some(pattern=>pattern.test(request.url())))return route.continue();
   requests.push({key:request.headers()["idempotency-key"],body:request.postData()!});
   if(requests.length===2)return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({message:"Synthetic uncertain retry refusal"})});
   const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);
   if(requests.length===1)return route.abort("failed");return route.fulfill({response});
  });
  await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`,{waitUntil:"domcontentloaded"});
  const collect=page.getByRole("button",{name:"تحصيل قسط",exact:true});await collect.waitFor({timeout:5000});await expect.poll(()=>collect.isEnabled()).toBe(true);await collect.click();
  await page.getByLabel("مبلغ القسط",{exact:true}).fill("500");await page.getByRole("button",{name:"سجّل القسط واطبع السند",exact:true}).click();
  const retry=page.getByRole("button",{name:"إعادة التحقق من العملية السابقة",exact:true});await retry.waitFor();
  expect(await page.getByLabel("مبلغ القسط",{exact:true}).isDisabled()).toBe(true);
  expect((await db.query("SELECT count(*)::int AS count FROM payments WHERE patient_id=$1",[patientId])).rows[0].count).toBe(1);
  await page.reload({waitUntil:"domcontentloaded"});await retry.waitFor({timeout:5000});expect(await collect.isDisabled()).toBe(true);
  await retry.click();await expect.poll(()=>page.getByRole("alert").filter({hasText:"Synthetic uncertain retry refusal"}).isVisible()).toBe(true);
  expect(await collect.isDisabled()).toBe(true);await page.reload({waitUntil:"domcontentloaded"});await retry.waitFor();expect(requests).toHaveLength(2);
  await retry.click();await expect.poll(()=>retry.count()).toBe(0);await expect.poll(()=>collect.isEnabled()).toBe(true);
  expect(requests).toHaveLength(3);expect(requests[1]).toEqual(requests[0]);expect(requests[2]).toEqual(requests[0]);
  expect((await db.query("SELECT amount_minor::text FROM payments WHERE patient_id=$1",[patientId])).rows).toEqual([{amount_minor:"50000"}]);
  expect((await db.query("SELECT count(*)::int AS count FROM invoices WHERE patient_id=$1",[patientId])).rows[0].count).toBe(1);
  await page.screenshot({path:`.settings-ui-artifacts/agreement-recovery-${status}-${width}.png`,fullPage:true});
 }finally{await context.close();}
});
it.each(["invoice","opening"] as const)("direct approved %s HTTP targets reject missing keys and amounts above 300SAR",async kind=>{
 const {patientId,planId}=await fixture();await db.query("UPDATE treatment_plans SET total_minor=30000,base_currency='SAR' WHERE id=$1",[planId]);await db.query("UPDATE plan_installments SET amount_minor=15000 WHERE plan_id=$1",[planId]);
 if(kind==="opening")await db.query("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date) VALUES($1,'SAR',30000,'2026-09-01')",[patientId]);
 const approval=await authedMutation(`/api/plans/${planId}/financial-approval`,h.sessions.admin,"POST",JSON.stringify({expectedTotalMinor:30000,currency:"SAR",source:kind==="invoice"?{kind:"new"}:{kind:"opening",historicalPaidMinor:0},reason:"Synthetic direct source review"}),{"Idempotency-Key":`direct-source-${planId}`});expect(approval.status,await approval.clone().text()).toBe(201);
 const source=(await db.query("SELECT invoice_id,opening_currency FROM approved_agreement_principals WHERE plan_id=$1",[planId])).rows[0];
 const body=(amount:string)=>JSON.stringify({patientId,invoiceId:source.invoice_id,openingCurrency:source.opening_currency,kind:"payment",amount,currency:"SAR",method:"cash"});
 const missing=await Promise.all([authedMutation("/api/payments",h.sessions.cashier,"POST",body("100")),authedMutation("/api/payments",h.sessions.cashier,"POST",body("100"))]);expect(missing.map(r=>r.status)).toEqual([400,400]);
 const over=await authedMutation("/api/payments",h.sessions.cashier,"POST",body("301"),{"Idempotency-Key":`direct-over-${planId}`});expect(over.status).toBe(400);
 expect((await db.query("SELECT count(*)::int AS count FROM payments WHERE patient_id=$1",[patientId])).rows[0].count).toBe(0);
});
