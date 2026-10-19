import {mkdir} from 'node:fs/promises';
import {Client} from 'pg';
import {chromium,type Browser} from 'playwright';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {authedGet,baseUrl,harness} from './_server';
import {formatMoney,type Currency} from '../../lib/money';
let h:Awaited<ReturnType<typeof harness>>,client:Client,browser:Browser;
const fixtures:{patientId:number;planId:number;currency:Currency;amount:number}[]=[];
let openingPatient=0;let draftPlan=0;
beforeAll(async()=>{
 h=await harness();client=new Client({connectionString:h.seeded.dbUrl,ssl:false});await client.connect();
 const stamp=Date.now();
 for(const [index,currency,amount] of [[1,'YER',2500],[2,'SAR',10000],[3,'USD',5000]] as const){
  const patient=(await client.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id",[`PLAN-READ-${stamp}-${index}`,`مريض قراءة اصطناعي ${currency}`])).rows[0].id;
  const plan=(await client.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,created_by) VALUES($1,$2,$3,$4,CURRENT_DATE,'synthetic') RETURNING id",[patient,`خطة قراءة ${currency}`,amount,currency])).rows[0].id;
  const item=(await client.query("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor) VALUES($1,'Synthetic service',1,$2) RETURNING id",[plan,amount])).rows[0].id;
  const invoice=(await client.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,$3,0,$4,'synthetic') RETURNING id",[`PLAN-READ-${stamp}-${index}`,patient,amount,currency])).rows[0].id;
  await client.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,plan_item_id) VALUES($1,'Synthetic invoice',1,$2,$2,$3)",[invoice,amount,item]);
  // Build the source snapshot with the actual canonical reader; no guessed hash.
  process.env.DATABASE_URL=h.seeded.dbUrl;
  const db=await import('../../lib/db');const {readDebtPosition}=await import('../../lib/debt-installments-db');
  const runner=await db.getPool().connect();
  const source=await readDebtPosition(runner,{patientId:patient,currency,invoiceId:invoice,openingCurrency:null});runner.release();
  const arrangement=(await client.query("INSERT INTO debt_repayment_arrangements(patient_id,currency,invoice_id,created_by) VALUES($1,$2,$3,'synthetic') RETURNING id",[patient,currency,invoice])).rows[0].id;
  const date=(await client.query("SELECT (CURRENT_DATE-1)::text AS day")).rows[0].day;
  await client.query("INSERT INTO debt_repayment_revisions(arrangement_id,version,status,principal_minor,settled_snapshot_minor,source_snapshot,terms,reason,idempotency_key,request_hash,created_by) VALUES($1,1,'active',$2,0,$3::jsonb,$4::jsonb,'Synthetic fixture',$5,$6,'synthetic')",[arrangement,amount,JSON.stringify(source.sourceSnapshot),JSON.stringify({mode:'installments',installments:[{dueDate:date,amountMinor:amount,kind:'installment'}]}),`read-${stamp}-${index}`,source.sourceHash]);
  fixtures.push({patientId:patient,planId:plan,currency,amount});
 }
 openingPatient=(await client.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض رصيد سابق اصطناعي') RETURNING id",[`OPEN-READ-${stamp}`])).rows[0].id;
 await client.query("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'YER',1000,CURRENT_DATE,'synthetic')",[openingPatient]);
 const draftPatient=(await client.query("INSERT INTO patients(patient_number,full_name,phone) VALUES($1,'عرض غير ممول اصطناعي','777123456') RETURNING id",[`DRAFT-READ-${stamp}`])).rows[0].id;
 draftPlan=(await client.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,created_by) VALUES($1,'عرض غير ممول 1500',1500,'YER',CURRENT_DATE,'synthetic') RETURNING id",[draftPatient])).rows[0].id;
 await client.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,CURRENT_DATE-1,1500)",[draftPlan]);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 await mkdir('.settings-ui-artifacts',{recursive:true});
},180000);
afterAll(async()=>{await browser?.close();await client?.end();const db=await import('../../lib/db');await db.resetPoolForTesting();});
it('returns canonical invoice schedules over HTTP without clinical leakage for finance roles',async()=>{
 for(const f of fixtures){
  for(const role of ['admin','accountant'] as const){
   const response=await authedGet(`/api/plans?patientId=${f.patientId}`,h.sessions[role]);expect(response.status).toBe(200);
   const {plans}=await response.json();const plan=plans.find((p:{id:number})=>p.id===f.planId);
   expect(plan).toMatchObject({debtSource:'invoice',baseCurrency:f.currency,installments:[],paidMinor:0,progress:{remainingMinor:f.amount,overdueMinor:f.amount},invoiceFinancial:{kind:'invoice_backed'}});
   expect(plan.invoiceFinancial.schedules).toHaveLength(1);
   if(role==='accountant'){expect(plan).not.toHaveProperty('items');expect(plan.invoiceFinancial.schedules[0]).not.toHaveProperty('history');}
  }
  expect((await authedGet(`/api/plans?patientId=${f.patientId}`,h.sessions.doctorB)).status).toBe(403);
 }
});
it.each([390,1280])('renders native currencies, invoice schedule print and opening labels at %ipx',async width=>{
 const context=await browser.newContext({viewport:{width,height:1000},locale:'ar-YE',serviceWorkers:'block'});
 const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:baseUrl}]);
 const writes:string[]=[];
 await context.route('**/*',async route=>{const request=route.request();if(new URL(request.url()).origin!==baseUrl)return route.abort();if(!['GET','HEAD','OPTIONS'].includes(request.method())){writes.push(request.method());return route.abort();}await route.continue();});
 const page=await context.newPage();
 try{
  await page.goto(`${baseUrl}/finance/plans`);await page.getByText('خطة قراءة SAR',{exact:true}).waitFor();
  for(const f of fixtures){const row=page.locator('tr').filter({has:page.getByText(`خطة قراءة ${f.currency}`,{exact:true})});expect(await row.innerText()).toContain(formatMoney(f.amount,f.currency));}
  expect(await page.getByText('عرض غير ممول 1500',{exact:true}).count()).toBe(0);
  expect(await page.locator('section').first().innerText()).not.toContain(formatMoney(4000,'YER'));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:`.settings-ui-artifacts/plan-native-currencies-${width}.png`,fullPage:true});
  const sarRow=page.locator('tr').filter({has:page.getByText('خطة قراءة SAR',{exact:true})});
  const amount=sarRow.getByText(formatMoney(10000,'SAR'),{exact:true});await amount.scrollIntoViewIfNeeded();
  const bounds=await amount.boundingBox();expect(bounds).not.toBeNull();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width+1);
  await page.screenshot({path:`.settings-ui-artifacts/plan-amount-visible-${width}.png`});
  await page.getByRole('button',{name:'كل الخطط الجارية',exact:true}).click();
  const draftRow=page.locator('tr').filter({has:page.getByText('عرض غير ممول 1500',{exact:true})});
  expect(await draftRow.innerText()).toContain('لا يوجد دين مثبت');
  expect(await draftRow.locator(`#plan-reminder-btn-${draftPlan}`).count()).toBe(0);
  await page.goto(`${baseUrl}/print/plan/${fixtures[1].planId}`);await page.getByText('سداد الفواتير المرتبطة بخطة العلاج',{exact:true}).waitFor();expect(await page.locator('body').innerText()).toContain('جدول سداد الفاتورة');
  await page.screenshot({path:`.settings-ui-artifacts/plan-invoice-schedule-${width}.png`,fullPage:true});
  await page.goto(`${baseUrl}/print/dossier/${openingPatient}`);await page.getByText('الرصيد السابق:',{exact:false}).waitFor();
  const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
  expect(body).toContain(`إجمالي الفواتير: ${formatMoney(0,'YER')}`);expect(body).toContain(`الرصيد السابق: ${formatMoney(1000,'YER')}`);expect(body).toContain(`الرصيد المتبقي (الذمة): ${formatMoney(1000,'YER')}`);
  await page.screenshot({path:`.settings-ui-artifacts/dossier-opening-${width}.png`,fullPage:true});expect(writes).toEqual([]);
 }finally{await context.close();}
});

