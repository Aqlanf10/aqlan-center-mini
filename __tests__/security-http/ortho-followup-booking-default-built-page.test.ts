import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUCKET_LABEL, type FollowupRow } from "../../lib/ortho-followup";
import type { AppointmentService } from "../../lib/appointment-services";
import { addDays, APPOINTMENT_TYPES } from "../../lib/schedule";
import { FOLLOWUP_SERVICE_REVIEW_MESSAGE } from "../../lib/ortho-booking-intent";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

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
    { width: 1280, mode: "unavailable" }, { width: 1280, mode: "contrary" }, { width: 1280, mode: "stale" }, { width: 1280, mode: "stale-source" }])(
    "books or safely refuses the board intent at $width px (catalogue $mode)", async ({ width, mode }) => {
    let catalogAvailable = mode !== "unavailable";
    let contraryCatalogue = mode === "contrary";
    let changedSyntheticSpecialty = false;
    const patientName = `مريض حجز متابعة اصطناعي ${width} ${mode}`;
    const patientId = (await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
      [`FOLLOWUP-BOOK-${width}-${Date.now()}`, patientName, doctorId],
    )).rows[0].id;
    const caseId = (await db.query<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, appliance, arches, slot, created_by, responsible_doctor_id)
       VALUES ($1,'fixed_metal','both','022','synthetic-followup-booking-ui',$2) RETURNING id`, [patientId, responsibleDoctorId],
    )).rows[0].id;
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 90 + (["canonical", "unavailable", "contrary", "stale", "stale-source"].indexOf(mode) * 2 + (width === 390 ? 1 : 2)));
    const bookedDate = date.toISOString().slice(0, 10);
    // Cover the inclusive D..D+2 warning window without ever treating it as an overlap override.
    const nearbyOffset = mode === "canonical" && width === 1280 ? 1 : mode === "unavailable" ? 2 : 0;
    const unrelatedDate = addDays(bookedDate, nearbyOffset);
    // Preserve an existing unrelated visit; the board should offer review first.
    const unrelatedId = (await db.query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, appointment_type)
       VALUES ($1,$2,'09:00',15,'consultation') RETURNING id`, [patientId, unrelatedDate],
    )).rows[0].id;
    let before = await storedState(patientId);
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
        if (request.method() === "POST" && url.pathname === "/api/appointments" && !url.search && expected) {
          const payload = request.postDataJSON();
          if (isDeepStrictEqual(payload, expected)) { writes.push(payload); expected = null; await route.continue(); return; }
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
      const dialog = page.getByRole("dialog", { name: `حجز موعد للمريض: ${patientName}`, exact: true });
      let expectedDoctorId = responsibleDoctorId;
      const readProof = async () => {
        const response = await context.request.get(`${baseUrl}/api/patients/${patientId}/return-booking-context?kind=ortho_case&sourceId=${caseId}`);
        expect(response.status()).toBe(200);
        const proof = await response.json() as { ok: boolean; patientId: number; source: { kind: string; id: number }; orthoCaseId: number; doctorId: number; doctorName: string; fingerprint: string };
        expect(proof).toMatchObject({ ok: true, patientId, source: { kind: "ortho_case", id: caseId }, orthoCaseId: caseId, doctorId: expectedDoctorId });
        expect(proof.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(proof.doctorName.trim()).not.toBe("");
        return proof;
      };
      let proof = await readProof();
      const selectSource = async () => {
        const source = dialog.getByRole("combobox", { name: "سياق موعد المراجعة", exact: true });
        await expect.poll(() => source.locator(`option[value="ortho_case:${caseId}"]`).count()).toBe(1);
        await source.selectOption(`ortho_case:${caseId}`);
        await expect.poll(() => dialog.getByRole("region", { name: "الطبيب المسؤول عن موعد المراجعة", exact: true }).innerText()).toContain(proof.doctorName);
        expect(await dialog.locator('[id$="-doctor"]').count()).toBe(0);
      };
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
      await selectSource();
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
      proof = await readProof(); // Reopening must verify current case responsibility again.
      await selectSource();
      let expectedPayload = { patientId, date: bookedDate, time: "16:00", durationMinutes: requestedDuration,
        serviceId: periodic.id, appointmentType: "follow_up", bookingIntent: "ortho_follow_up", returnBookingSource: proof.source, returnBookingFingerprint: proof.fingerprint, isNewPatient: false };
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
        await expect.poll(() => dialog.getByRole("region", { name: "الطبيب المسؤول عن موعد المراجعة", exact: true }).innerText()).toContain(proof.doctorName);
      }
      const rejectedPayloads: Array<Record<string, unknown>> = mode === "stale" ? [expectedPayload] : [];
      if (mode === "stale-source") {
        // Real admin settings transaction on this synthetic case only. The stale
        // reception draft must fail instead of choosing an arbitrary replacement.
        const settingsRead = await authedGet(`/api/patients/${patientId}/responsibility?kind=ortho&sourceId=${caseId}`, h.sessions.admin);
        expect(settingsRead.status).toBe(200);
        const settings = await settingsRead.json();
        expect(settings.doctorId).toBe(responsibleDoctorId);
        const changed = await authedMutation(`/api/patients/${patientId}/responsibility`, h.sessions.admin, "PATCH", JSON.stringify({
          kind: "ortho", sourceId: caseId, expectedSourceFingerprint: settings.sourceFingerprint,
          doctorId, reason: "تغيير مسؤولية حالة اصطناعية لاختبار رفض اقتراح قديم",
        }));
        expect(changed.status).toBe(200);
        expect((await changed.json()).doctorId).toBe(doctorId);
        before = await storedState(patientId); // Only the explicit setup responsibility change is accepted.
        expected = expectedPayload;
        const refusal = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/appointments");
        await dialog.locator('button[type="submit"]').click();
        const denied = await refusal;
        // POST /api/appointments uses 400 for source-contract refusals; 409 is
        // reserved here for booking conflicts (the rebooking endpoint differs).
        expect(denied.status()).toBe(400);
        expect(await denied.json()).toMatchObject({ code: "return_booking_source_changed" });
        expect((await db.query("SELECT id FROM appointments WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: unrelatedId }]);
        expect(await storedState(patientId)).toEqual(before);
        rejectedPayloads.push(expectedPayload);
        expectedDoctorId = doctorId;
        const staleFingerprint = proof.fingerprint;
        proof = await readProof();
        expect(proof.fingerprint).not.toBe(staleFingerprint);
        await expect.poll(() => dialog.getByRole("region", { name: "الطبيب المسؤول عن موعد المراجعة", exact: true }).innerText()).toContain(proof.doctorName);
        expectedPayload = { ...expectedPayload, returnBookingSource: proof.source, returnBookingFingerprint: proof.fingerprint };
      }
      const warningDialog = page.getByRole("dialog", { name: "للمريض موعد قائم قريب", exact: true });
      const askNearby = async (duplicateSubmit = false) => {
        expected = expectedPayload;
        const response = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/appointments");
        if (duplicateSubmit) await dialog.locator("form").evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
        else await dialog.locator('button[type="submit"]').click();
        const warning = await response;
        expect(warning.status()).toBe(409);
        const body = await warning.json();
        expect(body).toMatchObject({ kind: "nearby_patient_appointments", canOverride: false });
        expect(body.nearbyAppointments).toEqual([expect.objectContaining({ id: unrelatedId, scheduledDate: unrelatedDate, scheduledTime: "09:00" })]);
        expect(typeof body.confirmationToken).toBe("string"); expect(body.confirmationToken.length).toBeGreaterThan(0);
        await warningDialog.waitFor();
        expect((await db.query("SELECT id FROM appointments WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: unrelatedId }]);
        expect(await storedState(patientId)).toEqual(before);
        return body.confirmationToken as string;
      };
      await askNearby(true);
      await warningDialog.getByRole("button", { name: "إلغاء الحجز الجديد", exact: true }).click();
      await expect.poll(() => dialog.locator('button[type="submit"]').isEnabled()).toBe(true);
      expect(await dialog.locator('[id$="-date"]').inputValue()).toBe(bookedDate);
      expect(await dialog.locator('[id$="-time"]').inputValue()).toBe("16:00");
      const token = await askNearby();
      const confirmedPayload = { ...expectedPayload, nearbyAppointmentConfirmation: token };
      expected = confirmedPayload; // One exact token-bearing retry, only after the deliberate confirmation click.
      const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/appointments");
      const reloaded = feedResponse();
      await warningDialog.getByRole("button", { name: "تأكيد موعد إضافي مقصود", exact: true }).click();
      expect((await saved).status()).toBe(201);
      const refreshed = await reloaded; expect(refreshed.status()).toBe(200);
      const row = ownRow(await refreshed.json() as Feed);
      expect(row.nextAppointment).toMatchObject({ date: bookedDate, time: "16:00", appointmentType: "follow_up", serviceName: periodic.nameAr, matchBasis: "designated_service" });
      expect(row.buckets).not.toContain("no_appointment");
      expect(row.bookingContext?.otherAppointments.map((appointment) => appointment.id)).toContain(unrelatedId);
      await expect.poll(() => dialog.count()).toBe(0);
      await page.getByRole("button", { name: new RegExp(`^${BUCKET_LABEL.upcoming}`) }).click();
      await patient.getByText("موعد متابعة التقويم المسجل:", { exact: false }).waitFor();
      expect(writes).toEqual([...rejectedPayloads, expectedPayload, expectedPayload, confirmedPayload]);
      expect(expected).toBeNull();
      const appointments = (await db.query<{ id: number; patient_id: number; service_id: number; appointment_type: string; doctor_id: number; duration_minutes: number }>(
        "SELECT id, patient_id, service_id, appointment_type, doctor_id, duration_minutes FROM appointments WHERE patient_id=$1 ORDER BY id", [patientId],
      )).rows;
      expect(appointments).toHaveLength(2);
      expect(appointments.find((appointment) => appointment.id !== unrelatedId)).toMatchObject({ patient_id: patientId, service_id: periodic.id,
        appointment_type: "follow_up", doctor_id: expectedDoctorId, duration_minutes: requestedDuration });
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
