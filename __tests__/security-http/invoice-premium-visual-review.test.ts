import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {mkdirSync,writeFileSync} from "node:fs";
import {baseUrl,harness} from "./_server";

import {formatMoney,type Currency} from "../../lib/money";

let browser:Browser,db:Client,h:Awaited<ReturnType<typeof harness>>,endo:number,ortho:number;
const doctors:number[]=[];
const evidence=".settings-ui-artifacts/invoice-premium";
beforeAll(async()=>{
  h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  for(const name of ["طبيب تجريبي أ","طبيب تجريبي ب"])doctors.push((await db.query("INSERT INTO parties(name,kind) VALUES($1,'doctor') RETURNING id",[name])).rows[0].id);
  const service=async(name:string,category:string,yer:number,sar:number)=>(await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES($1,$2,$3,$4,$5,TRUE,TRUE) RETURNING id",[name,category,yer,sar,yer/10])).rows[0].id;
  endo=await service("علاج جذور سن تجريبي","rct",55000,40000);ortho=await service("تقويم ثابت للفكين تجريبي","ortho",210000,600000);
  mkdirSync(evidence,{recursive:true});
},180000);
afterAll(async()=>{await browser?.close();await db?.end();});

describe("approved premium invoice layout in the actual application",()=>{
  it.each([1440,390].flatMap(width=>[false,true].flatMap(historical=>(["YER","SAR","USD"] as Currency[]).map(currency=>({width,historical,currency})))))("captures $historical historical in $currency at $width using real catalogue, preview and financial totals",async({width,historical,currency})=>{
    const patientId=(await db.query("INSERT INTO patients(patient_number,full_name,birth_date) VALUES($1,'مريض تجريبي','1998-01-01') RETURNING id",[`PREMIUM-${width}-${historical}-${currency}-${Date.now()}`])).rows[0].id;
    const context=await browser.newContext({viewport:{width,height:1040},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const amounts=currency==="YER"?{discount:"20000",paid:"120000",first:"80000",second:historical?"100000":"220000",remaining:historical?"180,000":"300,000"}
      :currency==="SAR"?{discount:"300",paid:"1200",first:"1500",second:historical?"3800":"5000",remaining:historical?"5,300":"6,500"}
      :{discount:"20",paid:"120",first:"80",second:historical?"100":"220",remaining:historical?"180":"300"};
    const page=await context.newPage();const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    try{
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});
      await page.getByTestId("treatment-entry-open").click();await page.getByRole("button",{name:historical?"علاج بدأ قبل النظام":"علاج جديد",exact:true}).click();
      await page.getByLabel(historical?"عملة الاتفاق":"عملة الفاتورة",{exact:true}).selectOption(currency);
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة",{exact:true}).selectOption(String(endo));
      await page.getByTestId("invoice-tooth-button-0").click();
      await page.getByTestId("odontogram-tooth-16").click();await page.getByTestId("odontogram-tooth-17").click();await page.getByTestId("tooth-dialog-confirm").click();
      await page.getByRole("button",{name:"+ بند آخر",exact:true}).click();
      await page.getByTestId("invoice-row-2").getByLabel("الخدمة",{exact:true}).selectOption(String(ortho));
      await page.getByTestId("invoice-row-2").getByLabel("نطاق العلاج",{exact:true}).selectOption("both");
      // Canonical indices stay per tooth; only the new-treatment entry controls are grouped.
      const visibleIndices=historical?[0,1,2]:[0,2];
      expect(await page.locator('[data-testid^="invoice-row-"]').count()).toBe(visibleIndices.length);
      expect(await page.locator('[data-testid^="invoice-provider-"]').count()).toBe(visibleIndices.length);
      expect(await page.getByLabel("السعر",{exact:true}).count()).toBe(visibleIndices.length);
      const endoUnitMinor=currency==="YER"?55000:currency==="SAR"?40000:5500;
      const endoGroup=page.getByTestId("invoice-row-0");
      expect(await endoGroup.getAttribute("data-tooth-count")).toBe(historical?"1":"2");
      expect(await endoGroup.getByLabel("الكمية",{exact:true}).inputValue()).toBe(historical?"1":"2");
      expect(await endoGroup.getByLabel("الكمية",{exact:true}).isDisabled()).toBe(true);
      expect(await endoGroup.getByLabel("السعر",{exact:true}).count()).toBe(1);
      expect(await page.getByTestId("invoice-line-total-0").innerText()).toContain(formatMoney(endoUnitMinor*(historical?1:2),currency));
      if(historical){
        for(const [index,tooth] of [[0,16],[1,17]]){
          expect(await page.getByTestId(`invoice-row-${index}`).getAttribute("data-tooth")).toBe(String(tooth));
          expect(await page.getByTestId(`invoice-row-${index}`).getAttribute("data-display-group")).toBe("");
          expect(await page.getByTestId(`invoice-row-${index}`).getByLabel("الكمية",{exact:true}).inputValue()).toBe("1");
          expect(await page.getByTestId(`invoice-line-total-${index}`).innerText()).toContain(formatMoney(endoUnitMinor,currency));
        }
      }else{
        expect(await endoGroup.getAttribute("data-display-group")).toBeTruthy();
        expect(await page.getByTestId("invoice-row-1").count()).toBe(0);
        expect(await page.getByTestId("invoice-tooth-chip-0").innerText()).toContain("الأسنان: 16، 17");
        expect(await page.getByTestId("invoice-group-details-0").locator('[data-testid^="invoice-clinical-preview-"]').count()).toBe(2);
      }
      for(const [position,index] of visibleIndices.entries())await page.getByTestId(`invoice-provider-${index}`).selectOption(String(doctors[position%2]));
      await page.getByLabel("الخصم",{exact:true}).fill(amounts.discount);
      await page.getByLabel("سبب الخصم",{exact:true}).fill("خصم اتفاق معتمد للتجربة");
      if(historical){await page.getByLabel("المدفوع قبل النظام",{exact:true}).fill(amounts.paid);await page.getByLabel("تاريخ المعلومات التاريخية",{exact:true}).fill("2026-10-01");}
      await page.getByRole("radio",{name:"جدول أقساط",exact:true}).check();
      await page.getByLabel("تاريخ السداد 1",{exact:true}).fill("2026-10-20");await page.getByLabel("مبلغ السداد 1",{exact:true}).fill(amounts.first);
      await page.getByRole("button",{name:"إضافة موعد سداد",exact:true}).click();
      await page.getByLabel("تاريخ السداد 2",{exact:true}).fill("2026-11-20");await page.getByLabel("مبلغ السداد 2",{exact:true}).fill(amounts.second);
      const save=page.getByRole("button",{name:historical?"احفظ الاتفاق التاريخي":"احفظ الفاتورة",exact:true});
      await expect.poll(()=>save.isEnabled()).toBe(true);
      const canonicalPreviewRows=await page.locator(`[data-testid^="${historical?"historical":"invoice"}-clinical-preview-"]`).count();
      expect(canonicalPreviewRows).toBe(3);
      expect(await page.getByLabel("الخصم",{exact:true}).count()).toBe(1);
      const summary=await page.getByTestId("invoice-financial-summary").innerText();
      expect(summary).toContain(amounts.remaining);expect(errors).toEqual([]);
      const form=page.getByTestId("invoice-workspace");
      expect(await form.getByTestId("treatment-entry-choice").count()).toBe(1);
      expect(await form.getByRole("button",{name:historical?"علاج بدأ قبل النظام":"علاج جديد",exact:true}).getAttribute("aria-pressed")).toBe("true");
      expect(await form.getByLabel("المدفوع قبل النظام",{exact:true}).count()).toBe(historical?1:0);
      await page.keyboard.press("Tab");
      await page.evaluate(()=>window.scrollTo(0,0));
      const geometry=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,form:document.querySelector('[data-testid="invoice-workspace"]')!.getBoundingClientRect().toJSON()}));
      expect(geometry.document).toBeLessThanOrEqual(width+1);
      const prefix=`${historical?"historical":"new"}-${width}${currency===(historical?"YER":"SAR")?"":`-${currency}`}`;
      await page.screenshot({path:`${evidence}/${prefix}-page.png`,fullPage:true});
      await page.screenshot({path:`${evidence}/${prefix}-form.png`,fullPage:true,clip:{x:geometry.form.x,y:geometry.form.y,width:geometry.form.width,height:geometry.form.height}});
      writeFileSync(`${evidence}/${prefix}.json`,JSON.stringify({patientId,historical,currency,width,geometry,summary,errors,visibleEntryRows:visibleIndices.length,endoDisplayedQuantity:historical?1:2,canonicalPreviewRows,source:"real app, synthetic local PostgreSQL catalogue and preview; unsaved review form"},null,2));
      expect((await db.query("SELECT count(*)::int AS count FROM invoices WHERE patient_id=$1",[patientId])).rows[0].count).toBe(0);
      expect((await db.query("SELECT count(*)::int AS count FROM payments WHERE patient_id=$1",[patientId])).rows[0].count).toBe(0);
    }finally{await context.close();}
  });
});
