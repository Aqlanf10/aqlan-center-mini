import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

// Real built application, isolated PostgreSQL and synthetic rows. No response or CSS replacement.
let browser: Browser, db: Client, h: Awaited<ReturnType<typeof harness>>, patientId: number;
const evidence = process.env.PATIENT_VISUAL_OUTPUT ?? ".settings-ui-artifacts/patient-premium";
beforeAll(async () => {
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  patientId = (await db.query(`INSERT INTO patients (patient_number,full_name,phone,gender,birth_date,primary_doctor_id,medical_alert)
    VALUES ($1,'أحمد محمد — ملف اصطناعي','777123456','male','1998-01-15',$2,'حساسية بنسلين — تنبيه اختبار اصطناعي') RETURNING id`, [`VISUAL-${Date.now()}`, doctor])).rows[0].id;
  for (const [title, currency, total] of [["خطة ترميم الأسنان", "YER", 30000000], ["خطة متابعة مستقلة", "SAR", 300000]] as const) {
    const plan = (await db.query(`INSERT INTO treatment_plans (patient_id,title,total_minor,base_currency,status,consent_at) VALUES ($1,$2,$3,$4,'active',NOW()) RETURNING id`, [patientId,title,total,currency])).rows[0].id;
    await db.query(`INSERT INTO plan_items (plan_id,service_name,tooth_code,unit_price_minor,status) VALUES ($1,'حشوة تجريبية',26,$2,'done'),($1,'متابعة تجريبية',36,$2,'planned')`,[plan,total / 2]);
  }
  await db.query(`INSERT INTO visits (patient_name,patient_id,doctor_id,status) VALUES ('أحمد محمد — ملف اصطناعي',$1,$2,'in_chair')`,[patientId,doctor]);
  await db.query(`INSERT INTO invoices (invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES ($1,$2,2500000,0,'YER','secadmin')`,[`VISUAL-INV-${Date.now()}`,patientId]);
  await mkdir(evidence,{recursive:true});
  browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
},240_000);
afterAll(async()=>{ await browser?.close(); await db?.end(); });

describe("patient premium real application evidence",()=>{
  it.each([1448,1280,390])("captures summary, account, treatment, today and files at %ipx",async width=>{
    const context=await browser.newContext({viewport:{width,height:1024},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");
    await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage(); const errors:string[]=[];
    page.on("pageerror",e=>errors.push(e.message));
    // Block external services without substituting any application response.
    await context.route("**/*",async route=>new URL(route.request().url()).origin===baseUrl ? route.continue() : route.abort());
    try {
      for(const tab of ["summary","account","treatment","today","files"]){
        await page.goto(`${baseUrl}/patients/${patientId}?tab=${tab}`,{waitUntil:"networkidle"});
        await page.getByTestId(`patient-tab-${tab}`).waitFor();
        await page.evaluate(async()=>{await document.fonts.ready;});
        expect(await page.getByTestId(`patient-tab-${tab}`).getAttribute("aria-current")).toBe("page");
        expect(await page.getByTestId("patient-medical-alert-banner").isVisible()).toBe(true);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
        await page.screenshot({path:`${evidence}/${tab}-${width}.png`});
        await page.screenshot({path:`${evidence}/${tab}-${width}-full.png`,fullPage:true});
        await writeFile(`${evidence}/${tab}-${width}-geometry.json`,JSON.stringify(await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,headings:[...document.querySelectorAll("h1,h2,h3")].map(el=>({text:el.textContent,y:el.getBoundingClientRect().y})), tabs:document.querySelector('[aria-label="أقسام ملف المريض"]')?.getBoundingClientRect().toJSON()})),null,2));
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
