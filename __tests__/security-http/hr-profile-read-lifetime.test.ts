import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { hrNavigationAdapter } from './_hr-navigation-adapter';
let browser: Browser, script: string;
beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {StaffProfileModal} from './components/hr/StaffProfileModal';import {HrNavigationContext} from './components/hr/HrNavigation';const root=createRoot(document.getElementById('root'));window.profileRequests=[];window.edited=[];window.fetch=(path)=>new Promise(resolve=>window.profileRequests.push({path,resolve}));window.mountProfile=(owner,staffId,profileTab='overview')=>{window.profileSession={username:owner,role:'admin'};flushSync(()=>root.render(<HrNavigationContext.Provider value={{staffId:String(staffId),profileTab,contractId:'',href:()=>'/hr',selectStaff:()=>{},selectContract:()=>{},closeProfile:()=>{}}}><StaffProfileModal staffId={staffId} open onClose={()=>{}} onEdit={detail=>window.edited.push(detail.staff.id)}/></HrNavigationContext.Provider>));};window.resolveProfile=(index,payload,status=200)=>window.profileRequests[index].resolve(new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}}));`, sourcefile: 'synthetic-profile.jsx', resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, jsx: 'automatic', platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [hrNavigationAdapter, { name: 'synthetic-profile-session', setup(build) {
    build.onResolve({ filter: /(?:^|\/)SessionProvider$/ }, () => ({ path: 'session', namespace: 'profile-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'profile-fixture' }, () => ({ contents: 'export const useSession=()=>window.profileSession;', loader: 'js' }));
  } }] });
  script = result.outputFiles![0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); });
type Fixture = Window & { mountProfile(owner: string, id: number, tab?: string): void; resolveProfile(index: number, payload: unknown, status?: number): void; profileRequests: Array<{ path: string }>; edited: number[] };
const mount = (page: Page, owner: string, id: number, tab = 'overview') => page.evaluate(({ owner, id, tab }) => (window as unknown as Fixture).mountProfile(owner, id, tab), { owner, id, tab });
const settle = (page: Page, index: number, payload: unknown, status = 200) => page.evaluate(({ index, payload, status }) => (window as unknown as Fixture).resolveProfile(index, payload, status), { index, payload, status });
const count = (page: Page) => page.evaluate(() => (window as unknown as Fixture).profileRequests.length);
const detail = (id: number, name: string) => ({ staff: { id, fullName: name, jobTitle: 'Synthetic', workStatus: 'active', payTerms: null, currentPay: { asOf: '2026-10-15', source: 'staff_profile', terms: { kind: 'commission' }, contract: null, blockers: [], profilePayLocked: false } }, changes: [], linkedUser: null });
async function setup() { const page = await browser.newPage(); await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: script }); return page; }
it('late employee A cannot replace B, including A -> B -> A with ignored AbortSignals', async () => {
  const page = await setup();
  try {
    await mount(page, 'owner', 1); await expect.poll(() => count(page)).toBe(1);
    await mount(page, 'owner', 2); await expect.poll(() => count(page)).toBe(2);
    await settle(page, 1, detail(2, 'Current B')); await expect.poll(() => page.textContent('body')).toContain('Current B');
    await mount(page, 'owner', 1); await expect.poll(() => count(page)).toBe(3);
    expect(await page.textContent('body')).not.toContain('Current B');
    await settle(page, 2, detail(1, 'Fresh A')); await settle(page, 0, detail(1, 'Retired A secret'));
    await expect.poll(() => page.textContent('body')).toContain('Fresh A'); expect(await page.textContent('body')).not.toContain('Retired A secret');
    await page.getByRole('button', { name: 'تعديل بيانات الموظف وربط الحساب' }).click();
    expect(await page.evaluate(() => (window as unknown as Fixture).edited)).toEqual([1]);
  } finally { await page.close(); }
});
it('signed owner A -> B -> A cannot revive old private pay, and failed/tab-mismatched data stays hidden', async () => {
  const page = await setup();
  try {
    await mount(page, 'owner-a', 1); await expect.poll(() => count(page)).toBe(1);
    await mount(page, 'owner-b', 1); await expect.poll(() => count(page)).toBe(2);
    await mount(page, 'owner-a', 1); await expect.poll(() => count(page)).toBe(3);
    await settle(page, 2, detail(1, 'Current authorized read'));
    await settle(page, 0, detail(1, 'Retired owner A')); await settle(page, 1, detail(1, 'Retired owner B'));
    await expect.poll(() => page.textContent('body')).toContain('Current authorized read');
    expect(await page.textContent('body')).not.toContain('Retired owner');
    await mount(page, 'owner-a', 1, 'leaves'); await expect.poll(() => count(page)).toBe(5);
    expect(await page.textContent('body')).not.toContain('Current authorized read');
    await settle(page, 3, detail(1, 'Current authorized read')); await settle(page, 4, [{ staffId: 2, availableDays: 99 }]);
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('هوية بيانات الملف');
    expect(await page.textContent('body')).not.toContain('99');
    await mount(page, 'owner-a', 1); await expect.poll(() => count(page)).toBe(6);
    await settle(page, 5, { message: 'forbidden' }, 403);
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('تعذّر تحميل');
    expect(await page.getByRole('button', { name: 'تعديل بيانات الموظف وربط الحساب' }).count()).toBe(0);
  } finally { await page.close(); }
});
