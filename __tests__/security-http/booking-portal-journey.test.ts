import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { seedAdvisoryDuty } from "../helpers/advisory-duty-fixture";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let doctorId: number;
let otherDoctor: number;
let serviceId: number;
let date: string;
let duty: Awaited<ReturnType<typeof seedAdvisoryDuty>>;
let duty2: Awaited<ReturnType<typeof seedAdvisoryDuty>>;
const evidence = join(process.cwd(), "docs/review/booking-portal/evidence");
const post = (body: unknown, key: string) => fetch(`${baseUrl}/api/book`, { method: "POST",
  headers: { "Content-Type": "application/json", Origin: baseUrl, "Idempotency-Key": key }, body: JSON.stringify(body) });
const input = (phone: string, time = "10:00") => ({ fullName: "مريض بوابة اصطناعي", phone, preferredDate: date,
  preferences: { serviceId, doctorId, time } });
const confirm = (id: number, extra: Record<string, unknown> = {}, role = h.sessions.reception) => authedMutation(`/api/booking-requests/${id}`, role, "PATCH",
  JSON.stringify({ action: "confirm", date, time: "10:00", durationMinutes: 30, serviceId, doctorId, ...extra }));
async function savedId(phone: string) {
  return (await db.query("SELECT id FROM booking_requests WHERE phone=$1 ORDER BY id DESC", [`967${phone}`])).rows[0]?.id as number;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctors = (await db.query("SELECT username,party_id FROM users WHERE username IN ('secdoctora','secdoctorb') ORDER BY username")).rows;
  doctorId = doctors[0].party_id; otherDoctor = doctors[1].party_id;
  date = (await db.query("SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date+20)::text AS date")).rows[0].date;
  duty = await seedAdvisoryDuty(db, doctorId, date, date);
  duty2 = await seedAdvisoryDuty(db, otherDoctor, date, date);
  serviceId = (await db.query(`INSERT INTO appointment_services(code,name_ar,specialty,default_duration_minutes,requires_provider,requires_chair)
    VALUES('SYNTHETIC_PORTAL','خدمة بوابة اصطناعية','general',30,true,true) RETURNING id`)).rows[0].id;
  mkdirSync(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => {
  await browser?.close();
  if (db) {
    await db.query("DELETE FROM booking_requests WHERE phone LIKE '%777841%' OR preferences->>'serviceId'=$1 OR appointment_id IN (SELECT id FROM appointments WHERE service_id=$2)", [String(serviceId), serviceId]);
    await db.query("DELETE FROM appointments WHERE service_id=$1 OR note='SYNTHETIC_INTERNAL_RECEPTION_NOTE'", [serviceId]);
    await db.query("DELETE FROM clinical_cases WHERE title='حالة جذور اصطناعية' AND patient_id=$1", [h.seeded.patientAId]);
    await db.query("DELETE FROM patients WHERE phone LIKE '%777841%' OR patient_number IN ('SYNTH-PHONE-A','SYNTH-PHONE-B')");
    await db.query("DELETE FROM appointment_services WHERE id=$1", [serviceId]);
  }
  await duty?.cleanup(); await duty2?.cleanup(); await db?.end();
});

it("allows only the public availability DTO and verifies role boundaries", async () => {
  const catalog = await (await fetch(`${baseUrl}/api/book`)).json();
  expect(Object.keys(catalog).sort()).toEqual(["days", "doctors", "services", "timeZone", "today"]);
  const response = await fetch(`${baseUrl}/api/book?date=${date}&doctorId=${doctorId}&serviceId=${serviceId}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.times).toContain("10:00");
  expect(JSON.stringify(body)).not.toMatch(/patient|phone|salary|staffId|Private synthetic|reason|note/);
  expect(body).toMatchObject({ bookingGuaranteed: false, timeZone: "Asia/Aden" });
  expect((await fetch(`${baseUrl}/api/booking-requests/1`)).status).toBe(401);
  expect((await authedGet("/api/booking-requests/1", h.sessions.doctorA)).status).toBe(403);
  expect((await authedGet("/api/booking-requests/1", h.sessions.cashier)).status).toBe(403);
});

it("deduplicates concurrent HTTP requests and a retry after staff confirmation", async () => {
  const body = input("777841001");
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(body, "synthetic-http-retry-1")));
  expect(responses.map(row => row.status)).toEqual(Array(8).fill(201));
  expect((await db.query("SELECT count(*)::int n FROM booking_requests WHERE phone='967777841001'")).rows[0].n).toBe(1);
  const id = await savedId("777841001");
  const confirmed = await confirm(id);
  expect(confirmed.status).toBe(201);
  const receipt = await confirmed.json();
  const replay = await confirm(id);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ appointmentId: receipt.appointmentId, scheduledDate: date, scheduledTime: "10:00", replayed: true });
  expect((await post(body, "synthetic-http-retry-1")).status).toBe(201);
  expect((await post({ ...body, reason: "changed" }, "synthetic-http-retry-1")).status).toBe(409);
  expect((await db.query("SELECT count(*)::int n FROM appointments WHERE patient_id=$1", [receipt.patientId])).rows[0].n).toBe(1);
});

it("rejects forged closed times and stale slots, and admits just one competing doctor booking", async () => {
  expect((await post(input("777841002", "08:00"), "synthetic-http-closed-1")).status).toBe(409);
  expect((await post(input("777841002", "10:00"), "synthetic-http-stale-1")).status).toBe(409);
  await post(input("777841003", "11:00"), "synthetic-http-race-1");
  await post(input("777841004", "11:00"), "synthetic-http-race-2");
  const ids = [await savedId("777841003"), await savedId("777841004")];
  const results = await Promise.all(ids.map(id => confirm(id, { time: "11:00", chairNo: 1 })));
  expect(results.map(response => response.status).sort()).toEqual([201, 409]);
  const rows = (await db.query("SELECT service_id,doctor_id,chair_no FROM appointments WHERE scheduled_date=$1 AND scheduled_time='11:00'", [date])).rows;
  expect(rows).toEqual([{ service_id: serviceId, doctor_id: doctorId, chair_no: 1 }]);
  const pending = ids[results.findIndex(response => response.status === 409)];
  expect((await confirm(pending, { time: "08:00", overrideReason: "synthetic authorized override" }, h.sessions.admin)).status).toBe(409);
});

it("uses case responsibility across specialties, rejects stale owner and warns without blocking distinct visits", async () => {
  const patient = h.seeded.patientAId;
  const existingPhone = (await db.query("SELECT phone FROM patients WHERE id=$1", [patient])).rows[0].phone;
  // A staff-reviewed legacy request can carry no public selection; confirmation supplies it.
  const requestId = (await db.query("INSERT INTO booking_requests(full_name,phone,preferred_date) VALUES('Synthetic followup',$1,$2) RETURNING id", [existingPhone, date])).rows[0].id;
  const caseId = (await db.query(`INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by)
    VALUES($1,'endodontics','حالة جذور اصطناعية',$2,'synthetic') RETURNING id`, [patient, otherDoctor])).rows[0].id;
  expect((await confirm(requestId, { time: "12:00", caseId, doctorId })).status).toBe(409);
  const response = await confirm(requestId, { time: "12:00", caseId, doctorId: otherDoctor });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ doctorId: otherDoctor });
  const second = (await db.query("INSERT INTO booking_requests(full_name,phone,preferred_date) VALUES('Synthetic second visit',$1,$2) RETURNING id", [existingPhone, date])).rows[0].id;
  const review = await (await authedGet(`/api/booking-requests/${second}?date=${date}`, h.sessions.reception)).json();
  expect(review.nearby).toHaveLength(1);
  expect((await confirm(second, { time: "12:30", doctorId: otherDoctor })).status).toBe(201);
  expect((await db.query("SELECT responsible_party_id FROM clinical_cases WHERE id=$1", [caseId])).rows[0].responsible_party_id).toBe(otherDoctor);
});

it("requires an explicit patient choice for a shared phone and never grants portal staff rights", async () => {
  const phone = "777841007";
  const patients = (await db.query(`INSERT INTO patients(patient_number,full_name,phone) VALUES
    ('SYNTH-PHONE-A','اصطناعي ألف',$1),('SYNTH-PHONE-B','اصطناعي باء',$1) RETURNING id`, [phone])).rows;
  const id = (await db.query("INSERT INTO booking_requests(full_name,phone) VALUES('Synthetic shared phone',$1) RETURNING id", [`967${phone}`])).rows[0].id;
  expect((await confirm(id, { time: "09:00" })).status).toBe(409);
  expect((await confirm(id, { time: "09:00" }, h.sessions.portalA)).status).toBe(401);
  expect((await confirm(id, { time: "09:00", patientId: patients[1].id })).status).toBe(201);
  expect((await db.query("SELECT patient_id FROM appointments WHERE id=(SELECT appointment_id FROM booking_requests WHERE id=$1)", [id])).rows[0].patient_id).toBe(patients[1].id);
});

for (const width of [390, 1440]) describe(`public Arabic request at ${width}px`, () => {
  it("reviews and goes back, survives a lost response and double submission without duplication", async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "America/Los_Angeles" });
    // No external messages or real data: all network navigation stays local.
    const page = await context.newPage();
    const phone = width === 390 ? "777841008" : "777841009";
    try {
      await page.goto(`${baseUrl}/book`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("الخدمة").selectOption(String(serviceId));
      await page.getByLabel("الطبيب").selectOption(String(doctorId));
      await page.getByLabel("اليوم").selectOption(date);
      await page.getByRole("button", { name: "09:30", exact: true }).click();
      await page.getByRole("button", { name: "متابعة", exact: true }).click();
      await page.getByLabel("الاسم الكامل").fill("مريض رحلة اصطناعي");
      await page.getByLabel("رقم الجوال").fill(phone);
      await page.getByRole("button", { name: "متابعة", exact: true }).click();
      await page.getByRole("button", { name: "رجوع", exact: true }).click();
      expect(await page.getByLabel("رقم الجوال").inputValue()).toBe(phone);
      await page.getByRole("button", { name: "متابعة", exact: true }).click();
      expect(await page.locator('main[dir="rtl"]').count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: join(evidence, `public-review-${width}.png`), fullPage: true });
      let sent = 0; const keys: string[] = [];
      await page.route("**/api/book", async route => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        sent++; keys.push(route.request().headers()["idempotency-key"]);
        if (sent === 1) { await route.fetch(); await new Promise(resolve => setTimeout(resolve, 500)); await route.abort("connectionreset"); }
        else if (sent === 2) await route.fulfill({ status: 429, json: { message: "طلبات كثيرة. أعد المحاولة بعد قليل." } });
        else await route.continue();
      });
      await page.getByRole("button", { name: "أرسل طلب الموعد", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect.poll(() => page.getByRole("button", { name: "إعادة الإرسال للتحقق", exact: true }).count()).toBe(1);
      expect(sent).toBe(1);
      await page.screenshot({ path: join(evidence, `public-response-loss-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "إعادة الإرسال للتحقق", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "طلبات كثيرة. أعد المحاولة بعد قليل." }).waitFor();
      // A rejected retry cannot establish that the first, lost response did not commit.
      expect(await page.getByRole("button", { name: "رجوع", exact: true }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "إعادة الإرسال للتحقق", exact: true }).click();
      await expect.poll(() => page.getByRole("heading", { name: "وصلنا طلبكم", exact: true }).count()).toBe(1);
      expect(keys).toHaveLength(3); expect(new Set(keys).size).toBe(1);
      expect((await db.query("SELECT count(*)::int n FROM booking_requests WHERE phone=$1", [`967${phone}`])).rows[0].n).toBe(1);
      await page.screenshot({ path: join(evidence, `public-received-${width}.png`), fullPage: true });
    } catch (error) {
      await page.screenshot({ path: join(evidence, `failure-${width}.png`), fullPage: true });
      console.log("Synthetic booking browser page:", await page.locator("body").innerText());
      throw error;
    } finally { await context.close(); }
  }, 120_000);
});

