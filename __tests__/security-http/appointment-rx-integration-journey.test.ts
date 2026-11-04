import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedAdvisoryDuty } from "../helpers/advisory-duty-fixture";
import { authedMutation, baseUrl, harness } from "./_server";

// One synthetic patient crosses both protocols on the actual composed build.
// SQL creates only a patient and scoped staff duty, and reads persisted evidence.
// Appointment, arrival, visit documentation, Rx issuance, print authorization
// and follow-up all use real application routes. No clinical dose is invented:
// the manual medicine strings are the established prescription-reprint fixture.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
let doctorId: number, duty: Awaited<ReturnType<typeof seedAdvisoryDuty>>;
beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: target.toString(), ssl: false }); await db.connect();
  doctorId = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  duty = await seedAdvisoryDuty(db, doctorId, "2000-01-01", "2099-12-31");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => {
  try { await browser?.close(); } finally { try { await duty?.cleanup(); } finally { await db?.end(); } }
});
async function mutate(role: "admin" | "reception" | "doctorA", path: string, method: "POST" | "PATCH", body: object, status = 200) {
  const response = await authedMutation(path, h.sessions[role], method, JSON.stringify(body));
  const text = await response.text();
  expect(response.status, `${method} ${path}: ${text}`).toBe(status);
  return JSON.parse(text);
}

