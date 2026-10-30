/**
 * M2 slice 24 — canonical recall, built application, owned database and server.
 *
 * UI → HTTP → DB with password logins: the lists follow the patient scope; recording a
 * follow-up needs appointments.create; closing a past booking goes through the
 * canonical appointment move; «حجز موعد» opens the canonical booking form with the
 * patient chosen; the screen calls only canonical routes; no request runs DDL.
 * Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-rc-owner", password: "Canon#RCOwner1", role: "admin", display: "المالك التجريبي" },
  desk: { username: "canon-rc-desk", password: "Canon#RCDesk1", role: "reception", display: "متابعة المرضى", patientScope: "all", appointmentScope: "all",
    grants: { "appointments.create": true, "appointments.edit": true, "visits.manage": true } },
  doctor: { username: "canon-rc-doctor", password: "Canon#RCDoctor1", role: "doctor", display: "طبيب تجريبي", doctor: true, patientScope: "own", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { missed: 0, open: 0, mine: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 23, secret: "canonical-recall-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,created_at) VALUES ($1,$2,'0500000501',$3,NOW() - INTERVAL '200 days') RETURNING id", [number, name, doctor])).rows[0].id;
      ids.mine = await patient("SYN-RCJ-1", "مريضة الطبيب المنقطعة", parties.doctor!);
      const other = await patient("SYN-RCJ-2", "مريض غاب عن موعده", null);
      ids.missed = (await db.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,(NOW() AT TIME ZONE 'Asia/Aden')::date - 3,'10:00','no_show') RETURNING id", [other])).rows[0].id;
      ids.open = (await db.query<{ id: number }>("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,(NOW() AT TIME ZONE 'Asia/Aden')::date - 2,'11:00','booked') RETURNING id", [other])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: the lists follow the patient scope; recording needs appointments.create", async () => {
  const doctor = await journey.login("doctor");
  const own = await journey.api("/api/recall?weeks=6", doctor.cookie);
  expect(own.status).toBe(200);
  const body = await own.json();
  expect(body.missed).toEqual([]);
  expect(body.lapsed.map((row: { id: number }) => row.id)).toEqual([ids.mine]);
  expect(body.canRecord).toBe(false);
  const refused = await journey.api("/api/recall", doctor.cookie, { method: "POST", body: JSON.stringify({ kind: "lapsed", id: ids.mine }) });
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the desk opens «المتابعة», closes a past booking, records a follow-up, and books from the canonical form", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  const failures: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await journey.browserLogin(page, "desk");
  apiCalls.length = 0; failures.length = 0;
  await page.getByRole("link", { name: "المتابعة" }).first().click();
  await page.waitForURL(/\/recall$/);
  const pending = page.getByRole("region", { name: "مواعيد معلّقة" });
  await pending.getByRole("button", { name: "تمّت" }).click();
  await pending.getByRole("button", { name: "تمّت" }).waitFor({ state: "detached" });
  const missed = page.getByRole("region", { name: "متغيّبون" });
  await missed.getByRole("button", { name: /تمت المتابعة/ }).click();
  await missed.getByText("لا يوجد مرضى بانتظار متابعة غياب.").waitFor();
  const lapsed = page.getByRole("region", { name: "منقطعون" });
  await lapsed.getByRole("button", { name: /حجز موعد/ }).first().click();
  await page.waitForURL(/\/appointments\?bookPatient=\d+/);
  await page.getByTestId("booking-form").getByLabel("المريض").waitFor();
  expect(await page.getByTestId("booking-form").getByLabel("المريض").inputValue()).toMatch(/مريضة الطبيب المنقطعة|مريض غاب عن موعده/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const allowed = /^\/api\/(auth\/(login|me)|recall|appointments(\/\d+)?|provider-blocks)$/;
  expect(apiCalls.filter(path => !allowed.test(path))).toEqual([]);
  expect(failures).toEqual([]);
  await context.close();
  expect((await journey.db.query("SELECT status FROM appointments WHERE id=$1", [ids.open])).rows[0].status).toBe("done");
  expect((await journey.db.query("SELECT follow_up_at IS NOT NULL AS done FROM appointments WHERE id=$1", [ids.missed])).rows[0].done).toBe(true);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='recall.contact'")).rows).toEqual([{ actor: "canon-rc-desk" }]);
  expect(await journey.ddlLog()).toEqual([]);
});
