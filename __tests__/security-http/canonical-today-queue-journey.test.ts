/**
 * M2 slices 11–13 — canonical Today queue, arrival, queue moves and chair readiness, built application,
 * owned database and server.
 *
 * UI → HTTP → DB with password logins: the queue lists only visits inside the actor's
 * patient scope, the arrival needs `visits.manage` and a patient inside the scope,
 * refusals carry an Arabic `message`, the screen calls only canonical routes, and no
 * request runs DDL. Synthetic data only.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const MANAGE = { "visits.manage": true } as const;
const ACCOUNTS = {
  owner: { username: "canon-q-owner", password: "Canon#QOwner1", role: "admin", display: "المالك التجريبي" },
  reception: { username: "canon-q-reception", password: "Canon#QReception1", role: "reception", display: "استقبال الصالة", patientScope: "all", grants: { ...MANAGE, "patients.operational-summary.view": true } },
  viewer: { username: "canon-q-viewer", password: "Canon#QViewer1", role: "reception", display: "شاشة اطلاع", patientScope: "all" },
  doctor: { username: "canon-q-doctor", password: "Canon#QDoctor1", role: "doctor", display: "طبيب تقويم تجريبي", doctor: true, patientScope: "own", grants: { ...MANAGE, "clinical.plans.view": true } },
  other: { username: "canon-q-other", password: "Canon#QOther1", role: "doctor", display: "طبيب آخر تجريبي", doctor: true, patientScope: "own" },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
let mine = 0, theirs = 0;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 13, secret: "canonical-today-queue-journey-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string, doctor: number) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES($1,$2,'0500000000',$3) RETURNING id", [number, name, doctor])).rows[0].id;
      mine = await patient("SYN-QJ-1", "مريضة الطبيب التجريبية", parties.doctor!);
      theirs = await patient("SYN-QJ-2", "مريض الطبيب الآخر", parties.other!);
      await db.query("INSERT INTO visits(patient_name,note,patient_id,doctor_id,arrived_at) VALUES('مريض الطبيب الآخر','ملاحظة وصول تجريبية',$1,$2,NOW() - interval '40 minutes')", [theirs, parties.other!]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const arrive = (cookie: string, body: unknown) => journey.api("/api/visits", cookie, { method: "POST", body: JSON.stringify(body) });

it("HTTP: the queue follows the patient scope; the arrival needs visits.manage and a patient inside the scope", async () => {
  const reception = await journey.login("reception");
  const all = await journey.api("/api/visits", reception.cookie);
  expect(all.status).toBe(200);
  expect(all.headers.get("cache-control")).toMatch(/no-store/);
  expect(await all.json()).toMatchObject({ canManage: true, projection: { note: true }, visits: [{ patientName: "مريض الطبيب الآخر", note: "ملاحظة وصول تجريبية" }] });

  const doctor = await journey.login("doctor");
  expect((await (await journey.api("/api/visits", doctor.cookie)).json()).visits).toEqual([]);
  const outside = await arrive(doctor.cookie, { patientId: theirs, patientName: "x" });
  const missing = await arrive(doctor.cookie, { patientId: 999_999, patientName: "x" });
  expect([outside.status, missing.status]).toEqual([404, 404]);
  expect(await outside.json()).toEqual(await missing.json());

  const viewer = await journey.login("viewer");
  const denied = await arrive(viewer.cookie, { patientName: "مريض مرفوض" });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  const view = await journey.api("/api/visits?view=reception-handoff", reception.cookie);
  expect(view.status).toBe(409);
  expect((await view.json()).message).toMatch(ARABIC);

  const own = await arrive(doctor.cookie, { patientId: mine, patientName: "مريضة الطبيب التجريبية" });
  expect(own.status).toBe(201);
  const created = await own.json();
  expect(created).toMatchObject({ patientId: mine, doctorId: journey.parties.doctor });
  const again = await arrive(doctor.cookie, { patientId: mine, patientName: "مريضة الطبيب التجريبية" });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ code: "visit_already_active", visitId: created.id });
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: reception opens the Today queue from the shell, sees the waiting patient and registers a walk-in", async () => {
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
  await page.getByRole("link", { name: "قائمة اليوم" }).first().click();
  await page.waitForURL(/\/visits$/);
  const waiting = page.getByTestId("waiting-list");
  await waiting.getByText("مريض الطبيب الآخر").waitFor();
  await waiting.getByText("ملاحظة وصول تجريبية").waitFor();
  const form = page.getByTestId("arrival-form");
  await form.getByLabel("اسم المريض").fill("مراجع بلا ملف");
  await form.getByLabel("الجوال").fill("0577777777");
  await form.getByRole("button", { name: "وصل" }).click();
  await form.getByRole("status").filter({ hasText: "سُجّل وصول مراجع بلا ملف." }).waitFor();
  await waiting.getByText("مراجع بلا ملف").waitFor();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // Only canonical routes: the queue, its readiness, and the file search (debounced, may not fire).
  expect(apiCalls.filter(path => !/^\/api\/auth\/(login|me)$/.test(path)).every(path => ["/api/visits", "/api/visits/readiness", "/api/patients"].includes(path))).toBe(true);
  expect(apiCalls).toContain("/api/visits");
  expect(failures).toEqual([]);
  await context.close();
  const { rows } = await journey.db.query("SELECT a.actor FROM audit_log a JOIN visits v ON a.entity = 'visit' AND a.entity_id = v.id::text WHERE a.action = 'visit.create' AND v.patient_name = 'مراجع بلا ملف'");
  expect(rows.map(row => row.actor)).toEqual(["canon-q-reception"]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: a doctor without visits.manage sees only its own patients' queue and no arrival form", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "other");
  await page.goto(`${journey.baseUrl}/visits`);
  await page.getByTestId("canonical-today-queue").waitFor();
  await page.getByTestId("waiting-list").getByText("مريض الطبيب الآخر").waitFor();
  expect(await page.getByTestId("arrival-form").count()).toBe(0);
  expect(await page.getByText("ملاحظة وصول تجريبية").count()).toBe(0);
  await context.close();
});

const patch = (cookie: string, id: number, body: unknown) => journey.api(`/api/visits/${id}`, cookie, { method: "PATCH", body: JSON.stringify(body) });

it("HTTP: queue moves need visits.manage and a visit inside the scope; not-yet-canonical actions refuse", async () => {
  const { rows: [theirs] } = await journey.db.query<{ id: number }>("SELECT id FROM visits WHERE patient_name = 'مريض الطبيب الآخر'");
  const doctor = await journey.login("doctor");
  const outside = await patch(doctor.cookie, theirs.id, { action: "finish" });
  const missing = await patch(doctor.cookie, 999_999, { action: "finish" });
  expect([outside.status, missing.status]).toEqual([404, 404]);
  expect(await outside.json()).toEqual(await missing.json());
  const other = await journey.login("other");
  const denied = await patch(other.cookie, theirs.id, { action: "call", chair: 1 });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  const reception = await journey.login("reception");
  const defer = await patch(reception.cookie, theirs.id, { action: "defer" });
  expect(defer.status).toBe(409);
  expect(await defer.json()).toMatchObject({ code: "visit_action_not_canonical" });
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: reception calls, seats and finishes a waiting patient from the canonical queue", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`);
  });
  await journey.browserLogin(page, "reception");
  failures.length = 0;
  await page.goto(`${journey.baseUrl}/visits`);
  const row = page.getByTestId("waiting-list").getByRole("listitem").filter({ hasText: "مريض الطبيب الآخر" });
  await row.getByRole("button", { name: "نداء إلى كرسي 1" }).click();
  await page.getByTestId("move-message").filter({ hasText: "تنبيه: لم تُقَرّ جاهزية المريض بعد" }).waitFor();
  const chair = page.getByTestId("chair-1");
  await chair.getByText("نُودي على مريض الطبيب الآخر").waitFor();
  await chair.getByRole("button", { name: "جلس" }).click();
  await chair.getByText(/مريض الطبيب الآخر — منذ/).waitFor();
  await chair.getByRole("button", { name: "انتهى" }).click();
  await page.getByTestId("move-message").filter({ hasText: "انتهت زيارة مريض الطبيب الآخر." }).waitFor();
  await chair.getByText("فارغ").waitFor();
  expect(failures).toEqual([]);
  await context.close();
  const { rows } = await journey.db.query("SELECT a.action, a.actor FROM audit_log a JOIN visits v ON a.entity = 'visit' AND a.entity_id = v.id::text WHERE v.patient_name = 'مريض الطبيب الآخر' ORDER BY a.id");
  expect(rows).toEqual([
    { action: "visit.call", actor: "canon-q-reception" }, { action: "visit.seat", actor: "canon-q-reception" }, { action: "visit.finish", actor: "canon-q-reception" },
  ]);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: reception reads the readiness checklist and acknowledges it; a viewer without grants sees no checklist", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  const page = await context.newPage();
  await journey.browserLogin(page, "reception");
  await page.goto(`${journey.baseUrl}/visits`);
  const row = page.getByTestId("waiting-list").getByRole("listitem").filter({ hasText: "مريضة الطبيب التجريبية" });
  await row.getByText("لا تنبيهات طبية").waitFor();
  await row.getByRole("button", { name: "أقِرّ الجاهزية" }).click();
  await page.getByTestId("move-message").filter({ hasText: "أُقِرّت جاهزية مريضة الطبيب التجريبية." }).waitFor();
  await row.getByText("جاهز — أقرّه canon-q-reception").waitFor();
  expect(await row.getByRole("button", { name: "أقِرّ الجاهزية" }).count()).toBe(0);
  await context.close();

  const viewer = await journey.login("viewer");
  const view = await (await journey.api("/api/visits/readiness", viewer.cookie)).json();
  expect(view.projection).toEqual({ checklist: "none", balances: false });
  for (const item of view.items) expect(item).not.toHaveProperty("checklist");
  const other = await journey.login("other");
  const outside = await journey.api(`/api/visits/readiness?patientId=${mine}`, other.cookie);
  expect(outside.status).toBe(404);
  expect((await outside.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});
