#!/usr/bin/env node
import { loadChromium, executablePath } from "./playwright.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { isLoopbackHost, validateLocalVerificationTarget } from "../../lib/verification-target-policy.mjs";

/**
 * رحلة خطة العلاج — من الاتفاق إلى تنفيذه.
 *
 * ما لا يقوله أي اختبار وحدة: هل يستطيع إنسانٌ فعلًا أن يبني خطةً ويوافق عليها
 * ويرى بنودها تُشطب من نفسها؟ فحوصُ القاعدة تثبت المنطق، والرحلة تثبت أن الشاشة
 * توصّل إليه — وبينهما وقع أكثر ما وقع من خلل: زرٌّ لا يظهر، وحقلٌ لا يُحفظ.
 *
 *   الاستعمال: node scripts/journeys/plan.mjs <مجلد-الصور>
 *   (خادم اختبار محلي يعمل على 3000 وحساب اسمه shots؛ ليست ضمن CI)
 *   DATABASE_ENVIRONMENT=test وTEST_DATABASE_URL مطلوبان لتهيئة اتفاق أقساط قائم.
 *   لا ينشئ مسار الفاتورة الجديد اتفاق أقساط آخر ولا يعيد فوترة العلاج المغطى.
 */

const OUT = process.argv[2] ?? ".";
const BASE = process.env.JOURNEY_BASE ?? "http://127.0.0.1:3000";
const USER = process.env.JOURNEY_USER ?? "shots";
const PASS = process.env.JOURNEY_PASS ?? "shots-only-local-1234";
const target = new URL(BASE);
assert.equal(target.protocol, "http:");
assert.ok(isLoopbackHost(target.hostname), "Journey requires a local synthetic server");
assert.equal(process.env.DATABASE_ENVIRONMENT, "test", "Use an explicitly isolated test database");
const database = validateLocalVerificationTarget(process.env.TEST_DATABASE_URL, process.env, { varName: "TEST_DATABASE_URL" });
assert.ok(["/aqlan_p1_test", "/aqlan_sec_http"].includes(database.pathname), "Only the isolated verification databases are allowed");
const db = new Client({ connectionString: database.toString(), ssl: false });
await db.connect();
assert.equal(Math.floor(Number((await db.query("SHOW server_version_num")).rows[0].server_version_num) / 10000), 18);
const chromium = await loadChromium();

const b = await chromium.launch({ executablePath });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[خطأ صفحة]", String(e).slice(0, 160)));
const type = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay: 16 }); };

try {
await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await type(page.locator("#username"), USER);
await type(page.locator("#password"), PASS);
await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });
await page.waitForTimeout(4000);

// ١) مريضٌ مسجَّل — الخطة اتفاقٌ على ملف، لا على اسمٍ عابر
const stamp = Date.now().toString().slice(-6);
const name = "مريض الخطة " + stamp.slice(-5);
const phone = "77" + stamp.padStart(7, "0");
await page.goto(BASE + "/patients", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "+ مريض جديد" }).click();
await page.waitForTimeout(1200);
await type(page.getByLabel("الاسم الكامل"), name);
await type(page.getByLabel("رقم الجوال"), phone);
await page.waitForFunction(() => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("احفظ وافتح الملف"));
  return button && !button.disabled;
});
await page.getByRole("button", { name: /احفظ وافتح الملف/ }).click();
await page.waitForURL(/\/patients\/\d+/, { timeout: 20000 });
await page.waitForTimeout(3000);
console.log("1) أُنشئ ملف المريض");
console.log("2) فُتح ملف المريض");

// ٢) مسار واحد من الخطط إلى الفاتورة؛ الخدمة المالية وحدها لا تختلق بند علاج.
const patientId = Number(new URL(page.url()).pathname.split("/").at(-1));
const patient = (await db.query("SELECT full_name FROM patients WHERE id = $1", [patientId])).rows[0];
assert.equal(patient?.full_name, name, "The browser and isolated database must identify the same newly created synthetic patient");
const doctor = (await db.query("SELECT id FROM parties WHERE kind = 'doctor' AND is_active ORDER BY id LIMIT 1")).rows[0];
assert.ok(doctor, "The isolated fixture needs an active doctor");
const filling = (await db.query(`INSERT INTO services (name, category, price_minor, price_configured, is_active)
  VALUES ($1, 'filling', 10000, TRUE, TRUE) RETURNING id`, [`حشوة رحلة موحدة ${stamp}`])).rows[0].id;
const consultation = (await db.query(`INSERT INTO services (name, category, price_minor, price_configured, is_active)
  VALUES ($1, 'consultation', 5000, TRUE, TRUE) RETURNING id`, [`كشف رحلة موحدة ${stamp}`])).rows[0].id;
