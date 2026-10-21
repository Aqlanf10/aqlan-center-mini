import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdirSync } from "node:fs";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser, converted: number, native: number, zero: number, roundedZero: number, doctor: number, serial = 0;
const keys = ["finance.rate.SAR", "finance.rate.USD", "billing.max_discount_percent", "finance.reception_adds_opening_balance", "plans.specialty_templates"];
let prior: { key: string; value: string }[] = [];
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  doctor = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  const create = async (name: string, category: string, sar: number | null, usd: number | null) => (await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES($1,$2,2200,$3,$4,TRUE,TRUE) RETURNING id", [name, category, sar, usd])).rows[0].id;
  converted = await create("Synthetic converted contract ortho", "ortho", null, null);
  native = await create("Synthetic native contract ortho", "ortho", 150000, 50000);
  zero = await create("Synthetic configured zero", "consultation", 0, 0);
  roundedZero=await create("Synthetic rounded zero conversion","consultation",null,null);
  await db.query("UPDATE services SET price_minor=1 WHERE id=$1",[roundedZero]);
  prior = (await db.query("SELECT key,value FROM settings WHERE key=ANY($1::text[])", [keys])).rows;
  await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','440'),('finance.rate.USD','2200'),('billing.max_discount_percent','10'),('finance.reception_adds_opening_balance','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  const settings=await (await authedGet("/api/settings",h.sessions.admin)).json();
  const template={id:"invoice_quote_test",name:"Synthetic converted invoice template",specialty:"تقويم",description:"Synthetic invoice template source",steps:[{key:"ortho",title:"Converted orthodontic step",category:"ortho",preferredService:"Synthetic converted contract ortho",perTooth:false,optional:false,billingRule:"on_completion",labWork:false,sessions:[{title:"Synthetic assessment",minutes:30,afterDays:0}]}]};
  const configured=await authedMutation("/api/settings",h.sessions.admin,"PATCH",JSON.stringify({"plans.specialty_templates":JSON.stringify([template]),__versions:{"plans.specialty_templates":settings.__versions?.["plans.specialty_templates"]??null},__reason:"Synthetic invoice quote contract fixture"}));expect(configured.status).toBe(200);
  mkdirSync(".settings-ui-artifacts", { recursive: true });
}, 180000);
afterAll(async () => {
  await browser?.close();
  if (db) {
    const settings=await (await authedGet("/api/settings",h.sessions.admin)).json();
    const restored=await authedMutation("/api/settings",h.sessions.admin,"PATCH",JSON.stringify({"plans.specialty_templates":prior.find(row=>row.key==="plans.specialty_templates")?.value??"",__versions:{"plans.specialty_templates":settings.__versions?.["plans.specialty_templates"]??null},__reason:"Restore synthetic invoice template fixture"}));expect(restored.status).toBe(200);
    await db.query("DELETE FROM settings WHERE key=ANY($1::text[])", [keys]);
    for (const row of prior) await db.query("INSERT INTO settings(key,value) VALUES($1,$2)", [row.key, row.value]);
    await db.end();
  }
});
async function patient() { return (await db.query("INSERT INTO patients(patient_number,full_name,phone) VALUES($1,'Synthetic invoice contract patient','777123456') RETURNING id", [`QUOTE-CONTRACT-${Date.now()}-${++serial}`])).rows[0].id as number; }
async function open(role: "admin" | "reception", historical = false) {
  const patientId = await patient(); const width = role === "admin" ? 1280 : 390;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions[role].cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("treatment-entry-open").click(); await page.getByRole("button", { name: historical ? "علاج بدأ قبل النظام" : "علاج جديد", exact: true }).click();
  const row = page.getByTestId("invoice-row-0"); await row.getByLabel("الخدمة", { exact: true }).selectOption(String(converted));
  await row.getByLabel("نطاق العلاج", { exact: true }).selectOption("both"); await page.getByTestId("invoice-provider-0").selectOption(String(doctor));
  return { patientId, context, page, row, width, editor: page.getByTestId("debt-repayment-editor") };
}
async function facts(patientId: number) {
  return (await db.query(`SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,(SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans,
    (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) AS cases,
    (SELECT count(*)::int FROM debt_repayment_arrangements WHERE patient_id=$1) AS schedules,
    (SELECT count(*)::int FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1) AS items`, [patientId])).rows[0];
}
describe("invoice converted source, manual reasons and saved contract", () => {
  it.each(["admin","reception"] as const)("%s gets a clear positive manual-price path for a rounded-zero conversion and cannot save free accidentally",async role=>{
    const {patientId,context,page,row,width}=await open(role);
    try{
      await page.getByLabel("عملة الفاتورة",{exact:true}).selectOption("SAR");
      await row.getByLabel("الخدمة",{exact:true}).selectOption(String(roundedZero));
      const price=row.getByLabel("السعر",{exact:true});expect(await price.inputValue()).toBe("");
      const save=page.getByRole("button",{name:"احفظ الفاتورة",exact:true});expect(await save.isDisabled()).toBe(true);
      expect(await page.getByTestId("invoice-input-problem-0").innerText()).toContain("نتيجة التحويل بعد التقريب صفر");
      expect(await page.getByTestId("invoice-price-source-0").innerText()).not.toContain("سعر محوّل مقترح");
      await row.getByLabel("سبب تغيير السعر",{exact:true}).waitFor();
      const catalog=await (await authedGet("/api/services",h.sessions[role])).json();
      const quote=catalog.find((service:{id:number})=>service.id===roundedZero).invoiceQuotes.SAR;
      const refused=await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify({patientId,currency:"SAR",items:[{serviceId:roundedZero,price:"0",catalogPriceMinor:null,priceQuote:quote}],idempotencyKey:`zero-rounded-refuse-${patientId}`}));
      expect(refused.status).toBe(400);expect((await refused.json()).message).toContain("نتيجة التحويل بعد التقريب صفر");
      expect(await facts(patientId)).toEqual({invoices:0,payments:0,plans:0,cases:0,schedules:0,items:0});
      await page.screenshot({path:`.settings-ui-artifacts/invoice-rounded-zero-${role}-${width}.png`,fullPage:true});
      await price.fill("7.25");expect(await save.isDisabled()).toBe(true);
      await row.getByLabel("سبب تغيير السعر",{exact:true}).fill("Synthetic positive price after rounded zero");
      await expect.poll(()=>save.isEnabled()).toBe(true);await save.click();
      await page.getByRole("region",{name:"فاتورة جديدة",exact:true}).waitFor({state:"detached"});
      expect((await db.query("SELECT total_minor::int AS total FROM invoices WHERE patient_id=$1",[patientId])).rows).toEqual([{total:725}]);
      expect(await facts(patientId)).toEqual({invoices:1,payments:0,plans:0,cases:0,schedules:1,items:0});
    }finally{await context.close();}
  });
  it.each(["admin","reception"] as const)("%s reviews and saves a converted template with its exact source and one canonical work item",async role=>{
    const {patientId,context,page,row,width}=await open(role);
    try{
      await row.getByLabel("الخدمة",{exact:true}).selectOption("");await row.getByLabel("وصف البند",{exact:true}).fill("");
      await page.getByLabel("عملة الفاتورة",{exact:true}).selectOption("SAR");
      await page.getByRole("button",{name:"اختيار قالب علاج",exact:true}).click();
      await page.getByLabel("قالب العلاج",{exact:true}).selectOption("invoice_quote_test");
      await page.getByLabel("طبيب بنود القالب",{exact:true}).selectOption(String(doctor));
      await page.getByLabel("نطاق Converted orthodontic step",{exact:true}).selectOption("both");
      const source=page.getByTestId("invoice-template-price-source-0");await expect.poll(()=>source.innerText()).toContain("440");
      expect(await source.innerText()).toContain("محوّل مقترح");
      await page.getByRole("checkbox",{name:"راجعت بنود القالب ومبلغه وجدول جلساته",exact:true}).check();
      const save=page.getByRole("button",{name:"احفظ الفاتورة",exact:true});await expect.poll(()=>save.isEnabled()).toBe(true);
      await page.screenshot({path:`.settings-ui-artifacts/invoice-template-converted-${role}-${width}.png`,fullPage:true});
      await save.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
      await page.getByRole("region",{name:"فاتورة جديدة",exact:true}).waitFor({state:"detached"});
      expect(await facts(patientId)).toEqual({invoices:1,payments:0,plans:1,cases:1,schedules:1,items:1});
      const audit=(await db.query("SELECT details FROM audit_log WHERE action='invoice.create' AND details->>'المريض'=$1",[String(patientId)])).rows[0].details;
      expect(audit.invoicePriceSnapshots[0]).toMatchObject({agreedPriceSource:"converted",quote:{rate:440,minor:500,source:"converted"}});
    }finally{await context.close();}
  });
  it.each(["admin", "reception"] as const)("%s sees native/converted currency sources, saves once and prints the actual saved schedule", async role => {
    const { patientId, context, page, row, width, editor } = await open(role);
    try {
      const currency = page.getByLabel("عملة الفاتورة", { exact: true }); const price = row.getByLabel("السعر", { exact: true });
      expect((await price.inputValue()).replaceAll(",", "")).toBe("2200");
      await page.screenshot({path:`.settings-ui-artifacts/invoice-quote-YER-${role}-${width}.png`,fullPage:true});
      await currency.selectOption("USD"); expect(await price.inputValue()).toBe("1.00");
      await page.screenshot({path:`.settings-ui-artifacts/invoice-quote-USD-${role}-${width}.png`,fullPage:true});
      await currency.selectOption("SAR"); expect(await price.inputValue()).toBe("5.00");
      expect(await page.getByTestId("invoice-price-source-0").innerText()).toContain("440");
      await page.screenshot({path:`.settings-ui-artifacts/invoice-quote-SAR-${role}-${width}.png`,fullPage:true});
      await row.getByLabel("الخدمة", { exact: true }).selectOption(String(native)); expect((await price.inputValue()).replaceAll(",", "")).toBe("1500.00");
      await row.getByLabel("الخدمة", { exact: true }).selectOption(String(converted));
      await row.getByLabel("نطاق العلاج", { exact: true }).selectOption("both"); await page.getByTestId("invoice-provider-0").selectOption(String(doctor));
      const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
      await price.fill("1500"); expect(await save.isDisabled()).toBe(true);
      expect(await page.getByTestId("invoice-input-problem-0").innerText()).toContain("سبب التسعير اليدوي");
      await row.getByLabel("سبب تغيير السعر", { exact: true }).fill("Synthetic explicit manual agreement");
      expect(await page.getByTestId("invoice-price-source-0").innerText()).toContain("سعر يدوي");
      await editor.getByRole("radio", { name: "جدول أقساط", exact: true }).check();
      await editor.getByLabel("مبلغ الدفعة المقدمة المقترحة", { exact: true }).fill("490");
      await editor.getByLabel("تاريخ الدفعة المقدمة المقترحة", { exact: true }).fill("2026-10-14");
      await editor.getByLabel("عدد الأشهر", { exact: true }).fill("3");
      await editor.getByLabel("أول استحقاق شهري", { exact: true }).fill("2028-01-31");
      await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).click();
      expect(await editor.getByLabel("تاريخ السداد 3", { exact: true }).inputValue()).toBe("2028-02-29");
      expect(await editor.getByLabel("تاريخ السداد 4", { exact: true }).inputValue()).toBe("2028-03-31");
      expect(await editor.getByRole("checkbox").count()).toBe(0);
      expect(await editor.getByText("القسط 1",{exact:true}).count()).toBe(1);
      expect(await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).count()).toBe(1);
      expect(await page.getByTestId("invoice-financial-summary").getByText("المبلغ المتبقي", { exact: true }).count()).toBe(0);
      await expect.poll(() => save.isEnabled()).toBe(true);
      await page.screenshot({ path: `.settings-ui-artifacts/invoice-quoted-${role}-${width}.png`, fullPage: true });
      const bodies: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname === "/api/invoices" && request.method() === "POST") bodies.push(request.postData()!); });
      await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).waitFor({ state: "detached" });
      expect(bodies).toHaveLength(1); expect(await facts(patientId)).toEqual({ invoices: 1, payments: 0, plans: 1, cases: 1, schedules: 1, items: 1 });
      const repeated = await authedMutation("/api/invoices", h.sessions[role], "POST", bodies[0]); expect(repeated.status).toBe(200); expect((await repeated.json()).replayed).toBe(true);
      const ledgerResponse=await context.request.get(`${baseUrl}/api/patients/${patientId}/ledger`);expect(ledgerResponse.status()).toBe(200);
      const ledger=await ledgerResponse.json();expect(ledger.balances.SAR).toMatchObject({billedMinor:150000,collectedMinor:0,dueMinor:150000});
      expect(ledger.balances.YER.dueMinor).toBe(0);expect(ledger.balances.USD.dueMinor).toBe(0);
      const statement=await context.newPage();const statementResponse=await statement.goto(`${baseUrl}/print/statement/${patientId}`,{waitUntil:"domcontentloaded"});
      expect(statementResponse?.status()).toBe(200);
      // Current statements group stored treatment lines in a table per invoice;
      // the persisted invoice number is in its repeating header, not a body row.
      const statementInvoice=statement.locator(`table.statement-invoice[data-invoice-id="${ledger.invoices[0].id}"]`);
      await statementInvoice.waitFor();expect(await statementInvoice.count()).toBe(1);
      expect(await statementInvoice.locator("thead").innerText()).toContain(ledger.invoices[0].invoiceNumber);
      expect(await statementInvoice.locator("tbody tr").filter({hasText:"صافي الفاتورة بعد الخصم"}).innerText()).toContain("1,500.00");
      expect(await statement.locator(".line").filter({hasText:"إجمالي المفوتر"}).innerText()).toContain("1,500.00");
      expect(await statement.locator(".line").filter({hasText:"صافي المحصّل بعد الاستردادات وعكس السندات"}).innerText()).toContain("0.00");
      await statement.emulateMedia({media:"print"});await statement.screenshot({path:`.settings-ui-artifacts/invoice-statement-${role}-${width}.png`,fullPage:true});await statement.close();
      const audit = (await db.query("SELECT details FROM audit_log WHERE action='invoice.create' AND details->>'المريض'=$1", [String(patientId)])).rows[0].details;
      expect(audit.invoicePriceSnapshots[0]).toMatchObject({ quote: { source: "converted", rate: 440, rounding: "nearest-major-unit", minor: 500 }, agreedPriceSource:"manual", requestedMinor: 150000, reason: "Synthetic explicit manual agreement" });
      await page.reload({ waitUntil: "domcontentloaded" });
      const print = page.getByRole("link", { name: "طباعة عقد التقسيط", exact: true }); await print.waitFor();
      expect(await print.getAttribute("href")).toMatch(/^\/print\/plan\/\d+\?source=debt-repayment&version=1$/);
      const popup = context.waitForEvent("page"); await print.click(); const contract = await popup;
      await contract.getByTestId("saved-installment-contract").waitFor();
      const text = await contract.getByTestId("saved-installment-contract").innerText();
      expect(text).toContain("Synthetic invoice contract patient"); expect(text).toContain("SAR"); expect(text).toContain("فاتورة"); expect(text).toContain("التوقيع والاسم الثلاثي");
      expect(await contract.locator("tbody tr").count()).toBe(4); expect(text).toContain("490.00"); expect(text).toContain("1,010.00");
      expect(await contract.getByText("قسط 1",{exact:true}).count()).toBe(1);
      await contract.emulateMedia({ media: "print" });
      await contract.screenshot({ path: `.settings-ui-artifacts/invoice-contract-${role}-${width}.png`, fullPage: true });
      await contract.pdf({ path: `.settings-ui-artifacts/invoice-contract-${role}.pdf`, format: "A4", printBackground: true });
      expect(await facts(patientId)).toEqual({ invoices: 1, payments: 0, plans: 1, cases: 1, schedules: 1, items: 1 });
      const href = await print.getAttribute("href");
      const invalid = await context.request.get(`${baseUrl}${href!.replace("version=1", "version=2")}`); expect(invalid.status()).toBe(404);
      for (const denied of ["doctorA", "cashier", "accountant"] as const) {
        const refusal = await authedGet(href!, h.sessions[denied]);
        // Existing route allowlists redirect the two restricted financial roles
        // before rendering; the doctor reaches the page's notFound guard.
        expect(refusal.status).toBe(denied === "doctorA" ? 404 : 307);
        if (denied !== "doctorA") expect(new URL(refusal.headers.get("location")!,baseUrl).pathname).toBe("/finance");
        expect(await refusal.text()).not.toContain("Synthetic invoice contract patient");
      }
    } finally { await context.close(); }
  });
  it.each(["admin", "reception"] as const)("%s validates stale FX even when rounded quote stays5, preserves native guards, and refuses missing manual reasons", async role => {
    const patientId = await patient(); const catalogue = await (await authedGet("/api/services", h.sessions[role])).json();
    const item = { serviceId: converted, doctorId: doctor, scope: "both", price: "5", catalogPriceMinor: null, priceQuote: catalogue.find((s: { id: number }) => s.id === converted).invoiceQuotes.SAR };
    const body = { patientId, currency: "SAR", items: [item], idempotencyKey: `quote-stale-${role}-${patientId}` };
    try {
      await db.query("UPDATE settings SET value='441' WHERE key='finance.rate.SAR'");
      for (const path of ["/api/invoices/clinical-preview", "/api/invoices"]) {
        const stale = await authedMutation(path, h.sessions[role], "POST", JSON.stringify(body)); expect(stale.status).toBe(409); expect((await stale.json()).code).toBe("INVOICE_PRICE_STALE");
        expect((await authedMutation(path, h.sessions[role], "POST", JSON.stringify({ ...body, items: [{ ...item, priceQuote: undefined, price: "1500" }] }))).status).toBe(400);
      }
      expect(await facts(patientId)).toEqual({ invoices: 0, payments: 0, plans: 0, cases: 0, schedules: 0, items: 0 });
    } finally { await db.query("UPDATE settings SET value='440' WHERE key='finance.rate.SAR'"); }
    const nativeItem = { serviceId: native, doctorId: doctor, scope: "both", catalogPriceMinor: 150000, price: "1600", priceReason: "Synthetic higher native price" };
    const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions[role], "POST", JSON.stringify({ ...body, items: [nativeItem] })); expect(preview.status).toBe(role === "admin" ? 200 : 400);
    const zeroResponse = await authedMutation("/api/invoices", h.sessions[role], "POST", JSON.stringify({ patientId, currency: "SAR", items: [{ serviceId: zero, price: "0", catalogPriceMinor: 0 }], idempotencyKey: `quote-zero-${role}-${patientId}` })); expect(zeroResponse.status).toBe(201); expect((await zeroResponse.json()).totalMinor).toBe(0);
    const offered = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify(body)); expect(offered.status).toBe(201);
    const offeredInvoice=await offered.json(); expect(offeredInvoice.totalMinor).toBe(500);
    const snapshot=(await db.query("SELECT details FROM audit_log WHERE action='invoice.create' AND entity_id=$1",[String(offeredInvoice.id)])).rows[0].details.invoicePriceSnapshots[0];
    expect(snapshot.agreedPriceSource).toBe("converted");expect(snapshot.quoteHash).toMatch(/^[a-f0-9]{64}$/);
    try{await db.query("UPDATE settings SET value='441' WHERE key='finance.rate.SAR'");const replay=await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify(body));expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({id:offeredInvoice.id,totalMinor:500,replayed:true});}
    finally{await db.query("UPDATE settings SET value='440' WHERE key='finance.rate.SAR'");}
  });
  it.each(["admin", "reception"] as const)("%s prints historical opening installments without creating a new invoice, plan or receipt", async role => {
    const { patientId, context, page, row, width, editor } = await open(role, true);
    try {
      await page.getByLabel("عملة الاتفاق", { exact: true }).selectOption("SAR");
      await row.getByLabel("السعر", { exact: true }).fill("1500");
      await row.getByLabel("سبب تغيير السعر", { exact: true }).fill("Synthetic historical manual agreement");
      await page.getByLabel("المدفوع قبل النظام", { exact: true }).fill("500");
      await page.getByLabel("تاريخ المعلومات التاريخية", { exact: true }).fill("2026-10-01");
      await editor.getByRole("radio", { name: "جدول أقساط", exact: true }).check();
      await editor.getByLabel("مبلغ الدفعة المقدمة المقترحة", { exact: true }).fill("490");
      await editor.getByLabel("تاريخ الدفعة المقدمة المقترحة", { exact: true }).fill("2026-10-14");
      await editor.getByRole("button", { name: "15 شهرًا", exact: true }).click();
      await editor.getByLabel("أول استحقاق شهري", { exact: true }).fill("2028-01-31");
      await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).click();
      expect(await editor.getByLabel("مبلغ السداد 2", { exact: true }).inputValue()).toBe("34.00");
      const save = page.getByRole("button", { name: "احفظ الاتفاق التاريخي", exact: true }); await expect.poll(() => save.isEnabled()).toBe(true);
      const commands: string[] = []; const path = `/api/patients/${patientId}/historical-documents`;
      page.on("request", request => { if (new URL(request.url()).pathname === path && request.method() === "POST") commands.push(request.postData()!); });
      await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await page.getByRole("region", { name: "اتفاق تاريخي متعدد البنود", exact: true }).waitFor({ state: "detached" });
      expect(commands).toHaveLength(1); expect((await authedMutation(path, h.sessions[role], "POST", commands[0])).status).toBe(200);
      const before = await facts(patientId); expect(before).toEqual({ invoices: 0, payments: 0, plans: 1, cases: 1, schedules: 1, items: 1 });
      expect((await db.query("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1", [patientId])).rows[0].amount_minor).toBe("100000");
      const print = page.getByRole("link", { name: "طباعة عقد التقسيط", exact: true }); await print.waitFor();
      const popup = context.waitForEvent("page"); await print.click(); const contract = await popup; await contract.getByTestId("saved-installment-contract").waitFor();
      const text = await contract.getByTestId("saved-installment-contract").innerText();
      expect(text).toContain("الرصيد السابق SAR"); expect(text).toContain("1,000.00"); expect(text).toContain("490.00"); expect(text).toContain("510.00");
      expect(await contract.locator("tbody tr").count()).toBe(16); expect(text).toContain("التوقيع والاسم الثلاثي");
      await contract.emulateMedia({ media: "print" });
      await contract.screenshot({ path: `.settings-ui-artifacts/historical-contract-${role}-${width}.png`, fullPage: true });
      await contract.pdf({ path: `.settings-ui-artifacts/historical-contract-${role}.pdf`, format: "A4", printBackground: true });
      expect(await facts(patientId)).toEqual(before);
    } finally { await context.close(); }
  });
});
