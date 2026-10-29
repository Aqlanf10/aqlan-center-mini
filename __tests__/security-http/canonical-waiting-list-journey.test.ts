/**
 * M2 slice 14 — canonical waiting list, built application, owned database and server.
 *
 * UI → HTTP → DB with password logins: the appointment scope decides rows, the writes
 * need `appointments.edit` and an entry inside the scope, refusals carry an Arabic
 * `message`, the screen calls only canonical routes, and no request runs DDL.
 * Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const EDIT = { "appointments.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "canon-wl-owner", password: "Canon#WLOwner1", role: "admin", display: "المالك التجريبي" },
  reception: { username: "canon-wl-reception", password: "Canon#WLReception1", role: "reception", display: "استقبال المواعيد", appointmentScope: "all", grants: EDIT },
  viewer: { username: "canon-wl-viewer", password: "Canon#WLViewer1", role: "reception", display: "اطلاع على المواعيد", appointmentScope: "all" },
  doctor: { username: "canon-wl-doctor", password: "Canon#WLDoctor1", role: "doctor", display: "طبيب تجريبي", doctor: true, appointmentScope: "own", grants: EDIT },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let entryOther = 0, entryMine = 0;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 15, secret: "canonical-waiting-list-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,'0500000000',$3) RETURNING id", [number, name, doctor])).rows[0].id;
      const mine = await patient("SYN-WLJ-1", "مريضة تنتظر عند الطبيب", parties.doctor!);
      const other = await patient("SYN-WLJ-2", "مريض ينتظر موعدًا", null);
      entryMine = (await db.query<{ id: number }>("INSERT INTO waiting_list(patient_id,doctor_id,urgency,preferred_period,created_by) VALUES($1,$2,'soon','any','synthetic') RETURNING id", [mine, parties.doctor!])).rows[0].id;
      entryOther = (await db.query<{ id: number }>("INSERT INTO waiting_list(patient_id,urgency,preferred_period,created_by) VALUES($1,'normal','any','synthetic') RETURNING id", [other])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const patch = (cookie: string, id: number, body: unknown) => journey.api(`/api/waiting-list/${id}`, cookie, { method: "PATCH", body: JSON.stringify(body) });

it("HTTP: rows by appointment scope; writes need appointments.edit and an entry inside the scope", async () => {
  const doctor = await journey.login("doctor");
  const own = await (await journey.api("/api/waiting-list?withHistory=1", doctor.cookie)).json();
  expect(own.entries.map((entry: { id: number }) => entry.id)).toEqual([entryMine]);
  const outside = await patch(doctor.cookie, entryOther, { action: "offer" });
  const missing = await patch(doctor.cookie, 999_999, { action: "offer" });
  expect([outside.status, missing.status]).toEqual([404, 404]);
  expect(await outside.json()).toEqual(await missing.json());

  const viewer = await journey.login("viewer");
  const all = await journey.api("/api/waiting-list", viewer.cookie);
  expect(all.status).toBe(200);
  expect(all.headers.get("cache-control")).toMatch(/no-store/);
  expect((await all.json()).canEdit).toBe(false);
  const denied = await patch(viewer.cookie, entryOther, { action: "offer" });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);

  const reception = await journey.login("reception");
  const book = await patch(reception.cookie, entryOther, { action: "book", date: "2026-11-02", time: "10:00" });
  expect(book.status).toBe(409);
  expect(await book.json()).toMatchObject({ code: "waiting_action_not_canonical" });
  const slot = await journey.api("/api/waiting-list?date=2026-11-02&time=10:00", reception.cookie);
  expect(slot.status).toBe(409);
  expect((await slot.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: reception opens the waiting list from the shell and records a call; the viewer sees no write controls", async () => {
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
  await page.getByRole("link", { name: "قائمة الانتظار" }).first().click();
  await page.waitForURL(/\/waiting-list$/);
  const row = page.locator(`[data-waiting-entry="${entryOther}"]`);
  await row.getByText("مريض ينتظر موعدًا").waitFor();
  await row.locator('[data-action="contact"]').click();
  await row.locator('[data-field="contact-note"]').fill("اتصال تجريبي");
  await row.locator('[data-action="confirm-contact"]').click();
  await page.getByText("سُجّلت المكالمة.").waitFor();
  await row.locator('[data-action="history"]').waitFor();
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => { const r = el.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }).slice(0, 8).map(el => `${el.tagName}.${(el.getAttribute("class") ?? "").slice(0, 80)} [${Math.round(el.getBoundingClientRect().left)},${Math.round(el.getBoundingClientRect().right)}] ${(el.textContent ?? "").slice(0, 30)}`));
  expect(wide).toEqual([]);
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path) && path !== "/api/waiting-list" && path !== `/api/waiting-list/${entryOther}`)).toEqual([]);
  expect(failures).toEqual([]);
  // The page itself does not send canonical sessions to the booking screen (the shell's
  // own «المواعيد» entry is the read-only canonical day view).
  expect(await page.locator('main a[href="/appointments"]').count()).toBe(0);
  await context.close();
  const { rows } = await journey.db.query("SELECT action, actor FROM audit_log WHERE entity='waiting_list' AND entity_id=$1::text ORDER BY id", [entryOther]);
  expect(rows).toEqual([{ action: "waiting_list.contact", actor: "canon-wl-reception" }]);

  const viewerContext = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const viewerPage = await viewerContext.newPage();
  await journey.browserLogin(viewerPage, "viewer");
  await viewerPage.goto(`${journey.baseUrl}/waiting-list`);
  await viewerPage.locator(`[data-waiting-entry="${entryOther}"]`).getByText("مريض ينتظر موعدًا").waitFor();
  expect(await viewerPage.locator('[data-action="contact"], [data-action="edit-preferences"], [data-action="close"]').count()).toBe(0);
  await viewerContext.close();
  expect(await journey.ddlLog()).toEqual([]);
});
