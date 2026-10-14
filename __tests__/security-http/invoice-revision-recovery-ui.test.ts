import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {mkdirSync} from "node:fs";
import {baseUrl,harness} from "./_server";
let h:Awaited<ReturnType<typeof harness>>,db:Client,browser:Browser;
const evidence="artifacts/invoice-revision-recovery";
beforeAll(async()=>{h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});mkdirSync(evidence,{recursive:true});},240000);
afterAll(async()=>{await browser?.close();await db?.end();});
describe("actual invoice correction and durable original command",()=>{
  it.each([390,1440])("keeps exact correction after lost response and reload at %i px",async width=>{
    const stamp=`${width}-${Date.now()}`;
    const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض تصحيح تجريبي') RETURNING id",[`REV-UI-${stamp}`])).rows[0].id;
    const invoiceId=(await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,50000,0,'YER','synthetic') RETURNING id",[`REV-UI-${stamp}`,patientId])).rows[0].id;
    await db.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'علاج تجريبي للتصحيح',1,50000,50000)",[invoiceId]);
    const context=await browser.newContext({viewport:{width,height:1040},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();page.setDefaultTimeout(20000);page.on("dialog",dialog=>void dialog.accept());
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    const path=`**/api/invoices/${invoiceId}/correct`,bodies:string[]=[];let dropped=false;
    try{
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});
      await page.getByRole("button",{name:"تصحيح الفاتورة",exact:true}).click();
      const form=page.getByTestId("invoice-correction-editor");
      await form.getByLabel("سعر التصحيح 1",{exact:true}).fill("60000");
      await form.getByLabel("سبب التصحيح",{exact:true}).fill("تعديل الاتفاق المعتمد للتجربة");
      await form.getByRole("radio",{name:"جدول أقساط",exact:true}).check();
      await form.getByLabel("تاريخ السداد 1",{exact:true}).fill("2026-11-14");await form.getByLabel("مبلغ السداد 1",{exact:true}).fill("60000");
      await page.screenshot({path:`${evidence}/correction-${width}-before.png`,fullPage:true});
      await page.route(path,async route=>{if(route.request().method()!=="POST"){await route.continue();return;}bodies.push(route.request().postData()??"");
        if(!dropped){dropped=true;const response=await route.fetch();expect(response.status()).toBe(201);await route.abort("failed");}else await route.continue();});
      await form.getByRole("button",{name:"تأكيد تصحيح الفاتورة",exact:true}).click();
      await expect.poll(()=>form.getByRole("button",{name:"إعادة نفس طلب التصحيح",exact:true}).isEnabled()).toBe(true);
      expect(await form.getByRole("button",{name:"تأكيد تصحيح الفاتورة",exact:true}).isDisabled()).toBe(true);
      await page.reload({waitUntil:"domcontentloaded"});
      const recovered=page.getByTestId("invoice-revision-recovery");
      await expect.poll(()=>recovered.isVisible()).toBe(true);
      expect(await page.getByRole("button",{name:"قبض دفعة",exact:true}).isDisabled()).toBe(true);
      await recovered.getByRole("button",{name:"إعادة نفس طلب التصحيح",exact:true}).click();
      await expect.poll(()=>page.getByText(/حُفظ التصحيح في/).isVisible()).toBe(true);
      expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);
      expect((await db.query("SELECT id FROM invoice_corrections WHERE patient_id=$1",[patientId])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1 AND status<>'cancelled'",[patientId])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[patientId])).rows).toHaveLength(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
      await page.screenshot({path:`${evidence}/correction-${width}-saved.png`,fullPage:true});
    }finally{await context.close();}
  },90000);
});
