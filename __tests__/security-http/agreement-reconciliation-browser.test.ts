import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
let browser: Browser, db: Client, h: Awaited<ReturnType<typeof harness>>, serial = 0;
beforeAll(async () => {
 h = await harness(); db = new Client({connectionString:h.seeded.dbUrl,ssl:false}); await db.connect();
 await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 await db.query("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
 browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
},180000);
afterAll(async()=>{await browser?.close();await db?.end();});
async function fixture(){
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic reconciliation browser') RETURNING id",[`REC-UI-${Date.now()}-${++serial}`])).rows[0].id as number;
 const doctorId=(await db.query("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic reconciliation provider','doctor',30) RETURNING id")).rows[0].id as number;
 await db.query("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source,reason,recorded_by) VALUES($1,30,NULL,'2020-01-01','baseline','Synthetic policy','secadmin')",[doctorId]);
 const planId=(await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,billing_mode,primary_doctor_id,total_from_items,consent_at,consent_by) VALUES($1,'Synthetic classic reconciliation',180000,'SAR','2026-10-01','installments',$2,false,now(),'secadmin') RETURNING id",[patientId,doctorId])).rows[0].id as number;
 await db.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-10-01',12000),($1,2,'2099-12-01',168000)",[planId]);
 const payment=await authedMutation(`/api/plans/${planId}`,h.sessions.admin,'POST',JSON.stringify({amount:'120',currency:'SAR'}),{'Idempotency-Key':`reconcile-fixture-${planId}`,'x-collection-similarity-review':'none'});
 expect(payment.status,await payment.clone().text()).toBe(201);
 await db.query("UPDATE treatment_plans SET status='completed' WHERE id=$1",[planId]);
 return {patientId,planId};
}
it.each([390,1280])('reconciles a completed classic agreement at %spx after a lost success reply without rebilling',async width=>{
 const {patientId,planId}=await fixture();
 const originalPayments=(await db.query('SELECT id,invoice_id,amount_minor::text,currency FROM payments WHERE patient_id=$1 ORDER BY id',[patientId])).rows;
 const context=await browser.newContext({viewport:{width,height:960},locale:'ar-YE',serviceWorkers:'block'});
 const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:baseUrl}]);
 const page=await context.newPage();
 try{
  await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'تسوية الاتفاق',exact:true}).click();
  const panel=page.getByTestId('agreement-reconciliation');
  await panel.getByRole('button',{name:'تأكيد التسوية',exact:true}).waitFor({state:'visible'});
  await expect.poll(()=>panel.getByRole('button',{name:'تأكيد التسوية',exact:true}).isEnabled()).toBe(true);
  expect(await panel.innerText()).toContain('المبلغ الذي سيُضاف للفوترة');
  const second=await context.newPage();await second.goto(`${baseUrl}/patients/${patientId}?tab=plans`,{waitUntil:'domcontentloaded'});await second.getByRole('button',{name:'تسوية الاتفاق',exact:true}).click();
  await expect.poll(()=>second.getByTestId('agreement-reconciliation').getByRole('button',{name:'تأكيد التسوية',exact:true}).isEnabled()).toBe(true);
  let secondPosts=0;second.on('request',request=>{if(request.url().endsWith(`/plans/${planId}/reconcile`)&&request.method()==='POST')secondPosts++;});
  let committed!:()=>void;const saved=new Promise<void>(resolve=>{committed=resolve;});let captured='';
  await page.route(`**/api/plans/${planId}/reconcile`,async route=>{
   if(route.request().method()!=='POST'||captured){await route.continue();return;}
   captured=route.request().postData()??'';const result=await route.fetch();expect(result.ok(),await result.text()).toBe(true);committed();await route.abort('failed');
  });
  await panel.getByRole('button',{name:'تأكيد التسوية',exact:true}).click();await saved;
  await panel.getByRole('button',{name:'تحقق من حالة الطلب',exact:true}).waitFor();
  await second.getByRole('button',{name:'تأكيد التسوية',exact:true}).click();
  await second.getByRole('button',{name:'إعادة الطلب المحفوظ نفسه',exact:true}).waitFor();expect(secondPosts).toBe(0);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByTestId('agreement-reconciliation').getByRole('button',{name:'تحقق من حالة الطلب',exact:true}).click();
  await expect.poll(async()=>await page.getByTestId('agreement-reconciliation').innerText()).toContain('محفوظة');
  expect((await db.query('SELECT count(*)::int AS count FROM agreement_reconciliations WHERE plan_id=$1',[planId])).rows[0].count).toBe(1);
  expect((await db.query('SELECT sum(total_minor-discount_minor)::text AS total,count(*)::int AS count FROM invoices WHERE plan_id=$1',[planId])).rows[0]).toEqual({total:'180000',count:2});
  expect((await db.query('SELECT id,invoice_id,amount_minor::text,currency FROM payments WHERE patient_id=$1 ORDER BY id',[patientId])).rows).toEqual(originalPayments);
  const same=await authedMutation(`/api/plans/${planId}/reconcile`,h.sessions.admin,'POST',captured);expect(same.status).toBe(200);expect((await same.json()).replayed).toBe(true);
  const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(geometry.scroll).toBeLessThanOrEqual(geometry.width+1);
  const current=await authedGet(`/api/plans/${planId}/reconcile`,h.sessions.admin);expect(current.status).toBe(200);expect((await current.json()).status).toBe('reconciled');
 }finally{await context.close();}
},180000);
