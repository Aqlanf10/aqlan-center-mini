import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {authedMutation,baseUrl,harness} from "./_server";
let browser:Browser,h:Awaited<ReturnType<typeof harness>>,db:Client,endo:number,ortho:number,serial=0;
beforeAll(async()=>{
  h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  const service=async(category:string,amount:number)=>(await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,$2,$3,$4,TRUE,TRUE) RETURNING id",[`Synthetic historical ${category}`,category,amount,amount*100])).rows[0].id;
  endo=await service("rct",55000);ortho=await service("ortho",210000);
  await db.query("INSERT INTO settings(key,value) VALUES('finance.reception_adds_opening_balance','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  // The positive reception journey has a documented 6.25% discount. Grant its
  // synthetic fixture a 10% limit; application/default authority is unchanged.
  await db.query("INSERT INTO settings(key,value) VALUES('billing.max_discount_percent','10') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
},180000);
afterAll(async()=>{await browser?.close();await db?.end();});
const scenarios=[{role:"admin" as const,width:1280,currency:"YER"},{role:"reception" as const,width:390,currency:"SAR"}];
async function open(scenario:typeof scenarios[number]){
  const patientId=(await db.query("INSERT INTO patients(patient_number,full_name,birth_date) VALUES($1,'Synthetic historical UI','1990-01-01') RETURNING id",[`HIST-UI-${Date.now()}-${++serial}`])).rows[0].id;
  const context=await browser.newContext({viewport:{width:scenario.width,height:900},locale:"ar-YE",serviceWorkers:"block"});const [name,...value]=h.sessions[scenario.role].cookie.split("=");
  await context.addCookies([{name,value:value.join("="),url:baseUrl}]);const page=await context.newPage();const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});
  await page.getByTestId("treatment-entry-open").click();await page.getByRole("button",{name:"علاج بدأ قبل النظام",exact:true}).click();
  await page.getByLabel("عملة الاتفاق",{exact:true}).selectOption(scenario.currency);
  await page.getByTestId("invoice-row-0").getByLabel("الخدمة",{exact:true}).selectOption(String(endo));
  await page.getByTestId("invoice-tooth-button-0").click();const dialog=page.getByTestId("tooth-dialog");
  await dialog.getByTestId("odontogram-tooth-16").click();await dialog.getByTestId("odontogram-tooth-17").click();await page.getByTestId("tooth-dialog-confirm").click();await dialog.waitFor({state:"detached"});
  await page.getByRole("button",{name:"+ بند آخر",exact:true}).click();await page.getByTestId("invoice-row-2").getByLabel("الخدمة",{exact:true}).selectOption(String(ortho));await page.getByTestId("invoice-row-2").getByTestId("scope-both").click();
  await page.getByLabel("الخصم",{exact:true}).fill("20000");await page.getByLabel("سبب الخصم",{exact:true}).fill("Synthetic documented discount");
  await page.getByLabel("المدفوع قبل النظام",{exact:true}).fill("120000");await page.getByLabel("تاريخ المعلومات التاريخية",{exact:true}).fill("2026-10-01");
  await expect.poll(()=>page.getByRole("button",{name:"احفظ الاتفاق التاريخي",exact:true}).isEnabled(),{timeout:15000}).toBe(true);
  return{patientId,context,page,errors};
}
async function facts(patientId:number){return(await db.query(`SELECT
 (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
 (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,
 (SELECT count(*)::int FROM legacy_treatment_documents WHERE patient_id=$1) AS documents,
 (SELECT count(*)::int FROM legacy_treatment_agreements WHERE patient_id=$1) AS lines,
 (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) AS cases,
 (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans,
 (SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1) AS opening`,[patientId])).rows[0];}
