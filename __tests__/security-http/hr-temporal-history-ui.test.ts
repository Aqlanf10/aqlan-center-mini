import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from './_server';
import { openHrJourneyServer } from './_hr-isolated-server';

let h: Awaited<ReturnType<typeof harness>>, owned: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser;
const evidence = process.env.HR_EVIDENCE_DIR ?? '/tmp/hr-temporal-native-evidence';
async function api(method: string, path: string, body?: unknown, cookie = h.sessions.admin.cookie) {
  const response = await fetch(owned.baseUrl + path, { method, headers: { cookie, origin: owned.baseUrl, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const input = (key: string, expectedRevision = 0, supersedeIds: string[] = [], status = 'active') => ({ requestId: key, expectedUsername: 'secadmin', expectedRevision, reason: 'سبب اصطناعي لتوثيق تاريخ مستقل', supersedeIds,
  append: [{ id: `fact-${key}`, kind: 'known', from: '2026-10-01', to: null, value: { status } }] });
async function staff(name: string, currency = 'YER') {
  const result = await api('POST', '/api/hr/staff', { fullName: name, jobTitle: 'استقبال تجريبي', department: 'secretariat', workStatus: 'active', hireDate: '2020-01-01', endDate: null, phone: null, note: null, contractKind: 'salary', salaryAmountMinor: 10000, salaryCurrency: currency, salaryPeriod: 'monthly', salaryEffectiveOn: '2026-01-01' });
  expect(result.status, JSON.stringify(result.body)).toBe(201); return result.body.staff?.id ?? result.body.id;
}
beforeAll(async () => {
  h = await harness(); owned = await openHrJourneyServer(h); mkdirSync(evidence, { recursive: true });
  // Withhold only the receipt table in this owned fixture to retain the original
  // partial-schema refusal assertion; the real runtime already registered0056–0058.
  const id = await staff('اختبار بوابة الإدماج');
  expect((await owned.db.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(row => row.version)).toEqual(['0051','0052','0056','0057','0058','0063','0064','0065','0066','0067','0068','0069','0070','0071']);
  await owned.db.query('ALTER TABLE hr_temporal_write_receipts RENAME TO synthetic_withheld_receipts');
  try { expect((await api('GET', `/api/hr/staff/${id}/history`))).toMatchObject({ status: 503, body: { code: 'integration_pending' } }); }
  finally { await owned.db.query('ALTER TABLE synthetic_withheld_receipts RENAME TO hr_temporal_write_receipts'); }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { try { await browser?.close(); } finally { await owned?.close(); } });
async function contextAt(width: number): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ar-YE', timezoneId: 'Asia/Aden' });
  const pair = h.sessions.admin.cookie.split(';')[0], split = pair.indexOf('='); await context.addCookies([{ name: pair.slice(0, split), value: pair.slice(split + 1), url: owned.baseUrl }]); return context;
}
async function openHistory(page: Page, name: string) {
  await page.getByRole('button', { name: `تاريخ العمل: ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `تاريخ العمل: ${name}`, exact: true });
  await dialog.getByRole('form', { name: 'توثيق التاريخ' }).waitFor(); return dialog;
}
async function layout(page: Page, region: Locator, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const result = await region.evaluate(element => ({ rtl: getComputedStyle(element).direction, viewport: innerWidth,
    pageWidth: document.documentElement.scrollWidth, pageClient: document.documentElement.clientWidth,
    width: element.scrollWidth, client: element.clientWidth, scrollX, regionX: element.scrollLeft,
    controls: [...element.querySelectorAll<HTMLElement>('input,select,textarea,button')].filter(c => c.getClientRects().length).map(c => { const r = c.getBoundingClientRect(); return { tag: c.tagName, left: r.left, right: r.right }; }) }));
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(result, null, 2));
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
  expect(result.rtl).toBe('rtl'); expect(result.pageWidth).toBeLessThanOrEqual(result.pageClient + 1); expect(result.width).toBeLessThanOrEqual(result.client + 1);
  expect(result.scrollX).toBe(0); expect(result.regionX).toBe(0);
  for (const c of result.controls) { expect(c.left, c.tag).toBeGreaterThanOrEqual(-1); expect(c.right, c.tag).toBeLessThanOrEqual(result.viewport + 1); }
}
async function save(page: Page, dialog: Locator, endpoint: string) {
  const button = dialog.getByRole('button', { name: 'توثيق الفترة', exact: true });
  const contrast = await button.evaluate(element => {
    const style = getComputedStyle(element), luminance = (color: string) => {
      const parts = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
    }; const fg = luminance(style.color), bg = luminance(style.backgroundColor); return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  }); expect(contrast).toBeGreaterThanOrEqual(4.5);
  const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST'), button.click()]);
  expect(response.status(), await response.text()).toBe(200);
  await expect.poll(() => dialog.getByRole('status').textContent()).toContain('بإيصال مطابق'); return response.json();
}
it('enforces real HTTP identity, forged fields, stale revisions and exact replay after later changes', async () => {
  const id = await staff('اختبار سلطة التاريخ'), endpoint = `/api/hr/staff/${id}/history`, body = input('http-signed-history-0001');
  expect((await api('GET', endpoint, undefined, '')).status).toBe(401);
  expect((await api('GET', endpoint, undefined, h.sessions.doctorA.cookie)).status).toBe(403);
  expect((await api('POST', endpoint, body, h.sessions.reception.cookie)).status).toBe(403);
  for (const field of ['actorUserId', 'staffId', 'operation', 'approval']) expect((await api('POST', endpoint, { ...body, [field]: 'forged' })).status).toBe(400);
  expect(await api('POST', endpoint, { ...body, expectedUsername: 'another-admin' })).toMatchObject({ status: 403, body: { code: 'owner_changed' } });
  const first = await api('POST', endpoint, body); expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ staffId: id, actorUsername: 'secadmin', activation: 'documented_only', revision: 1 });
  expect((await api('POST', endpoint, input('http-signed-history-0002', 1, [body.append[0].id], 'suspended'))).status).toBe(200);
  expect(await api('POST', endpoint, body)).toEqual(first);
  const stale = await api('POST', endpoint, input('http-signed-history-stale', 1, [body.append[0].id]));
  expect(stale).toMatchObject({ status: 409, body: { code: 'stale_revision', refusal: { confirmedNoCommitAttempt: true } } });
  expect((await api('GET', `/api/hr/payroll/history-preview?staffId=${id}&from=2026-10-01&to=2026-11-01&requiresProration=false`)).status).toBe(400);
  const read = await api('GET', endpoint + '?revision=1&day=2026-09-30'); expect(read.body.selected.kind).toBe('unknown'); expect(read.body.selectedRecord.reason).toBe(body.reason);
});

for (const width of [390, 1280]) {
  it(`uses native employment create, invalid range, correction, dated version and conflict reload at ${width}`, async () => {
    const name = `تاريخ موظف اصطناعي ${width}`, id = await staff(name), endpoint = `/api/hr/staff/${id}/history`, context = await contextAt(width);
    try {
      const page = await context.newPage(); await page.goto(owned.baseUrl + '/hr'); await page.getByRole('tab', { name: 'الطاقم' }).click(); const dialog = await openHistory(page, name);
      await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-10-10'); await dialog.getByLabel('نهاية السريان (غير مشمولة)', { exact: true }).fill('2026-10-01');
      await dialog.getByLabel('سبب التوثيق أو التصحيح').fill('إثبات تاريخ من مستند تجريبي');
      // A focus refresh replaces the private list, but must preserve this editor,
      // its unsaved fields and its admitted history write until explicit close.
      const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/hr/staff' && r.request().method() === 'GET');
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed;
      expect(await dialog.getByLabel('نهاية السريان (غير مشمولة)', { exact: true }).inputValue()).toBe('2026-10-01');
      expect(await dialog.getByLabel('سبب التوثيق أو التصحيح').inputValue()).toBe('إثبات تاريخ من مستند تجريبي');
      await dialog.getByRole('button', { name: 'توثيق الفترة', exact: true }).click(); await dialog.getByRole('alert').waitFor();
      expect((await api('GET', endpoint)).body.headRevision).toBe(0); await layout(page, dialog, `employment-invalid-${width}`);
      await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-10-01'); await dialog.getByLabel('نهاية السريان (غير مشمولة)', { exact: true }).fill(''); const first = await save(page, dialog, endpoint);
      await dialog.getByLabel('نوع التوثيق').selectOption('correct'); await dialog.getByLabel('الفترة الأصلية').selectOption(first.timeline.facts[0].id);
      await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-09-29'); await dialog.getByLabel('سبب التوثيق أو التصحيح').fill('تصحيح بداية موثقة دون محو الأصل'); const corrected = await save(page, dialog, endpoint);
      await dialog.getByLabel('نوع التوثيق').selectOption('version'); await dialog.getByLabel('الفترة الأصلية').selectOption(corrected.timeline.facts[0].id);
      await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-11-01'); await dialog.getByLabel('حالة العمل الموثقة').selectOption('suspended'); await dialog.getByLabel('سبب التوثيق أو التصحيح').fill('إيقاف مستقبلي موثق');
      // A different committed command invalidates the visible expected revision.
      const external = input(`native-external-${width}-0001`, 2, [corrected.timeline.facts[0].id]); external.append[0].from = '2026-09-29';
      const other = await api('POST', endpoint, external); expect(other.status).toBe(200);
      const [conflict] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === endpoint), dialog.getByRole('button', { name: 'توثيق الفترة', exact: true }).click()]); expect(conflict.status()).toBe(409);
      await expect.poll(() => dialog.getByRole('alert').textContent()).toContain('تغيّرت المراجعة'); await layout(page, dialog, `employment-conflict-${width}`);
      await dialog.getByRole('button', { name: 'إعادة تحميل أحدث مراجعة' }).click(); await expect.poll(() => dialog.textContent()).toContain('الأحدث: 3');
      await dialog.getByLabel('الفترة الأصلية').selectOption(other.body.timeline.facts[0].id); await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-11-01'); await dialog.getByLabel('حالة العمل الموثقة').selectOption('suspended');
      const version = await save(page, dialog, endpoint); expect(version.timeline.facts.map((f: { from: string; to: string | null }) => [f.from, f.to])).toEqual([['2026-09-29', '2026-11-01'], ['2026-11-01', null]]);
      await layout(page, dialog, `employment-version-${width}`);
      expect((await api('GET', endpoint + '?revision=1')).body.timeline).toEqual(first.timeline);
      expect((await owned.db.query('SELECT work_status,hire_date::text FROM hr_staff WHERE id=$1', [id])).rows[0]).toEqual({ work_status: 'active', hire_date: '2020-01-01' });
    } finally { await context.close(); }
  });
  it(`retains one exact request through native double click, lost response and modal reopen at ${width}`, async () => {
    const name = `طلب غير محسوم ${width}`, id = await staff(name), endpoint = `/api/hr/staff/${id}/history`, context = await contextAt(width);
    try {
      const page = await context.newPage(); await page.goto(owned.baseUrl + '/hr'); await page.getByRole('tab', { name: 'الطاقم' }).click(); let dialog = await openHistory(page, name);
      await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-10-01'); await dialog.getByLabel('سبب التوثيق أو التصحيح').fill('اختبار فقدان جواب محلي');
      const sent: unknown[] = []; let committed!: () => void; const done = new Promise<void>(resolve => { committed = resolve; });
      await page.route(`**${endpoint}`, async route => { if (route.request().method() !== 'POST') return route.continue(); sent.push(route.request().postDataJSON()); const result = await route.fetch(); expect(result.status()).toBe(200); await route.abort('failed'); committed(); });
      await dialog.getByRole('button', { name: 'توثيق الفترة', exact: true }).dblclick(); await done;
      await expect.poll(() => dialog.getByRole('alert').textContent()).toContain('غير محسومة'); expect(sent).toHaveLength(1);
      await dialog.getByRole('button', { name: 'إغلاق التاريخ' }).click(); dialog = await openHistory(page, name); await layout(page, dialog, `retained-request-${width}`);
      expect(await dialog.getByLabel('بداية السريان', { exact: true }).isDisabled()).toBe(true);
      await page.unroute(`**${endpoint}`); page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === endpoint) sent.push(request.postDataJSON()); });
      const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === endpoint), dialog.getByRole('button', { name: 'إعادة الطلب المحفوظ للتحقق' }).click()]); expect(response.status()).toBe(200);
      await expect.poll(() => dialog.getByRole('status').textContent()).toContain('بإيصال مطابق'); expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
      expect((await owned.db.query('SELECT count(*)::int AS n FROM hr_temporal_write_receipts WHERE staff_id=$1', [id])).rows[0].n).toBe(1);
      await layout(page, dialog, `replayed-receipt-${width}`);
    } finally { await context.close(); }
  });
  it(`documents an overnight split schedule and uses real settings and read-only payroll preview at ${width}`, async () => {
    const name = `وردية ليلية اصطناعية ${width}`, id = await staff(name), context = await contextAt(width);
    try {
      const page = await context.newPage(); await page.goto(owned.baseUrl + '/hr'); await page.getByRole('tab', { name: 'الدوام والحضور' }).click();
      await page.getByLabel('جدول مؤرخ لموظف').selectOption(String(id)); await page.getByRole('button', { name: `نسخ جدول الموظف: ${name}` }).click();
      const dialog = page.getByRole('dialog', { name: `نسخ جدول الموظف: ${name}` }); await dialog.getByRole('form', { name: 'توثيق التاريخ' }).waitFor();
      await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-10-01'); await dialog.getByLabel('الأحد', { exact: true }).check();
      await dialog.getByLabel('بداية المقطع 1', { exact: true }).fill('22:00'); await dialog.getByLabel('نهاية المقطع 1', { exact: true }).fill('02:00'); await dialog.getByLabel('يوم النهاية للمقطع 1').selectOption('1');
      await dialog.getByRole('button', { name: 'إضافة مقطع', exact: true }).click();
      await dialog.getByLabel('بداية المقطع 2', { exact: true }).fill('04:00'); await dialog.getByLabel('نهاية المقطع 2', { exact: true }).fill('06:00'); await dialog.getByLabel('يوم البداية للمقطع 2').selectOption('1'); await dialog.getByLabel('يوم النهاية للمقطع 2').selectOption('1');
      await dialog.getByLabel('سبب التوثيق أو التصحيح').fill('جدول اصطناعي بمقطعين بلا افتراض استحقاق'); const result = await save(page, dialog, `/api/hr/staff/${id}/schedule-history`);
      expect(result.timeline.facts[0].value.segments).toHaveLength(2); await layout(page, dialog, `schedule-overnight-${width}`); await dialog.getByRole('button', { name: 'إغلاق التاريخ' }).click();
      await page.getByRole('tab', { name: 'الإعدادات' }).click(); const settings = page.getByRole('region', { name: 'إعدادات الموارد البشرية' });
      await settings.getByLabel('العملة الافتراضية').selectOption('SAR'); await settings.getByLabel('يوم الراتب').fill('28'); await settings.getByLabel('يوم الإقفال').fill('27'); await settings.getByLabel('سماح الحضور بالدقائق').fill('10');
      const [saved] = await Promise.all([page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/hr/settings'), settings.getByRole('button', { name: 'حفظ الإعدادات التشغيلية' }).click()]); expect(saved.status()).toBe(200);
      await expect.poll(() => settings.getByRole('status').textContent()).toContain('حُفظت'); await layout(page, settings, `settings-${width}`);
      const settingsValue = await api('GET', '/api/hr/settings'); expect(settingsValue.body.payrollCycle).toMatchObject({ defaultCurrency: 'SAR', salaryDay: 28, cutoffDay: 27 });
      await page.getByRole('tab', { name: 'المسير والصرف' }).click(); const preview = page.getByRole('region', { name: 'معاينة التاريخ للرواتب' });
      await preview.getByLabel('موظف المعاينة').selectOption(String(id)); await preview.getByLabel('من تاريخ', { exact: true }).fill('2026-10-01'); await preview.getByLabel('إلى تاريخ (غير مشمول)').fill('2026-11-01');
      const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/hr/payroll/history-preview'), preview.getByRole('button', { name: 'عرض المعاينة التاريخية' }).click()]); expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ operationalReady: false, pinnedRevisions: { schedule: 1, employment: 0 } });
      await expect.poll(() => preview.textContent()).toContain('حالة العمل التاريخية غير معروفة'); await layout(page, preview, `payroll-history-${width}`);
    } finally { await context.close(); }
  });
}
