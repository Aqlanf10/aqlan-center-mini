import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, clinicDateString } from "../../lib/schedule";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { authedGet, baseUrl, harness, type Session } from "./_server";

// Hosted built-app acceptance only. Never run against production: the harness
// owns aqlan_sec_http. No response mocks, external messages, or financial writes.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
let doctorId: number, doctorName: string, today: string;
const poll = { timeout: 15_000 };
beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctor = (await db.query<{ id: number; name: string }>(
    "SELECT p.id,p.name FROM parties p JOIN users u ON u.party_id=p.id WHERE u.username='secdoctora'",
  )).rows[0];
  doctorId = doctor.id; doctorName = doctor.name;
  const workflow = await authedGet(`/api/patients/${h.seeded.patientAId}/workflow`, h.sessions.admin);
  expect(workflow.status).toBe(200);
  today = clinicDateString(new Date(), (await workflow.json() as { timeZone: string }).timeZone);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

async function contextFor(session: Session) {
  const context = await browser.newContext({ locale: "ar-YE", viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const [name, ...value] = session.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  return context;
}

describe("current responsibility and intentional nearby return booking — hosted browser", () => {
  it("saves an actual adjustment, retains a cancelled booking draft, confirms one extra appointment and shows it in the responsible doctor's personal schedule", async () => {
    const number = `SYN-RETURN-BROWSER-${randomUUID()}`, name = "مريض متابعة اصطناعي " + number.slice(-8);
    const patientId = (await db.query<{ id: number }>(`INSERT INTO patients
      (patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id`, [number, name, doctorId])).rows[0].id;
    const caseId = (await db.query<{ id: number }>(`INSERT INTO ortho_cases
      (patient_id,start_date,created_by,responsible_doctor_id) VALUES($1,$2,'secadmin',$3) RETURNING id`, [patientId, today, doctorId])).rows[0].id;
    await db.query(`INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,ortho_case_id,created_by)
      VALUES($1,'orthodontics','حالة متابعة اصطناعية',$2,$3,'secadmin')`, [patientId, doctorId, caseId]);
    // Isolated distant day avoids other suites' real availability fixtures.
    const date = addDays(today, 1103);
    const oldId = (await db.query<{ id: number }>(`INSERT INTO appointments
      (patient_id,scheduled_date,scheduled_time,duration_minutes,status,doctor_id)
      VALUES($1,$2,'16:00',15,'booked',$3) RETURNING id`, [patientId, date, doctorId])).rows[0].id;
    const context = await contextFor(h.sessions.admin), unexpected: string[] = [];
    const writes: { path: string; body: Record<string, unknown>; status: number }[] = [];
    let allowed: "adjustment" | "warning" | "confirm" | null = null;
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== baseUrl) { unexpected.push(`external ${method} ${url.origin}`); await route.abort(); return; }
      if (["GET", "HEAD", "OPTIONS"].includes(method)) { await route.continue(); return; }
      const admission = allowed; allowed = null;
      const body = request.postDataJSON() as Record<string, unknown>;
      const adjustment = admission === "adjustment" && url.pathname === `/api/ortho/${caseId}`;
      const booking = (admission === "warning" || admission === "confirm") && url.pathname === "/api/appointments" && body.patientId === patientId;
      if (method !== "POST" || url.search || (!adjustment && !booking)) {
        unexpected.push(`mutation ${method} ${url.pathname}`); await route.abort(); return;
      }
      if (booking) {
        expect(body).toMatchObject({ date, time: "17:00", appointmentType: "follow_up", durationMinutes: 15 });
        expect(body).not.toHaveProperty("doctorId");
        expect(body.returnBookingFingerprint).toMatch(/^[a-f0-9]{64}$/);
        if (admission === "confirm") expect(typeof body.nearbyAppointmentConfirmation).toBe("string");
        else expect(body).not.toHaveProperty("nearbyAppointmentConfirmation");
      }
      const response = await route.fetch();
      writes.push({ path: url.pathname, body, status: response.status() });
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    await guard.run(async () => {
      expect((await page.goto(`${baseUrl}/patients/${patientId}?tab=ortho`, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
      await page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن" }).click();
      await page.getByLabel("ما نُفّذ في الشدّة").fill("مراجعة اصطناعية دون تغيير الأسلاك");
      allowed = "adjustment";
      await page.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
      await expect.poll(() => writes[0]?.status, poll).toBe(201);
      await page.getByText("📅 الجلسة القادمة المقترحة", { exact: true }).waitFor();
      await expect.poll(() => page.getByRole("region", { name: "الطبيب المسؤول عن موعد المراجعة" }).innerText(), poll).toContain(doctorName);
      await page.getByRole("button", { name: "📅 حجز الموعد المقترح الآن", exact: true }).click();
      await page.getByLabel("تاريخ الجلسة القادمة").fill(date);
      await page.getByLabel("وقت الجلسة القادمة").fill("17:00");
      allowed = "warning";
      await page.getByRole("button", { name: "أكّد الحجز", exact: true }).click();
      const warning = page.getByRole("dialog", { name: "للمريض موعد قائم قريب" });
      await warning.waitFor();
      expect(await warning.innerText()).toContain(doctorName);
      await warning.getByRole("button", { name: "إلغاء الحجز الجديد", exact: true }).click();
      await expect.poll(() => page.getByRole("button", { name: "أكّد الحجز", exact: true }).isEnabled(), poll).toBe(true);
      expect(await page.getByLabel("تاريخ الجلسة القادمة").inputValue()).toBe(date);
      expect(await page.getByLabel("وقت الجلسة القادمة").inputValue()).toBe("17:00");
      expect((await db.query("SELECT id FROM appointments WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: oldId }]);
      allowed = "warning";
      await page.getByRole("button", { name: "أكّد الحجز", exact: true }).click();
      await warning.waitFor();
      allowed = "confirm";
      await warning.getByRole("button", { name: "تأكيد موعد إضافي مقصود", exact: true }).click();
      await page.getByText("تم حجز الجلسة القادمة بنجاح", { exact: true }).waitFor();
      await page.getByText(`الطبيب: ${doctorName}`, { exact: true }).waitFor();
      expect(writes.map(row => row.status)).toEqual([201, 409, 409, 201]);
      expect(writes[3].body.returnBookingSource).toEqual({ kind: "ortho_adjustment", id: (await db.query("SELECT id FROM ortho_adjustments WHERE case_id=$1", [caseId])).rows[0].id });
    }, () => expect(unexpected).toEqual([]));
    const rows = (await db.query<{ id: number; doctor_id: number; time: string }>(
      "SELECT id,doctor_id,to_char(scheduled_time,'HH24:MI') AS time FROM appointments WHERE patient_id=$1 ORDER BY id", [patientId],
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ doctor_id: doctorId, time: "17:00" });
    const doctorContext = await contextFor(h.sessions.doctorA), doctorUnexpected: string[] = [];
    const doctorGuard = await guardBrowserRoutes(doctorContext, baseUrl, doctorUnexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        doctorUnexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
      }
      await route.continue();
    });
    await doctorGuard.run(async () => {
      const doctorPage = await doctorContext.newPage();
      expect((await doctorPage.goto(`${baseUrl}/my-work`, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
      await doctorPage.getByLabel("تاريخ جدول المواعيد").fill(date);
      const schedule = doctorPage.getByRole("region", { name: "جدول مواعيدي" });
      await expect.poll(() => schedule.innerText(), poll).toContain(name);
      await expect.poll(() => schedule.innerText(), poll).toContain("17:00");
      const mine = await authedGet(`/api/appointments/mine?date=${date}`, h.sessions.doctorA);
      expect(mine.status).toBe(200);
      expect((await mine.json() as { appointments: { appointmentId: number }[] }).appointments.some(row => row.appointmentId === rows[1].id)).toBe(true);
    }, () => expect(doctorUnexpected).toEqual([]));
  });
});
