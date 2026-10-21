import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Client} from "pg";
import {chromium,type Browser,type Page} from "playwright";
import {baseUrl,harness} from "./_server";

let ctx:Awaited<ReturnType<typeof harness>>, db:Client, browser:Browser;
beforeAll(async()=>{
  ctx=await harness();
  db=new Client({connectionString:ctx.seeded.dbUrl,ssl:false});await db.connect();
  await db.query(`INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd)
    SELECT 'similar-browser',0,0,0 WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')`);
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
},240000);
afterAll(async()=>{await browser?.close();await db?.end();});
async function count(){
  const r=await db.query<{n:number}>(`SELECT COUNT(*)::int n FROM payments
    WHERE patient_id=$1 AND kind='payment' AND amount_minor=71594 AND currency='YER'`,[ctx.seeded.patientAId]);
  return r.rows[0].n;
}
async function openPayment(page:Page){
  await page.getByRole("button",{name:/الحساب/}).first().click();
  await page.getByRole("button",{name:"قبض دفعة"}).click();
  await page.getByRole("dialog",{name:"تحصيل دفعة"}).waitFor();
  return page.getByRole("dialog",{name:"تحصيل دفعة"});
}
describe("actual cashier receipt warning: advisory UI",()=>{
  it("shows previous receipt, cancel is read-only, explicit proceed posts new receipt",async()=>{
    const context=await browser.newContext({viewport:{width:1280,height:900},locale:"ar-YE"});
    const [name,...rest]=ctx.sessions.admin.cookie.split("=");
    await context.addCookies([{name,value:rest.join("="),url:baseUrl}]);
    const page=await context.newPage();
    try{
      const initial=await count();
      await page.goto(`${baseUrl}/patients/${ctx.seeded.patientAId}?tab=account`);
      let modal=await openPayment(page);
      await modal.getByLabel("المبلغ").fill("71594");
      await modal.getByRole("button",{name:"سجّل الدفعة واطبع السند"}).click();
      await modal.waitFor({state:"hidden"});
      expect(await count()).toBe(initial+1);
      // Reload for a fresh form: a distinct valid operation must be reviewed.
      await page.reload();
      modal=await openPayment(page);
      await modal.getByLabel("المبلغ").fill("71594");
      await modal.getByRole("button",{name:"سجّل الدفعة واطبع السند"}).click();
      const warning=page.getByRole("dialog",{name:"تنبيه سند قبض مشابه"});
      await warning.waitFor();
      expect(await warning.getByText(/71594|71,594/).count()).toBeGreaterThan(0);
      expect(await count()).toBe(initial+1);
      await warning.getByRole("button",{name:"إلغاء"}).click();
      await warning.waitFor({state:"hidden"});
      expect(await count()).toBe(initial+1);
      await modal.getByRole("button",{name:"سجّل الدفعة واطبع السند"}).click();
      await warning.waitFor();
      await warning.getByRole("button",{name:"تسجيل الدفعة رغم التشابه"}).click();
      await modal.waitFor({state:"hidden"});
      expect(await count()).toBe(initial+2);
    }finally{await context.close();}
  },180000);
});
