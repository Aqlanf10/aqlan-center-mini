import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, type Harness } from './_server';
import { openHrJourneyServer } from './_hr-isolated-server';
let h: Harness, isolated: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser;
const evidence = process.env.HR_EVIDENCE_DIR ?? '/tmp/hr-profile-evidence';
const employees: Array<{ id: number; contractId: number; currency: string; amount: number; name: string }> = [];
let secondContractId: number;
async function api(method: string, path: string, body?: unknown, cookie = h.sessions.admin.cookie) {
  const response = await fetch(`${isolated.baseUrl}${path}`, { method, headers: { cookie, origin: isolated.baseUrl, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  h = await harness(); isolated = await openHrJourneyServer(h);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  mkdirSync(evidence, { recursive: true });
  for (const [currency, amount] of [['YER', 150000], ['SAR', 150055], ['USD', 150099]] as const) {
    const name = `ملف اصطناعي ${currency}`;
    const created = await api('POST', '/api/hr/staff', { fullName: name, department: 'secretariat', jobTitle: 'موظف اصطناعي', hireDate: '2026-01-01', endDate: null, phone: null, note: null, workStatus: 'active', contractKind: 'salary', salaryAmountMinor: 10000, salaryCurrency: currency, salaryPeriod: 'monthly', salaryEffectiveOn: '2026-01-01' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.staff?.id ?? created.body.id;
    const contract = await api('POST', '/api/hr/contracts', { staffId: id, title: `عقد اصطناعي ${currency}`, templateKind: 'support_staff', startDate: '2026-01-02', compensationKind: 'salary', baseSalaryMinor: amount, salaryCurrency: currency, salaryPeriod: 'monthly' });
    expect(contract.status, JSON.stringify(contract.body)).toBe(201);
    expect((await api('PATCH', `/api/hr/contracts/${contract.body.id}`, { action: 'transition', status: 'approved', reason: 'اعتماد اصطناعي' })).status).toBe(200);
    // Synthetic older profile observation left behind when a future agreement
    // becomes effective. The zero-write day rollover itself is proved on PostgreSQL.
    await isolated.db.query("UPDATE hr_staff SET salary_amount_minor=10000, salary_effective_on='2026-01-01' WHERE id=$1", [id]);
    employees.push({ id, contractId: contract.body.id, currency, amount, name });
  }
  const second = await api('POST', '/api/hr/contracts', { staffId: employees[0].id, title: 'عقد تنقل اصطناعي ثانٍ', templateKind: 'support_staff', startDate: '2099-02-01', compensationKind: 'salary', baseSalaryMinor: 175000, salaryCurrency: 'YER', salaryPeriod: 'monthly' });
  expect(second.status).toBe(201); secondContractId = second.body.id;
});
afterAll(async () => { await browser?.close(); await isolated?.close(); });
it('HTTP private current-pay projection is precise in all currencies and denied to other roles', async () => {
  for (const employee of employees) {
    const read = await api('GET', `/api/hr/staff/${employee.id}`);
    expect(read.body.staff.payTerms.amountMinor).toBe(10000);
    expect(read.body.staff.currentPay).toMatchObject({ source: 'contract', terms: { currency: employee.currency, salaryMinor: employee.amount }, contract: { id: employee.contractId }, profilePayLocked: true });
    for (const cookie of [h.sessions.reception.cookie, h.sessions.doctorA.cookie, h.sessions.accountant.cookie, h.sessions.cashier.cookie]) {
      expect((await api('GET', `/api/hr/staff/${employee.id}`, undefined, cookie)).status).toBe(403);
    }
  }
  const directory = await api('GET', '/api/hr/directory', undefined, h.sessions.reception.cookie);
  expect(directory.status).toBe(200); expect(JSON.stringify(directory.body)).not.toContain('currentPay');
});
for (const width of [390, 1280]) it(`native employee links, wage source, metadata edit and preserved navigation at ${width}`, async () => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const pair = h.sessions.admin.cookie.split(';')[0], separator = pair.indexOf('=');
  await context.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), url: isolated.baseUrl }]);
  const page = await context.newPage(), employee = employees[0], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const forbiddenWrites: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && /payroll|commission|parties/.test(request.url())) forbiddenWrites.push(request.url()); });
  try {
    await page.goto(`${isolated.baseUrl}/hr?tab=staff`, { waitUntil: 'domcontentloaded' });
    for (const person of employees) {
      const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: person.name, exact: true }) });
      await expect.poll(() => row.textContent()).toContain('المصدر: العقد');
      await expect.poll(() => row.textContent()).toContain(({ YER: '150,000', SAR: '1,500.55', USD: '1,500.99' } as Record<string, string>)[person.currency]);
    }
    await page.getByRole('link', { name: employee.name, exact: true }).click();
    const profile = page.getByRole('dialog', { name: 'ملف الموظف الشامل' });
    await expect.poll(() => profile.textContent()).toContain('150,000');
    const wageOrder = await profile.getByLabel('الأجر الموثق اليوم').locator('p').first().evaluate(element => {
      const amount = element.querySelector('bdi');
      if (!amount) throw new Error('Missing isolated wage number');
      const node = [...amount.parentElement!.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent?.includes('ر.ي'));
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error('Missing wage currency');
      const offset = (node.textContent ?? '').indexOf('ر.ي');
      if (offset < 0) throw new Error('Missing YER unit');
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 3);
      return { amountLeft: amount.getBoundingClientRect().left, currencyRight: range.getBoundingClientRect().right };
    });
    expect(wageOrder.amountLeft).toBeGreaterThanOrEqual(wageOrder.currencyRight - 1);
    await page.screenshot({ path: join(evidence, `hr-profile-${width}.png`), fullPage: true });
    await profile.getByRole('button', { name: 'تعديل بيانات الموظف وربط الحساب' }).click();
    const editor = page.getByRole('dialog');
    expect(await editor.locator('fieldset').getAttribute('disabled')).not.toBeNull();
    expect(await editor.getByRole('radio').first().isDisabled()).toBe(true);
    await editor.getByLabel('الهاتف', { exact: true }).fill(`synthetic-${width}`);
    await editor.getByLabel(/سبب هذا التعديل/).fill('تصحيح اصطناعي لبيانات الملف فقط');
    const request = page.waitForRequest(req => req.method() === 'PATCH' && req.url().endsWith(`/api/hr/staff/${employee.id}`));
    await editor.getByRole('button', { name: 'حفظ', exact: true }).click();
    const sent = (await request).postDataJSON();
    for (const key of ['contractKind', 'salaryAmountMinor', 'salaryCurrency', 'salaryPeriod', 'salaryEffectiveOn']) expect(sent).not.toHaveProperty(key);
    await expect.poll(() => profile.textContent()).toContain(`synthetic-${width}`);
    await profile.getByRole('link', { name: 'مراجعة العقد وإضافة ملحق' }).click();
    await expect.poll(() => page.url()).toContain(`staffId=${employee.id}`);
    const details = page.getByRole('dialog');
    await expect.poll(() => details.textContent()).toContain('عقد اصطناعي YER');
    expect(await details.getByRole('button', { name: '+ إضافة ملحق', exact: true }).isVisible()).toBe(true);
    await details.getByRole('button', { name: 'إغلاق', exact: true }).click();
    expect(await page.getByLabel('عقود الموظف', { exact: true }).inputValue()).toBe(String(employee.id));
    await page.getByRole('tab', { name: /الطاقم/ }).click();
    await profile.getByRole('link', { name: 'أرصدة الإجازة', exact: true }).click();
    await expect.poll(() => profile.textContent()).toContain('لا أرصدة إجازة مسجلة');
    await page.reload();
    await expect.poll(() => profile.textContent()).toContain('لا أرصدة إجازة مسجلة');
    await profile.getByRole('link', { name: 'طلبات الإجازة واعتماداتها' }).click();
    await expect.poll(() => page.getByLabel('عرض رصيد الموظف', { exact: true }).inputValue()).toBe(String(employee.id));
    await page.getByRole('tab', { name: /الطاقم/ }).click();
    await expect.poll(() => profile.getByRole('link', { name: 'أرصدة الإجازة', exact: true }).getAttribute('aria-current')).toBe('page');
    await profile.getByRole('link', { name: 'الحضور', exact: true }).click();
    await profile.getByRole('link', { name: 'إدارة الحضور والتصحيحات' }).click();
    await expect.poll(() => page.url()).toContain(`tab=attendance&staffId=${employee.id}`);
    await page.screenshot({ path: join(evidence, `hr-profile-attendance-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.goto(`${isolated.baseUrl}/print/hr/staff`);
    expect(await page.locator('.report-meta').textContent()).not.toMatch(/\d{2}T\d{2}:/);
    for (const person of employees) {
      const row = page.getByRole('row').filter({ hasText: person.name });
      await expect.poll(() => row.textContent()).toContain(({ YER: '150,000', SAR: '1,500.55', USD: '1,500.99' } as Record<string, string>)[person.currency]);
      expect(await row.textContent()).toContain('العقد');
      expect(await row.textContent()).not.toContain('10,000');
    }
    if (width === 1280) await page.pdf({ path: join(evidence, 'hr-profile-wage-sources.pdf'), format: 'A4', printBackground: true });
    expect(errors).toEqual([]); expect(forbiddenWrites).toEqual([]);
    writeFileSync(join(evidence, `hr-profile-result-${width}.json`), JSON.stringify({ syntheticOnly: true, width, employeeId: employee.id, contractId: employee.contractId, metadataRequestKeys: Object.keys(sent), wageOrder, errors, forbiddenWrites }, null, 2));
  } catch (error) {
    await page.screenshot({ path: join(evidence, `hr-profile-failure-${width}.png`), fullPage: true }).catch(() => undefined);
    writeFileSync(join(evidence, `hr-profile-failure-${width}.json`), JSON.stringify({ url: page.url(), text: await page.textContent('body').catch(() => ''), errors }, null, 2));
    throw error;
  } finally { await context.close(); }
});

it('editor refuses save while its current-pay read is pending, then preserves the entered data after verification', async () => {
  const created = await api('POST', '/api/hr/staff', { fullName: 'موظف تحقق اصطناعي', department: 'secretariat', jobTitle: 'اصطناعي', hireDate: '2026-01-01', endDate: null, phone: null, note: null, workStatus: 'active', contractKind: 'salary', salaryAmountMinor: 10000, salaryCurrency: 'YER', salaryPeriod: 'monthly', salaryEffectiveOn: '2026-01-01' });
  expect(created.status).toBe(201);
  const id = created.body.staff?.id ?? created.body.id;
  const context = await browser.newContext(), page = await context.newPage();
  const pair = h.sessions.admin.cookie.split(';')[0], separator = pair.indexOf('=');
  await context.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), url: isolated.baseUrl }]);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const patches: unknown[] = [];
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/api/hr/staff/${id}`)) patches.push(request.postDataJSON()); });
  try {
    await page.goto(`${isolated.baseUrl}/hr?tab=staff&staffId=${id}`);
    const profile = page.getByRole('dialog', { name: 'ملف الموظف الشامل' });
    await expect.poll(() => profile.textContent()).toContain('شروط الملف الابتدائية');
    await page.route(`${isolated.baseUrl}/api/hr/staff/${id}`, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
    });
    await profile.getByRole('button', { name: 'تعديل بيانات الموظف وربط الحساب' }).click(); await entered;
    const editor = page.getByRole('dialog');
    await editor.getByLabel('الهاتف', { exact: true }).fill('synthetic-pending-read');
    await editor.getByRole('button', { name: 'حفظ', exact: true }).click();
    await expect.poll(() => editor.getByRole('alert').textContent()).toContain('لم تُرسل تغييرات');
    expect(patches).toEqual([]);
    release();
    await expect.poll(() => editor.getByRole('radio').first().isEnabled()).toBe(true);
    await editor.getByRole('button', { name: 'حفظ', exact: true }).click();
    await expect.poll(() => profile.textContent()).toContain('synthetic-pending-read');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ salaryAmountMinor: 10000, salaryCurrency: 'YER', phone: 'synthetic-pending-read' });
  } finally { release(); await context.close(); }
});

