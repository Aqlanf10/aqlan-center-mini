import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {authedMutation,baseUrl,harness} from "./_server";
let browser:Browser,db:Client,h:Awaited<ReturnType<typeof harness>>,serviceId:number;
beforeAll(async()=>{h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  await db.query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) SELECT 'synthetic-history-recovery',0,0,0 WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
  serviceId=(await db.query("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('علاج تاريخي تجريبي','rct',300000,TRUE,TRUE) RETURNING id")).rows[0].id;
},240000);
afterAll(async()=>{await browser?.close();await db?.end();});
describe("historical editor retains actual collections and survives lost correction replies",()=>{
  it.each([390,1440])("reduces historical principal below actual collection without a fake receipt at%i px",async width=>{
    const patientId=(await db.query("INSERT INTO patients(patient_number,full_name,birth_date) VALUES($1,'مريض تاريخي تجريبي','1990-01-01') RETURNING id",[`HIST-CORR-${width}-${Date.now()}`])).rows[0].id;
    const source={patientId,currency:"YER",items:[{serviceId,quantity:1,price:"300000",catalogPriceMinor:300000,toothCode:16}],discount:"0",discountReason:null,previouslyPaidAmount:"120000",historicalAsOf:"2026-10-01",note:null,idempotencyKey:`history-ui-create-${patientId}`,
      repaymentTerms:{mode:"full",installments:[]},repaymentRemainingMinor:180000,repaymentVersion:0,repaymentSourceHash:null};
    const created=await authedMutation(`/api/patients/${patientId}/historical-documents`,h.sessions.admin,"POST",JSON.stringify(source));const initial=await created.json();expect(created.status,JSON.stringify(initial)).toBe(201);
    const paid=await authedMutation("/api/payments",h.sessions.admin,"POST",JSON.stringify({patientId,amount:"20000",currency:"YER",openingCurrency:"YER",kind:"payment",method:"cash"}));expect(paid.status,await paid.text()).toBe(201);
    const before=(await db.query("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1",[patientId])).rows;
    const context=await browser.newContext({viewport:{width,height:1000},locale:"ar-YE",serviceWorkers:"block"});const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();page.on("dialog",dialog=>void dialog.accept());const bodies:string[]=[];
    try{
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});await page.getByRole("button",{name:"تصحيح الاتفاق التاريخي",exact:true}).click();
      const editor=page.getByTestId("historical-correction-editor");await editor.getByLabel("سعر تصحيح الاتفاق 1",{exact:true}).fill("130000");await editor.getByLabel("سبب تصحيح الاتفاق",{exact:true}).fill("تصحيح الاتفاق المعتمد للتجربة");
      await expect.poll(()=>editor.innerText()).toContain("رصيد لصالح المريض");
      await page.route(`**/api/patients/${patientId}/historical-documents/${initial.document.id}/correct`,async route=>{
        bodies.push(route.request().postData()!);const response=await route.fetch();expect(response.status()).toBe(200);if(bodies.length===1)return route.abort("failed");return route.fulfill({response});
      });
      await editor.getByRole("button",{name:"تأكيد تصحيح الاتفاق",exact:true}).click();await expect.poll(()=>page.getByTestId("historical-correction-recovery").innerText()).toContain("انقطع الرد");
      expect(await page.getByRole("button",{name:"قبض دفعة",exact:true}).isDisabled()).toBe(true);await page.reload({waitUntil:"domcontentloaded"});
      await page.getByTestId("historical-correction-recovery").getByRole("button",{name:"إعادة نفس طلب تصحيح الاتفاق",exact:true}).click();
      await expect.poll(()=>page.getByText(/حُفظ تصحيح الاتفاق/).isVisible()).toBe(true);expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);
      expect((await db.query("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1",[patientId])).rows).toEqual(before);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1",[patientId])).rows).toHaveLength(0);
      expect((await db.query("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1",[patientId])).rows).toEqual([{amount_minor:"10000"}]);
      expect((await db.query("SELECT id FROM legacy_treatment_document_revisions WHERE document_id=$1",[initial.document.id])).rows).toHaveLength(2);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }finally{await context.close();}
  },90000);
});
