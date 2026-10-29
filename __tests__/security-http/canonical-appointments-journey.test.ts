/**
 * M2 slices 15–16 — canonical appointment day list, personal schedule and booking, built
 * application, owned database and server.
 *
 * UI → HTTP → DB with password logins: the appointment scope decides rows, lab readiness
 * follows the operational summary, the doctor's own schedule card reads only its own
 * party, the screen calls only canonical routes, and no request runs DDL. Synthetic data.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-ap-owner", password: "Canon#APOwner1", role: "admin", display: "المالك التجريبي" },
  reception: { username: "canon-ap-reception", password: "Canon#APReception1", role: "reception", display: "استقبال المواعيد", appointmentScope: "all", grants: { "patients.operational-summary.view": true } },
  doctor: { username: "canon-ap-doctor", password: "Canon#APDoctor1", role: "doctor", display: "طبيب تجريبي", doctor: true, appointmentScope: "own", patientScope: "own", grants: { "clinical.plans.view": true } },
  patientsOnly: { username: "canon-ap-patients", password: "Canon#APPatients1", role: "reception", display: "ملفات فقط", patientScope: "all" },
  booker: { username: "canon-ap-booker", password: "Canon#APBooker1", role: "reception", display: "حجز المواعيد", appointmentScope: "all", patientScope: "all", grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let today = "";

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 17, secret: "canonical-appointments-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      today = (await db.query<{ today: string }>("SELECT to_char((NOW() AT TIME ZONE 'Asia/Aden')::date, 'YYYY-MM-DD') AS today")).rows[0].today;
      const patient = async (number: string, name: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,'0500000000',$3) RETURNING id", [number, name, doctor])).rows[0].id;
      const mine = await patient("SYN-APJ-1", "مريضة موعد الطبيب", parties.doctor!);
      const other = await patient("SYN-APJ-2", "مريض موعد عام", null);
      await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id) VALUES($1,$2::date,'09:00',$3),($4,$2::date,'10:00',NULL)", [mine, today, parties.doctor!, other]);
      await db.query("INSERT INTO lab_orders (patient_id, lab_name, work_type, status, due_date) VALUES ($1,'مختبر تجريبي','تاج تجريبي','sent',$2::date)", [mine, today]);
      await db.query("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-APJ-3','مراجعة جديدة للحجز','0500000099')");
      for (const [key, value] of [["clinic.chairs", "1"], ["clinic.day_start", "00:00"], ["clinic.day_end", "23:59"]]) {
        await db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
      }
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the appointment scope decides rows; a patient scope alone is refused in Arabic", async () => {
  const reception = await journey.login("reception");
  const all = await journey.api(`/api/appointments?date=${today}`, reception.cookie);
  expect(all.status).toBe(200);
  expect(all.headers.get("cache-control")).toMatch(/no-store/);
  expect(all.headers.get("x-clinic-time-zone")).toBeTruthy();
  expect((await all.json()).appointments.map((row: { patientName: string }) => row.patientName)).toEqual(["مريضة موعد الطبيب", "مريض موعد عام"]);
  const doctor = await journey.login("doctor");
  expect((await (await journey.api(`/api/appointments?date=${today}`, doctor.cookie)).json()).appointments.map((row: { patientName: string }) => row.patientName)).toEqual(["مريضة موعد الطبيب"]);
  const mine = await journey.api("/api/appointments/mine?doctorId=1", doctor.cookie);
  expect(mine.status).toBe(400);
  const patientsOnly = await journey.login("patientsOnly");
  const refused = await journey.api(`/api/appointments?date=${today}`, patientsOnly.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: reception opens the appointments from the shell and sees lab readiness", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  const failures: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`);
  });
  await journey.browserLogin(page, "reception");
  apiCalls.length = 0; failures.length = 0;
  await page.getByRole("link", { name: "المواعيد" }).first().click();
  await page.waitForURL(/\/appointments$/);
  const list = page.getByTestId("appointments-day-list");
  await list.getByText("مريضة موعد الطبيب").waitFor();
  await list.getByText(/تاج تجريبي:/).waitFor();
  expect(await page.getByRole("region", { name: "جدول مواعيدي" }).count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && path !== "/api/appointments")).toEqual([]);
  expect(failures).toEqual([]);
  await context.close();
});

it("browser: the doctor sees its own schedule card and only its own appointments", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  await journey.browserLogin(page, "doctor");
  apiCalls.length = 0;
  await page.goto(`${journey.baseUrl}/appointments`);
  const card = page.getByRole("region", { name: "جدول مواعيدي" });
  await card.getByRole("link", { name: "مريضة موعد الطبيب" }).waitFor();
  await page.getByTestId("appointments-day-list").getByText("مريضة موعد الطبيب").waitFor();
  expect(await page.getByText("مريض موعد عام").count()).toBe(0);
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && path !== "/api/appointments" && path !== "/api/appointments/mine")).toEqual([]);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: booking needs appointments.create; own scope books only its own patients", async () => {
  const reception = await journey.login("reception");
  const denied = await journey.api("/api/appointments", reception.cookie, { method: "POST", body: JSON.stringify({ patientId: 1, date: today, time: "12:00" }) });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: a booker books from the canonical day view; the full chair shows its reasons, never a silent failure", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  await journey.browserLogin(page, "booker");
  apiCalls.length = 0;
  await page.goto(`${journey.baseUrl}/appointments`);
  const form = page.getByTestId("booking-form");
  await form.getByLabel("المريض").fill("مراجعة جديدة");
  await form.getByRole("button", { name: /مراجعة جديدة للحجز/ }).click();
  await form.getByLabel("الوقت").fill("09:00");
  await form.getByRole("button", { name: "احجز" }).click();
  await form.getByTestId("booking-conflict").getByText(/الكراسي ممتلئة/).first().waitFor();
  await form.getByLabel("الوقت").fill("15:30");
  await form.getByRole("button", { name: "احجز" }).click();
  await form.getByRole("status").filter({ hasText: "حُجز" }).waitFor();
  await page.getByTestId("appointments-day-list").getByText("مراجعة جديدة للحجز").waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && !["/api/appointments", "/api/patients"].includes(path))).toEqual([]);
  await context.close();
  const { rows } = await journey.db.query("SELECT a.actor FROM audit_log a WHERE a.action = 'appointment.create'");
  expect(rows.map(row => row.actor)).toEqual(["canon-ap-booker"]);
  expect(await journey.ddlLog()).toEqual([]);
});
