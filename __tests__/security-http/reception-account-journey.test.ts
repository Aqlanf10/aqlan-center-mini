import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

let browser: Browser, context: BrowserContext, db: Client, page: Page;
let patient: number, other: number, invoice: number, doctor: number;
let adminCookie: string, doctorCookie: string;
const errors: string[] = [];
const localDate = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const account = async () => {
  const result = await context.request.get(baseUrl + "/api/patients/" + patient + "?projection=reception-money");
  expect(result.status(), await result.text()).toBe(200);
  return result.json();
};

beforeAll(async () => {
  const h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  // Fresh patients keep the test independent of other HTTP suite fixtures.
  const created = await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض تجربة الاستقبال'),($2,'حساب منفصل تجريبي') RETURNING id",
    ["DESK-A-" + Date.now(), "DESK-B-" + Date.now()]);
  [patient, other] = created.rows.map(row => row.id);
  invoice = (await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency) VALUES($1,$2,100000,'YER') RETURNING id",
    ["DESK-INV-" + Date.now(), patient])).rows[0].id;
  await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency) VALUES($1,$2,9876543,'YER')", ["OTHER-" + Date.now(), other]);
  doctor = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
  context = await browser.newContext({ locale: "ar-YE", serviceWorkers: "block" });
  const [name, value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value, url: baseUrl }]);
  adminCookie = h.sessions.admin.cookie;
  doctorCookie = h.sessions.doctorA.cookie;
  await db.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [doctor, patient]);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
});
afterAll(async () => { await browser?.close(); await db?.end(); });

it("books in Chromium and persists the appointment for the selected patient", async () => {
  await page.goto(baseUrl + "/patients/" + patient + "?tab=treatment&sub=ortho");
  await page.getByRole("heading", { name: "مريض تجربة الاستقبال" }).waitFor();
  await page.getByRole("button", { name: "حجز موعد", exact: true }).click();
  let offset = 1;
  while (new Date(localDate(offset)).getUTCDay() !== 0) offset++;
  await page.getByLabel("التاريخ", { exact: true }).fill(localDate(offset));
  await page.getByLabel("الوقت", { exact: true }).fill("16:30");
  await page.getByLabel(/الطبيب المعالج/).selectOption(String(doctor));
  const confirmed = page.waitForResponse(r => r.url().endsWith("/api/appointments") && r.request().method() === "POST");
  await page.getByRole("button", { name: "تأكيد الحجز" }).click();
  const response = await confirmed;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await db.query("SELECT id FROM appointments WHERE patient_id=$1 AND doctor_id=$2 AND scheduled_date=$3", [patient, doctor, localDate(offset)])).rowCount).toBe(1);
});