for (const width of [390, 1280]) it(`contract detail URL preserves staff through A -> close -> B -> reload/back and close/reload at ${width}`, async () => {
  const context = await browser.newContext({ viewport: { width, height: 900 } }), employee = employees[0];
  const pair = h.sessions.admin.cookie.split(';')[0], separator = pair.indexOf('=');
  await context.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), url: isolated.baseUrl }]);
  const page = await context.newPage(), writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url()); });
  const dialog = page.getByRole('dialog');
  const selected = () => new URL(page.url()).searchParams;
  try {
    await page.goto(`${isolated.baseUrl}/hr?tab=contracts&staffId=${employee.id}&contractId=${employee.contractId}`);
    await expect.poll(() => dialog.textContent()).toContain('عقد اصطناعي YER');
    await dialog.getByRole('button', { name: 'إغلاق', exact: true }).click();
    await expect.poll(() => selected().get('contractId')).toBeNull();
    expect(selected().get('staffId')).toBe(String(employee.id));
    await page.getByRole('row').filter({ hasText: 'عقد تنقل اصطناعي ثانٍ' }).getByRole('button', { name: 'عرض وتعديل', exact: true }).click();
    await expect.poll(() => dialog.textContent()).toContain('عقد تنقل اصطناعي ثانٍ');
    expect(selected().get('contractId')).toBe(String(secondContractId));
    expect(selected().get('staffId')).toBe(String(employee.id));
    await page.reload();
    await expect.poll(() => dialog.textContent()).toContain('عقد تنقل اصطناعي ثانٍ');
    await page.goBack();
    await expect.poll(() => selected().get('contractId')).toBeNull();
    await expect.poll(() => dialog.count()).toBe(0);
    await page.goBack();
    await expect.poll(() => dialog.textContent()).toContain('عقد اصطناعي YER');
    expect(selected().get('contractId')).toBe(String(employee.contractId));
    await dialog.getByRole('button', { name: 'إغلاق', exact: true }).click();
    await expect.poll(() => selected().get('contractId')).toBeNull();
    await page.reload();
    await expect.poll(() => page.getByLabel('عقود الموظف', { exact: true }).inputValue()).toBe(String(employee.id));
    expect(await dialog.count()).toBe(0); expect(selected().get('contractId')).toBeNull();
    expect(writes).toEqual([]);
  } finally { await context.close(); }
});

