import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
let browser: Browser, script: string;
// Real provider/editor/store/Modal. Only the signed-session source and API transport
// have synthetic adapters; the separate native suite exercises actual Next/PG routes.
beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {HrHistoryDraftProvider} from './components/hr/HistoryDraftProvider';import {HrHistoryLauncher} from './components/hr/HistoryEditor';const root=createRoot(document.getElementById('root'));window.mountHistory=(username,role='admin',visible=true)=>{window.syntheticHistorySession={username,role};flushSync(()=>root.render(React.createElement(HrHistoryDraftProvider,{view:visible?'staff':'tasks'},visible&&role==='admin'?React.createElement(HrHistoryLauncher,{key:username,staffId:7,label:'Synthetic staff',kind:'employment'}):null)));};`, resolveDir: process.cwd(), sourcefile: 'synthetic-history-owner.jsx', loader: 'jsx' }, bundle: true, write: false, jsx: 'automatic', platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
    plugins: [{ name: 'synthetic-history-session', setup(build) {
      build.onResolve({ filter: /(?:^|\/)SessionProvider$/ }, () => ({ path: 'session', namespace: 'history-fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'history-fixture' }, () => ({ loader: 'js', contents: 'export const useSession=()=>window.syntheticHistorySession;' }));
    } }],
  }); script = result.outputFiles![0].text; browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); });
type FixtureWindow = Window & { mountHistory(username: string, role?: string, visible?: boolean): void; oldHistorySubmit?: (event: { preventDefault(): void }) => Promise<void> };
const mount = (page: Page, username: string, role = 'admin', visible = true) => page.evaluate(({ username, role, visible }) => (window as unknown as FixtureWindow).mountHistory(username, role, visible), { username, role, visible });
const invokeOld = (page: Page) => page.evaluate(() => (window as unknown as FixtureWindow).oldHistorySubmit!({ preventDefault() {} }));
async function setup() {
  const context = await browser.newContext(), page = await context.newPage(), sent: unknown[] = [], outside: string[] = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); if (url.origin !== 'http://127.0.0.1:47894') { outside.push(url.origin); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' });
    if (url.pathname !== '/api/hr/staff/7/history') { outside.push(url.pathname); return route.abort(); }
    if (route.request().method() === 'POST') { sent.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"requestId":"foreign-receipt"}' }); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ staffId: 7, kind: 'employment', headRevision: 0, timeline: { revision: 0, facts: [] }, records: [], selectedRecord: null, selected: { kind: 'unknown' }, asOfDay: '2026-10-11', legacyObservation: { workStatus: 'active', hireDate: null, endDate: null, linkedUserId: null } }) });
  });
  await page.goto('http://127.0.0.1:47894/'); await page.addScriptTag({ content: script }); return { context, page, sent, outside };
}
async function fillCapture(page: Page) {
  await page.getByRole('button', { name: 'تاريخ العمل: Synthetic staff' }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('بداية السريان', { exact: true }).fill('2026-10-01'); await dialog.getByLabel('سبب التوثيق أو التصحيح').fill('Synthetic retained production handler');
  await dialog.locator('form').evaluate(form => {
    const key = Object.keys(form).find(key => key.startsWith('__reactProps$')); if (!key) throw new Error('Real committed React props unavailable');
    (window as unknown as FixtureWindow).oldHistorySubmit = (form as unknown as Record<string, { onSubmit: FixtureWindow['oldHistorySubmit'] }>)[key].onSubmit;
  });
}
it.each(['owner-A-B-A', 'tab-detach', 'admin-revoked'])('fences actual stale submit after %s and still admits a new live form', async scenario => {
  const f = await setup(); try {
    await mount(f.page, 'owner-a'); await fillCapture(f.page);
    if (scenario === 'owner-A-B-A') { await mount(f.page, 'owner-b'); await invokeOld(f.page); await mount(f.page, 'owner-a'); }
    if (scenario === 'tab-detach') { await mount(f.page, 'owner-a', 'admin', false); await invokeOld(f.page); await mount(f.page, 'owner-a'); }
    if (scenario === 'admin-revoked') { await mount(f.page, 'owner-a', 'doctor'); await invokeOld(f.page); await mount(f.page, 'owner-a'); }
    await invokeOld(f.page); expect(f.sent).toEqual([]); await fillCapture(f.page); await invokeOld(f.page);
    await expect.poll(() => f.sent.length).toBe(1); await expect.poll(() => f.page.getByRole('button', { name: 'إعادة الطلب المحفوظ للتحقق' }).count()).toBe(1);
    // An unrelated successful HTTP response cannot acknowledge this command.
    expect(await f.page.getByLabel('بداية السريان', { exact: true }).isDisabled()).toBe(true); expect(f.outside).toEqual([]);
  } finally { await f.context.close(); }
});
it('keeps an uncertain A command private across A→B→A and rejects the detached callback', async () => {
  const f = await setup(); try {
    await mount(f.page, 'owner-a'); await fillCapture(f.page); await invokeOld(f.page); await expect.poll(() => f.sent.length).toBe(1);
    await mount(f.page, 'owner-b'); await f.page.getByRole('button', { name: 'تاريخ العمل: Synthetic staff' }).click(); await f.page.getByRole('form').waitFor();
    expect(await f.page.getByRole('button', { name: 'إعادة الطلب المحفوظ للتحقق' }).count()).toBe(0); expect(await f.page.getByLabel('بداية السريان', { exact: true }).inputValue()).toBe('');
    await invokeOld(f.page); expect(f.sent).toHaveLength(1); await mount(f.page, 'owner-a'); await f.page.getByRole('button', { name: 'تاريخ العمل: Synthetic staff' }).click();
    await f.page.getByRole('button', { name: 'إعادة الطلب المحفوظ للتحقق' }).click(); await expect.poll(() => f.sent.length).toBe(2); expect(f.sent[1]).toEqual(f.sent[0]);
  } finally { await f.context.close(); }
});
