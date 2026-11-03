/**
 * M2 slice 68 — canonical lab-order creation, built application, owned database and
 * server. Synthetic data only.
 *
 * - POST /api/lab under clinical.lab.order inside the patient scope, with a request key:
 *   a repeat returns the same order (200, replayed), concurrent repeats create one order,
 *   a reused key for another request is refused; money and posting fields are refused.
 * - The board's form: a lost response (the server committed, the browser never saw the
 *   reply) is retried with the same key and answers "already recorded" — one order.
 * - Only canonical requests; no request runs DDL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-lc-owner", password: "Canon#LCOwner1", role: "admin", display: "المالك التجريبي" },
  coordinator: { username: "canon-lc-coord", password: "Canon#LCCoord1", role: "reception", display: "منسق المختبر", patientScope: "all",
    grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  viewer: { username: "canon-lc-view", password: "Canon#LCView1", role: "reception", display: "مطّلع", patientScope: "all",
    grants: { "clinical.lab.view": true } },
  doctor: { username: "canon-lc-doc", password: "Canon#LCDoc1", role: "doctor", display: "طبيب تجريبي", doctor: true, patientScope: "own",
    grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ctx = { patient: 0, browserPatient: 0, lab: 0, doctor: 0 };
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const ordersOf = async (patientId: number) => (await journey.db.query<{ n: number }>("SELECT count(*)::int AS n FROM lab_orders WHERE patient_id=$1", [patientId])).rows[0].n;

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 110, secret: "canonical-lab-create-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      const patient = async (number: string, name: string) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ($1,$2,'0500000820') RETURNING id", [number, name])).rows[0].id;
      ctx.patient = await patient("SYN-LCJ-1", "مريض تركيبات تجريبي");
      ctx.browserPatient = await patient("SYN-LCJ-2", "مريضة الجسر التجريبية");
      ctx.lab = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,currency) VALUES('مختبر الضياء التجريبي','lab','YER') RETURNING id")).rows[0].id;
      ctx.doctor = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES('د. تجريبي المعالج','doctor',TRUE) RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: one order per request key (repeat, concurrency), refusals in Arabic, money refused, scope and grant", async () => {
  const coordinator = await journey.login("coordinator");
  const input = { requestKey: randomUUID(), patientId: ctx.patient, partyId: ctx.lab, doctorId: ctx.doctor, workType: "تاج زيركون كامل",
    toothNumbers: "16", sentDate: "2031-04-01", dueDate: "2031-04-08" };
  const created = await journey.api("/api/lab", coordinator.cookie, post(input));
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toContain("no-store");
  const first = await created.json();
  expect(first).toMatchObject({ replayed: false, order: { patientId: ctx.patient, labName: "مختبر الضياء التجريبي", status: "sent" } });
  const repeat = await journey.api("/api/lab", coordinator.cookie, post(input));
  expect([repeat.status, (await repeat.json()).order.id]).toEqual([200, first.order.id]);

  const concurrent = { ...input, requestKey: randomUUID() };
  const responses = await Promise.all(Array.from({ length: 4 }, () => journey.api("/api/lab", coordinator.cookie, post(concurrent))));
  expect(responses.map(response => response.status).sort()).toEqual([200, 200, 200, 201]);
  expect(await ordersOf(ctx.patient)).toBe(2);

  const reused = await journey.api("/api/lab", coordinator.cookie, post({ ...input, toothNumbers: "17" }));
  expect(reused.status).toBe(409);
  expect(await reused.json()).toMatchObject({ code: "lab_request_key_reused", message: expect.stringMatching(ARABIC) });
  const money = await journey.api("/api/lab", coordinator.cookie, post({ ...input, requestKey: randomUUID(), cost: "5000" }));
  expect(money.status).toBe(409);
  expect(await money.json()).toMatchObject({ code: "lab_money_not_canonical", field: "cost", message: expect.stringMatching(ARABIC) });

  const viewer = await journey.login("viewer");
  const denied = await journey.api("/api/lab", viewer.cookie, post({ ...input, requestKey: randomUUID() }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  const doctor = await journey.login("doctor");
  expect((await journey.api("/api/lab", doctor.cookie, post({ ...input, requestKey: randomUUID(), doctorId: undefined }))).status).toBe(404);
  expect(await ordersOf(ctx.patient)).toBe(2);

  // The creation directory reaches only those who may create orders.
  expect(await (await journey.api("/api/lab", coordinator.cookie)).json()).toMatchObject({ labParties: [{ id: ctx.lab }], doctors: expect.arrayContaining([{ id: ctx.doctor, name: "د. تجريبي المعالج" }]) });
  expect(await (await journey.api("/api/lab", viewer.cookie)).json()).not.toHaveProperty("labParties");
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: a lost response is retried with the same key — one order, told it was already recorded; canonical requests only", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  const apiCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(`${request.method()} ${path}`); });
  await journey.browserLogin(page, "coordinator");
  await page.goto(`${journey.baseUrl}/lab`);
  const board = page.getByTestId("canonical-lab-board");
  await board.getByTestId("lab-create-open").click();
  const form = board.getByTestId("lab-create-form");
  await form.getByTestId("lab-create-patient").fill("الجسر");
  await form.locator(`[data-patient="${ctx.browserPatient}"]`).click();
  // The selection holds (a picker inside a <label> used to clear it on the forwarded click).
  await expect.poll(async () => `${await form.textContent()}`).toContain("مريضة الجسر التجريبية");
  await form.getByTestId("lab-create-party").selectOption(String(ctx.lab));
  await form.getByTestId("lab-create-doctor").selectOption(String(ctx.doctor));
  await form.getByTestId("lab-create-work").fill("جسر زيركون");
  await form.getByTestId("lab-create-teeth").fill("14, 15, 16");

  // The first submission reaches the server and commits, but its reply is lost.
  let dropped = false;
  await page.route("**/api/lab", async route => {
    if (route.request().method() === "POST" && !dropped) { dropped = true; await route.fetch(); await route.abort("connectionreset"); return; }
    await route.continue();
  });
  await form.getByTestId("lab-create-submit").click();
  await expect.poll(() => form.getByRole("alert").textContent()).toMatch(/أعد الإرسال بأمان/);
  expect(await ordersOf(ctx.browserPatient)).toBe(1);
  await form.getByTestId("lab-create-submit").click();
  await expect.poll(() => form.getByRole("status").textContent()).toMatch(/مسجّل سلفًا/);
  expect(await ordersOf(ctx.browserPatient)).toBe(1);
  await board.getByRole("button", { name: /عند المختبر/ }).click();
  await expect.poll(() => board.getByTestId("lab-orders").textContent()).toContain("مريضة الجسر التجريبية");

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(apiCalls.filter(call => !/^(GET|POST) \/api\/auth\/(login|me)$/.test(call) && !/^(GET \/api\/lab(\/backlog)?|POST \/api\/lab|GET \/api\/patients)$/.test(call))).toEqual([]);
  expect(await journey.ddlLog()).toEqual([]);
});
