import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { seedAdvisoryDuty } from "../helpers/advisory-duty-fixture";
import { baseUrl, harness } from "./_server";

// Real built page + real HTTP + synthetic PostgreSQL. Delayed responses below
// are fetched from the actual endpoint, never invented successful responses.
let browser: Browser, db: Client, h: Awaited<ReturnType<typeof harness>>;
let duty: Awaited<ReturnType<typeof seedAdvisoryDuty>>;
let doctorId: number, unknownDoctorId: number, date: string, tomorrow: string;
const bookedIds: number[] = [];
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number; date: string; tomorrow: string }>(
    `SELECT party_id,((NOW() AT TIME ZONE 'Asia/Aden')::date+47)::text AS date,
      ((NOW() AT TIME ZONE 'Asia/Aden')::date+48)::text AS tomorrow FROM users WHERE username='secdoctora'`);
  doctorId = doctor.party_id; date = doctor.date; tomorrow = doctor.tomorrow;
  unknownDoctorId = (await db.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic doctor without roster') RETURNING id")).rows[0].id;
  duty = await seedAdvisoryDuty(db, doctorId, date, tomorrow);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => {
  await browser?.close();
  if (db) {
    // Durable booking receipts retain appointment identity; release occupancy
    // without deleting their protected history. The harness drops the database.
    if (bookedIds.length) await db.query("UPDATE appointments SET status='cancelled' WHERE id=ANY($1::int[])", [bookedIds]);
    await duty?.cleanup();
    // Real booking attempts can establish immutable commission history even
    // when admission refuses. Retain that history until the harness drops its DB.
    if (unknownDoctorId) await db.query("UPDATE parties SET is_active=false WHERE id=$1 AND name='Synthetic doctor without roster'", [unknownDoctorId]);
    await db.end();
  }
});
async function open(timezoneId = "UTC", day = date): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar-YE", timezoneId });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/appointments?date=${day}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /حجز موعد جديد/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("التصنيف السريري للموعد",{exact:true}).selectOption("other");
  await dialog.locator('input[type="date"]').fill(day);
  await expect.poll(() => dialog.locator('select[id$="-doctor"] option').count()).toBeGreaterThan(1);
  return { context, page };
}
describe("qualified doctor duty suggestions in the existing reception form", () => {
  it.each(["unlinked", "ambiguous"] as const)("truthfully refuses a selected doctor with %s HR mapping without an appointment or override", async mapping => {
    let extraUser: number | undefined, extraStaff: number | undefined;
    const selectedDoctor = mapping === "unlinked" ? unknownDoctorId : doctorId;
    const counts = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM appointments WHERE patient_id=$1) AS appointments,
      (SELECT count(*)::int FROM appointment_booking_commands WHERE patient_id=$1) AS commands`, [h.seeded.patientAId])).rows[0];
    const before = await counts();
    let context: BrowserContext | undefined;
    try {
      if (mapping === "ambiguous") {
        // A second distinct staff/account claims the same doctor party. Keep
        // both real mappings intact so the actual roster resolver must refuse.
        extraUser = (await db.query(`INSERT INTO users(username,display_name,password_hash,role,party_id)
          VALUES($1,'Synthetic competing doctor','synthetic-unusable-password','doctor',$2) RETURNING id`,
        [`synthetic_roster_conflict_${Date.now()}`, doctorId])).rows[0].id;
        extraStaff = (await db.query(`INSERT INTO hr_staff(full_name,user_id,department,created_by)
          VALUES('Private synthetic competing staff',$1,'doctors','synthetic-roster-conflict') RETURNING id`, [extraUser])).rows[0].id;
      }
      const ui = await open(); context = ui.context;
      const dialog = ui.page.getByRole("dialog");
      await dialog.getByLabel("المريض", { exact: true }).fill("مريض الأمن أ");
      await dialog.getByRole("button", { name: /SECA-001/ }).click();
      await dialog.locator('select[id$="-doctor"]').selectOption(String(selectedDoctor));
      await expect.poll(() => dialog.getByText("جدول دوام الطبيب غير مؤكد. لا يمكن تأكيد الحجز قبل مراجعة ربط الطبيب بملف الموظف وجدول دوامه.").count()).toBe(1);
      expect(await dialog.getByRole("button", { name: /— مقترح$/ }).count()).toBe(0);
      const evidence = process.env.APPOINTMENTS_RX_EVIDENCE_DIR || ".settings-ui-artifacts/appointments-rx-integration";
      await mkdir(evidence, { recursive: true });
      for (const width of [390, 1280]) {
        await ui.page.setViewportSize({ width, height: 900 });
        await dialog.getByRole("region", { name: "أوقات الطبيب" }).screenshot({ path: `${evidence}/roster-${mapping}-warning-${width}.png` });
      }
      await ui.page.setViewportSize({ width: 390, height: 900 });
      await dialog.locator('input[type="time"]').fill("12:00");
      const refused = ui.page.waitForResponse(response => new URL(response.url()).pathname === "/api/appointments" && response.request().method() === "POST");
      await dialog.locator('button[type="submit"]').click();
      const response = await refused;
      expect(response.status()).toBe(409);
      const result = await response.json();
      expect(result).toMatchObject({ canOverride: false, suggestion: null,
        message: "تعذّر إثبات جدول الطبيب. راجع ربط الطبيب بالموظف وجدول دوامه قبل الحجز.",
        suggestionMessage: "راجع ربط الطبيب وجدول دوامه، ثم اختر وقتًا متاحًا." });
      expect(JSON.stringify(result)).not.toMatch(/Private synthetic|staffId|missing_mapping|ambiguous_mapping/);
      await expect.poll(() => dialog.getByRole("alert").filter({ hasText: result.message }).count()).toBeGreaterThan(0);
      expect(await dialog.getByLabel("سبب التجاوز", { exact: false }).count()).toBe(0);
      expect(await dialog.isVisible()).toBe(true);
      expect(await dialog.locator('input[type="time"]').inputValue()).toBe("12:00");
      expect(await counts()).toEqual(before);
      await dialog.screenshot({ path: `${evidence}/roster-${mapping}-390.png` });
    } finally {
      await context?.close();
      if (extraStaff) await db.query("DELETE FROM hr_staff WHERE id=$1 AND created_by='synthetic-roster-conflict'", [extraStaff]);
      if (extraUser) await db.query("DELETE FROM users WHERE id=$1 AND username LIKE 'synthetic_roster_conflict_%'", [extraUser]);
    }
  });
  it("separates unknown from known day off and keeps manual entry and Close/reopen", async () => {
    const { context, page } = await open();
    try {
      const dialog = page.getByRole("dialog"), select = dialog.locator('select[id$="-doctor"]');
      await select.selectOption(String(unknownDoctorId));
      await expect.poll(() => dialog.getByText("جدول دوام الطبيب غير مؤكد. لا يمكن تأكيد الحجز قبل مراجعة ربط الطبيب بملف الموظف وجدول دوامه.").count()).toBe(1);
      expect(await dialog.getByRole("button", { name: /— مقترح$/ }).count()).toBe(0);
      await dialog.locator('input[type="time"]').fill("12:00");
      expect(await dialog.locator('input[type="time"]').inputValue()).toBe("12:00");
      await db.query("UPDATE hr_work_schedules SET working_days=$1::jsonb WHERE id=$2", [JSON.stringify([(new Date(`${date}T00:00:00Z`).getUTCDay() + 2) % 7]), duty.scheduleId]);
      await select.selectOption(String(doctorId));
      await expect.poll(() => dialog.getByText("لا توجد أوقات مقترحة ضمن جدول الدوام وورديات المركز.").count()).toBe(1);
      expect(await dialog.getByText("جدول دوام الطبيب غير مؤكد. لا يمكن تأكيد الحجز قبل مراجعة ربط الطبيب بملف الموظف وجدول دوامه.").count()).toBe(0);
      await dialog.getByRole("button", { name: "إغلاق", exact: true }).click();
      expect(await page.getByRole("dialog").count()).toBe(0);
      await page.getByRole("button", { name: /حجز موعد جديد/ }).click();
      expect(await page.getByRole("dialog").count()).toBe(1);
    } finally {
      await db.query("UPDATE hr_work_schedules SET working_days='[0,1,2,3,4,5,6]'::jsonb WHERE id=$1", [duty.scheduleId]);
      await context.close();
    }
  });
  it("does not revive a delayed real response after doctor/date/duration changes", async () => {
    const { context, page } = await open();
    let release: (() => void) | undefined;
    let held: Promise<void> | undefined;
    let sawReal = false;
    try {
      const dialog = page.getByRole("dialog");
      const oldReply = new Promise<void>(resolve => { release = resolve; });
      let intercepted = false;
      await page.route("**/api/appointments/availability?*", async (route: Route) => {
        const params = new URL(route.request().url()).searchParams;
        if (!intercepted && params.get("doctorId") === String(doctorId)) {
          intercepted = true;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          const body = await response.json();
          expect(body).toMatchObject({ rosterStatus: "resolved", bookingGuaranteed: false });
          expect(body.slots.some((slot: { status: string }) => slot.status === "available")).toBe(true);
          sawReal = true;
          held = (async () => {
            await oldReply;
            // Aborting the old fetch may prevent delivery entirely; either way
            // it must not replace the newer unknown state with old suggestions.
            await route.fulfill({ response }).catch(error => {
              if (!/cancel|closed|handled|abort/i.test(String(error))) throw error;
            });
          })();
          await held;
        } else await route.continue();
      });
      await dialog.locator('select[id$="-doctor"]').selectOption(String(doctorId));
      await expect.poll(() => sawReal).toBe(true);
      await dialog.locator('input[type="date"]').fill(tomorrow);
      await dialog.locator('select[id$="-duration"]').selectOption("60");
      await dialog.locator('select[id$="-doctor"]').selectOption(String(unknownDoctorId));
      await expect.poll(() => dialog.getByText("جدول دوام الطبيب غير مؤكد. لا يمكن تأكيد الحجز قبل مراجعة ربط الطبيب بملف الموظف وجدول دوامه.").count()).toBe(1);
      release!(); await held;
      expect(await dialog.getByRole("button", { name: /— مقترح$/ }).count()).toBe(0);
      expect(await dialog.getByText("جدول دوام الطبيب غير مؤكد. لا يمكن تأكيد الحجز قبل مراجعة ربط الطبيب بملف الموظف وجدول دوامه.").count()).toBe(1);
    } finally { release?.(); await context.close(); }
  });
  it.each(["UTC", "Asia/Aden"])("keeps selected 12:00 in the actual booking and WhatsApp link in browser %s", async timezone => {
    const day = timezone === "UTC" ? date : tomorrow;
    const { context, page } = await open(timezone, day);
    try {
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("المريض", { exact: true }).fill("مريض الأمن أ");
      await dialog.getByRole("button", { name: /SECA-001/ }).click();
      await dialog.locator('select[id$="-doctor"]').selectOption(String(doctorId));
      const noon = dialog.getByRole("button", { name: "12:00 — مقترح", exact: true });
      await noon.waitFor({ timeout: 30_000 });
      expect(await noon.isEnabled()).toBe(true); await noon.click();
      expect(await dialog.locator('input[type="time"]').inputValue()).toBe("12:00");
      expect(await dialog.getByText("أوقات مقترحة وفق الدوام المسجّل").count()).toBe(1);
      expect(await dialog.getByText("الاقتراح ليس حجزًا مؤكّدًا.").count()).toBe(1);
      const written = page.waitForResponse(response => new URL(response.url()).pathname === "/api/appointments" && response.request().method() === "POST");
      await dialog.locator('button[type="submit"]').click();
      const response = await written;
      expect(response.status()).toBe(201);
      const appointment = await response.json(); bookedIds.push(appointment.id);
      expect(appointment).toMatchObject({ scheduledTime: "12:00", scheduledDate: day, doctorId });
      const stored = (await db.query("SELECT scheduled_time::text AS time,scheduled_date::text AS date,doctor_id FROM appointments WHERE id=$1", [appointment.id])).rows[0];
      expect(stored).toEqual({ time: "12:00:00", date: day, doctor_id: doctorId });
      await page.goto(`${baseUrl}/appointments?date=${day}`, { waitUntil: "domcontentloaded" });
      const row = page.locator(`[data-appointment="${appointment.id}"]`);
      await row.waitFor({ timeout: 30_000 });
      const href = await row.locator('a[title="إرسال رسالة تأكيد الحجز الفوري للمريض عبر واتساب"]').getAttribute("href");
      expect(href).toBeTruthy();
      const message = new URL(href!).searchParams.get("text");
      expect(message).toContain("12:00 مساءً");
      expect(message).not.toContain("3:00");
      // Reading and opening the form is not a reminder delivery claim.
      expect((await db.query("SELECT reminder_sent_at FROM appointments WHERE id=$1", [appointment.id])).rows[0].reminder_sent_at).toBeNull();
    } finally { await context.close(); }
  });
});
