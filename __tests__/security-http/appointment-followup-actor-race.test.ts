import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { chromium, type Browser } from 'playwright';
import { baseUrl, harness } from './_server';
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
it('held successful context GET cannot let another cookie actor commit or erase the original actor intent', async () => {
  const { rows: [source] } = await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,'2000-01-01','10:00','no_show') RETURNING id", [h.seeded.patientAId]);
  const endpoint = `${baseUrl}/api/appointments/${source.id}/followup`;
  const context = await browser.newContext();
  const setActor = async (cookie: string) => {
    const [name, ...value] = cookie.split('=');
    await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  };
  await setActor(h.sessions.reception.cookie);
  const page = await context.newPage();
  const open = async () => {
    await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=summary`);
    await page.getByRole('region', { name: 'مواعيد المريض', exact: true }).getByRole('button', { name: 'السابقة والمغلقة' }).click();
    const row = page.locator(`[data-patient-appointment="${source.id}"]`);
    await row.getByRole('button', { name: 'متابعة الغياب', exact: true }).click();
    return row.getByRole('region', { name: 'إجراء متابعة الغياب' });
  };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const editor = await open();
    await page.route(endpoint, route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    await editor.getByRole('button', { name: 'فتح متابعة', exact: true }).click();
    await expect.poll(() => editor.getByRole('button', { name: 'إعادة المحاولة نفسها', exact: true }).isEnabled()).toBe(true);
    const saved = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('appointment-followup:v1:'))!);
    expect(saved).toBeTruthy();
    await page.unroute(endpoint);
    let gotContext = false;
    await page.route(`${endpoint}?*`, async route => {
      const response = await route.fetch(); // authenticated as A, held after successful response
      expect(response.status()).toBe(200);
      gotContext = true;
      await held;
      await route.fulfill({ response });
    });
    const post = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
    await editor.getByRole('button', { name: 'إعادة المحاولة نفسها', exact: true }).click();
    await expect.poll(() => gotContext).toBe(true);
    await setActor(h.sessions.admin.cookie);
    release();
    const result = await post;
    expect(result.status()).toBe(409);
    await expect.poll(() => editor.getByRole('button', { name: 'إعادة المحاولة نفسها', exact: true }).count()).toBe(0);
    expect(await page.evaluate(key => localStorage.getItem(key), saved[0])).toBe(saved[1]);
    expect(Number((await db.query('SELECT count(*) FROM appointment_followups WHERE source_appointment_id=$1', [source.id])).rows[0].count)).toBe(0);
    await page.unroute(`${endpoint}?*`);
    await setActor(h.sessions.reception.cookie);
    const restored = await open();
    await restored.getByRole('button', { name: 'إعادة المحاولة نفسها', exact: true }).click();
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), saved[0])).toBeNull();
    const { rows } = await db.query('SELECT e.actor_user_id, e.request_id FROM appointment_followup_events e JOIN appointment_followups f ON f.id=e.followup_id WHERE f.source_appointment_id=$1', [source.id]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].actor_user_id)).toBe(saved[0].split(':')[2]);
    expect(rows[0].request_id).toBe(JSON.parse(saved[1]).requestId);
  } finally { release(); await context.close(); }
});

it('characterizes remaining recovery blocker: an uncommitted expired intent stays preserved after repeat refusals', async () => {
  const { rows: [source] } = await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,'2000-01-01','10:00','no_show') RETURNING id", [h.seeded.patientAId]);
  const endpoint = `${baseUrl}/api/appointments/${source.id}/followup`;
  const snapshot = await (await fetch(`${endpoint}?patientId=${h.seeded.patientAId}`, { headers: { Cookie: h.sessions.reception.cookie } })).json();
  const key = `appointment-followup:v1:${snapshot.actorUserId}:${h.seeded.patientAId}:${source.id}`;
  const raw = JSON.stringify({ ...snapshot.source, expectedActorUserId: snapshot.actorUserId, requestId: crypto.randomUUID(), expectedRevision: 0, assigneeUserId: snapshot.actorUserId, dueAt: '2000-01-01T00:00:00.000Z', status: 'open', outcome: 'pending', nextStep: 'call' });
  const context = await browser.newContext();
  const [name, ...value] = h.sessions.reception.cookie.split('=');
  await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=summary`);
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
    await page.getByRole('region', { name: 'مواعيد المريض', exact: true }).getByRole('button', { name: 'السابقة والمغلقة' }).click();
    const row = page.locator(`[data-patient-appointment="${source.id}"]`);
    await row.getByRole('button', { name: 'متابعة الغياب', exact: true }).click();
    const editor = row.getByRole('region', { name: 'إجراء متابعة الغياب' });
    for (let i = 0; i < 2; i++) {
      const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
      await editor.getByRole('button', { name: 'إعادة المحاولة نفسها', exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(400);
      expect((await response.json()).code).toBe('FOLLOWUP_DUE_MUST_BE_FUTURE');
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(raw);
      await editor.getByRole('button', { name: 'تحديث السياق مع إبقاء الطلب', exact: true }).click();
      await expect.poll(() => editor.getByRole('button', { name: 'إعادة المحاولة نفسها', exact: true }).isEnabled()).toBe(true);
    }
    expect(await editor.getByRole('button', { name: 'فتح متابعة', exact: true }).count()).toBe(0);
    expect(Number((await db.query('SELECT count(*) FROM appointment_followups WHERE source_appointment_id=$1', [source.id])).rows[0].count)).toBe(0);
  } finally { await context.close(); }
});