it('native staff list follows the read-only governing-kind projection across its effective-day boundary', async () => {
  const { currentStaffPay } = await import('../../lib/hr-current-pay');
  const detail = (await api('GET', `/api/hr/staff/${employees[0].id}`)).body;
  const old = { ...detail.staff, contractKind: 'commission' as const, payTerms: null };
  const agreement = { id: 700, contractNumber: 'SYN-KIND', versionNumber: 1, status: 'approved', startDate: '2099-02-01', endDate: null, kind: 'salary' as const, salaryMinor: 175000, currency: 'YER' as const, salaryPeriod: 'monthly' as const, commissionRatePercent: null, doctorPartyId: null };
  const snapshot = JSON.stringify({ old, agreement });
  // Only the read response's clinic day changes. The paired PostgreSQL test
  // exercises these projections in READ ONLY and compares every relevant row.
  let day = '2099-01-31';
  const context = await browser.newContext(), page = await context.newPage(), writes: string[] = [];
  const pair = h.sessions.admin.cookie.split(';')[0], separator = pair.indexOf('=');
  await context.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), url: isolated.baseUrl }]);
  await page.route(url => url.pathname === '/api/hr/staff', route => route.fulfill({ json: [{ ...old, currentPay: currentStaffPay(old, [agreement], day) }] }));
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url()); });
  try {
    await page.goto(`${isolated.baseUrl}/hr?tab=staff`);
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: old.fullName, exact: true }) });
    await expect.poll(() => row.getByRole('cell').nth(5).textContent()).toBe('نسبة');
    expect(await row.textContent()).toContain('شروط الملف الابتدائية');
    day = '2099-02-01';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => row.getByRole('cell').nth(5).textContent()).toBe('راتب');
    expect(await row.textContent()).toContain('175,000');
    expect(await row.textContent()).toContain('SYN-KIND');
    expect(JSON.stringify({ old, agreement })).toBe(snapshot); expect(writes).toEqual([]);
  } finally { await context.close(); }
});
