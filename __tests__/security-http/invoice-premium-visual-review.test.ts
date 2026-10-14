import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import {Client} from "pg";
import {mkdirSync,writeFileSync} from "node:fs";
import {baseUrl,harness} from "./_server";

let browser:Browser,db:Client,h:Awaited<ReturnType<typeof harness>>,endo:number,ortho:number;
const doctors:number[]=[];
const evidence=".settings-ui-artifacts/invoice-premium";
beforeAll(async()=>{
  h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  for(const name of ["طبيب تجريبي أ","طبيب تجريبي ب"])doctors.push((await db.query("INSERT INTO parties(name,kind) VALUES($1,'doctor') RETURNING id",[name])).rows[0].id);
  const service=async(name:string,category:string,yer:number,sar:number)=>(await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,$2,$3,$4,TRUE,TRUE) RETURNING id",[name,category,yer,sar])).rows[0].id;
  endo=await service("علاج جذور سن تجريبي","rct",55000,40000);ortho=await service("تقويم ثابت للفكين تجريبي","ortho",210000,600000);
  mkdirSync(evidence,{recursive:true});
},180000);
afterAll(async()=>{await browser?.close();await db?.end();});

describe("approved premium invoice layout in the actual application",()=>{
  it.each([1440,390].flatMap(width=>[false,true].map(historical=>({width,historical}))))("captures $historical historical at $width using real catalogue, preview and financial totals",async({width,historical})=>{
    const patientId=(await db.query("INSERT INTO patients(patient_number,full_name,birth_date) VALUES($1,'مريض تجريبي','1998-01-01') RETURNING id",[`PREMIUM-${width}-${historical}-${Date.now()}`])).rows[0].id;
    const context=await browser.newContext({viewport:{width,height:1040},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    try{
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`,{waitUntil:"domcontentloaded"});
      await page.getByTestId("treatment-entry-open").click();await page.getByRole("button",{name:historical?"علاج بدأ قبل النظام":"علاج جديد",exact:true}).click();
      await page.getByLabel(historical?"عملة الاتفاق":"عملة الفاتورة",{exact:true}).selectOption(historical?"YER":"SAR");
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة",{exact:true}).selectOption(String(endo));
      await page.getByTestId("invoice-tooth-button-0").click();
      await page.getByTestId("odontogram-tooth-16").click();await page.getByTestId("odontogram-tooth-17").click();await page.getByTestId("tooth-dialog-confirm").click();
      await page.getByRole("button",{name:"+ بند آخر",exact:true}).click();
      await page.getByTestId("invoice-row-2").getByLabel("الخدمة",{exact:true}).selectOption(String(ortho));
      await page.getByTestId("invoice-row-2").getByLabel("نطاق العلاج",{exact:true}).selectOption("both");
      for(let index=0;index<3;index++)await page.getByTestId(`invoice-provider-${index}`).selectOption(String(doctors[index%2]));
      await page.getByLabel("الخصم",{exact:true}).fill(historical?"20000":"300");
      await page.getByLabel("سبب الخصم",{exact:true}).fill("خصم اتفاق معتمد للتجربة");
      if(historical){await page.getByLabel("المدفوع قبل النظام",{exact:true}).fill("120000");await page.getByLabel("تاريخ المعلومات التاريخية",{exact:true}).fill("2026-10-01");}
      await page.getByRole("radio",{name:"جدول أقساط",exact:true}).check();
      await page.getByLabel("تاريخ السداد 1",{exact:true}).fill("2026-10-20");await page.getByLabel("مبلغ السداد 1",{exact:true}).fill(historical?"80000":"1500");
      await page.getByRole("button",{name:"إضافة موعد سداد",exact:true}).click();
      await page.getByLabel("تاريخ السداد 2",{exact:true}).fill("2026-11-20");await page.getByLabel("مبلغ السداد 2",{exact:true}).fill(historical?"100000":"5000");
      const save=page.getByRole("button",{name:historical?"احفظ الاتفاق التاريخي":"احفظ الفاتورة",exact:true});
      await expect.poll(()=>save.isEnabled()).toBe(true);
      expect(await page.getByLabel("الخصم",{exact:true}).count()).toBe(1);
      const summary=await page.getByTestId("invoice-financial-summary").innerText();
      expect(summary).toContain(historical?"180,000":"6,500");expect(errors).toEqual([]);
      const form=page.getByTestId("invoice-workspace");
      expect(await form.getByTestId("treatment-entry-choice").count()).toBe(1);
      expect(await form.getByRole("button",{name:historical?"علاج بدأ قبل النظام":"علاج جديد",exact:true}).getAttribute("aria-pressed")).toBe("true");
      expect(await form.getByLabel("المدفوع قبل النظام",{exact:true}).count()).toBe(historical?1:0);
      await page.keyboard.press("Tab");
      await page.evaluate(()=>window.scrollTo(0,0));
      const geometry=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,form:document.querySelector('[data-testid="invoice-workspace"]')!.getBoundingClientRect().toJSON()}));
      expect(geometry.document).toBeLessThanOrEqual(width+1);
      const prefix=`${historical?"historical":"new"}-${width}`;
      await page.screenshot({path:`${evidence}/${prefix}-page.png`,fullPage:true});
      await page.screenshot({path:`${evidence}/${prefix}-form.png`,fullPage:true,clip:{x:geometry.form.x,y:geometry.form.y,width:geometry.form.width,height:geometry.form.height}});
      writeFileSync(`${evidence}/${prefix}.json`,JSON.stringify({patientId,historical,width,geometry,summary,errors,source:"real app, synthetic local PostgreSQL catalogue and preview; unsaved review form"},null,2));
      expect((await db.query("SELECT count(*)::int AS count FROM invoices WHERE patient_id=$1",[patientId])).rows[0].count).toBe(0);
      expect((await db.query("SELECT count(*)::int AS count FROM payments WHERE patient_id=$1",[patientId])).rows[0].count).toBe(0);
    }finally{await context.close();}
  });
});