it("reflects configured weekday changes immediately without a Friday hardcode", async () => {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const previous = (await db.query("SELECT value FROM settings WHERE key='clinic.working_days'")).rows[0]?.value;
  try {
    await db.query(`INSERT INTO settings(key,value) VALUES('clinic.working_days',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [[0,1,2,3,4,5,6].filter(day => day !== weekday).join(",")]);
    expect((await (await fetch(`${baseUrl}/api/book`)).json()).days).not.toContain(date);
    expect((await fetch(`${baseUrl}/api/book?date=${date}&doctorId=${doctorId}&serviceId=${serviceId}`)).status).toBe(400);
    await db.query("UPDATE settings SET value='5' WHERE key='clinic.working_days'");
    const fridayOnly = await (await fetch(`${baseUrl}/api/book`)).json();
    expect(fridayOnly.days.length).toBeGreaterThan(0);
    expect(fridayOnly.days.every((day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() === 5)).toBe(true);
  } finally {
    if (previous === undefined) await db.query("DELETE FROM settings WHERE key='clinic.working_days'");
    else await db.query("UPDATE settings SET value=$1 WHERE key='clinic.working_days'", [previous]);
  }
});

it("revokes a copied patient cookie on logout and keeps a fresh login independent", async () => {
  const { loginPortal, TEST_PATIENTS } = await import("./_server");
  const patient = TEST_PATIENTS.patientA;
  const session = await loginPortal(patient.phone, patient.patientNumber);
  expect((await authedGet("/api/portal/me", session)).status).toBe(200);
  expect((await authedGet("/api/portal/me", { ...session, cookie: `${session.cookie}.extra` })).status).toBe(401);
  const out = await authedMutation("/api/portal/logout", session, "POST", "{}");
  expect(out.status).toBe(200);
  expect((await authedGet("/api/portal/me", session)).status).toBe(401);
  const fresh = await loginPortal(patient.phone, patient.patientNumber);
  expect((await authedGet("/api/portal/me", fresh)).status).toBe(200);
  const fingerprint = createHash("sha256").update(session.cookie.slice(session.cookie.indexOf("=") + 1)).digest("hex");
  const audit = (await db.query("SELECT entity_id,details FROM audit_log WHERE action='portal.session_revoked' AND entity_id=$1", [fingerprint])).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0].entity_id).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(audit)).not.toContain(session.cookie.split("=")[1]);
});

for (const width of [390, 1440]) it(`reception confirms the synthetic request at ${width}px and WhatsApp uses persisted time`, async () => {
  const { friendlyDate, friendlyTime } = await import("../../lib/reminders");
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const phone = width === 390 ? "777841008" : "777841009";
  const time = width === 390 ? "09:30" : "12:30";
  try {
    await page.goto(`${baseUrl}/requests`, { waitUntil: "domcontentloaded" });
    const card = page.getByRole("listitem").filter({ hasText: `967${phone}` });
    await card.getByRole("button", { name: "حدّد موعدًا" }).click();
    expect(await card.getByLabel("خدمة الموعد").inputValue()).toBe(String(serviceId));
    expect(await card.getByLabel("طبيب الموعد").inputValue()).toBe(String(doctorId));
    await card.locator('input[type="time"]').fill(time);
    await expect.poll(() => card.getByRole("button", { name: "تأكيد الحجز", exact: true }).isEnabled()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await card.screenshot({ path: join(evidence, `reception-review-${width}.png`) });
    await card.getByRole("button", { name: "تأكيد الحجز", exact: true }).click();
    const link = page.locator('a[href^="https://wa.me/"]');
    await link.waitFor();
    const url = new URL((await link.getAttribute("href"))!);
    const persisted = (await db.query(`SELECT a.scheduled_date::text AS date,a.scheduled_time::text AS time,a.service_id,a.doctor_id
      FROM appointments a JOIN booking_requests r ON r.appointment_id=a.id WHERE r.phone=$1`, [`967${phone}`])).rows[0];
    expect(persisted).toMatchObject({ date, time: `${time}:00`, service_id: serviceId, doctor_id: doctorId });
    expect(url.searchParams.get("text")).toContain(`${friendlyDate(persisted.date)} الساعة ${friendlyTime(persisted.time)}`);
    // Read the prepared link only. Never navigate to WhatsApp or send a message.
    await page.screenshot({ path: join(evidence, `reception-confirmed-${width}.png`), fullPage: false });
  } finally { await context.close(); }
}, 120_000);

it("keeps internal appointment notes out of authenticated patient HTTP responses", async () => {
  await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,note) VALUES($1,$2::date+1,'10:00',30,'SYNTHETIC_INTERNAL_RECEPTION_NOTE')", [h.seeded.patientAId, date]);
  const response = await authedGet("/api/portal/appointments", h.sessions.portalA);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("SYNTHETIC_INTERNAL_RECEPTION_NOTE");
});

for (const width of [390, 1440]) it(`shows loading, unavailable and retry states at ${width}px`, async () => {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  const page = await context.newPage();
  let mode: "failure" | "empty" | "live" = "failure";
  try {
    await page.route("**/api/book?*", async route => {
      await new Promise(resolve => setTimeout(resolve, 400));
      if (mode === "failure") await route.fulfill({ status: 503, json: { message: "تعذّر تحميل الأوقات. أعد المحاولة." } });
      else if (mode === "empty") await route.fulfill({ json: { times: [] } });
      else await route.continue();
    });
    await page.goto(`${baseUrl}/book`);
    await page.getByLabel("الخدمة").selectOption(String(serviceId));
    await page.getByLabel("الطبيب").selectOption(String(doctorId));
    await page.getByLabel("اليوم").selectOption(date);
    await page.getByText("جارٍ التحقق من الأوقات…", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "متابعة", exact: true }).isDisabled()).toBe(true);
    await page.getByText("تعذّر تحميل الأوقات. أعد المحاولة.", { exact: true }).waitFor();
    mode = "empty";
    await page.getByRole("button", { name: "تحديث الأوقات", exact: true }).click();
    await page.getByText("لا توجد أوقات متاحة لهذا الطبيب في اليوم المختار.", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "متابعة", exact: true }).isDisabled()).toBe(true);
    await page.screenshot({ path: join(evidence, `public-unavailable-${width}.png`), fullPage: true });
    mode = "live";
    await page.getByRole("button", { name: "تحديث الأوقات", exact: true }).click();
    await page.getByRole("button", { name: "10:30", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await context.close(); }
}, 120_000);

it("accepts an expanded booking horizon immediately after an administrative setting change", async () => {
  const previous = (await db.query("SELECT value FROM settings WHERE key='scheduling.max_days_ahead'")).rows[0]?.value;
  try {
    await db.query("INSERT INTO settings(key,value) VALUES('scheduling.max_days_ahead','1') ON CONFLICT(key) DO UPDATE SET value='1'");
    // Warm the request validator at the short horizon, then expand it without waiting for a cache TTL.
    expect((await post({ fullName: "اصطناعي إعداد المدى", phone: "777841010" }, "synthetic-horizon-warm-1")).status).toBe(201);
    await db.query("UPDATE settings SET value='60' WHERE key='scheduling.max_days_ahead'");
    expect((await post(input("777841011", "10:30"), "synthetic-horizon-live-1")).status).toBe(201);
  } finally {
    if (previous === undefined) await db.query("DELETE FROM settings WHERE key='scheduling.max_days_ahead'");
    else await db.query("UPDATE settings SET value=$1 WHERE key='scheduling.max_days_ahead'", [previous]);
  }
});
