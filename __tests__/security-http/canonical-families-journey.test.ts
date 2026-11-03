/**
 * M2 slice 72 — canonical patient families, built application, owned database and server.
 * Synthetic data only.
 *
 * - HTTP: create idempotent by request key (a repeat returns the same family), writes need
 *   patients.edit, an own scope never learns a family without its patients, money only
 *   with finance.patient-ledger.view (owner rule) — never in write responses.
 * - Browser: reception creates a family from the canonical patient file and links a
 *   second patient with clicks; only canonical requests; no request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-fam-owner", password: "Canon#FamOwner1", role: "admin", display: "المالك التجريبي" },
  reception: { username: "canon-fam-rec", password: "Canon#FamRec1", role: "reception", display: "استقبال العائلات", patientScope: "all",
    grants: { "patients.edit": true } },
  viewer: { username: "canon-fam-view", password: "Canon#FamView1", role: "reception", display: "مطّلع", patientScope: "all" },
  ledger: { username: "canon-fam-ledger", password: "Canon#FamLedger1", role: "accountant", display: "محاسب الحسابات", patientScope: "all",
    grants: { "finance.patient-ledger.view": true } },
  doctor: { username: "canon-fam-doc", password: "Canon#FamDoc1", role: "doctor", display: "طبيب تجريبي", doctor: true, patientScope: "own" },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { head: 0, child: 0, mine: 0, family: 0 };
const send = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 120, secret: "canonical-families-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string, phone: string, doctor: number | null) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,$3,$4) RETURNING id", [number, name, phone, doctor])).rows[0].id;
      ids.head = await patient("SYN-FJ-1", "عبدالله العائلي", "0500000951", null);
      ids.child = await patient("SYN-FJ-2", "مريم العائلية", "0500000952", null);
      ids.mine = await patient("SYN-FJ-3", "مريض الطبيب", "0500000953", parties.doctor!);
      await db.query("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES ($1,'YER',8800,'2031-01-01','synthetic')", [ids.head]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: create by request key, scope, the money projection and explicit refusals", async () => {
  const reception = await journey.login("reception");
  const body = { requestKey: "journey-family-key-0001", name: "عائلة العائلي", members: [{ patientId: ids.head, role: "father" }] };
  const created = await journey.api("/api/families", reception.cookie, send("POST", body));
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toContain("no-store");
  const family = await created.json();
  ids.family = family.id;
  expect(family).toMatchObject({ replayed: false, canSeeMoney: false, members: [{ id: ids.head }] });
  expect(JSON.stringify(family)).not.toContain("8800");
  const again = await (await journey.api("/api/families", reception.cookie, send("POST", body))).json();
  expect(again).toMatchObject({ id: ids.family, replayed: true });
  expect((await journey.db.query("SELECT count(*)::int AS n FROM patient_families")).rows[0].n).toBe(1);

  const viewer = await journey.login("viewer");
  const denied = await journey.api(`/api/families/${ids.family}`, viewer.cookie, send("PATCH", { note: "x" }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  const plain = await (await journey.api(`/api/families/${ids.family}`, viewer.cookie)).json();
  expect(plain.canSeeMoney).toBe(false);
  expect(JSON.stringify(plain)).not.toMatch(/8800|balances|totals/);
  const ledger = await (await journey.api(`/api/families/${ids.family}`, (await journey.login("ledger")).cookie)).json();
  expect(ledger.totals).toEqual([{ currency: "YER", balanceMinor: 8800 }]);

  const doctor = await journey.login("doctor");
  const hidden = await journey.api(`/api/families/${ids.family}`, doctor.cookie);
  expect(hidden.status).toBe(404);
  expect((await hidden.json()).message).toMatch(ARABIC);
  expect((await journey.api(`/api/families?q=${encodeURIComponent("العائلي")}`, doctor.cookie)).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: reception links a second patient to the family from the canonical file — canonical requests only", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await journey.browserLogin(page, "reception");
  await page.goto(`${journey.baseUrl}/patients/${ids.child}`);
  const profile = page.getByTestId("canonical-patient-profile");
  await profile.getByRole("heading", { name: "مريم العائلية" }).waitFor();
  await profile.getByRole("button", { name: "ربط بعائلة قائمة" }).click();
  await profile.getByLabel("ابحث عن عائلة").fill("العائلي");
  await profile.getByRole("button", { name: /ربط بعائلة عائلة العائلي/ }).click();
  await expect.poll(async () => (await journey.db.query<{ family_id: number | null }>("SELECT family_id FROM patients WHERE id=$1", [ids.child])).rows[0].family_id).toBe(ids.family);
  await profile.getByRole("link", { name: /عبدالله العائلي/ }).waitFor();
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='family.link' AND entity_id=$1::text", [String(ids.child)])).rows).toEqual([{ actor: "canon-fam-rec" }]);
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