it("collects only the due installment, updates the patient balance and prints one receipt", async () => {
  const url = baseUrl + "/api/patients/" + patient + "/debt-repayments";
  const targets = (await (await context.request.get(url)).json()).targets;
  const target = targets.find((t: { target: { invoiceId: number } }) => t.target.invoiceId === invoice);
  const schedule = await context.request.post(url, { headers: { Origin: baseUrl }, data: {
    invoiceId: invoice, currency: "YER", openingCurrency: null, expectedVersion: target.version,
    expectedSourceHash: target.sourceHash, expectedRemainingMinor: 100000, reason: "Synthetic acceptance",
    idempotencyKey: "desk-schedule-" + patient,
    terms: { mode: "installments", installments: [
      { dueDate: localDate(-1), amountMinor: 10000, kind: "installment" },
      { dueDate: localDate(30), amountMinor: 90000, kind: "installment" },
    ] },
  } });
  expect(schedule.status(), await schedule.text()).toBe(201);
  await page.goto(baseUrl + "/finance");
  const shift = await (await context.request.get(baseUrl + "/api/shifts")).json();
  expect(Object.keys(shift)).toEqual(["open"]);
  if (!shift.open) {
    const opened = page.waitForResponse(r => r.url().endsWith("/api/shifts") && r.request().method() === "POST");
    await page.getByRole("button", { name: "فتح الوردية" }).click();
    expect((await opened).status()).toBe(201);
  }
  await page.goto(baseUrl + "/patients/" + patient);
  const before = await account();
  expect(before.balances.find((b: {currency:string}) => b.currency === "YER")).toMatchObject({ dueMinor: 100000, scheduledDueMinor: 10000 });
  expect(JSON.stringify(before)).not.toContain("9876543");
  await page.getByRole("button", { name: "تحصيل دفعة فعلية" }).click();
  expect(await page.getByLabel("مبلغ تحصيل القسط").inputValue()).toBe("10,000");
  const booked = page.waitForResponse(r => r.url().includes("/debt-repayments/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "تأكيد التحصيل وإصدار السند" }).click();
  const payment = await booked;
  expect(payment.ok(), await payment.text()).toBe(true);
  const retry = await context.request.post(payment.url(), { headers: { Origin: baseUrl, "Idempotency-Key": payment.request().headers()["idempotency-key"] }, data: payment.request().postDataJSON() });
  expect(retry.ok(), await retry.text()).toBe(true);
  const after = await account();
  expect(after.balances.find((b: {currency:string}) => b.currency === "YER")).toMatchObject({ dueMinor: 90000, paidMinor: 10000, scheduledDueMinor: 0 });
  expect(after.receipts).toHaveLength(1);
  await page.getByText("الدفعات والسندات (1)").click();
  const print = page.waitForEvent("popup");
  await page.getByRole("link", { name: "طباعة السند", exact:true }).click();
  const receipt = await print;
  await receipt.getByText(after.receipts[0].number, { exact:true }).waitFor();
  await receipt.close();
  expect((await db.query("SELECT id FROM payments WHERE patient_id=$1 AND invoice_id=$2", [patient, invoice])).rowCount).toBe(1);
});

it("uploads an external report and denies reception all tested image and clinic-total reads", async () => {
  await page.goto(baseUrl + "/patients/" + patient);
  await page.locator('select[name=kind]').selectOption("report");
  await page.locator('input[type=file]').setInputFiles({ name:"acceptance.pdf", mimeType:"application/pdf", buffer:Buffer.from("%PDF-1.4\nsynthetic\n%%EOF") });
  const uploaded = page.waitForResponse(r => r.url().endsWith("/documents") && r.request().method() === "POST");
  await page.getByRole("button", { name: "رفع المستند", exact:true }).click();
  const response = await uploaded;
  console.info("External document upload HTTP", response.status());
  expect(response.status()).toBe(201);
  await page.getByText("رُفع المستند إلى ملف المريض.").waitFor();
  const docs = await db.query("SELECT id FROM patient_documents WHERE patient_id=$1", [patient]);
  expect(docs.rowCount).toBe(1);
  console.info("Verified stored upload");
  for (const path of ["/api/patients/" + patient, "/api/patients/" + patient + "/photo", "/api/patients/" + patient + "/documents",
    "/api/documents/" + docs.rows[0].id, "/api/payments", "/api/plans", "/api/expenses", "/api/finance/debts", "/api/finance/report", "/api/export"]) {
    const reply = await context.request.get(baseUrl + path, {timeout:10000});
    expect(reply.status(), path).toBe(403);
  }
  for (const path of ["/print/shift/1", "/reports"]) {
    expect((await context.request.get(baseUrl + path, { maxRedirects:0 })).status(), path).toBe(307);
  }
  const admin = await context.request.get(baseUrl + "/api/patients/" + patient + "/documents", { headers:{ Cookie:adminCookie } });
  expect(admin.status()).toBe(200);
  expect(JSON.stringify(await admin.json())).toContain("acceptance.pdf");
  expect(errors).toEqual([]);
});

it("keeps an existing clinical photograph visible to the treating doctor and private from reception", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5peEYAAAAASUVORK5CYII=", "base64");
  const created = await context.request.post(baseUrl + "/api/patients/" + patient + "/documents", {
    headers: { Origin: baseUrl, Cookie: adminCookie }, multipart: {
      kind: "photo", file: { name: "synthetic-clinical.png", mimeType: "image/png", buffer: png },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const url = baseUrl + "/api/documents/" + (await created.json()).id;
  const authorized = await context.request.get(url, { headers: { Cookie: doctorCookie } });
  expect(authorized.status()).toBe(200);
  expect(await authorized.body()).toEqual(png);
  for (const suffix of ["", "?download=1"]) {
    const desk = await context.request.get(url + suffix);
    expect(desk.status()).toBe(403);
    expect(desk.headers()["content-type"]).toContain("application/json");
  }
});
