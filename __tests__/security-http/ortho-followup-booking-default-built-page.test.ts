import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUCKET_LABEL, type FollowupRow } from "../../lib/ortho-followup";
import type { AppointmentService } from "../../lib/appointment-services";
import { APPOINTMENT_TYPES } from "../../lib/schedule";
import { FOLLOWUP_SERVICE_REVIEW_MESSAGE } from "../../lib/ortho-booking-intent";
import { baseUrl, harness } from "./_server";

// CI-only real built /ortho -> modal -> POST /api/appointments -> board read.
// Use only fresh synthetic patients in the existing isolated HTTP database.
// Browser mutations are closed by default; exactly one validated appointment
// request per deliberate attempt is admitted. No Production connection or patient write.
let h: Awaited<ReturnType<typeof harness>>; let db: Client; let browser: Browser;
let doctorId: number; let responsibleDoctorId: number;
beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
  expect(target.pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorId = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  responsibleDoctorId = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username='secdoctorb'")).rows[0].party_id;
  expect(doctorId).not.toBe(responsibleDoctorId);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

type Feed = { today: string; buckets: Array<{ bucket: string; rows: FollowupRow[] }> };
async function storedState(patientId: number) {
  return (await db.query(`SELECT
    (SELECT to_jsonb(p) FROM patients p WHERE p.id=$1) AS patient,
    (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ortho_cases c WHERE c.patient_id=$1) AS cases,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE c.patient_id=$1) AS adjustments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb) FROM visits v WHERE v.patient_id=$1) AS visits,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM treatment_plans p WHERE p.patient_id=$1) AS plans,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.patient_id=$1) AS payments`, [patientId])).rows;
}
async function geometry(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, value: element instanceof HTMLSelectElement ? element.value : element.textContent,
      selected: element.getAttribute("aria-pressed"), hit: element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
      pageWidth: document.documentElement.scrollWidth };
  });
}

