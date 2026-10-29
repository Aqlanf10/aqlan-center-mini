/**
 * M2 slice 22 — canonical planned-session scheduling from the patient file, built
 * application, owned database and server.
 *
 * UI → HTTP → DB with password logins: the session is booked on the case's responsible
 * doctor (read from the server at booking time) through the capacity engine; booking
 * needs appointments.create; the screen calls only canonical routes; no request runs
 * DDL. Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-pv-owner", password: "Canon#PVOwner1", role: "admin", display: "المالك التجريبي" },
  desk: { username: "canon-pv-desk", password: "Canon#PVDesk1", role: "reception", display: "منسّق المواعيد", patientScope: "all", appointmentScope: "all", grants: { "clinical.plans.view": true, "appointments.create": true } },
  reader: { username: "canon-pv-reader", password: "Canon#PVReader1", role: "reception", display: "اطلاع على الخطط", patientScope: "all", appointmentScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let patientId = 0, plannedId = 0, doctorId = 0, tomorrow = "";

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 21, secret: "canonical-planned-visits-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      tomorrow = (await db.query<{ d: string }>("SELECT to_char((NOW() AT TIME ZONE 'Asia/Aden')::date + 1, 'YYYY-MM-DD') AS d")).rows[0].d;
      doctorId = (await db.query<{ id: number }>("INSERT INTO parties(kind,name,is_active) VALUES ('doctor','طبيبة الحالة التجريبية',TRUE) RETURNING id")).rows[0].id;
      patientId = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-PVJ-1','مريض الخطة التجريبي','0500000301') RETURNING id")).rows[0].id;
      const plan = (await db.query<{ id: number }>("INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES ($1,'خطة تجريبية',1000,'active') RETURNING id", [patientId])).rows[0].id;
      const clinical = (await db.query<{ id: number }>("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'general','حالة تجريبية',$2,'synthetic') RETURNING id", [patientId, doctorId])).rows[0].id;
      const item = (await db.query<{ id: number }>("INSERT INTO plan_items(plan_id,case_id,service_name,unit_price_minor) VALUES ($1,$2,'حشوة تجريبية',1000) RETURNING id", [plan, clinical])).rows[0].id;
      plannedId = (await db.query<{ id: number }>("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,status,duration_minutes) VALUES ($1,$2,1,'الجلسة الأولى التجريبية','planned',30) RETURNING id", [patientId, plan])).rows[0].id;
      await db.query("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)", [item, plannedId]);
      for (const [key, value] of [["clinic.chairs", "1"], ["clinic.day_start", "00:00"], ["clinic.day_end", "23:59"]]) {
        await db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
      }
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the booking context is read in the patient scope; scheduling needs appointments.create", async () => {
  const reader = await journey.login("reader");
  const context = await journey.api(`/api/patients/${patientId}/return-booking-context?kind=planned_visit&sourceId=${plannedId}`, reader.cookie);
  expect(context.status).toBe(200);
  const body = await context.json();
  expect(body).toMatchObject({ ok: true, doctorId, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const refused = await journey.api(`/api/planned-visits/${plannedId}/schedule`, reader.cookie, { method: "POST", body: JSON.stringify({ date: tomorrow, time: "09:00", returnBookingFingerprint: body.fingerprint }) });
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT status FROM planned_visits WHERE id=$1", [plannedId])).rows[0].status).toBe("planned");
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the desk books the planned session from the patient file on the responsible doctor; audited", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  const failures: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await journey.browserLogin(page, "desk");
  apiCalls.length = 0; failures.length = 0;
  await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  const panel = page.getByTestId("planned-visits");
  const row = panel.locator(`li[data-planned-visit="${plannedId}"]`);
  await row.getByRole("button", { name: "حدّد موعد الجلسة" }).click();
  await row.getByLabel("التاريخ").fill(tomorrow);
  await row.getByLabel("الوقت").fill("10:30");
  await row.getByRole("button", { name: "احجز الجلسة" }).click();
  await panel.getByRole("status").filter({ hasText: "طبيبة الحالة التجريبية" }).waitFor();
  await row.getByText(/محجوزة/).waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(failures).toEqual([]);
  const allowed = new RegExp(`^/api/(auth/(login|me)|patients/${patientId}(/[a-z-]+)?|planned-visits/${plannedId}/schedule)$`);
  expect(apiCalls.filter(path => !allowed.test(path))).toEqual([]);
  await context.close();
  const { rows: [appointment] } = await journey.db.query("SELECT a.doctor_id, to_char(a.scheduled_time,'HH24:MI') AS time FROM appointments a WHERE a.planned_visit_id=$1", [plannedId]);
  expect(appointment).toEqual({ doctor_id: doctorId, time: "10:30" });
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='appointment.create'")).rows).toEqual([{ actor: "canon-pv-desk" }]);
  expect(await journey.ddlLog()).toEqual([]);
});
