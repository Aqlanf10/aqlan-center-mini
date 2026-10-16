import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {authedGet,authedMutation,baseUrl,harness} from "./_server";
let h:Awaited<ReturnType<typeof harness>>,db:Client,browser:Browser;
beforeAll(async()=>{h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  await db.query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) SELECT 'synthetic-money-recovery',0,0,0 WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
},240000);
afterAll(async()=>{await browser?.close();await db?.end();});
describe("shared collection from the patient header and durable financial recovery",()=>{
  it("replays collection and correction with their saved FX snapshots after settings change",async()=>{
    const prior=(await(await authedGet("/api/settings",h.sessions.admin)).json())["finance.rate.SAR"];
    const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic FX recovery') RETURNING id",[`MONEY-FX-${Date.now()}`])).rows[0].id;
    const invoiceId=(await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,200000,0,'SAR','synthetic') RETURNING id",[`MONEY-FX-${Date.now()}`,patientId])).rows[0].id;
    const rate=async(value:string)=>{
      const current=await(await authedGet("/api/settings",h.sessions.admin)).json();
      const response=await authedMutation("/api/settings",h.sessions.admin,"PATCH",JSON.stringify({"finance.rate.SAR":value,__versions:{"finance.rate.SAR":current.__versions["finance.rate.SAR"]},__reason:"Synthetic recovery FX test"}));
      expect(response.status,await response.text()).toBe(200);
    };
    try{
      await rate("125");const body=JSON.stringify({patientId,invoiceId,amount:"100",currency:"SAR",kind:"payment",method:"cash"}),headers={"Idempotency-Key":`money-fx-collect-${patientId}`};
      const first=await authedMutation("/api/payments",h.sessions.admin,"POST",body,headers),receipt=await first.json();expect(first.status,JSON.stringify(receipt)).toBe(201);expect(receipt).toMatchObject({amountMinor:10000,exchangeRate:125,baseAmountMinor:12500});
      await rate("250");const replay=await authedMutation("/api/payments",h.sessions.admin,"POST",body,headers);expect(replay.status).toBe(200);expect(await replay.json()).toEqual(receipt);
      const change=JSON.stringify({mode:"correct",reason:"Synthetic FX correction",target:"original",amount:"50",currency:"SAR",method:"cash"}),key={"Idempotency-Key":`money-fx-correct-${patientId}`};
      const corrected=await authedMutation(`/api/payments/${receipt.id}/correct`,h.sessions.admin,"POST",change,key),saved=await corrected.json();expect(corrected.status,JSON.stringify(saved)).toBe(201);expect(saved.replacement).toMatchObject({amountMinor:5000,exchangeRate:250,baseAmountMinor:12500});
      await rate("500");const duplicate=await authedMutation(`/api/payments/${receipt.id}/correct`,h.sessions.admin,"POST",change,key);expect(duplicate.status).toBe(200);expect(await duplicate.json()).toEqual({...saved,replayed:true});
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[patientId])).rows).toHaveLength(3);
    }finally{await rate(prior);}
  });
  it.each([390,1440])("reloads a lost committed collection reply with its exact original key and body at%i px",async width=>{
    const stamp=`${width}-${Date.now()}`;
    const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض تحصيل تجريبي') RETURNING id",[`MONEY-UI-${stamp}`])).rows[0].id;
    await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,25000,0,'YER','synthetic')",[`MONEY-UI-${stamp}`,patientId]);
    const context=await browser.newContext({viewport:{width,height:1000},locale:"ar-YE",serviceWorkers:"block"});const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();page.on("dialog",dialog=>void dialog.accept());const requests:{key:string;body:string}[]=[];
    try{
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});
      await page.getByRole("button",{name:"تحصيل دفعة",exact:true}).click();const modal=page.getByRole("dialog",{name:"تحصيل دفعة",exact:true});
      await expect.poll(()=>modal.getByLabel("المبلغ",{exact:true}).isEnabled()).toBe(true);await modal.getByLabel("المبلغ",{exact:true}).fill("500");
      await page.route("**/api/payments",async route=>{
        if(route.request().method()!=="POST")return route.continue();requests.push({key:route.request().headers()["idempotency-key"],body:route.request().postData()!});
        const response=await route.fetch();expect(response.ok(),await response.text()).toBe(true);if(requests.length===1)return route.abort("failed");return route.fulfill({response});
      });
      await modal.getByRole("button",{name:"سجّل الدفعة واطبع السند",exact:true}).click();
      await expect.poll(()=>modal.getByRole("button",{name:"إعادة التحقق من العملية السابقة",exact:true}).isVisible()).toBe(true);
      expect(await modal.getByLabel("المبلغ",{exact:true}).isDisabled()).toBe(true);
      await page.reload({waitUntil:"domcontentloaded"});const recovery=page.getByTestId("money-command-recovery");await recovery.waitFor();
      expect(await page.getByRole("button",{name:"قبض دفعة",exact:true}).isDisabled()).toBe(true);
      await recovery.getByRole("button",{name:"إعادة التحقق من العملية السابقة",exact:true}).click();
      await expect.poll(()=>page.getByText(/تأكد حفظ سند القبض السابق/).isVisible()).toBe(true);
      expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
      expect((await db.query("SELECT amount_minor::text,kind FROM payments WHERE patient_id=$1",[patientId])).rows).toEqual([{amount_minor:"500",kind:"payment"}]);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1",[patientId])).rows).toHaveLength(1);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }finally{await context.close();}
  },90000);
});