it("books, arrives, issues and reprints one linked saved Rx, then preserves the doctor on follow-up", async () => {
  const number = `SYN-APPT-RX-${randomUUID()}`;
  const name = "مريض تكامل الموعد والوصفة الاصطناعي";
  const patientId = (await db.query(`INSERT INTO patients(patient_number,full_name,primary_doctor_id)
    VALUES($1,$2,$3) RETURNING id`, [number, name, doctorId])).rows[0].id;
  const { rows: [days] } = await db.query(`SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date+51)::text AS date,
    ((NOW() AT TIME ZONE 'Asia/Aden')::date+58)::text AS next_date`);
  const reception = (await db.query("SELECT id,permissions FROM users WHERE username='secreception'")).rows[0];
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [cookieName, ...cookieValue] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name: cookieName, value: cookieValue.join("="), url: baseUrl }]);
  const external: string[] = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === baseUrl) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await context.addInitScript(() => {
    const state = window as typeof window & { syntheticPrintCount: number };
    state.syntheticPrintCount = 0;
    window.print = () => { state.syntheticPrintCount++; };
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/appointments?date=${days.date}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /حجز موعد جديد/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("المريض", { exact: true }).fill(number);
    await dialog.getByRole("button", { name: new RegExp(number) }).click();
    await dialog.getByLabel("التصنيف السريري للموعد", { exact: true }).selectOption("other");
    await dialog.locator('input[type="date"]').fill(days.date);
    await expect.poll(() => dialog.locator(`select[id$="-doctor"] option[value="${doctorId}"]`).count()).toBe(1);
    await dialog.locator('select[id$="-doctor"]').selectOption(String(doctorId));
    await dialog.getByRole("button", { name: "10:00 — مقترح", exact: true }).click();
    const bookingResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/appointments" && response.request().method() === "POST");
    await dialog.locator('button[type="submit"]').click();
    const booked = await bookingResponse;
    expect(booked.status()).toBe(201);
    const appointment = await booked.json();
    expect(appointment).toMatchObject({ patientId, doctorId, scheduledDate: days.date, scheduledTime: "10:00", clinicalCategory: "other" });
    await dialog.waitFor({ state: "hidden" });
    const row = page.locator(`[data-appointment="${appointment.id}"]`);
    const arrivalResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/appointments/${appointment.id}` && response.request().method() === "PATCH");
    await row.getByRole("button", { name: /وصل للعيادة/ }).click();
    expect((await arrivalResponse).status()).toBe(200);
    const visits = (await db.query("SELECT id,patient_id,doctor_id,status FROM visits WHERE appointment_id=$1", [appointment.id])).rows;
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ patient_id: patientId, doctor_id: doctorId, status: "waiting" });
    const visitId = visits[0].id;
    await mutate("reception", `/api/appointments/${appointment.id}`, "PATCH", { action: "arrive" }, 409);
    await mutate("doctorA", `/api/visits/${visitId}/clinical`, "POST", {
      action: "save", doctorId, diagnosis: "Synthetic integration documentation", procedures: [],
    });
    const body = {
      commandKey: randomUUID(), patientId, visitId, prescribingDoctorPartyId: doctorId,
      diagnosis: "Synthetic private diagnosis", notes: "Synthetic private notes",
      items: [{ name: "SyntheticRxOnly", dose: "fixture", form: "Synthetic form", frequency: "fixture",
        duration: "Synthetic duration", selection: { id: "manual", amount: "Synthetic amount only", confirmed: true } }],
    };
    const rx = await mutate("doctorA", "/api/prescriptions", "POST", body, 201);
    expect(await mutate("doctorA", "/api/prescriptions", "POST", body, 201)).toMatchObject({ id: rx.id, replayed: true });
    const saved = (await db.query("SELECT * FROM prescriptions WHERE id=$1", [rx.id])).rows[0];
    expect(saved).toMatchObject({ patient_id: patientId, visit_id: visitId, prescribing_doctor_party_id: doctorId, created_by: "secdoctora" });
    const prescriptionCommands = (await db.query("SELECT * FROM prescription_issuance_commands WHERE command_key=$1", [body.commandKey])).rows;
    expect(prescriptionCommands).toHaveLength(1);
    await mutate("doctorA", `/api/visits/${visitId}/clinical`, "POST", { action: "sign" });
    await mutate("admin", `/api/users/${reception.id}`, "PATCH", { permissions: { ...(reception.permissions ?? {}), canPrintSavedPrescriptions: true } });
    const evidence = process.env.APPOINTMENTS_RX_EVIDENCE_DIR || ".settings-ui-artifacts/appointments-rx-integration";
    await mkdir(evidence, { recursive: true });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${baseUrl}/patients/${patientId}?tab=today&checkoutVisit=${visitId}`);
      await page.locator("summary").filter({ hasText: /^الوصفات المحفوظة(?: للزيارة #\d+)?$/ }).click();
      const printPath = `/print/prescription/${patientId}?rx=${rx.id}`;
      const link = page.getByRole("link", { name: "فتح الوصفة للطباعة", exact: true });
      await link.waitFor(); expect(await link.getAttribute("href")).toBe(printPath);
      await page.goto(`${baseUrl}${printPath}`);
      const sheet = page.locator(".sheet.sheet-a5.prescription-approved-a5");
      await sheet.waitFor();
      expect(await sheet.innerText()).toContain(name);
      expect(await sheet.innerText()).toContain(number);
      expect(await sheet.locator(".prescription-record-identity").innerText()).toContain(`Rx #${rx.id}`);
      expect(await sheet.locator(".prescription-record-identity").innerText()).toContain(saved.prescribing_doctor_name);
      expect(await sheet.innerText()).toContain("SyntheticRxOnly");
      expect(await sheet.locator('[data-prescription-body="ltr"]').count()).toBe(1);
      expect(Math.abs(await sheet.evaluate(node => node.getBoundingClientRect().width) - 148 * 96 / 25.4)).toBeLessThan(2);
      expect(await page.evaluate(() => (window as typeof window & { syntheticPrintCount: number }).syntheticPrintCount)).toBe(0);
      await page.screenshot({ path: `${evidence}/saved-rx-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "اطبع", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as typeof window & { syntheticPrintCount: number }).syntheticPrintCount)).toBe(1);
    }
    const pdf = await page.pdf({ path: `${evidence}/saved-rx-a5.pdf`, format: "A5", printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true });
    const paper = execFileSync("pdfinfo", ["-"], { input: pdf, encoding: "utf8" });
    const size = paper.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
    expect(size).not.toBeNull();
    expect(Math.abs(Number(size![1]) - 148 * 72 / 25.4)).toBeLessThan(1);
    expect(Math.abs(Number(size![2]) - 210 * 72 / 25.4)).toBeLessThan(1);
    expect(execFileSync("pdftotext", ["-", "-"], { input: pdf, encoding: "utf8" })).toContain("SyntheticRxOnly");
    const next = await mutate("reception", `/api/visits/${visitId}/next`, "POST", { date: days.next_date, time: "10:00", durationMinutes: 30 }, 201);
    expect(next).toMatchObject({ patientId });
    expect((await db.query("SELECT patient_id,doctor_id,status,clinical_category FROM appointments WHERE id=$1", [next.appointmentId])).rows[0])
      .toEqual({ patient_id: patientId, doctor_id: doctorId, status: "booked", clinical_category: null });
    expect((await db.query("SELECT patient_id,doctor_id,status,clinical_category FROM appointments WHERE id=$1", [appointment.id])).rows[0])
      .toEqual({ patient_id: patientId, doctor_id: doctorId, status: "done", clinical_category: "other" });
    expect((await db.query("SELECT * FROM prescriptions WHERE id=$1", [rx.id])).rows[0]).toEqual(saved);
    expect((await db.query("SELECT * FROM prescription_issuance_commands WHERE command_key=$1", [body.commandKey])).rows).toEqual(prescriptionCommands);
    expect((await db.query("SELECT id FROM prescriptions WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: rx.id }]);
    expect((await db.query("SELECT id FROM visits WHERE appointment_id=$1", [appointment.id])).rows).toEqual([{ id: visitId }]);
    expect((await db.query("SELECT id FROM document_prints WHERE doc_type='prescription' AND doc_id=$1 AND printed_by='secreception'", [String(rx.id)])).rows).toHaveLength(2);
    expect(external).toEqual([]);
  } finally {
    await context.close();
    await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [reception.permissions, reception.id]);
  }
}, 120_000);