// Exercise reachable controls on the real patient tab, including actual clinical
// status writes only on these isolated synthetic fixtures. No collection is sent.
it.each([390,1280])('clicks invoice plan print and completion controls across source states at %ipx',async width=>{
 const stamp=`${Date.now()}-${width}`;
 const shift=(await client.query("INSERT INTO cashier_shifts(opened_by,status,closed_at,opening_yer,opening_sar,opening_usd) VALUES('synthetic','closed',NOW(),0,0,0) RETURNING id")).rows[0].id;
 const plans:{id:number;patientId:number;state:string;title:string}[]=[];
 for(const state of ['unpaid','partpaid','paid','completed','review_required','drift']){
  const patient=(await client.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض نقر اصطناعي') RETURNING id",[`CLICK-${stamp}-${state}`])).rows[0].id;
  const title=`خطة نقر ${state}`;
  const id=(await client.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,created_by,status) VALUES($1,$2,1000,'YER',CURRENT_DATE,'synthetic',$3) RETURNING id",[patient,title,state==='completed'?'completed':'active'])).rows[0].id;
  const item=(await client.query("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor) VALUES($1,'Synthetic',1,1000) RETURNING id",[id])).rows[0].id;
  const invoice=(await client.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,1000,0,'YER','synthetic') RETURNING id",[`CLICK-${stamp}-${state}`,patient])).rows[0].id;
  await client.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,plan_item_id) VALUES($1,'Synthetic',1,1000,1000,$2)",[invoice,item]);
  if(state==='review_required')await client.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Unassigned',1,1,1)",[invoice]);
  const db=await import('../../lib/db');const {readDebtPosition}=await import('../../lib/debt-installments-db');
  const runner=await db.getPool().connect();const source=await readDebtPosition(runner,{patientId:patient,currency:'YER',invoiceId:invoice,openingCurrency:null});runner.release();
  const arrangement=(await client.query("INSERT INTO debt_repayment_arrangements(patient_id,currency,invoice_id,created_by) VALUES($1,'YER',$2,'synthetic') RETURNING id",[patient,invoice])).rows[0].id;
  await client.query("INSERT INTO debt_repayment_revisions(arrangement_id,version,status,principal_minor,settled_snapshot_minor,source_snapshot,terms,reason,idempotency_key,request_hash,created_by) VALUES($1,1,'active',1000,0,$2::jsonb,$3::jsonb,'Synthetic',$4,$5,'synthetic')",[arrangement,JSON.stringify(source.sourceSnapshot),JSON.stringify({mode:'installments',installments:[{dueDate:'2026-01-01',amountMinor:1000,kind:'installment'}]}),`CLICK-${stamp}-${state}`,source.sourceHash]);
  const amount=state==='partpaid'?400:state==='paid'?1000:0;
  if(amount)await client.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',$5,'YER',1,$5,'YER','cash','synthetic')",[`CLICK-PAY-${stamp}-${state}`,patient,invoice,shift,amount]);
  if(state==='drift')await client.query("INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,'payment',100,'YER',1,100,'YER','cash','synthetic')",[`CLICK-CREDIT-${stamp}`,patient,shift]);
  plans.push({id,patientId:patient,state,title});
 }
 const before=(await client.query('SELECT receipt_number,amount_minor,currency,exchange_rate,base_amount_minor FROM payments WHERE patient_id=ANY($1::int[]) ORDER BY id',[plans.map(p=>p.patientId)])).rows;
 const context=await browser.newContext({viewport:{width,height:1000},locale:'ar-YE',serviceWorkers:'block'});
 const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:baseUrl}]);
 const unexpected:string[]=[];const completed:number[]=[];
 await context.route('**/*',async route=>{
  const r=route.request(),url=new URL(r.url());if(url.origin!==baseUrl)return route.abort();
  if(!['GET','HEAD','OPTIONS'].includes(r.method())){
   const id=Number(url.pathname.split('/').pop());
   if(r.method()==='PATCH'&&url.pathname===`/api/plans/${id}`&&plans.some(p=>p.id===id)&&r.postDataJSON()?.status==='completed'){completed.push(id);return route.continue();}
   unexpected.push(`${r.method()} ${url.pathname}`);return route.abort();
  }return route.continue();
 });
 const page=await context.newPage();
 try{
  for(const p of plans){
   await page.goto(`${baseUrl}/patients/${p.patientId}?tab=plans`);
   const card=page.locator('li').filter({has:page.getByText(p.title,{exact:true})});await card.waitFor();
   expect(await card.getByRole('button',{name:'تحصيل قسط',exact:true}).count()).toBe(0);
   const [popup]=await Promise.all([context.waitForEvent('page'),card.getByRole('link',{name:/طباعة المرجع/}).click()]);
   await popup.waitForLoadState();expect(popup.url()).toContain(`/print/plan/${p.id}`);
   if(['review_required','drift'].includes(p.state)){
    expect(await card.getByTestId('verified-plan-schedule-row').count()).toBe(0);
    expect(await popup.getByTestId('verified-plan-schedule-row').count()).toBe(0);
   }else expect(await popup.getByTestId('verified-plan-schedule-row').count()).toBeGreaterThan(0);
   await popup.close();
   if(p.state==='completed')expect(await card.getByRole('button',{name:'إنهاء الخطة',exact:true}).count()).toBe(0);
   else{
    await card.getByRole('button',{name:'إنهاء الخطة',exact:true}).click();
    await expect.poll(async()=>(await client.query('SELECT status FROM treatment_plans WHERE id=$1',[p.id])).rows[0].status).toBe('completed');
    await expect.poll(()=>card.getByRole('button',{name:'إنهاء الخطة',exact:true}).count()).toBe(0);
   }
  }
  expect(completed).toHaveLength(5);expect(unexpected).toEqual([]);
  expect((await client.query('SELECT receipt_number,amount_minor,currency,exchange_rate,base_amount_minor FROM payments WHERE patient_id=ANY($1::int[]) ORDER BY id',[plans.map(p=>p.patientId)])).rows).toEqual(before);
  await page.screenshot({path:`.settings-ui-artifacts/plan-controls-clicked-${width}.png`,fullPage:true});
 }finally{await context.close();}
},120000);
