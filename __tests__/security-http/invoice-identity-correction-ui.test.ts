import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type Browser,type Page} from "playwright";
import {Client} from "pg";
import {mkdirSync} from "node:fs";
import {authedMutation,baseUrl,harness} from "./_server";
import type {Currency} from "../../lib/money";
let h:Awaited<ReturnType<typeof harness>>,db:Client,browser:Browser,service:number,nextService:number,doctor:number,nextDoctor:number,serial=0;
const evidence="artifacts/invoice-identity-correction";
beforeAll(async()=>{
  h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});mkdirSync(evidence,{recursive:true});
  [doctor,nextDoctor]=(await db.query("SELECT party_id FROM users WHERE username IN ('secdoctora','secdoctorb') ORDER BY username")).rows.map(row=>Number(row.party_id));
  const services=await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES('Synthetic original identity service','rct',1000,100000,100000,TRUE,TRUE),('Synthetic corrected identity service','rct',1000,100000,100000,TRUE,TRUE) RETURNING id");
  [service,nextService]=services.rows.map(row=>Number(row.id));
},240000);
afterAll(async()=>{await browser?.close();await db?.end();});
async function fixture(currency:Currency,width:number){
  const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض تصحيح هوية اصطناعي') RETURNING id",[`IDENTITY-UI-${Date.now()}-${++serial}`])).rows[0].id;
  const response=await authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify({patientId,currency,discount:"0",idempotencyKey:`identity-ui-${patientId}`,
    items:[{serviceId:service,doctorId:doctor,quantity:1,price:"1000",catalogPriceMinor:currency==="YER"?1000:100000,toothCode:36}]}));
  const invoice=await response.json();expect(response.status,JSON.stringify(invoice)).toBe(201);
  const context=await browser.newContext({viewport:{width,height:1040},locale:"ar-YE",serviceWorkers:"block"});
  const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
  const open=async(page:Page)=>{await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});await page.getByRole("button",{name:"تصحيح الفاتورة",exact:true}).click();await page.getByLabel("سعر التصحيح 1",{exact:true}).waitFor();};
  return {patientId,invoice,context,open};
}
const scenarios=(["YER","SAR","USD"] as Currency[]).flatMap(currency=>[390,1440].map(width=>({currency,width})));
describe("real safe clinical identity amendment and native currencies",()=>{
  it.each(scenarios)("amends service/provider/tooth in $currency at $width with original evidence retained",async({currency,width})=>{
    const {patientId,invoice,context,open}=await fixture(currency,width),page=await context.newPage(),errors:string[]=[],bodies:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));page.on("dialog",dialog=>void dialog.accept());
    try{
      await open(page);const form=page.getByTestId("invoice-correction-editor");
      await form.getByText("تصحيح الخدمة والطبيب والموضع",{exact:true}).click();
      await form.getByLabel("خدمة التصحيح 1",{exact:true}).selectOption(String(nextService));
      await form.getByLabel("طبيب التصحيح 1",{exact:true}).selectOption(String(nextDoctor));
      await form.getByLabel("سن التصحيح 1",{exact:true}).fill("46");
      await form.getByLabel("سعر التصحيح 1",{exact:true}).fill("900");
      await form.getByLabel("سبب التصحيح",{exact:true}).fill("تصحيح موثق قبل بدء العلاج الاصطناعي");
      const save=form.getByRole("button",{name:"تأكيد تصحيح الفاتورة",exact:true});expect(await save.isEnabled()).toBe(true);
      await page.screenshot({path:`${evidence}/identity-${currency}-${width}-before.png`,fullPage:true});
      const lost=currency==="SAR"&&width===390;
      await page.route(`**/api/invoices/${invoice.id}/correct`,async route=>{
        if(route.request().method()!=="POST")return route.continue();bodies.push(route.request().postData()!);
        if(lost&&bodies.length===1){const response=await route.fetch();expect(response.status()).toBe(201);return route.abort("failed");}
        return route.continue();
      });
      await save.click();
      if(lost){
        const retry=form.getByRole("button",{name:"إعادة نفس طلب التصحيح",exact:true});await expect.poll(()=>retry.isEnabled()).toBe(true);
        expect(await save.isDisabled()).toBe(true);await page.reload({waitUntil:"domcontentloaded"});
        await page.getByTestId("invoice-revision-recovery").getByRole("button",{name:"إعادة نفس طلب التصحيح",exact:true}).click();
      }
      await page.getByText(/حُفظ التصحيح في/).waitFor();
      expect(bodies).toHaveLength(lost?2:1);if(lost)expect(bodies[1]).toBe(bodies[0]);
      expect(JSON.parse(bodies[0]).lines[0]).toMatchObject({serviceId:nextService,doctorId:nextDoctor,toothCode:46});
      const ledger=await page.request.get(`${baseUrl}/api/patients/${patientId}/ledger`);expect(ledger.status()).toBe(200);
      const data=await ledger.json(),old=data.invoices.find((row:{id:number})=>row.id===invoice.id),current=data.invoices.find((row:{status:string})=>row.status!=="cancelled");
      expect(old.items[0]).toMatchObject({serviceId:service,doctorId:doctor,toothCode:36});
      expect(current.items[0]).toMatchObject({serviceId:nextService,doctorId:nextDoctor,toothCode:46,unitPriceMinor:currency==="YER"?900:90000,financialReviewRequired:false});
      expect((await db.query("SELECT id FROM invoice_corrections WHERE patient_id=$1",[patientId])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM plan_items WHERE plan_id IN(SELECT id FROM treatment_plans WHERE patient_id=$1)",[patientId])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM clinical_cases WHERE patient_id=$1",[patientId])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[patientId])).rows).toHaveLength(0);
      await page.screenshot({path:`${evidence}/identity-${currency}-${width}-saved.png`,fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(errors).toEqual([]);
    }finally{await context.close();}
  });
  it("serializes competing correction tabs into one replacement",async()=>{
    const {patientId,context,open}=await fixture("YER",390),a=await context.newPage(),b=await context.newPage();
    try{
      await Promise.all([open(a),open(b)]);
      for(const [page,price] of [[a,"900"],[b,"800"]] as const){await page.getByLabel("سعر التصحيح 1",{exact:true}).fill(price);await page.getByLabel("سبب التصحيح",{exact:true}).fill("تصحيح اصطناعي متزامن");}
      await Promise.all([a,b].map(page=>page.getByRole("button",{name:"تأكيد تصحيح الفاتورة",exact:true}).click()));
      await expect.poll(async()=>Number((await db.query("SELECT count(*) FROM invoice_corrections WHERE patient_id=$1",[patientId])).rows[0].count)).toBe(1);
      await expect.poll(async()=>await a.getByText(/حُفظ التصحيح في/).count()+await b.getByText(/حُفظ التصحيح في/).count()).toBeGreaterThan(0);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1 AND status<>'cancelled'",[patientId])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[patientId])).rows).toHaveLength(0);
    }finally{await context.close();}
  });
});