describe("approved historical workspace persists one mixed document",()=>{
  it.each(scenarios)("$role at$width saves and reloads2teeth+grouped orthodontics in$currency with real dated terms",async scenario=>{
    const {patientId,context,page,errors}=await open(scenario);
    try{
      await page.getByRole("radio",{name:"جدول أقساط",exact:true}).check();await page.getByLabel("مبلغ السداد 1",{exact:true}).fill("80000");await page.getByLabel("تاريخ السداد 1",{exact:true}).fill("2026-10-12");
      await page.getByRole("checkbox",{name:/دفعة مقدمة مقترحة/}).check();await page.getByRole("button",{name:"إضافة موعد سداد",exact:true}).click();
      await page.getByLabel("مبلغ السداد 2",{exact:true}).fill("100000");await page.getByLabel("تاريخ السداد 2",{exact:true}).fill("2026-11-12");
      const response=page.waitForResponse(response=>response.url().endsWith("/historical-documents")&&response.request().method()==="POST");
      await page.getByRole("button",{name:"احفظ الاتفاق التاريخي",exact:true}).click();const saved=await response;const body=await saved.json();expect(saved.status(),JSON.stringify(body)).toBe(201);
      await page.getByRole("region",{name:"اتفاق تاريخي متعدد البنود",exact:true}).waitFor({state:"detached"});
      const expected=scenario.currency==="SAR"?18000000:180000;
      expect(await facts(patientId)).toEqual({invoices:0,payments:0,documents:1,lines:3,cases:3,plans:1,opening:String(expected)});
      await page.reload({waitUntil:"domcontentloaded"});await expect.poll(()=>page.getByTestId("historical-documents").innerText()).toContain("النسخة الحالية 1");
      await expect.poll(()=>page.getByTestId("debt-repayment-panel").innerText()).toContain("جدول أقساط");
      expect((await db.query("SELECT r.terms FROM debt_repayment_revisions r JOIN debt_repayment_arrangements a ON a.id=r.arrangement_id WHERE a.patient_id=$1",[patientId])).rows[0].terms).toMatchObject({mode:"installments",installments:[{amountMinor:expected*8/18},{amountMinor:expected*10/18}]});
      const geometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));expect(geometry.width).toBeLessThanOrEqual(geometry.viewport+1);expect(errors).toEqual([]);
    }finally{await context.close();}
  });
  it.each(scenarios.flatMap(scenario=>["lost","malformed","lost-reload","malformed-reload"].map(fault=>({...scenario,fault}))))("$role $fault acknowledgement retains exact actor/patient command at$width",async scenario=>{
    const {patientId,context,page,errors}=await open(scenario);const bodies:string[]=[];const receipts:Record<string,unknown>[]=[];
    await page.route(`**/api/patients/${patientId}/historical-documents`,async route=>{
      if(route.request().method()!=="POST")return route.continue();bodies.push(route.request().postData()!);const response=await route.fetch();const payload=await response.json();receipts.push(payload);
      if(bodies.length===1){expect(response.status(),JSON.stringify(payload)).toBe(201);if(scenario.fault.startsWith("lost"))return route.abort("failed");return route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({...payload,document:{...payload.document,lines:[]}})});}
      return route.fulfill({response});
    });
    try{
      const save=page.getByRole("button",{name:"احفظ الاتفاق التاريخي",exact:true});await save.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
      const recovery=page.getByTestId("invoice-command-recovery");await expect.poll(()=>recovery.innerText()).toContain("نتيجة الطلب غير مؤكدة");
      expect(bodies).toHaveLength(1);expect(await save.isDisabled()).toBe(true);expect(await page.getByLabel("عملة الاتفاق",{exact:true}).isDisabled()).toBe(true);
      await page.getByTestId("patient-tab-summary").click();expect(new URL(page.url()).searchParams.get("tab")).toBe("account");
      if(scenario.fault.endsWith("reload")){
        page.once("dialog",dialog=>dialog.accept());await page.reload({waitUntil:"domcontentloaded"});
        await page.getByRole("button",{name:"استعادة الطلب للتحقق بنفس المفتاح",exact:true}).click();
        await expect.poll(()=>recovery.innerText()).toContain("نتيجة الطلب غير مؤكدة");
      }
      await recovery.getByRole("button",{name:"إعادة نفس طلب الاتفاق",exact:true}).click();await page.getByRole("region",{name:"اتفاق تاريخي متعدد البنود",exact:true}).waitFor({state:"detached"});
      expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);expect(receipts[1]).toMatchObject({replayed:true,document:(receipts[0] as {document:unknown}).document});
      expect(await facts(patientId)).toMatchObject({documents:1,lines:3,invoices:0,payments:0});expect(errors).toEqual([]);
    }finally{await context.close();}
  });
  it("rejects forbidden actors and onlyadmin can correct historical facts",async()=>{
    for(const role of ["doctorA","cashier","accountant"] as const){
      for(const tail of ["historical-documents","historical-documents/preview","historical-documents/1/correct"])
        expect((await authedMutation(`/api/patients/${h.seeded.patientAId}/${tail}`,h.sessions[role],"POST",JSON.stringify({}))).status).toBe(403);
    }
    expect((await authedMutation(`/api/patients/${h.seeded.patientAId}/historical-documents/1/correct`,h.sessions.reception,"POST",JSON.stringify({}))).status).toBe(403);
  });
});
