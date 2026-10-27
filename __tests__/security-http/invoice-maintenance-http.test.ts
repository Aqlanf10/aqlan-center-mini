import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Client} from "pg";
import {chromium} from "playwright";
import {authedGet,authedMutation,baseUrl,harness} from "./_server";

let h:Awaited<ReturnType<typeof harness>>,db:Client,serial=0;
const command=(path:string,method:"POST"|"PUT",body:unknown)=>authedMutation(path,h.sessions.admin,method,JSON.stringify(body));
beforeAll(async()=>{h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();},120000);
afterAll(async()=>{await db?.end();});
async function fixture(total=20000){
  const patient=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic invoice maintenance HTTP') RETURNING id",[`MAINT-HTTP-${Date.now()}-${++serial}`])).rows[0].id as number;
  const invoice=(await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,$3,0,'YER','secadmin') RETURNING id",[`SYN-MAINT-${Date.now()}-${serial}`,patient,total])).rows[0].id as number;
  await db.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic original service',1,$2,$2)",[invoice,total]);
  return {patient,invoice,path:`/api/invoices/${invoice}`};
}
async function financialRows(patient:number){
  return Promise.all(["invoices","payments"].map(table=>db.query(`SELECT to_jsonb(r) AS row FROM ${table} r WHERE patient_id=$1 ORDER BY id`,[patient]).then(result=>result.rows)));
}