describe("two-tab durable money command arbitration",()=>{
  it.each(["collection","receipt-correction"] as const)("allows one %s intent from competing tabs",async mode=>{
    const stamp=`${mode}-${Date.now()}`;
    const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض تسابق مالي اصطناعي') RETURNING id",[`MONEY-TABS-${stamp}`])).rows[0].id;
    const invoiceId=(await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,25000,0,'YER','synthetic') RETURNING id",[`MONEY-TABS-${stamp}`,patientId])).rows[0].id;
    let originalReceipt=0;
    if(mode==="receipt-correction"){
      const response=await authedMutation("/api/payments",h.sessions.admin,"POST",JSON.stringify({patientId,invoiceId,amount:"500",currency:"YER",kind:"payment",method:"cash"}),{"Idempotency-Key":`tabs-original-${patientId}`});
      expect(response.status).toBe(201);originalReceipt=(await response.json()).id;
    }
    const context=await browser.newContext({viewport:{width:390,height:1000},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const pages=await Promise.all([context.newPage(),context.newPage()]),commands:{key:string;body:string|null}[]=[];
    await context.route(mode==="collection"?"**/api/payments":`**/api/payments/${originalReceipt}/correct`,async route=>{
      if(route.request().method()==="POST")commands.push({key:route.request().headers()["idempotency-key"],body:route.request().postData()});
      await route.continue();
    });
    try{
      await Promise.all(pages.map(async(page,index)=>{
        await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});
        if(mode==="collection"){
          await page.getByRole("button",{name:"تحصيل دفعة",exact:true}).click();
          const modal=page.getByRole("dialog",{name:"تحصيل دفعة",exact:true});
          await expect.poll(()=>modal.getByLabel("المبلغ",{exact:true}).isEnabled()).toBe(true);
          await modal.getByLabel("المبلغ",{exact:true}).fill(index?"700":"500");
        }else{
          const print=page.getByRole("link",{name:"السند",exact:true}).and(page.locator(`a[href="/print/receipt/${originalReceipt}"]`));
          await page.getByRole("region",{name:"الدفعات"}).locator("li").filter({has:print}).getByRole("button",{name:"تصحيح السند",exact:true}).click();
          const editor=page.getByRole("group",{name:/^تصحيح /});
          await editor.getByLabel("المبلغ الصحيح").fill(index?"100":"50");
          await editor.getByLabel("سبب تصحيح السند").fill("تصحيح اصطناعي متزامن");
        }
      }));
      await Promise.all(pages.map(page=>page.getByRole("button",{name:mode==="collection"?"سجّل الدفعة واطبع السند":"صحّح السند",exact:true}).click()));
      const expected=mode==="collection"?1:3;
      const count=async()=>Number((await db.query("SELECT count(*) FROM payments WHERE patient_id=$1",[patientId])).rows[0].count);
      await expect.poll(count).toBe(expected);
      await expect.poll(async()=> (await Promise.all(pages.map(page=>page.getByRole("status").allTextContents()))).flat().some(text=>/السند|الدفعة|العملية|الطلب/.test(text))).toBe(true);
      expect(new Set(commands.map(command=>command.key)).size).toBe(1);expect(new Set(commands.map(command=>command.body)).size).toBe(1);
      expect(await count()).toBe(expected);
      if(mode==="receipt-correction")expect((await db.query("SELECT id FROM payments WHERE reversal_of_id=$1",[originalReceipt])).rows).toHaveLength(1);
    }finally{await context.close();}
  });
});
