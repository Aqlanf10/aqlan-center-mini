import {Client} from "pg";
import {chromium} from "playwright";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {authedMutation,baseUrl,harness} from "./_server";
let h:Awaited<ReturnType<typeof harness>>,db:Client;
beforeAll(async()=>{h=await harness();expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();},240_000);
afterAll(async()=>{await db?.end();});
describe("explicit new-case agreement selection and lost-response reconciliation",()=>{
 it("creates through HTTP, selects in the real UI, and never replays an ambiguous write",async()=>{
  const stamp=Date.now();
  const patient=(await db.query<{id:number}>("INSERT INTO patients(patient_number,full_name) VALUES($1,'حالة تقويم اصطناعية للمراجعة') RETURNING id",[`ORTHO-RECONCILE-${stamp}`])).rows[0].id;
  const plan=(await db.query<{id:number}>("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'اتفاق اختبار قائم',10000) RETURNING id",[patient])).rows[0].id;
  await db.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,CURRENT_DATE,10000)",[plan]);
  const created=await authedMutation("/api/ortho",h.sessions.admin,"POST",JSON.stringify({patientId:patient,appliance:"fixed_metal",arches:"both",slot:"022",plannedMonths:18}));
  expect(created.status).toBe(201);const caseId=(await created.json()).id;
  const money=async()=>(await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT sum(total_minor)::text FROM treatment_plans WHERE patient_id=$1) principal",[patient])).rows;
  const before=await money();const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  const context=await browser.newContext({viewport:{width:1365,height:900},locale:"ar-YE",serviceWorkers:"block"});
  const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
  let writes=0;let committed=false;
  await context.route("**/*",async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!==baseUrl){await route.abort();return;}
   if(req.method()==="PATCH"&&url.pathname===`/api/ortho/${caseId}`){
    writes++;const body=req.postDataJSON();expect(body.planId).toBe(plan);expect(body.expectedVersion).toMatch(/^[a-f0-9]{64}$/);
    const response=await route.fetch();expect(response.status()).toBe(200);committed=true;
    // The real server commits, but the client receives an invalid success body.
    await route.fulfill({status:200,contentType:"application/json",body:"{}"});return;
   }
   if(!["GET","HEAD","OPTIONS"].includes(req.method())){await route.abort();return;}
   await route.continue();
  });
  try{
   const page=await context.newPage();await page.goto(`${baseUrl}/patients/${patient}?tab=ortho`,{waitUntil:"domcontentloaded"});
   await page.getByText("ربط خطة علاج أو اتفاق قائم",{exact:true}).click();
   const panel=page.getByRole("region",{name:"اتفاق التقويم",exact:true});
   await panel.getByRole("combobox",{name:"اختر اتفاقًا قائمًا",exact:true}).selectOption(String(plan));
   await panel.getByRole("button",{name:"اربط",exact:true}).dblclick();
   await expect.poll(()=>committed).toBe(true);
   await panel.getByText("تعذّر تأكيد نتيجة الربط. تحقّق من الحالة قبل أي طلب جديد.",{exact:true}).waitFor();
   expect(writes).toBe(1);
   await panel.getByRole("button",{name:"تحقق من الارتباط الحالي",exact:true}).click();
   await panel.getByText("اتفاق اختبار قائم",{exact:false}).waitFor();
   expect(writes).toBe(1);
   expect((await db.query("SELECT plan_id FROM ortho_cases WHERE id=$1",[caseId])).rows[0].plan_id).toBe(plan);
   expect(await money()).toEqual(before);
  }finally{await context.close();await browser.close();}
 },120_000);
});
