/**
 * M2 slice 21 — canonical online booking requests, built application, owned database
 * and server.
 *
 * UI → HTTP → DB with password logins: the queue needs appointments.create and the
 * whole appointment scope; confirmation books through the capacity engine (a new
 * person also needs patients.create) and rejection needs appointments.cancel; refusals
 * carry an Arabic `message`; the screen calls only canonical routes; no request runs
 * DDL. Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-br-owner", password: "Canon#BROwner1", role: "admin", display: "المالك التجريبي" },
  desk: { username: "canon-br-desk", password: "Canon#BRDesk1", role: "reception", display: "استقبال الطلبات", appointmentScope: "all", grants: { "appointments.create": true, "appointments.cancel": true, "patients.create": true } },
  booker: { username: "canon-br-booker", password: "Canon#BRBooker1", role: "reception", display: "حجز بلا ملفات", appointmentScope: "all", grants: { "appointments.create": true } },
  doctor: { username: "canon-br-doctor", password: "Canon#BRDoctor1", role: "doctor", display: "طبيب تجريبي", doctor: true, appointmentScope: "own", grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let tomorrow = "";
const ids: Record<"confirm" | "reject" | "stranger", number> = { confirm: 0, reject: 0, stranger: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 19, secret: "canonical-booking-requests-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      tomorrow = (await db.query<{ d: string }>("SELECT to_char((NOW() AT TIME ZONE 'Asia/Aden')::date + 1, 'YYYY-MM-DD') AS d")).rows[0].d;
      const add = async (name: string, phone: string) => (await db.query<{ id: number }>("INSERT INTO booking_requests(full_name, phone, reason, preferred_date, preferred_period) VALUES($1,$2,'سبب تجريبي',$3::date,'morning') RETURNING id", [name, phone, tomorrow])).rows[0].id;
      ids.confirm = await add("طالبة حجز تجريبية", "0500000201");
      ids.reject = await add("طلب مكرّر تجريبي", "0500000202");
      ids.stranger = await add("طالب حجز جديد", "0500000203");
      for (const [key, value] of [["clinic.chairs", "1"], ["clinic.day_start", "00:00"], ["clinic.day_end", "23:59"]]) {
        await db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
      }
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the queue needs the whole appointment scope; a new person needs patients.create; Arabic refusals", async () => {
  const desk = await journey.login("desk");
  const list = await journey.api("/api/booking-requests?status=new", desk.cookie);
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toMatch(/no-store/);
  expect((await list.json()).map((row: { fullName: string }) => row.fullName)).toEqual(["طالبة حجز تجريبية", "طلب مكرّر تجريبي", "طالب حجز جديد"]);
  const doctor = await journey.login("doctor");
  const refused = await journey.api("/api/booking-requests?status=new", doctor.cookie);
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  const booker = await journey.login("booker");
  const needsPatients = await journey.api(`/api/booking-requests/${ids.stranger}`, booker.cookie, { method: "PATCH", body: JSON.stringify({ action: "confirm", date: tomorrow, time: "12:00" }) });
  expect(needsPatients.status).toBe(403);
  expect(await needsPatients.json()).toMatchObject({ code: "patient_create_required", message: expect.stringMatching(ARABIC) });
  const cannotReject = await journey.api(`/api/booking-requests/${ids.stranger}`, booker.cookie, { method: "PATCH", body: JSON.stringify({ action: "reject" }) });
  expect(cannotReject.status).toBe(403);
  expect((await journey.db.query("SELECT status FROM booking_requests WHERE id=$1", [ids.stranger])).rows[0].status).toBe("new");
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the desk opens «طلبات الحجز» from the shell, confirms one and closes another; both audited", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  const failures: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await journey.browserLogin(page, "desk");
  apiCalls.length = 0; failures.length = 0;
  await page.getByRole("link", { name: "طلبات الحجز" }).first().click();
  await page.waitForURL(/\/requests$/);
  const card = page.locator("li").filter({ hasText: "طالبة حجز تجريبية" });
  await card.getByRole("button", { name: "حدّد موعدًا" }).click();
  await card.locator('input[type="time"]').fill("09:30");
  await card.getByRole("button", { name: "تأكيد الحجز" }).click();
  await page.getByText("تم الحجز. أبلغ المريض الآن:").waitFor();
  await page.locator("li").filter({ hasText: "طلب مكرّر تجريبي" }).getByRole("button", { name: "إغلاق" }).click();
  await page.locator("li").filter({ hasText: "طلب مكرّر تجريبي" }).waitFor({ state: "detached" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && path !== "/api/booking-requests" && !/^\/api\/booking-requests\/\d+$/.test(path))).toEqual([]);
  expect(failures).toEqual([]);
  await context.close();
  const { rows } = await journey.db.query("SELECT id, status FROM booking_requests WHERE id = ANY($1::int[]) ORDER BY id", [[ids.confirm, ids.reject]]);
  expect(rows.map(row => row.status)).toEqual(["confirmed", "rejected"]);
  const audit = await journey.db.query("SELECT action, actor FROM audit_log WHERE action IN ('booking_request.confirm','booking_request.reject','appointment.create') ORDER BY id");
  expect(audit.rows).toEqual([
    { action: "appointment.create", actor: "canon-br-desk" }, { action: "booking_request.confirm", actor: "canon-br-desk" },
    { action: "booking_request.reject", actor: "canon-br-desk" },
  ]);
  expect(await journey.ddlLog()).toEqual([]);
});
