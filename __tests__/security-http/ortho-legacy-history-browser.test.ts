import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { monthsBefore } from '../../lib/ortho-baseline';
import { BUCKET_LABEL } from '../../lib/ortho-followup';
import { authedGet, baseUrl, harness } from './_server';

// Real built patient, board and print pages; real API/PG observations only.
// Requires explicit-duration entry and legacy unknown-follow-up product fixes.
// A historical baseline is not a treatment visit, T1 record, payment or recall.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const UNKNOWN_HISTORY = 'الحالة بدأت قبل النظام؛ تاريخ آخر جلسة تقويم غير مسجل. لا يمكن تقدير الاستحقاق أو مدة الانقطاع.';
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');
  expect(['127.0.0.1', 'localhost']).toContain(new URL(h.seeded.dbUrl).hostname);
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => { await browser?.close(); await db?.end(); });
async function counts(patientId: number) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM ortho_cases WHERE patient_id=$1) cases,
    (SELECT count(*)::int FROM visits WHERE patient_id=$1) visits,
    (SELECT count(*)::int FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE c.patient_id=$1) adjustments,
    (SELECT count(*)::int FROM ceph_analyses WHERE patient_id=$1) ceph,
    (SELECT count(*)::int FROM patient_documents WHERE patient_id=$1) documents,
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,
    (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) plans,
    (SELECT count(*)::int FROM patient_opening_balances WHERE patient_id=$1) openings`, [patientId])).rows[0];
}
type FollowupEvidence = { caseId: number; patientId: number; baselineKind: string | null; startDate: string;
  lastAdjustmentDate: string | null; dueDate: string | null; daysSinceLast: number | null; dueBasis: string; buckets: string[] };
it.each([390, 1280])('keeps unknown legacy durations explicit and avoids invented follow-up history at %ipx', async width => {
  const patientName = `Synthetic legacy history ${width} ${randomUUID().slice(0, 8)}`;
  const patientId = Number((await db.query('INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id', [randomUUID(), patientName])).rows[0].id);
  const empty = { cases: 0, visits: 0, adjustments: 0, ceph: 0, documents: 0, invoices: 0, payments: 0, plans: 0, openings: 0 };
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ar-YE', timezoneId: 'Asia/Aden', serviceWorkers: 'block' });
  const [name, ...value] = h.sessions.admin.cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  const posts: Record<string, unknown>[] = [], blocked: string[] = [], errors: string[] = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === baseUrl && ['GET', 'HEAD'].includes(request.method())) return route.continue();
    if (url.origin === baseUrl && request.method() === 'POST' && url.pathname === '/api/ortho/baseline' && !posts.length) {
      const body = request.postDataJSON() as Record<string, unknown>; posts.push(body);
      expect(body).toMatchObject({ patientId, monthsElapsed: 6, monthsRemaining: 12, financialMode: 'opening_balance', responsibleDoctorId: expect.any(Number) });
      const response = await route.fetch(); expect(response.status()).toBe(201);
      return route.fulfill({ response }); // Forward actual response, never fabricate business data.
    }
    blocked.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    await page.getByRole('button', { name: 'تسجيل حالة سابقة (قبل النظام)', exact: true }).click();
    const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'تسجيل حالة سابقة (قبل النظام)', exact: true }) });
    const elapsed = form.getByRole('textbox', { name: 'الأشهر المنقضية', exact: true });
    const remaining = form.getByRole('textbox', { name: 'الأشهر المتبقية', exact: true });
    const save = form.getByRole('button', { name: 'سجّل الحالة السابقة', exact: true });
    expect(await elapsed.inputValue()).toBe(''); expect(await remaining.inputValue()).toBe('');
    expect(await form.innerText()).not.toContain('بدء تقريبي:');
    await form.getByRole('combobox', { name: 'المرحلة الحالية', exact: true }).selectOption('working');
    await form.getByRole('combobox', { name: 'النظام المالي السابق', exact: true }).selectOption('opening_balance');
    // An administrator records a legacy case only with an explicitly chosen responsible doctor (#539).
    const doctor = form.getByRole('combobox', { name: 'الطبيب المسؤول', exact: true });
    await expect.poll(() => doctor.locator('option').count()).toBeGreaterThan(1);
    expect(await doctor.inputValue()).toBe(''); await doctor.selectOption({ index: 1 });
    const objectives = 'Synthetic remaining objectives preserved through validation';
    await form.getByRole('textbox', { name: 'الأهداف المتبقية', exact: true }).fill(objectives);
    await form.getByLabel('السلك العلوي الحالي', { exact: true }).fill('Synthetic recorded wire');
    const unchanged = async () => {
      expect(posts).toHaveLength(0); expect(await counts(patientId)).toEqual(empty);
      expect(await form.getByRole('textbox', { name: 'الأهداف المتبقية', exact: true }).inputValue()).toBe(objectives);
      expect(await form.getByLabel('السلك العلوي الحالي', { exact: true }).inputValue()).toBe('Synthetic recorded wire');
      expect(await form.getByRole('combobox', { name: 'النظام المالي السابق', exact: true }).inputValue()).toBe('opening_balance');
    };
    await save.click(); await page.getByText('الأشهر المنقضية: أدخل عددًا صحيحًا بين 0 و120؛ الفراغ ليس صفرًا.', { exact: true }).waitFor();
    await unchanged(); expect(await elapsed.inputValue()).toBe(''); expect(await remaining.inputValue()).toBe('');
    await elapsed.fill('6'); await save.click();
    await page.getByText('الأشهر المتبقية: أدخل عددًا صحيحًا بين 0 و120؛ الفراغ ليس صفرًا.', { exact: true }).waitFor();
    await unchanged(); expect(await remaining.inputValue()).toBe('');
    await remaining.fill('12'); await elapsed.fill('1e1'); await save.click();
    await page.getByText('الأشهر المنقضية: أدخل عددًا صحيحًا بين 0 و120؛ الفراغ ليس صفرًا.', { exact: true }).waitFor();
    await unchanged(); expect(await elapsed.inputValue()).toBe('1e1');
    await elapsed.fill('6'); await remaining.fill('121'); await save.click();
    await page.getByText('الأشهر المتبقية: أدخل عددًا صحيحًا بين 0 و120؛ الفراغ ليس صفرًا.', { exact: true }).waitFor();
    await unchanged(); expect(await remaining.inputValue()).toBe('121');
    await elapsed.fill(width === 390 ? '٠٦' : '۰۶'); await remaining.fill(width === 390 ? '١٢' : '۱۲');
    await save.click(); await form.waitFor({ state: 'hidden' }); expect(posts).toHaveLength(1);
    const cases = await authedGet(`/api/ortho?patientId=${patientId}`, h.sessions.admin); expect(cases.status).toBe(200);
    const listed = await cases.json(); expect(listed.cases).toHaveLength(1);
    const caseId = listed.cases[0].id;
    expect(listed.cases[0]).toMatchObject({ patientId, baselineKind: 'legacy', status: 'active', phase: 'working',
      startDate: monthsBefore(listed.today, 6), plannedMonths: 18, remainingObjectives: objectives });
    expect(await counts(patientId)).toEqual({ ...empty, cases: 1 });

    const feedResponse = await authedGet('/api/ortho/followups', h.sessions.admin); expect(feedResponse.status).toBe(200);
    const feed = await feedResponse.json() as { buckets: { bucket: string; rows: FollowupEvidence[] }[] };
    const matches = feed.buckets.flatMap(bucket => bucket.rows.filter(row => row.caseId === caseId));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ caseId, patientId, baselineKind: 'legacy', startDate: monthsBefore(listed.today, 6),
      lastAdjustmentDate: null, dueDate: null, daysSinceLast: null, dueBasis: 'legacy_adjustment_history_unknown', buckets: ['no_appointment'] });
    for (const bucket of feed.buckets.filter(bucket => ['lapsed_4', 'lapsed_6', 'lapsed_8', 'overdue'].includes(bucket.bucket))) {
      expect(bucket.rows.some(row => row.caseId === caseId)).toBe(false);
    }
    await page.goto(`${baseUrl}/ortho`);
    await page.getByRole('button', { name: new RegExp(`^${BUCKET_LABEL.no_appointment}`) }).click();
    const boardRow = page.locator('li').filter({ has: page.getByRole('link', { name: patientName, exact: true }) });
    await boardRow.getByText(UNKNOWN_HISTORY, { exact: true }).waitFor();
    expect(await boardRow.innerText()).not.toContain('آخر شدّ:');
    const caseLink = await boardRow.getByRole('link', { name: patientName, exact: true }).getAttribute('href');
    expect(caseLink).toBe(`/patients/${patientId}`); // Existing board link is patient-scoped; exact case is proven by feed and print below.
    const printLink = page.getByRole('link', { name: 'طباعة قائمة المتابعة المختارة', exact: true });
    expect(await printLink.getAttribute('href')).toBe('/print/ortho-followups?bucket=no_appointment');
    const popup = page.waitForEvent('popup'); await printLink.click(); const print = await popup;
    print.setDefaultTimeout(20000); print.on('pageerror', error => errors.push(error.message));
    const printed = print.locator('section').filter({ has: print.getByRole('heading', { name: `${patientName} · المريض #${patientId} · حالة التقويم #${caseId}`, exact: true }) });
    await printed.getByText(UNKNOWN_HISTORY, { exact: true }).waitFor();
    expect(await printed.innerText()).toContain('غير مسجلة؛ لا يثبت ذلك عدم إجراء علاج سابق');
    expect(await printed.innerText()).not.toContain('التاريخ المتوقع المشتق من اللوحة:');
    expect(await printed.innerText()).not.toContain(monthsBefore(listed.today, 6));
    expect(await counts(patientId)).toEqual({ ...empty, cases: 1 });
    expect(posts).toHaveLength(1); expect(blocked).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 180000);
