/**
 * M2 slice 25 — canonical provider blocks, built application, owned database and server.
 *
 * UI → HTTP → DB with password logins: a manager with appointments.schedule.manage
 * blocks a doctor's hours from the appointments day (with the overlap warning) and
 * cancels it; an own-scope doctor sees and blocks only itself; a reader sees the
 * blocks and cannot change them; the screen calls only canonical routes; no request
 * runs DDL. Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-pb-owner", password: "Canon#PBOwner1", role: "admin", display: "المالك التجريبي" },
  manager: { username: "canon-pb-manager", password: "Canon#PBManager1", role: "reception", display: "منسّق المواعيد", appointmentScope: "all",
    grants: { "appointments.schedule.manage": true } },
  reader: { username: "canon-pb-reader", password: "Canon#PBReader1", role: "reception", display: "استقبال", appointmentScope: "all", grants: {} },
  doctor: { username: "canon-pb-doctor", password: "Canon#PBDoctor1", role: "doctor", display: "طبيب تجريبي", doctor: true, appointmentScope: "own",
    grants: { "appointments.schedule.manage": true } },
  other: { username: "canon-pb-other", password: "Canon#PBOther1", role: "doctor", display: "طبيب آخر", doctor: true, appointmentScope: "own", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let today = "";

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 31, secret: "canonical-provider-blocks-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      today = (await db.query<{ d: string }>("SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date)::text AS d")).rows[0].d;
      const patient = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-PBJ-1','مريض موعده في وقت الحجب','0500000600') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,status,doctor_id) VALUES ($1,$2::date,'10:00',30,'booked',$3)", [patient, today, parties.doctor!]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const iso = (time: string) => new Date(`${today}T${time}:00+03:00`).toISOString();

it("HTTP: scope bounds the read and the write; the grant is required; refusals are Arabic", async () => {
  const doctor = await journey.login("doctor");
  const own = await (await journey.api(`/api/provider-blocks?date=${today}`, doctor.cookie)).json();
  expect(own.doctors.map((d: { id: number }) => d.id)).toEqual([journey.parties.doctor]);
  const created = await journey.api("/api/provider-blocks", doctor.cookie, { method: "POST", body: JSON.stringify({ providerId: journey.parties.doctor, startsAt: iso("09:30"), endsAt: iso("11:00"), reason: "عملية" }) });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ overlappingAppointments: 1 });
  const foreign = await journey.api("/api/provider-blocks", doctor.cookie, { method: "POST", body: JSON.stringify({ providerId: journey.parties.other, startsAt: iso("09:30"), endsAt: iso("11:00"), reason: "x" }) });
  expect(foreign.status).toBe(400);
  expect((await foreign.json()).message).toMatch(ARABIC);
  const reader = await journey.login("reader");
  const visible = await (await journey.api(`/api/provider-blocks?date=${today}`, reader.cookie)).json();
  expect(visible).toMatchObject({ canManage: false });
  expect(visible.blocks).toHaveLength(1);
  const denied = await journey.api("/api/provider-blocks", reader.cookie, { method: "POST", body: JSON.stringify({ providerId: journey.parties.doctor, startsAt: iso("12:00"), endsAt: iso("13:00"), reason: "x" }) });
  expect(denied.status).toBe(403);
  expect((await journey.api(`/api/provider-blocks/${visible.blocks[0].id}`, reader.cookie, { method: "DELETE" })).status).toBe(403);
  const otherDoctor = await journey.login("other");
  const hidden = await (await journey.api(`/api/provider-blocks?date=${today}&providerId=${journey.parties.doctor}`, otherDoctor.cookie)).json();
  expect(hidden.blocks).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the manager blocks a doctor's hours from the appointments day, sees the overlap warning, and cancels it", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  await journey.browserLogin(page, "manager");
  await page.goto(`${journey.baseUrl}/appointments`);
  const panel = page.getByTestId("provider-blocks-panel");
  await panel.locator("summary").click();
  await panel.getByTestId("provider-blocks-list").waitFor();
  const before = await panel.locator("[data-block]").count();
  const form = panel.getByTestId("provider-block-form");
  await form.getByLabel("الطبيب").selectOption(String(journey.parties.doctor));
  await form.getByLabel("السبب (إلزامي)").fill("مؤتمر طبي");
  await form.getByLabel("من الساعة").fill("10:00");
  await form.getByLabel("الساعة", { exact: true }).fill("10:30");
  await form.getByRole("button", { name: "حجب الوقت" }).click();
  await expect.poll(() => panel.getByRole("status").textContent()).toMatch(/1 موعدًا محجوزًا/);
  await expect.poll(() => panel.locator("[data-block]").count()).toBe(before + 1);
  const { rows: [row] } = await journey.db.query("SELECT id::text, starts_at, ends_at, created_by FROM provider_blocks WHERE reason='مؤتمر طبي'");
  expect([new Date(row.starts_at).toISOString(), new Date(row.ends_at).toISOString(), row.created_by]).toEqual([iso("10:00"), iso("10:30"), ACCOUNTS.manager.username]);
  await panel.locator(`[data-block="${row.id}"]`).getByRole("button", { name: "إلغاء الحجب" }).click();
  await expect.poll(() => panel.locator("[data-block]").count()).toBe(before);
  expect((await journey.db.query("SELECT cancelled_by FROM provider_blocks WHERE id=$1::bigint", [row.id])).rows[0].cancelled_by).toBe(ACCOUNTS.manager.username);
  await context.close();
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && !["/api/appointments", "/api/provider-blocks"].includes(path) && !/^\/api\/provider-blocks\/\d+$/.test(path))).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});