describe("invoice maintenance real HTTP boundaries and dated documents",()=>{
  it("uses registered invoice action schemas and restricts mutations to the current admin",async()=>{
    const f=await fixture();const before=await financialRows(f.patient);
    const archive=await authedGet(`${f.path}/archive`,h.sessions.admin);
    expect(archive.status).toBe(200);expect(await archive.json()).toMatchObject({readiness:"ready"});
    const service=await authedGet(`${f.path}/add-service`,h.sessions.admin);
    expect(service.status).toBe(200);
    for(const role of ["reception","doctorA","accountant","cashier"] as const){
      for(const action of ["archive","add-service"]){
        expect((await authedMutation(`${f.path}/${action}`,h.sessions[role],"POST","{}")).status).toBe(403);
      }
    }
    expect(await financialRows(f.patient)).toEqual(before);
    expect((await db.query("SELECT version FROM schema_migrations WHERE version IN ('0081','0082') ORDER BY version")).rows.map(row=>row.version)).toEqual(["0081","0082"]);
  });

  it("archives and restores without hiding the invoice from the ledger or either print reader",async()=>{
    const f=await fixture(0),before=await financialRows(f.patient);
    const input={action:"archive",reason:"Synthetic completed document",idempotencyKey:`archive-http-${f.invoice}`,expectedVersion:0};
    const response=await command(`${f.path}/archive`,"POST",input);expect(response.status).toBe(201);
    const result=await response.json();expect(result).toMatchObject({current:{archived:true,version:1},noop:false});
    const retry=await command(`${f.path}/archive`,"POST",input);expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({receipt:result.receipt,replayed:true});
    const ledger=await authedGet(`/api/patients/${f.patient}/ledger`,h.sessions.admin);expect(ledger.status).toBe(200);
    expect((await ledger.json()).invoices.some((row:{id:number})=>row.id===f.invoice)).toBe(true);
    const number=result.receipt.invoiceNumber as string;
    for(const path of [`/print/invoice/${f.invoice}`,`/print/statement/${f.patient}?mode=current`]){
      const printed=await authedGet(path,h.sessions.admin);expect(printed.status).toBe(200);expect(await printed.text()).toContain(number);
    }
    const restore=await command(`${f.path}/archive`,"POST",{...input,action:"restore",idempotencyKey:`restore-http-${f.invoice}`,expectedVersion:1});
    expect(restore.status).toBe(201);expect(await restore.json()).toMatchObject({current:{archived:false,version:2}});
    expect(await financialRows(f.patient)).toEqual(before);
  });

  it("refuses unpaid archive without changing the document or fabricating cancellation",async()=>{
    const f=await fixture(),before=await financialRows(f.patient);
    const response=await command(`${f.path}/archive`,"POST",{action:"archive",reason:"Synthetic unpaid request",idempotencyKey:`unpaid-http-${f.invoice}`,expectedVersion:0});
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:"policy_decision_required"});
    expect(await financialRows(f.patient)).toEqual(before);
  });

  it("previews and concurrently issues only the new service, retaining original identity and dated print",async()=>{
    const f=await fixture();
    const service=(await db.query("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic additional consultation','consultation',10000,TRUE,TRUE) RETURNING id")).rows[0].id as number;
    const before=await financialRows(f.patient);
    const viewResponse=await authedGet(`${f.path}/add-service`,h.sessions.admin);expect(viewResponse.status).toBe(200);
    const view=await viewResponse.json();
    const input={serviceId:service,doctorId:null,price:"10000",priceReason:"Synthetic documented price",discount:"1000",discountReason:"Synthetic additional discount",currency:"YER",reason:"Synthetic independent additional service",expectedSourceHash:view.sourceHash,idempotencyKey:`add-http-${f.invoice}`};
    const previewResponse=await command(`${f.path}/add-service`,"PUT",input);expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({addedNetMinor:9000,accountDueBeforeMinor:20000,accountDueAfterMinor:29000});
    expect(await financialRows(f.patient)).toEqual(before);
    const responses=await Promise.all([command(`${f.path}/add-service`,"POST",input),command(`${f.path}/add-service`,"POST",input)]);
    expect(responses.map(response=>response.status).sort()).toEqual([200,201]);
    const receipts=await Promise.all(responses.map(response=>response.json()));
    expect(receipts[0].additionalInvoiceId).toBe(receipts[1].additionalInvoiceId);
    expect(receipts[0]).toMatchObject({originalInvoiceId:f.invoice,patientId:f.patient,addedNetMinor:9000,cashMovementMinor:0});
    expect(receipts[0].additionalInvoiceId).not.toBe(f.invoice);
    const saved=receipts[0];
    const originals=(await db.query("SELECT to_jsonb(r) AS row FROM invoices r WHERE id=$1",[f.invoice])).rows;
    expect(originals).toEqual(before[0]);
    expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[f.patient])).rows).toHaveLength(0);
    const lines=(await db.query("SELECT description,total_minor::int AS total FROM invoice_items WHERE invoice_id=$1",[saved.additionalInvoiceId])).rows;
    expect(lines).toEqual([{description:"Synthetic additional consultation",total:10000}]);
    const originalPrint=await authedGet(`/print/invoice/${f.invoice}`,h.sessions.admin);
    const additionalPrint=await authedGet(`/print/invoice/${saved.additionalInvoiceId}`,h.sessions.admin);
    expect(originalPrint.status).toBe(200);expect(additionalPrint.status).toBe(200);
    const originalHtml=await originalPrint.text(),additionalHtml=await additionalPrint.text();
    expect(originalHtml).toContain("Synthetic original service");expect(originalHtml).not.toContain(saved.additionalInvoiceNumber);
    expect(additionalHtml).toContain(saved.additionalInvoiceNumber);expect(additionalHtml).toContain(view.original.invoiceNumber);
    expect(additionalHtml).toContain("Synthetic additional consultation");expect(additionalHtml).not.toContain("Synthetic original service");
    const replay=await command(`${f.path}/add-service`,"POST",input);expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({...saved,replayed:true});
    const changed=await command(`${f.path}/add-service`,"POST",{...input,price:"11000"});expect(changed.status).toBe(409);
  });

  it.each([390,1280])("recovers the same additional-service request after a lost response and reload at %i px",async width=>{
    const f=await fixture();
    const service=(await db.query("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic browser additional consultation','consultation',10000,TRUE,TRUE) RETURNING id")).rows[0].id as number;
    const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
    const context=await browser.newContext({viewport:{width,height:980},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();page.setDefaultTimeout(25000);
    const errors:string[]=[],bodies:string[]=[];page.on("pageerror",error=>errors.push(error.message));let dropped=false;
    try{
      await page.goto(`${baseUrl}/patients/${f.patient}?tab=account`,{waitUntil:"domcontentloaded"});
      await page.getByRole("button",{name:"إضافة خدمة",exact:true}).click();
      await page.getByLabel("الخدمة الإضافية",{exact:true}).selectOption(String(service));
      await page.getByLabel("سبب إضافة الخدمة",{exact:true}).fill("Synthetic independent service from the invoice screen");
      await page.getByRole("button",{name:"معاينة أثر الإضافة",exact:true}).click();
      const preview=page.getByTestId("invoice-add-service-preview");await expect.poll(()=>preview.isVisible()).toBe(true);
      expect(await preview.textContent()).toContain("Synthetic browser additional consultation");
      await page.route(`**/api/invoices/${f.invoice}/add-service`,async route=>{
        if(route.request().method()!=="POST"){await route.continue();return;}
        bodies.push(route.request().postData()??"");
        if(!dropped){dropped=true;const response=await route.fetch();expect(response.status()).toBe(201);await route.abort("failed");}
        else await route.continue();
      });
      await page.getByRole("button",{name:"تأكيد إصدار الفاتورة الإضافية",exact:true}).click();
      await expect.poll(()=>page.getByRole("button",{name:"إعادة نفس الطلب للتحقق",exact:true}).isEnabled()).toBe(true);
      expect(await page.getByRole("button",{name:"تأكيد إصدار الفاتورة الإضافية",exact:true}).isDisabled()).toBe(true);
      await page.reload({waitUntil:"domcontentloaded"});
      const recovery=page.getByTestId("invoice-maintenance-recovery");await expect.poll(()=>recovery.isVisible()).toBe(true);
      expect(await page.getByRole("button",{name:"قبض دفعة",exact:true}).isDisabled()).toBe(true);
      await recovery.getByRole("button",{name:"إعادة نفس الطلب للتحقق",exact:true}).click();
      const success=page.getByTestId("invoice-add-service-success");await expect.poll(()=>success.isVisible()).toBe(true);
      expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);
      const additions=(await db.query("SELECT receipt FROM invoice_service_additions WHERE original_invoice_id=$1",[f.invoice])).rows;
      expect(additions).toHaveLength(1);expect(await success.textContent()).toContain(additions[0].receipt.additionalInvoiceNumber);
      expect(await success.getByRole("link",{name:"طباعة الفاتورة الإضافية",exact:true}).getAttribute("href")).toBe(`/print/invoice/${additions[0].receipt.additionalInvoiceId}`);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[f.patient])).rows).toHaveLength(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
    }finally{await context.close();await browser.close();}
  },90000);

  it("opens the archive and restores the same invoice from the invoice screen",async()=>{
    const f=await fixture(0),before=await financialRows(f.patient);
    const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
    const context=await browser.newContext({viewport:{width:390,height:980},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();page.setDefaultTimeout(25000);
    try{
      await page.goto(`${baseUrl}/patients/${f.patient}?tab=account`,{waitUntil:"domcontentloaded"});
      await page.getByRole("button",{name:"الأرشفة والاسترجاع",exact:true}).click();
      const panel=page.getByRole("region",{name:"أرشفة الفاتورة واسترجاعها",exact:true});
      await panel.getByLabel("سبب إجراء الأرشفة",{exact:true}).fill("Synthetic archived completed invoice");
      await panel.getByRole("button",{name:"تأكيد الأرشفة",exact:true}).click();
      await expect.poll(()=>panel.getByText(/تم التحقق/).isVisible()).toBe(true);
      await panel.getByRole("button",{name:"إغلاق",exact:true}).click();
      const archive=page.locator('details[aria-label="أرشيف الفواتير"]');await archive.locator("summary").click();
      await archive.getByRole("button",{name:"عرض الأرشفة والاسترجاع",exact:true}).click();
      await panel.getByLabel("سبب إجراء الأرشفة",{exact:true}).fill("Synthetic document restored for review");
      await panel.getByRole("button",{name:"استرجاع الفاتورة",exact:true}).click();
      await expect.poll(()=>panel.getByText(/مسترجعة إلى السجل الجاري/).isVisible()).toBe(true);
      expect(await financialRows(f.patient)).toEqual(before);
      expect((await db.query("SELECT action FROM invoice_archive_events WHERE invoice_id=$1 ORDER BY version",[f.invoice])).rows).toEqual([{action:"archive"},{action:"restore"}]);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }finally{await context.close();await browser.close();}
  },90000);
});
