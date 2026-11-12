import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Locator } from "playwright";
import { Client } from "pg";
import { mkdir, readFile } from "node:fs/promises";
import { formatMoney } from "../../lib/money";
import type { PatientStatementDocument } from "../../lib/patient-statement-document";
import { baseUrl, harness, loginStaff, TEST_USERS } from "./_server";

// Built application + disposable PostgreSQL only. Browser failure/race cases
// intercept this synthetic patient's read; no real messages or external uploads.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0;
let completedPlanId = 0;
let originalId = 0;
const stamp = Date.now();
const number = `SW-${stamp}`;
const secret = `INTERNAL-ONLY-${stamp}`;
const directory = ".settings-ui-artifacts/patient-statement-workflow";
const at = (day: string) => `${day}T09:00:00+03:00`;
const receipt = (name: string) => `SW-${stamp}-${name}`;
const api = (query = "type=detailed") => `/api/patients/${patientId}/statement?${query}`;

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  patientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number,full_name,phone,created_at)
    VALUES ($1,'مريض الكشف الاصطناعي','777123456',$2) RETURNING id`, [number, at("2026-01-01")])).rows[0].id;
  await db.query(`INSERT INTO patient_opening_balances (patient_id,currency,amount_minor,as_of_date,created_by,updated_at)
    VALUES ($1,'YER',300,'2026-01-01',$2,$3)`, [patientId, secret, at("2026-01-01")]);
  const shift = (await db.query<{ id: number }>(`INSERT INTO cashier_shifts (opened_by,opening_yer,opening_sar,opening_usd,status)
    VALUES ($1,0,0,0,'closed') RETURNING id`, [secret])).rows[0].id;
  const invoiceIds: number[] = [];
  for (const [currency, gross, discount, day] of [["YER",2250,250,"2026-08-15"],["SAR",5000,0,"2026-09-05"],["USD",1000,0,"2026-09-05"]] as const) {
    const invoice = (await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number,patient_id,total_minor,discount_minor,base_currency,note,created_by,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING id`, [`SW-I-${stamp}-${currency}`,patientId,gross,discount,currency,secret,at(day)])).rows[0].id;
    invoiceIds.push(invoice);
    for (let line = 0; line < (currency === "YER" ? 45 : 1); line++) {
      const unit = currency === "YER" ? 50 : gross;
      await db.query(`INSERT INTO invoice_items (invoice_id,description,quantity,unit_price_minor,total_minor)
        VALUES ($1,$2,1,$3,$3)`, [invoice, `${currency}-LINE-${line+1} علاج الأسنان الاصطناعي مع متابعة مراحل العلاج وتوضيح الخدمة للمريض`,unit]);
    }
  }
  for (const [title, status] of [["علاج منتهٍ سريريًا اصطناعي","done"],["علاج جارٍ اصطناعي","planned"]] as const) {
    const plan = (await db.query<{ id:number }>(`INSERT INTO treatment_plans (patient_id,title,total_minor,base_currency,status,start_date,consent_at,created_at)
      VALUES ($1,$2,3000,'YER','active','2026-08-01',$3,$3) RETURNING id`, [patientId,title,at("2026-08-01")])).rows[0].id;
    if (status === "done") completedPlanId = plan;
    await db.query(`INSERT INTO plan_items (plan_id,service_name,tooth_code,quantity,unit_price_minor,status,done_at)
      VALUES ($1,'تاج سن اصطناعي',16,1,3000,$2,$3)`, [plan,status,status === "done" ? at("2026-09-20") : null]);
  }
  const insertPayment = async (label: string, amount: number, day: string, kind = "payment", reversal: number | null = null,
    currency = "YER", invoice: number | null = invoiceIds[0], plan: number | null = null) => {
    const rate = currency === "YER" ? 1 : currency === "SAR" ? 425 : 1500;
    return (await db.query<{id:number}>(`INSERT INTO payments (receipt_number,patient_id,invoice_id,plan_id,shift_id,kind,reversal_of_id,amount_minor,currency,
      exchange_rate,base_amount_minor,base_currency,method,note,created_by,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'YER','cash',$12,$12,$13) RETURNING id`,
    [receipt(label),patientId,invoice,plan,shift,kind,reversal,amount,currency,rate,currency === "YER" ? amount : Math.round(amount*rate/100),secret,at(day)])).rows[0].id;
  };
  originalId = await insertPayment("ORIGINAL",1000,"2026-08-20");
  await insertPayment("REVERSAL",1000,"2026-09-12","refund",originalId);
  const replacement = await insertPayment("ACTIVE",700,"2026-09-12");
  await insertPayment("CASH-REFUND",100,"2026-09-15","refund",replacement);
  await insertPayment("PLAN",300,"2026-09-18","payment",null,"YER",null,completedPlanId);
  await insertPayment("SAR",1000,"2026-09-06","payment",null,"SAR",invoiceIds[1]);
  await insertPayment("USD",200,"2026-09-06","payment",null,"USD",invoiceIds[2]);
  await db.query(`INSERT INTO audit_log (action,entity,entity_id,summary,details,actor,created_at)
    VALUES ('payment.correct','payment',$1,$2,$3,$2,$4)`, [String(originalId),secret,JSON.stringify({
      الطريقة:"تصحيح",السبب:secret,المريض:patientId,سند_العكس:receipt("REVERSAL"),المبلغ_المعكوس:1000,العملة_المعكوسة:"YER",
      السند_الصحيح:receipt("ACTIVE"),المبلغ_الصحيح:700,العملة_الصحيحة:"YER",
    }),at("2026-09-12")]);
  browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  await mkdir(directory,{recursive:true});
},240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function read(query = "type=detailed", role: "admin"|"reception"|"cashier"|"accountant"|"doctorA"|"portalA" = "admin") {
  return fetch(`${baseUrl}${api(query)}`,{headers:{cookie:h.sessions[role].cookie},redirect:"manual"});
}
async function fixture(width = 1280) {
  const context = await browser.newContext({viewport:{width,height:1000},locale:"ar-YE",timezoneId:"Asia/Aden",acceptDownloads:true});
  const [name,...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
  const external: string[] = [];
  await context.route("https://**/*",async route => { external.push(route.request().url()); await route.abort(); });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`);
  await page.getByRole("button",{name:"كشف حساب",exact:true}).waitFor();
  return {context,page,external,errors};
}
async function open(page: Page) {
  await page.getByRole("button",{name:"كشف حساب",exact:true}).click();
  return page.getByRole("dialog");
}
async function waitForPrepared(dialog: Locator, label: string) {
  const button = dialog.getByRole("button",{name:label,exact:true});
  await expect.poll(async()=>await button.isVisible() || await dialog.getByRole("alert").isVisible(),{timeout:30_000}).toBe(true);
  expect(await dialog.getByRole("alert").allTextContents()).toEqual([]);
  await button.waitFor();
}
async function download(page: Page, label: string, path: string) {
  const ready = page.waitForEvent("download");
  await page.getByRole("button",{name:label,exact:true}).click();
  const file = await ready;
  await file.saveAs(path);
  return readFile(path);
}

// Real endpoint authorization, coherent balances and patient-safe redaction are
// separate from fault-injected UI lifecycle checks below.
describe("patient statement workflow on the built app", () => {
  it("matches internal and portal currency balances while retaining real refunds and removing the correction chain", async () => {
    for (const role of ["admin","reception","cashier","accountant"] as const) expect((await read("type=detailed",role)).status).toBe(200);
    expect((await read("type=detailed","doctorA")).status).toBe(403);
    expect((await read("type=detailed","portalA")).status).toBe(401);
    const response = await read();
    expect(response.headers.get("cache-control")).toContain("no-store");
    const document = await response.json() as PatientStatementDocument;
    const text = JSON.stringify(document);
    for (const visible of [receipt("ACTIVE"),receipt("CASH-REFUND"),"استرداد",number,formatMoney(1400,"YER"),formatMoney(4000,"SAR"),formatMoney(800,"USD")]) expect(text).toContain(visible);
    for (const hidden of [secret,receipt("ORIGINAL"),receipt("REVERSAL"),"عكس سند","دون نقد","createdBy","reversalOfId","settlementAllocation"]) expect(text).not.toContain(hidden);
    const internal = await fetch(`${baseUrl}/api/patients/${patientId}/ledger`,{headers:{cookie:h.sessions.admin.cookie}});
    const ledger = await internal.json();
    expect(ledger.payments.some((p:{id:number})=>p.id===originalId)).toBe(true);
    expect(ledger.balances.YER.dueMinor).toBe(1400);
    expect(ledger.balances.SAR.dueMinor).toBe(4000);
    expect(ledger.balances.USD.dueMinor).toBe(800);
    // The existing portal uses patient authority rather than accepting a path/query id.
    const portalLogin = await fetch(`${baseUrl}/api/portal/login`,{method:"POST",headers:{"Content-Type":"application/json",Origin:baseUrl},
      body:JSON.stringify({phone:"777123456",patientNumber:number})});
    expect(portalLogin.status).toBe(200);
    const cookie = portalLogin.headers.getSetCookie().map(v=>v.split(";")[0]).find(v=>v.startsWith("aqlan_portal_session="));
    expect(cookie).toBeTruthy();
    const portalResponse = await fetch(`${baseUrl}/api/portal/statement`,{headers:{cookie:cookie!}});
    expect(portalResponse.status).toBe(200);
    const portal = await portalResponse.json();
    expect(portal.balances).toEqual(ledger.balances);
    for (const hidden of [secret,receipt("ORIGINAL"),receipt("REVERSAL"),"عكس سند","reversalOfId"]) expect(JSON.stringify(portal)).not.toContain(hidden);
    expect(JSON.stringify(portal)).toContain(receipt("CASH-REFUND"));
    expect((await db.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE entity='payment' AND entity_id=$1",[String(originalId)])).rows[0].count).toBe(1);
  });

  it("enforces restricted cashier ledger permission at the real endpoint", async () => {
    const saved = (await db.query("SELECT permissions FROM users WHERE username='seccashier'")).rows[0].permissions;
    try {
      await db.query("UPDATE users SET permissions=$1 WHERE username='seccashier'",[JSON.stringify({financeAccess:{viewPatientLedger:false}})]);
      const restricted = await loginStaff(TEST_USERS.cashier.username,TEST_USERS.cashier.password);
      const response = await fetch(`${baseUrl}${api()}`,{headers:{cookie:restricted.cookie},redirect:"manual"});
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(number);
    } finally {
      await db.query("UPDATE users SET permissions=$1 WHERE username='seccashier'",[saved === null ? null : JSON.stringify(saved)]);
    }
  });

  it("preserves period opening/closing and explicit treatment allocations without adding plans to invoices", async () => {
    const period = await read("type=period&from=2026-09-01&to=2026-09-30");
    expect(period.status).toBe(200);
    const text = JSON.stringify(await period.json());
    for (const amount of [formatMoney(1300,"YER"),formatMoney(1400,"YER"),formatMoney(4000,"SAR"),formatMoney(800,"USD")]) expect(text).toContain(amount);
    const historical = await read("type=period&from=2026-08-01&to=2026-08-31");
    expect(historical.status).toBe(200);
    const historicalText = JSON.stringify(await historical.json());
    expect(historicalText).toContain(formatMoney(1300,"YER"));
    expect(historicalText).not.toContain(receipt("ACTIVE"));
    expect(historicalText).not.toContain(formatMoney(1400,"YER"));
    const treatment = await read(`type=treatment&treatmentId=${completedPlanId}`);
    expect(treatment.status).toBe(200);
    const scoped = JSON.stringify(await treatment.json());
    expect(scoped).toContain("علاج منتهٍ سريريًا اصطناعي");
    expect(scoped).not.toContain(receipt("ACTIVE"));
    expect(scoped).not.toContain(receipt("SAR"));
    for (const query of ["type=period&from=2026-09-30&to=2026-09-01","type=period&from=2026-02-30&to=2026-03-01","type=treatment&treatmentId=99999999","type=unrecognized"]) {
      expect((await read(query)).status).toBeGreaterThanOrEqual(400);
    }
    const ongoing = await read("type=ongoing");
    expect(ongoing.status).toBe(200);
    const ongoingText = JSON.stringify(await ongoing.json());
    expect(ongoingText).toContain("علاج جارٍ اصطناعي");
    expect(ongoingText).toContain("علاج منتهٍ سريريًا اصطناعي");
  });

  it.each([390,1280])("previews readable RTL at %s px and exports actual Arabic PDF/PNG locally", async width => {
    const f = await fixture(width);
    try {
      const dialog = await open(f.page);
      // The dialog starts at the summary; detailed lines intentionally span pages.
      await dialog.getByLabel("نوع الكشف").selectOption("detailed");
      await dialog.getByRole("button",{name:"معاينة الكشف",exact:true}).click();
      await dialog.getByText(receipt("CASH-REFUND"),{exact:false}).waitFor();
      expect(await dialog.locator(".patient-statement-document").getAttribute("dir")).toBe("rtl");
      expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
      expect(await dialog.innerText()).not.toContain(secret);
      await f.page.evaluate(async()=>document.fonts.ready);
      await f.page.screenshot({path:`${directory}/preview-${width}.png`,fullPage:false});
      await dialog.getByRole("button",{name:"تجهيز ملف PDF",exact:true}).click();
      await waitForPrepared(dialog,"تنزيل PDF");
      const pdf = await download(f.page,"تنزيل PDF",`${directory}/statement-${width}.pdf`);
      expect(pdf.subarray(0,5).toString()).toBe("%PDF-");
      expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)??[]).length).toBeGreaterThan(1);
      expect(pdf.byteLength).toBeGreaterThan(30_000);
      await dialog.getByRole("button",{name:"تجهيز صور PNG",exact:true}).click();
      await waitForPrepared(dialog,"تنزيل الصورة 1");
      const png = await download(f.page,"تنزيل الصورة 1",`${directory}/statement-${width}.png`);
      expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(1200);
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(1500);
      expect(f.external).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  },240_000);
});

describe("patient statement read and sharing lifecycle", () => {
  it("clears failed/stale previews on retry and filter change and refuses export after user change", async () => {
    const document = await (await read("type=summary")).json() as PatientStatementDocument;
    const f = await fixture();
    const pending: import("playwright").Route[] = [];
    await f.context.route(`**/api/patients/${patientId}/statement?**`,route=>{pending.push(route);});
    try {
      const dialog = await open(f.page);
      const preview = () => dialog.getByRole("button",{name:"معاينة الكشف",exact:true}).click();
      const next = async () => {
        await expect.poll(()=>pending.length,{timeout:10000}).toBeGreaterThan(0);
        return pending.shift()!;
      };
      // Opening the composer performs its first summary read.
      await (await next()).fulfill({status:503,contentType:"application/json",body:JSON.stringify({message:"تعذر قراءة الكشف الاصطناعي"})});
      await dialog.getByRole("alert").waitFor();
      expect(await dialog.locator(".patient-statement-document").count()).toBe(0);
      expect(await dialog.getByRole("button",{name:"تجهيز ملف PDF",exact:true}).count()).toBe(0);
      await preview();
      const stale = await next();
      await dialog.getByLabel("نوع الكشف").selectOption("detailed");
      await stale.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...document,patient:{name:"OLD-RESPONSE-MUST-NOT-APPEAR",number}})}).catch(()=>undefined);
      expect(await dialog.locator(".patient-statement-document").count()).toBe(0);
      await preview();
      await (await next()).fulfill({status:200,contentType:"application/json",body:JSON.stringify(document)});
      await dialog.locator(".patient-statement-document").waitFor();
      expect(await dialog.innerText()).not.toContain("OLD-RESPONSE-MUST-NOT-APPEAR");
      await f.context.route("**/api/auth/me",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({username:"another-synthetic-user",role:"admin"})}));
      await dialog.getByRole("button",{name:"تجهيز ملف PDF",exact:true}).click();
      await dialog.getByRole("alert").waitFor();
      expect(await dialog.locator(".patient-statement-document").count()).toBe(0);
      expect(await dialog.getByRole("button",{name:"تنزيل PDF",exact:true}).count()).toBe(0);
      expect(f.external).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("requires content and recipient review and offers download/manual attachment when file sharing is unsupported", async () => {
    const f = await fixture(390);
    await f.page.evaluate(()=>{
      Object.defineProperty(navigator,"canShare",{configurable:true,value:()=>false});
      Object.defineProperty(navigator,"share",{configurable:true,value:()=>{throw new Error("Must not call unsupported share");}});
    });
    try {
      const dialog = await open(f.page);
      await dialog.getByRole("button",{name:"معاينة الكشف",exact:true}).click();
      await dialog.locator(".patient-statement-document").waitFor();
      await dialog.getByRole("button",{name:"تجهيز ملف PDF",exact:true}).click();
      await waitForPrepared(dialog,"تنزيل PDF");
      const share = dialog.getByRole("button",{name:"مشاركة الملف عبر الجهاز",exact:true});
      expect(await share.isDisabled()).toBe(true);
      expect(await dialog.getByRole("link",{name:"فتح واتساب للإرفاق اليدوي",exact:true}).count()).toBe(0);
      await dialog.getByLabel("راجعت محتوى الكشف والملف",{exact:true}).check();
      await dialog.getByLabel("رقم مستلم واتساب بالرمز الدولي",{exact:true}).fill("+967777123456");
      expect(await share.isDisabled()).toBe(true);
      await dialog.getByRole("checkbox",{name:/راجعت رقم المستلم/}).check();
      await share.click();
      await dialog.getByText("مشاركة الملفات غير مدعومة هنا. نزّل الملف ثم افتح واتساب وأرفقه يدويًا.",{exact:true}).waitFor();
      expect(await dialog.getByRole("link",{name:"فتح واتساب للإرفاق اليدوي",exact:true}).count()).toBe(0);
      await download(f.page,"تنزيل PDF",`${directory}/fallback-reviewed.pdf`);
      const manual = dialog.getByRole("link",{name:"فتح واتساب للإرفاق اليدوي",exact:true});
      await manual.waitFor();
      const href = await manual.getAttribute("href");
      expect(href).toBe("https://wa.me/967777123456");
      expect(href).not.toContain("text=");
      // Deliberately do not navigate to WhatsApp: this verifies the manual
      // destination without transmitting even synthetic patient data externally.
      await dialog.getByLabel("رقم مستلم واتساب بالرمز الدولي",{exact:true}).fill("+967777123457");
      expect(await share.isDisabled()).toBe(true);
      expect(await manual.count()).toBe(0);
      expect(f.external).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  },240_000);
});