await page.goto(`${BASE}/patients/${patientId}?tab=plans`, { waitUntil: "domcontentloaded" });
await page.getByTestId("plans-open-treatment-entry").click();
await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
await page.screenshot({ path: OUT + "/plan-1-empty.png", fullPage: true });
const first = page.getByTestId("invoice-row-0");
await first.getByLabel("الخدمة", { exact: true }).selectOption(String(filling));
await page.getByTestId("invoice-provider-0").selectOption(String(doctor.id));
await page.getByTestId("invoice-tooth-button-0").click();
const teeth = page.getByTestId("tooth-dialog");
await teeth.getByTestId("odontogram-tooth-16").click();
await teeth.getByTestId("surface-M").click();
await teeth.getByTestId("surface-O").click();
await page.getByTestId("tooth-dialog-confirm").click();
await page.getByRole("button", { name: "+ بند آخر", exact: true }).click();
await page.getByTestId("invoice-row-1").getByLabel("الخدمة", { exact: true }).selectOption(String(consultation));
await page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]').waitFor();
const invoiceResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).click();
const issued = await invoiceResponse;
assert.equal(issued.status(), 201);
const invoice = await issued.json();
const item = invoice.clinical.links.find(link => link.kind === "clinical");
assert.ok(item?.planItemId);
assert.equal(invoice.clinical.links.filter(link => link.kind === "clinical").length, 1);
assert.equal((await db.query("SELECT id FROM invoices WHERE patient_id = $1", [patientId])).rows.length, 1);
assert.equal((await db.query("SELECT id FROM invoice_items WHERE invoice_id = $1", [invoice.id])).rows.length, 2);
assert.deepEqual((await db.query("SELECT consent_at FROM treatment_plans WHERE id = $1", [invoice.clinical.planId])).rows, [{ consent_at: null }]);
await page.getByTestId("invoice-clinical-notice").waitFor();
await page.goto(`${BASE}/patients/${patientId}?tab=plans`, { waitUntil: "domcontentloaded" });
await page.getByText(/سن 16/).first().waitFor();
assert.match(await page.locator("body").innerText(), /MO/);
await page.screenshot({ path: OUT + "/plan-2-items.png", fullPage: true });
console.log("3–4) فاتورة واحدة؛ حشوة 16 (MO) مرتبطة بالخطة وكشف مالي بلا بند سريري مصطنع");

// ٤) الموافقة تُقفل الاتفاق
await page.getByRole("button", { name: /سجّل موافقة المريض/ }).click();
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "سجّل الموافقة" }).click();
await page.waitForTimeout(3000);
const consented = await page.locator("body").innerText();
assert.match(consented, /وافق المريض في/);
console.log("5) الموافقة السريرية مسجّلة صراحةً");
console.log("   وأُقفلت البنود:", (await page.getByRole("button", { name: "+ أضف" }).count()) === 0 ? "✓" : "ما زالت مفتوحة");
await page.screenshot({ path: OUT + "/plan-3-consented.png", fullPage: true });

// ٥) المخطط السني يُظهر البنود مخطَّطة
await page.goto(`${BASE}/patients/${patientId}?tab=chart`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const chart = await page.locator("body").innerText();
assert.match(chart, /مخطَّط|مخطط/);
console.log("6) المخطط يعرض العمل المخطط");
await page.screenshot({ path: OUT + "/plan-4-chart.png", fullPage: true });

// ٦) زيارة تنفّذ بندًا من الخطة
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await type(page.getByLabel("اسم المريض"), name);
// Select the actual existing file; typing its name alone creates an unlinked arrival.
await page.getByRole("button", { name: new RegExp(name) }).click();
const arrivalResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/visits"
  && response.request().method() === "POST");
await page.getByRole("button", { name: "وصل", exact: true }).click();
const arrival = await arrivalResponse;
assert.equal(arrival.status(), 201);
assert.equal(arrival.request().postDataJSON().patientId, patientId);
const arrived = await arrival.json();
assert.equal(arrived.patientId, patientId);
await page.getByRole("dialog", { name: "لوحة الوصول", exact: true }).getByRole("button", { name: "إغلاق", exact: true }).click();
const waitingRow = page.getByRole("region", { name: "قائمة الانتظار", exact: true }).getByRole("listitem")
  .filter({ has: page.locator(`a[href="/patients/${patientId}"]`) });
assert.equal(await waitingRow.count(), 1);
await waitingRow.locator("summary").click();
const clearedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/visits/${arrived.id}`
  && response.request().method() === "PATCH" && response.request().postDataJSON()?.action === "clear");
await waitingRow.getByRole("button", { name: "أقِرّ الجاهزية", exact: true }).click();
assert.equal((await clearedResponse).status(), 200);
const calledResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/visits/${arrived.id}`
  && response.request().method() === "PATCH" && response.request().postDataJSON()?.action === "call");
await waitingRow.locator("button:not([disabled])").filter({ hasText: /نادِ · كرسي/ }).first().click();
assert.equal((await calledResponse).status(), 200);
const calledRow = page.getByRole("region", { name: "نُودي عليهم", exact: true }).getByRole("listitem")
  .filter({ has: page.getByText(name, { exact: true }) });
const seatedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/visits/${arrived.id}`
  && response.request().method() === "PATCH" && response.request().postDataJSON()?.action === "seat");
await calledRow.getByRole("button", { name: "دخل الكرسي", exact: true }).click();
assert.equal((await seatedResponse).status(), 200);
const visit = (await db.query("SELECT id FROM visits WHERE patient_id = $1 AND status = 'in_chair' ORDER BY id DESC LIMIT 1", [patientId])).rows[0];
assert.equal(visit?.id, arrived.id, "The selected synthetic patient's exact visit must be seated through the native queue");
await page.goto(`${BASE}/patients/${patientId}?tab=today`, { waitUntil: "domcontentloaded" });
await page.getByLabel("الطبيب المعالج", { exact: false }).selectOption(String(doctor.id));
await type(page.getByRole("textbox", { name: /التشخيص/ }), "تسوّس الرحى الأولى");
await type(page.getByRole("textbox", { name: /ما نُفّذ/ }), "حشوة ضوئية");
await page.getByTestId(`planned-item-${item.planItemId}`).getByRole("button", { name: "+ نفّذ اليوم", exact: true }).click();
const savedClinical = page.waitForResponse(response => new URL(response.url()).pathname === `/api/visits/${visit.id}/clinical`
  && response.request().method() === "POST" && response.request().postDataJSON()?.action !== "sign");
await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
assert.equal((await savedClinical).status(), 200);
await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
const review = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
await review.getByRole("button", { name: /وقّع الزيارة — دون استحقاق إضافي/ }).waitFor();
await page.screenshot({ path: OUT + "/plan-5-visit.png", fullPage: true });
const signedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/visits/${visit.id}/clinical`
  && response.request().method() === "POST" && response.request().postDataJSON()?.action === "sign");
await review.getByRole("button", { name: /وقّع الزيارة — دون استحقاق إضافي/ }).click();
const signed = await signedResponse;
assert.equal(signed.status(), 200);
const signedBody = await signed.json();
assert.equal(signedBody.invoiceId, null);
assert.equal(signedBody.duesMinor, 0);
assert.equal((await db.query("SELECT id FROM invoices WHERE patient_id = $1", [patientId])).rows.length, 1);
console.log("7) نُفّذ بند الفاتورة نفسه بلا استحقاق أو فاتورة ثانية");

// ٧) الكشف المالي لم يُحسب بند علاج؛ الحشوة الوحيدة صارت منفّذة.
await page.goto(`${BASE}/patients/${patientId}?tab=plans`, { waitUntil: "domcontentloaded" });
await page.getByText(/أُنجز 1 من 1/).waitFor();
assert.deepEqual((await db.query("SELECT status FROM plan_items WHERE id = $1", [item.planItemId])).rows, [{ status: "done" }]);
assert.equal(await page.getByRole("button", { name: "تحصيل قسط", exact: true }).count(), 0);
await page.screenshot({ path: OUT + "/plan-6-done.png", fullPage: true });
console.log("8) أُنجز 1 من 1؛ الفاتورة الأصلية وحدها محفوظة");

// ٨) اتفاق أقساط قائم اصطناعيًا: اختبار الحفظ والتحصيل القديم، لا مسار إنشاء جديد.
const agreement = (await db.query(`INSERT INTO treatment_plans
  (patient_id, title, total_minor, base_currency, billing_mode, total_from_items, start_date, created_by)
  VALUES ($1, 'اتفاق أقساط قائم — رحلة محلية', 600000, 'YER', 'installments', FALSE, CURRENT_DATE, 'local-journey-fixture') RETURNING id`, [patientId])).rows[0].id;
await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
  VALUES ($1, 1, CURRENT_DATE, 200000), ($1, 2, CURRENT_DATE + 30, 200000), ($1, 3, CURRENT_DATE + 60, 200000)`, [agreement]);
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "تحصيل قسط", exact: true }).waitFor();
assert.equal(await page.getByRole("button", { name: "تحصيل قسط", exact: true }).count(), 1);
const financial = await page.locator("body").innerText();
assert.match(financial, /المدفوع/); assert.match(financial, /الباقي/); assert.match(financial, /جدول الأقساط/);
assert.equal((await db.query("SELECT id FROM invoices WHERE patient_id = $1", [patientId])).rows.length, 1);
assert.equal((await db.query("SELECT id FROM payments WHERE patient_id = $1", [patientId])).rows.length, 0);
await page.screenshot({ path: OUT + "/plan-7-financial.png", fullPage: true });
console.log("9) الاتفاق القائم يحتفظ بالجدول والتحصيل؛ العلاج المفوتر لا يعرض تحصيل قسط");
} catch (error) {
  await page.screenshot({ path: OUT + "/plan-failure.png", fullPage: true });
  throw error;
} finally {
  await b.close();
  await db.end();
}
