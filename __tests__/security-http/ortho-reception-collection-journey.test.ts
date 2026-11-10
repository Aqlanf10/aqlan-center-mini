import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { formatMoney } from '../../lib/money';
import { blankClinicalObservationV2 } from '../../lib/ortho-assessment-clinical-fields';
import { assessmentCommandV2 } from '../fixtures/ortho-assessment-schema2';
import { authedGet, authedMutation, baseUrl, harness } from './_server';

// Real HTTP baseline/opening setup and explicit doctor review/signature; real
// browser arrival, two distinct deferrals, canonical account collection, checkout.
// No fabricated invoice, endpoint response, inferred procedure or clinical approval.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');
  expect(['127.0.0.1', 'localhost']).toContain(new URL(h.seeded.dbUrl).hostname);
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  await db.query(`INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd)
    SELECT 'synthetic-ortho-reception',0,0,0 WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')`);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => { await browser?.close(); await db?.end(); });
const eventually = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: 20000 });
async function get(path: string) {
  const response = await authedGet(path, h.sessions.reception); expect(response.status).toBe(200); return response.json();
}
async function post(who: 'reception' | 'doctorA', path: string, body: unknown, status = 201) {
  const response = await authedMutation(path, h.sessions[who], 'POST', JSON.stringify(body));
  expect(response.status).toBe(status); return response.json();
}
async function financialRows(patientId: number) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,
    (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) plans,
    (SELECT count(*)::int FROM patient_opening_balances WHERE patient_id=$1) openings,
    (SELECT count(*)::int FROM legacy_balance_arrangements WHERE patient_id=$1) arrangements,
    (SELECT COALESCE(sum(amount_minor),0)::text FROM patient_opening_balances WHERE patient_id=$1) opening_total,
    (SELECT COALESCE(sum(amount_minor),0)::text FROM payments WHERE patient_id=$1) payment_total`, [patientId])).rows[0];
}
it('connects an ortho arrival, deferred collection, one canonical opening receipt and exact checkout without repeated debt or signature', async () => {
  const patientName = `Synthetic ortho reception ${randomUUID().slice(0, 8)}`;
  const doctorId = (await db.query(`SELECT party_id FROM users WHERE username='secdoctora'`)).rows[0].party_id;
  const patientId = Number((await db.query(`INSERT INTO patients(patient_number,full_name,primary_doctor_id)
    VALUES($1,$2,$3) RETURNING id`, [randomUUID(), patientName, doctorId])).rows[0].id);
  const baseline = { patientId, phase: 'working', financialMode: 'opening_balance', monthsElapsed: 9, monthsRemaining: 9,
    remainingObjectives: 'Synthetic historical documentation only' };
  const ortho = await post('doctorA', '/api/ortho/baseline', baseline);
  await post('reception', '/api/opening-balances', { patientId, amount: '90000', currency: 'YER', note: 'Synthetic previously owed balance' });
  const arrangement = await post('reception', `/api/patients/${patientId}/legacy-balance-arrangement`, {
    currency: 'YER', cadence: 'per_visit', installmentAmount: '30000', note: 'Synthetic collection schedule, no additional debt',
  });
  const initial = { invoices: 0, payments: 0, plans: 0, openings: 1, arrangements: 1, opening_total: '90000', payment_total: '0' };
  expect(await financialRows(patientId)).toEqual(initial);
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'ar-YE', timezoneId: 'Asia/Aden', serviceWorkers: 'block' });
  const [name, ...value] = h.sessions.reception.cookie.split('=');
  await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  const errors: string[] = [], unexpected: string[] = [];
  const collections: { body: string; key: string; status: number }[] = [];
  let arrived = false, deferred = false, visitId = 0;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === baseUrl && ['GET', 'HEAD'].includes(method)) return route.continue();
    if (url.origin === baseUrl && method === 'POST' && url.pathname === '/api/visits' && !arrived
      && request.postDataJSON().patientId === patientId) { arrived = true; return route.continue(); }
    if (url.origin === baseUrl && method === 'PATCH' && url.pathname === `/api/visits/${visitId}` && !deferred
      && request.postDataJSON().action === 'defer') { deferred = true; return route.continue(); }
    if (url.origin === baseUrl && method === 'POST' && url.pathname === '/api/payments' && !collections.length) {
      const body = request.postData()!, key = request.headers()['idempotency-key'];
      expect(JSON.parse(body)).toMatchObject({ patientId, amount: '30000', currency: 'YER', openingCurrency: 'YER', kind: 'payment', method: 'cash' });
      expect(JSON.parse(body)).not.toHaveProperty('invoiceId'); expect(JSON.parse(body)).not.toHaveProperty('planId');
      expect(key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
      const response = await route.fetch(); collections.push({ body, key, status: response.status() });
      return route.fulfill({ response }); // Forward the actual server reply, never a synthetic response.
    }
    unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(baseUrl);
    const arrivalForm = page.locator('form').filter({ has: page.getByRole('heading', { name: 'وصل مريض', exact: true }) });
    await arrivalForm.getByRole('textbox', { name: 'اسم المريض', exact: true }).fill(patientName);
    await arrivalForm.getByRole('button', { name: new RegExp(patientName) }).click();
    await arrivalForm.getByRole('button', { name: 'وصل', exact: true }).click();
    const arrival = page.getByRole('dialog', { name: 'لوحة الوصول', exact: true });
    await arrival.getByText(/حالة تقويم/).waitFor();
    expect(await arrival.innerText()).toContain(formatMoney(90000, 'YER'));
    const panel = await get(`/api/patients/${patientId}/arrival-panel`);
    expect(panel.ortho).not.toBeNull();
    expect(panel.money.lines).toEqual([expect.objectContaining({ currency: 'YER', openingRemainingMinor: 90000 })]);
    expect(panel.money.suggestions).toEqual([expect.objectContaining({ kind: 'legacy', currency: 'YER', amountMinor: 30000 })]);
    const visits = (await db.query('SELECT id FROM visits WHERE patient_id=$1', [patientId])).rows;
    expect(visits).toHaveLength(1); visitId = Number(visits[0].id);
    await arrival.getByRole('button', { name: 'الدفع بعد العلاج', exact: true }).click();
    await arrival.waitFor({ state: 'hidden' });
    expect(await financialRows(patientId)).toEqual(initial);
    // Arrival dismissal is not the separately audited signed-visit deferral.
    expect((await db.query(`SELECT id FROM audit_log WHERE action='visit.payment_deferred' AND entity_id=$1`, [String(visitId)])).rows).toHaveLength(0);

    await post('reception', `/api/visits/${visitId}/clinical`, { action: 'save', treatmentDone: 'Must not be written' }, 403);
    await post('reception', '/api/ortho/baseline', baseline, 403);
    await post('reception', `/api/ortho/${ortho.id}/assessment`, {}, 403);
    expect(await financialRows(patientId)).toEqual(initial);
    // Explicit synthetic physician review; no procedure, adjustment or billable intervention is inferred.
    await post('doctorA', `/api/visits/${visitId}/clinical`, { action: 'save', doctorId, procedures: [], treatmentDone: 'Synthetic documented review only' }, 200);
    const signed = await post('doctorA', `/api/visits/${visitId}/clinical`, { action: 'sign' }, 200);
    expect(signed.invoiceId).toBeNull(); expect(signed.createdInvoiceId).toBeNull();
    const signature = (await db.query('SELECT signed_at FROM visits WHERE id=$1', [visitId])).rows[0].signed_at;
    expect(signature).toBeInstanceOf(Date); expect(await financialRows(patientId)).toEqual(initial);

    const checkoutUrl = `${baseUrl}/patients/${patientId}?tab=today&checkoutVisit=${visitId}`;
    await page.goto(checkoutUrl);
    const checkout = page.getByRole('region', { name: 'شبّاك ما بعد الزيارة', exact: true });
    await eventually(() => checkout.getAttribute('data-financial-state')).toBe('verified');
    expect(await checkout.getAttribute('data-visit-id')).toBe(String(visitId));
    expect(await page.getByRole('region', { name: 'زيارة اليوم', exact: true }).count()).toBe(0);
    const before = await get(`/api/visits/${visitId}/walkout`);
    expect(before.dueRecommendation).toMatchObject({ patientId, collectionAction: 'account', currencies: [expect.objectContaining({ currency: 'YER', currentBalanceMinor: 90000, dueNowMinor: 30000,
      sources: [expect.objectContaining({ kind: 'legacy_opening', authorityId: arrangement.id, openingCurrency: 'YER', invoiceId: null })] })] });
    page.once('dialog', dialog => void dialog.accept('Synthetic explicit checkout deferral'));
    await checkout.getByRole('button', { name: 'تأجيل الدفع', exact: true }).click();
    await checkout.getByText('أُجِّل الدفع — الرصيد باقٍ على المريض', { exact: true }).waitFor();
    expect(await financialRows(patientId)).toEqual(initial);
    expect((await db.query(`SELECT id FROM audit_log WHERE action='visit.payment_deferred' AND entity_id=$1`, [String(visitId)])).rows).toHaveLength(1);

    const accountLink = checkout.getByRole('link', { name: 'اختيار مصدر التحصيل ومراجعته من الحساب', exact: true });
    expect(await accountLink.getAttribute('href')).toBe(`/patients/${patientId}?tab=account`);
    const popup = page.waitForEvent('popup'); await accountLink.click(); const account = await popup;
    account.setDefaultTimeout(20000); account.on('pageerror', error => errors.push(error.message));
    await account.getByRole('button', { name: 'قبض دفعة', exact: true }).click();
    const modal = account.getByRole('dialog', { name: 'تحصيل دفعة', exact: true });
    await modal.getByRole('combobox', { name: 'رصيد سابق', exact: true }).selectOption('YER');
    await modal.getByRole('textbox', { name: 'المبلغ', exact: true }).fill('30000');
    await modal.getByRole('button', { name: 'سجّل الدفعة واطبع السند', exact: true }).click();
    await modal.waitFor({ state: 'hidden' }); expect(collections).toHaveLength(1); expect(collections[0].status).toBe(201);
    const receipt = (await db.query('SELECT id,receipt_number,invoice_id,opening_currency,amount_minor::text FROM payments WHERE patient_id=$1', [patientId])).rows;
    expect(receipt).toHaveLength(1); expect(receipt[0]).toMatchObject({ invoice_id: null, opening_currency: 'YER', amount_minor: '30000' });
    expect(receipt[0].receipt_number).toBeTruthy();
    const paid = { ...initial, payments: 1, payment_total: '30000' };
    expect(await financialRows(patientId)).toEqual(paid);
    // Retry the exact acknowledged request over actual HTTP; same-key replay must not collect again.
    const retry = await authedMutation('/api/payments', h.sessions.reception, 'POST', collections[0].body, { 'Idempotency-Key': collections[0].key });
    expect(retry.status).toBe(200); const replay = await retry.json();
    expect((replay.payment ?? replay).id).toBe(receipt[0].id);
    expect(await financialRows(patientId)).toEqual(paid);
    await post('doctorA', `/api/visits/${visitId}/clinical`, { action: 'sign' }, 409);
    expect((await db.query('SELECT signed_at,invoice_id FROM visits WHERE id=$1', [visitId])).rows).toEqual([{ signed_at: signature, invoice_id: null }]);
    expect((await db.query(`SELECT id FROM audit_log WHERE action='visit.sign' AND entity_id=$1`, [String(visitId)])).rows).toHaveLength(1);
    await page.reload();
    await eventually(() => checkout.getAttribute('data-financial-state')).toBe('verified');
    expect(await checkout.locator('[data-testid="checkout-current-balance"][data-currency="YER"]').innerText()).toContain(formatMoney(60000, 'YER'));
    const after = await get(`/api/visits/${visitId}/walkout`);
    expect(after).toMatchObject({ visitId, patientId, invoice: null, checkout: { current: { YER: 60000 } }, dueRecommendation: { currencies: [expect.objectContaining({ currency: 'YER', currentBalanceMinor: 60000, dueNowMinor: 0 })] } });
    expect(after.summary).toEqual([expect.objectContaining({ newBillableMinor: 0, paymentsTodayMinor: 30000, currentBalanceMinor: 60000, legacySuggestedMinor: 0, dueNowMinor: 0 })]);
    expect(await financialRows(patientId)).toEqual(paid);
    expect((await db.query('SELECT id FROM visits WHERE patient_id=$1', [patientId])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM ortho_cases WHERE patient_id=$1', [patientId])).rows).toEqual([{ id: ortho.id }]);
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  } finally { await context.close(); }
}, 180000);

// Requires the separate clinical-read privacy fix in the product build. This
// assertion must fail against a build that still admits reception assessment reads.
it('denies reception current, historical and problem-source assessment reads while preserving physician and front-desk access', async () => {
  const doctorId = (await db.query(`SELECT party_id FROM users WHERE username='secdoctora'`)).rows[0].party_id;
  const patientId = Number((await db.query(`INSERT INTO patients(patient_number,full_name,primary_doctor_id)
    VALUES($1,'Synthetic assessment privacy acceptance',$2) RETURNING id`, [randomUUID(), doctorId])).rows[0].id);
  const intake = await post('doctorA', '/api/ortho/intake', { patientId, command: {
    schemaVersion: 1, clientRequestId: randomUUID(), reason: 'Synthetic privacy acceptance intake',
  } });
  const caseId = intake.orthoCaseId, canary = `SYNTHETIC_PRIVATE_ASSESSMENT_${randomUUID()}`;
  const command = assessmentCommandV2(); command.commandId = randomUUID();
  const complaint = { ...blankClinicalObservationV2('chiefComplaint'), value: { state: 'recorded' as const, text: `${canary}_historical` },
    occurredOn: { state: 'unknown' as const, reason: 'Synthetic observation date deliberately unknown' },
    provenance: { performer: { state: 'documented' as const, attribution: 'Synthetic physician' },
      method: { kind: 'direct_examination' as const, version: 1 as const, description: 'Synthetic privacy acceptance observation' }, sources: [], copiedFrom: null } };
  command.content.observations.observations.push(complaint);
  const historical = await post('doctorA', `/api/ortho/${caseId}/assessment`, command);
  const next = structuredClone(command); next.commandId = randomUUID(); next.expectedRevisionId = historical.revision.id;
  next.reason = 'Synthetic explicit correction; historical value remains preserved';
  next.content.observations.observations.find(row => row.id === complaint.id)!.value = { state: 'recorded', text: `${canary}_current` };
  const current = await post('doctorA', `/api/ortho/${caseId}/assessment`, next);
  expect(current.revision.id).not.toBe(historical.revision.id);
  const revisionRows = async () => (await db.query('SELECT id,content_hash FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY id', [caseId])).rows;
  const before = await revisionRows(); expect(before).toHaveLength(2);
  for (const [suffix, id, text] of [
    ['', current.revision.id, `${canary}_current`],
    [`&revisionId=${historical.revision.id}`, historical.revision.id, `${canary}_historical`],
  ] as const) {
    const path = `/api/ortho/${caseId}/assessment?acceptSchema=1,2${suffix}`;
    const denied = await authedGet(path, h.sessions.reception);
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain(canary);
    const allowed = await authedGet(path, h.sessions.doctorA); expect(allowed.status).toBe(200);
    const body = await allowed.json(); expect(body.revision.id).toBe(id);
    expect(body.revision.content.draft.observations.observations.find((row: { id: string }) => row.id === complaint.id).value)
      .toEqual({ state: 'recorded', text });
  }
  await post('reception', `/api/ortho/${caseId}/assessment`, next, 403);
  const problems = `/api/ortho/${caseId}/problem-sources?patientId=${patientId}`;
  const problemDenied = await authedGet(problems, h.sessions.reception);
  expect(problemDenied.status).toBe(403); expect(await problemDenied.text()).not.toContain(canary);
  const problemAllowed = await authedGet(problems, h.sessions.doctorA); expect(problemAllowed.status).toBe(200);
  expect(await problemAllowed.text()).toContain(`${canary}_current`);
  expect(await revisionRows()).toEqual(before);
  await post('reception', '/api/opening-balances', { patientId, amount: '12000', currency: 'YER', note: 'Synthetic independent financial access' });
  const ledger = await get(`/api/patients/${patientId}/ledger`);
  expect(ledger.openings).toEqual([expect.objectContaining({ currency: 'YER', amountMinor: 12000 })]);
  expect(JSON.stringify(ledger)).not.toContain(canary);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Aden', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const appointments = await get(`/api/appointments?date=${date}`);
  expect(Array.isArray(appointments)).toBe(true); expect(JSON.stringify(appointments)).not.toContain(canary);
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'ar-YE', serviceWorkers: 'block' });
  const [cookieName, ...cookieValue] = h.sessions.reception.cookie.split('=');
  await context.addCookies([{ name: cookieName, value: cookieValue.join('='), url: baseUrl }]);
  const assessmentRequests: string[] = [], blocked: string[] = [], errors: string[] = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === baseUrl && url.pathname === `/api/ortho/${caseId}/assessment`) assessmentRequests.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === baseUrl && ['GET', 'HEAD'].includes(request.method())) return route.continue();
    blocked.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${caseId}&pillar=diagnostics`);
    // Wait for the selected case and diagnostics to render, not an empty/loading page.
    await page.getByText(`#${caseId}`, { exact: true }).first().waitFor();
    await page.getByRole('region', { name: 'السجلات والصور', exact: true }).waitFor();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.getByRole('button', { name: 'فتح التقييم السريري والقياسات', exact: true }).count()).toBe(0);
    expect(await page.getByTestId('ortho-case-assessment-v2').count()).toBe(0);
    expect(await page.getByRole('region', { name: 'نتائج المقابلة والفحص المحفوظة', exact: true }).count()).toBe(0);
    expect(await page.locator('body').innerText()).not.toContain(canary);
    expect(assessmentRequests).toEqual([]); expect(blocked).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); }
  expect(await revisionRows()).toEqual(before);
}, 120000);
