import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {mkdirSync} from "node:fs";
import {authedGet,authedMutation,baseUrl,harness} from "./_server";
let browser:Browser;let h:Awaited<ReturnType<typeof harness>>;let db:Client;let serviceId:number;let serial=0;
beforeAll(async()=>{
  h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  serviceId=(await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES('Synthetic repayment consultation','consultation',10000,12345,2345,TRUE,TRUE) RETURNING id")).rows[0].id;
  // Real receipts require explicit stored FX even when tender and debt are SAR.
  await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  const shift=await authedMutation("/api/shifts",h.sessions.admin,"POST",JSON.stringify({opening:{YER:"0",SAR:"0",USD:"0"}}));expect([201,409]).toContain(shift.status);
  mkdirSync(".settings-ui-artifacts",{recursive:true});
},180000);
afterAll(async()=>{await browser?.close();await db?.end();});
async function open(role:"admin"|"reception",width:number){
  const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic repayment workspace') RETURNING id",[`REPAY-UI-${Date.now()}-${++serial}`])).rows[0].id;
  const context=await browser.newContext({viewport:{width,height:844},locale:"ar-YE",serviceWorkers:"block"});const [name,...value]=h.sessions[role].cookie.split("=");
  await context.addCookies([{name,value:value.join("="),url:baseUrl}]);const page=await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});
  await page.getByTestId("treatment-entry-open").click();await page.getByRole("button",{name:"علاج جديد",exact:true}).click();
  await page.getByLabel("الخدمة",{exact:true}).selectOption(String(serviceId));await page.getByLabel("عملة الفاتورة",{exact:true}).selectOption("SAR");
  // Financial-only lines now receive the same server price preview as clinical
  // lines. Exercise duplicate submission only after that real gate admits save.
  await expect.poll(()=>page.getByRole("button",{name:"احفظ الفاتورة",exact:true}).isEnabled()).toBe(true);
  return{patientId,context,page};
}
const scenarios=[{role:"admin" as const,width:1280},{role:"reception" as const,width:390}];
describe("ordinary invoice recovery and persistent repayment workspace",()=>{
  it.each(scenarios)("$role at$width persists installments, collects partially, revises only remaining and cancels dates without cancelling debt",async({role,width})=>{
    const {patientId,context,page}=await open(role,width);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    try{
      await page.getByRole("radio",{name:"جدول أقساط",exact:true}).check();
      await page.getByLabel("مبلغ السداد 1",{exact:true}).fill("23.45");await page.getByLabel("تاريخ السداد 1",{exact:true}).fill("2026-10-12");
      await page.getByRole("checkbox",{name:/دفعة مقدمة مقترحة/}).check();await page.getByRole("button",{name:"إضافة موعد سداد",exact:true}).click();
      await page.getByLabel("مبلغ السداد 2",{exact:true}).fill("100");await page.getByLabel("تاريخ السداد 2",{exact:true}).fill("2026-11-12");
      await page.getByRole("button",{name:"احفظ الفاتورة",exact:true}).click();
      await page.getByRole("region",{name:"فاتورة جديدة",exact:true}).waitFor({state:"detached"});
      const panel=page.getByTestId("debt-repayment-panel");await expect.poll(()=>panel.innerText()).toContain("جدول أقساط");
      expect((await db.query("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[patientId])).rows[0].n).toBe(0);
      const keys:string[]=[];
      for(let step=1;step<=3;step++){
        await panel.getByRole("button",{name:"تحصيل دفعة فعلية",exact:true}).click();await panel.getByLabel("مبلغ تحصيل القسط",{exact:true}).fill("20");
        const collectionResponse=page.waitForResponse(response=>response.url().endsWith("/collect")&&response.request().method()==="POST");
        await panel.getByRole("button",{name:"تأكيد التحصيل وإصدار السند",exact:true}).click();
        const collection=await collectionResponse;const collectionBody=await collection.json();expect(collection.status(),JSON.stringify(collectionBody)).toBe(201);
        keys.push(collection.request().headers()["idempotency-key"]);
        await panel.getByRole("link",{name:"طباعة سند التحصيل",exact:true}).waitFor();
        await expect.poll(()=>panel.innerText()).toContain((123.45-step*20).toFixed(2));
        const workspace=await (await authedGet(`/api/patients/${patientId}/debt-repayments`,h.sessions[role])).json();
        expect(workspace.arrangements[0]).toMatchObject({requiresReview:false,remainingMinor:12345-step*2000,collectedMinor:step*2000,version:1});
      }
      expect(new Set(keys).size).toBe(3);
      await panel.getByRole("button",{name:"مراجعة أو تعديل السداد",exact:true}).click();
      await panel.getByLabel("مبلغ السداد 1",{exact:true}).fill("63.45");
      await panel.getByLabel("سبب تعديل السداد",{exact:true}).fill("Synthetic remaining redistribution");
      await panel.getByRole("button",{name:"حفظ توزيع المتبقي",exact:true}).click();await expect.poll(()=>panel.innerText()).toContain("النسخة 2");
      await panel.getByRole("button",{name:"مراجعة أو تعديل السداد",exact:true}).click();await panel.getByLabel("سبب تعديل السداد",{exact:true}).fill("Synthetic dates cancellation");
      page.once("dialog",dialog=>dialog.accept());await panel.getByRole("button",{name:"إلغاء ترتيب المواعيد",exact:true}).click();await expect.poll(()=>panel.innerText()).toContain("ترتيب ملغى");
      const [facts]=(await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,(SELECT sum(amount_minor)::int FROM payments WHERE patient_id=$1) AS paid",[patientId])).rows;
      expect(facts).toEqual({invoices:1,payments:3,paid:6000});expect(await panel.innerText()).toContain("63.45");
      const geometry=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth}));expect(geometry.document).toBeLessThanOrEqual(geometry.width+1);
      expect(errors).toEqual([]);await page.screenshot({path:`.settings-ui-artifacts/debt-repayment-${role}-${width}.png`,fullPage:true});
    }finally{await context.close();}
  });
  it.each(scenarios.flatMap(s=>["lost","malformed","lost-reload","malformed-reload"].map(fault=>({...s,fault}))))("$role ordinary$fault acknowledgement keeps exact intent at$width and closes only after verified replay",async({role,width,fault})=>{
    const {patientId,context,page}=await open(role,width);const commands:string[]=[];const receipts:Record<string,unknown>[]=[];
    await page.route("**/api/invoices",async route=>{
      if(route.request().method()!=="POST")return route.continue();commands.push(route.request().postData()!);const response=await route.fetch();const receipt=await response.json();receipts.push(receipt);
      if(commands.length===1){expect(response.status()).toBe(201);if(fault.startsWith("lost"))return route.abort("failed");return route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({...receipt,repayment:null})});}
      return route.fulfill({response});
    });
    try{
      const save=page.getByRole("button",{name:"احفظ الفاتورة",exact:true});await save.evaluate((element:HTMLButtonElement)=>{element.click();element.click();});
      const recovery=page.getByTestId("invoice-command-recovery");await expect.poll(()=>recovery.innerText()).toContain("نتيجة الطلب غير مؤكدة");
      expect(commands).toHaveLength(1);expect(await save.isDisabled()).toBe(true);expect(await page.getByLabel("عملة الفاتورة",{exact:true}).isDisabled()).toBe(true);
      await page.getByTestId("treatment-entry-open").click();expect(await page.getByRole("region",{name:"فاتورة جديدة",exact:true}).count()).toBe(1);
      await page.getByTestId("patient-tab-summary").click();expect(new URL(page.url()).searchParams.get("tab")).toBe("account");
      if(fault.endsWith("reload")){
        page.once("dialog",dialog=>dialog.accept());await page.reload({waitUntil:"domcontentloaded"});
        await page.getByRole("button",{name:"استعادة الطلب للتحقق بنفس المفتاح",exact:true}).click();
        await expect.poll(()=>recovery.innerText()).toContain("نتيجة الطلب غير مؤكدة");
      }
      await recovery.getByRole("button",{name:"إعادة نفس طلب الفاتورة",exact:true}).click();await page.getByRole("region",{name:"فاتورة جديدة",exact:true}).waitFor({state:"detached"});
      expect(commands).toHaveLength(2);expect(commands[1]).toBe(commands[0]);expect(receipts[1]).toMatchObject({id:receipts[0].id,replayed:true});
      expect((await db.query("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[patientId])).rows[0].n).toBe(1);
      await page.getByTestId("treatment-entry-open").click();await page.getByRole("button",{name:"علاج جديد",exact:true}).click();expect(await recovery.count()).toBe(0);
    }finally{await context.close();}
  });
  it("denies schedule reads/writes and collection to doctors, cashier and accountant",async()=>{
    for(const role of ["doctorA","cashier","accountant"] as const){
      const read=await fetch(`${baseUrl}/api/patients/${h.seeded.patientAId}/debt-repayments`,{headers:{Cookie:h.sessions[role].cookie}});expect(read.status).toBe(403);
      expect((await authedMutation(`/api/patients/${h.seeded.patientAId}/debt-repayments`,h.sessions[role],"POST",JSON.stringify({}))).status).toBe(403);
      expect((await authedMutation(`/api/patients/${h.seeded.patientAId}/debt-repayments/1/collect`,h.sessions[role],"POST",JSON.stringify({}))).status).toBe(403);
    }
  });
});
