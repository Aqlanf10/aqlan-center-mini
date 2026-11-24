import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { chromium } from "playwright";
import { authedGet, authedMutation, baseUrl, harness, TEST_USERS } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patient: number;
const stamp = Date.now();
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  patient = (await db.query("INSERT INTO patients(patient_number,full_name,medical_alert) VALUES($1,'Synthetic collection desk','Private-fixture') RETURNING id", [`COL-${stamp}`])).rows[0].id;
  await db.query("INSERT INTO cashier_shifts(opened_by) SELECT 'synthetic' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
});
afterAll(async () => { await db?.end(); });

it("ties the patient account, receipt retry and print to the authorised desk employee", async () => {
  const desk = h.sessions.reception;
  const ledger = `/api/patients/${patient}/ledger`;
  const assignment = `/api/patients/${patient}/collection-assignment`;
  const decision = (action: string) => JSON.stringify({ action, username: TEST_USERS.reception.username });
  const collect = (role: "reception" | "admin", amount: string) => authedMutation("/api/payments", h.sessions[role], "POST",
    JSON.stringify({ patientId: patient, currency: "YER", kind: "payment", method: "cash", amount }),
    { "Idempotency-Key": `desk-${role}-${stamp}` });
  expect((await authedGet(ledger, desk)).status).toBe(403);
  expect((await collect("reception", "13")).status).toBe(403);
  expect((await authedMutation(assignment, desk, "POST", decision("grant"))).status).toBe(403);
  expect((await authedMutation(assignment, h.sessions.admin, "POST", decision("grant"))).status).toBe(200);
  const posted = await collect("reception", "13");
  expect(posted.status).toBe(201);
  const receipt = await posted.json();
  const replay = await collect("reception", "13");
  expect(replay.status).toBe(200);
  expect((await replay.json()).id).toBe(receipt.id);
  const other = await collect("admin", "19");
  expect(other.status).toBe(201);
  const peer = await other.json();
  const account = await authedGet(ledger, desk);
  expect(account.status).toBe(200);
  const body = await account.json();
  expect(body.payments.map((row: {id: number}) => row.id)).toEqual([receipt.id]);
  expect(body.dueRecommendation.patientId).toBe(patient);
  expect(body).not.toHaveProperty("receiptProvenance");
  expect(JSON.stringify(body)).not.toContain("Private-fixture");
  expect((await authedGet(`/print/receipt/${receipt.id}`, desk)).status).toBe(200);
  expect((await authedGet(`/print/receipt/${peer.id}`, desk)).status).toBe(404);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const ctx = await browser.newContext();
    const [name, ...value] = desk.cookie.split("=");
    await ctx.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/patients/${patient}?tab=account`);
    await page.getByRole("button", { name: "تسجيل تحصيل" }).click();
    await page.getByRole("dialog", { name: "تحصيل دفعة" }).waitFor();
    expect(await page.getByRole("link", { name: new RegExp(receipt.receiptNumber) }).count()).toBe(1);
  } finally { await browser.close(); }
  expect((await authedMutation(assignment, h.sessions.admin, "POST", decision("revoke"))).status).toBe(200);
  expect((await authedGet(ledger, desk)).status).toBe(403);
  expect((await collect("reception", "13")).status).toBe(403);
  expect((await authedGet(`/print/receipt/${receipt.id}`, desk)).status).toBe(404);
  expect((await db.query("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1", [patient])).rows[0].n).toBe(2);
});

it("collects an existing repayment arrangement from the desk account for today's appointment", async () => {
  const id = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic scheduled debt') RETURNING id", [`DUE-${stamp}`])).rows[0].id;
  await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time) VALUES($1,(now() AT TIME ZONE 'Asia/Aden')::date,'09:00')", [id]);
  await db.query("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date) VALUES($1,'YER',1900,current_date)", [id]);
  const route = `/api/patients/${id}/debt-repayments`;
  const { targets } = await (await authedGet(route, h.sessions.admin)).json();
  const target = targets.find((row: { target: { openingCurrency: string } }) => row.target.openingCurrency === "YER");
  expect(target.remainingMinor).toBe(1900);
  const created = await authedMutation(route, h.sessions.admin, "POST", JSON.stringify({ ...target.target, patientId: undefined,
    expectedVersion: target.version, expectedSourceHash: target.sourceHash, expectedRemainingMinor: target.remainingMinor,
    reason: "Synthetic due date", terms: { mode: "full", installments: [] }, idempotencyKey: `schedule-${stamp}` }));
  expect(created.status, await created.clone().text()).toBe(201);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext();
    const [name, ...value] = h.sessions.reception.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/patients/${id}?tab=account`);
    const panel = page.getByTestId("debt-repayment-panel");
    await panel.getByRole("button", { name: "تحصيل دفعة فعلية" }).click();
    const observed = page.waitForResponse(response => response.url().startsWith(baseUrl + route) && response.url().endsWith("/collect"));
    await panel.getByRole("button", { name: "تأكيد التحصيل وإصدار السند" }).click();
    const response = await observed;
    expect(response.status(), await response.text()).toBe(201);
    await expect.poll(async () => (await db.query("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1 AND created_by=$2", [id, TEST_USERS.reception.username])).rows[0].n).toBe(1);
  } finally { await browser.close(); }
});