describe("orthodontic board booking defaults satisfy its own follow-up classifier", () => {
  it.each([{ width: 390, mode: "canonical" }, { width: 1280, mode: "canonical" },
    { width: 1280, mode: "unavailable" }, { width: 1280, mode: "contrary" }, { width: 1280, mode: "stale" }])(
    "books or safely refuses the board intent at $width px (catalogue $mode)", async ({ width, mode }) => {
    let catalogAvailable = mode !== "unavailable";
    let contraryCatalogue = mode === "contrary";
    let changedSyntheticSpecialty = false;
    const patientName = `مريض حجز متابعة اصطناعي ${width} ${mode}`;
    const patientId = (await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
      [`FOLLOWUP-BOOK-${width}-${Date.now()}`, patientName, responsibleDoctorId],
    )).rows[0].id;
    const caseId = (await db.query<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, appliance, arches, slot, created_by)
       VALUES ($1,'fixed_metal','both','022','synthetic-followup-booking-ui') RETURNING id`, [patientId],
    )).rows[0].id;
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 90 + (["canonical", "unavailable", "contrary", "stale"].indexOf(mode) * 2 + (width === 390 ? 1 : 2)));
    const bookedDate = date.toISOString().slice(0, 10);
    // Preserve an existing unrelated visit; the board should offer review first.
    const unrelatedId = (await db.query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, appointment_type)
       VALUES ($1,$2,'09:00',15,'consultation') RETURNING id`, [patientId, bookedDate],
    )).rows[0].id;
    const before = await storedState(patientId);
    const unrelatedBefore = (await db.query("SELECT to_jsonb(a) AS row FROM appointments a WHERE id=$1", [unrelatedId])).rows;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.reception.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    // This independent read confirms the persisted catalogue even when the
    // browser must refuse unavailable metadata before retrying with an explicit ID.
    const catalogRead = await context.request.get(`${baseUrl}/api/settings/appointment-services`);
    expect(catalogRead.status()).toBe(200);
    const catalog = await catalogRead.json() as { services: AppointmentService[] };
    const periodic = catalog.services.find((service) => service.code === "ORTHO_FOLLOW_UP")!;
    expect(periodic).toMatchObject({ isActive: true, specialty: "orthodontics", legacyType: "follow_up" });
    const requestedDuration = periodic.defaultDurationMinutes;
    const page = await context.newPage(); const unexpected: string[] = []; const errors: string[] = [];
    const writes: Array<Record<string, unknown>> = []; let expected: Record<string, unknown> | null = null;
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseUrl) { unexpected.push(`external ${request.method()} ${url.origin}`); await route.abort(); return; }
      if (!catalogAvailable && request.method() === "GET" && url.pathname === "/api/settings/appointment-services") {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Synthetic catalogue unavailable"}' }); return;
      }
      if (contraryCatalogue && request.method() === "GET" && url.pathname === "/api/settings/appointment-services") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...catalog,
          services: catalog.services.map((row) => row.id === periodic.id ? { ...row, specialty: "endodontics" } : row) }) }); return;
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        if (request.method() === "POST" && url.pathname === "/api/appointments" && expected) {
          const payload = request.postDataJSON();
          if (JSON.stringify(payload) === JSON.stringify(expected)) { writes.push(payload); expected = null; await route.continue(); return; }
        }
        unexpected.push(`${request.method()} ${url.pathname}`); await route.abort(); return;
      }
      await route.continue();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const feedResponse = () => page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/ortho/followups");
    const ownRow = (feed: Feed) => feed.buckets.flatMap((bucket) => bucket.rows).find((row) => row.caseId === caseId)!;
    try {
      const [response] = await Promise.all([feedResponse(), page.goto(`${baseUrl}/ortho`, { waitUntil: "networkidle" })]);
      expect(response.status()).toBe(200); const initial = await response.json() as Feed;
      expect(ownRow(initial)).toMatchObject({ patientId, nextAppointment: null });
      expect(ownRow(initial).buckets).toContain("no_appointment");
      const patient = page.locator("li").filter({ has: page.getByRole("link", { name: patientName, exact: true }) });
      await patient.getByRole("button", { name: "📅 احجز بعد المراجعة", exact: true }).waitFor();
      const catalogResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/appointment-services");
      await patient.getByRole("button", { name: "📅 احجز بعد المراجعة", exact: true }).click();
      expect((await catalogResponse).status()).toBe(catalogAvailable ? 200 : 503);
      const dialog = page.getByRole("dialog");
      const service = dialog.locator('[data-service="ORTHO_FOLLOW_UP"]');
      const duration = dialog.getByLabel("المدة المحجوزة على الكرسي", { exact: true });
      if (!catalogAvailable || contraryCatalogue) {
        expect(await duration.inputValue()).toBe(String(APPOINTMENT_TYPES.find((type) => type.id === "follow_up")!.defaultDuration));
        expect(await dialog.locator('button[type="submit"]').isDisabled()).toBe(true);
        await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
        await dialog.getByRole("alert").filter({ hasText: FOLLOWUP_SERVICE_REVIEW_MESSAGE }).waitFor();
        expect(writes).toEqual([]); expect(unexpected).toEqual([]); expect(await storedState(patientId)).toEqual(before);
        expect((await db.query("SELECT id FROM appointments WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: unrelatedId }]);
        // Explicit retry can establish a current eligible service; a refused
        // proposal neither writes nor silently drops the original protection.
        catalogAvailable = true; contraryCatalogue = false;
        await dialog.getByRole("button", { name: "إعادة تحميل الخدمات", exact: true }).click();
      }
      await expect.poll(() => service.getAttribute("aria-pressed")).toBe("true");
      expect(await dialog.getByRole("heading").textContent()).toContain(patientName);
      expect(await duration.inputValue()).toBe(String(requestedDuration));
      expect(await duration.locator("option:checked").textContent()).toContain(String(requestedDuration));
      expect(await dialog.locator('[id$="-doctor"]').inputValue()).toBe("");
      const bounds = { service: await geometry(service), duration: await geometry(duration) };
      for (const control of Object.values(bounds)) {
        expect(control.width).toBeGreaterThan(0); expect(control.height).toBeGreaterThan(0); expect(control.hit).toBe(true);
        expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(width);
        expect(control.pageWidth).toBeLessThanOrEqual(width); expect(control.top).toBeGreaterThanOrEqual(0);
        expect(control.bottom).toBeLessThanOrEqual(control.viewportHeight);
      }
      if (mode === "canonical") {
        await service.screenshot({ path: `.settings-ui-artifacts/ortho-booking-service-${width}.png` });
        await duration.locator("..").screenshot({ path: `.settings-ui-artifacts/ortho-booking-duration-${width}.png` });
        await writeFile(`.settings-ui-artifacts/ortho-booking-${width}-bounds.json`, `${JSON.stringify(bounds, null, 2)}\n`);
      }
      // A deliberate edit is discarded only when reception cancels this modal.
      await duration.selectOption("45"); await dialog.getByRole("button", { name: "إلغاء", exact: true }).click();
      expect(writes).toEqual([]); expect(await storedState(patientId)).toEqual(before);
      await patient.getByRole("button", { name: "📅 احجز بعد المراجعة", exact: true }).click();
      await expect.poll(() => service.getAttribute("aria-pressed")).toBe("true");
      expect(await duration.inputValue()).toBe(String(requestedDuration));
      await dialog.locator('[id$="-date"]').fill(bookedDate); await dialog.locator('[id$="-time"]').fill("16:00");
      await dialog.locator('[id$="-doctor"]').selectOption(String(doctorId));
      const expectedPayload = { patientId, date: bookedDate, time: "16:00", durationMinutes: requestedDuration,
        serviceId: periodic.id, appointmentType: "follow_up", bookingIntent: "ortho_follow_up", doctorId, isNewPatient: false };
      if (mode === "stale") {
        // Synthetic fixture only: reproduce an owner-edit after catalogue read.
        // Restore exactly this field in finally; the shared service is never deleted.
        const changed = await db.query("UPDATE appointment_services SET specialty='endodontics' WHERE id=$1 AND specialty=$2", [periodic.id, periodic.specialty]);
        changedSyntheticSpecialty = changed.rowCount === 1;
        expect(changed.rowCount).toBe(1);
        expected = expectedPayload;
        const refused = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/appointments");
        await dialog.locator('button[type="submit"]').click();
        const rejected = await refused; expect(rejected.status()).toBe(400);
        expect(await rejected.json()).toEqual({ message: FOLLOWUP_SERVICE_REVIEW_MESSAGE });
        await expect.poll(() => dialog.locator('button[type="submit"]').isDisabled()).toBe(true);
        expect(await storedState(patientId)).toEqual(before);
        expect((await db.query("SELECT id FROM appointments WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: unrelatedId }]);
        expect((await db.query("UPDATE appointment_services SET specialty=$1 WHERE id=$2", [periodic.specialty, periodic.id])).rowCount).toBe(1);
        expect((await db.query("SELECT specialty FROM appointment_services WHERE id=$1", [periodic.id])).rows).toEqual([{ specialty: periodic.specialty }]);
        changedSyntheticSpecialty = false;
        await dialog.getByRole("button", { name: "إعادة تحميل الخدمات", exact: true }).click();
        await expect.poll(() => service.getAttribute("aria-pressed")).toBe("true");
        expect(await dialog.locator('[id$="-doctor"]').inputValue()).toBe(String(doctorId));
      }
      expected = expectedPayload;
      const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/appointments");
      const reloaded = feedResponse();
      await dialog.locator("form").evaluate((form) => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
      const savedResponse = await saved;
      expect({ status: savedResponse.status(), body: await savedResponse.text() }).toMatchObject({ status: 201 });
      const refreshed = await reloaded; expect(refreshed.status()).toBe(200);
      const row = ownRow(await refreshed.json() as Feed);
      expect(row.nextAppointment).toMatchObject({ date: bookedDate, time: "16:00", appointmentType: "follow_up", serviceName: periodic.nameAr, matchBasis: "designated_service" });
      expect(row.buckets).not.toContain("no_appointment");
      expect(row.bookingContext?.otherAppointments.map((appointment) => appointment.id)).toContain(unrelatedId);
      await expect.poll(() => dialog.count()).toBe(0);
      await page.getByRole("button", { name: new RegExp(`^${BUCKET_LABEL.upcoming}`) }).click();
      await patient.getByText("موعد متابعة التقويم المسجل:", { exact: false }).waitFor();
      expect(writes).toEqual(mode === "stale" ? [expectedPayload, expectedPayload] : [expectedPayload]);
      const appointments = (await db.query<{ id: number; patient_id: number; service_id: number; appointment_type: string; doctor_id: number; duration_minutes: number }>(
        "SELECT id, patient_id, service_id, appointment_type, doctor_id, duration_minutes FROM appointments WHERE patient_id=$1 ORDER BY id", [patientId],
      )).rows;
      expect(appointments).toHaveLength(2);
      expect(appointments.find((appointment) => appointment.id !== unrelatedId)).toMatchObject({ patient_id: patientId, service_id: periodic.id,
        appointment_type: "follow_up", doctor_id: doctorId, duration_minutes: requestedDuration });
      expect(await storedState(patientId)).toEqual(before);
      expect((await db.query("SELECT to_jsonb(a) AS row FROM appointments a WHERE id=$1", [unrelatedId])).rows).toEqual(unrelatedBefore);
      expect(unexpected).toEqual([]); expect(errors).toEqual([]);
    } finally {
      try {
        if (changedSyntheticSpecialty) {
          expect((await db.query("UPDATE appointment_services SET specialty=$1 WHERE id=$2", [periodic.specialty, periodic.id])).rowCount).toBe(1);
          expect((await db.query("SELECT specialty FROM appointment_services WHERE id=$1", [periodic.id])).rows).toEqual([{ specialty: periodic.specialty }]);
        }
      } finally { await context.close(); }
    }
  }, 240_000);
});
