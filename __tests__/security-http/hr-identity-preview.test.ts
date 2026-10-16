import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, type Harness } from './_server';
import { openHrJourneyServer } from './_hr-isolated-server';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import type { IdentityPreview } from '../../lib/hr-identity-preview-shared';

let h: Harness, isolated: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser;
let accountId: number, doctorId: number, partyId: number, unlinkedId: number;
const evidence = process.env.HR_IDENTITY_EVIDENCE_DIR ?? '/tmp/hr-identity-preview-evidence';
async function api(method = 'GET', body?: unknown, cookie = h.sessions.admin.cookie) {
  return fetch(`${isolated.baseUrl}/api/hr/identity-preview`, { method, headers: { cookie, origin: isolated.baseUrl, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  h = await harness(); isolated = await openHrJourneyServer(h);
  // Complete existing application startup before seeding deliberately unlinked doctors.
  // The preview itself must never invoke that legacy startup linker.
  await fetch(`${isolated.baseUrl}/api/auth/me`, { headers: { cookie: h.sessions.admin.cookie } });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  mkdirSync(evidence, { recursive: true });
  const parties = (await isolated.db.query("INSERT INTO parties(name,kind) VALUES ('طبيب معاينة اصطناعي','doctor'),('طبيب اصطناعي بلا حساب','doctor'),('مورد مستبعد اصطناعي','supplier') RETURNING id")).rows;
  partyId = parties[0].id;
  const users = (await isolated.db.query("INSERT INTO users(username,display_name,password_hash,role,party_id,commission_config) VALUES ('previewmanager','شخص اصطناعي واحد','private-preview-hash','admin',NULL,NULL),('previewdoctor','شخص اصطناعي واحد','private-preview-hash','doctor',$1,'{\"defaultPercent\":40}'),('previewunlinked','طبيب غير مربوط اصطناعي','private-preview-hash','doctor',NULL,NULL) RETURNING id",[partyId])).rows;
  accountId=users[0].id; doctorId=users[1].id; unlinkedId=users[2].id;
  await isolated.db.query("INSERT INTO hr_staff(full_name,created_by) VALUES ('ملف اصطناعي ناقص','synthetic')");
});
afterAll(async () => { await browser?.close(); await isolated?.close(); });
it('GET and temporary POST leave every table and sequence unchanged; unlinked doctor stays unlinked', async () => {
  const before = await identityDatabaseState(isolated.db);
  const response = await api(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
  const baseline = await response.json() as IdentityPreview;
  expect(baseline.candidates.find(c => c.key === `user:${accountId}`)?.userIds).toEqual([accountId]);
  const reviewed = await api('POST',{sourceDigest:baseline.sourceDigest,decisions:[{userIds:[accountId,doctorId],partyIds:[partyId],staffId:null,confirmedSamePerson:true}]});
  expect(reviewed.status).toBe(200);
  const result = await reviewed.json() as IdentityPreview;
  expect(result.candidates[0]).toMatchObject({action:'create',userIds:[accountId,doctorId],partyIds:[partyId],explicit:true});
  for (const forbidden of ['password_hash','private-preview-hash','credentialVersion','commission_config','defaultPercent','salary_amount_minor','permissions','session','مورد مستبعد اصطناعي']) expect(JSON.stringify(result)).not.toContain(forbidden);
  expect((await isolated.db.query('SELECT party_id FROM users WHERE id=$1',[unlinkedId])).rows[0].party_id).toBeNull();
  expect(await identityDatabaseState(isolated.db)).toEqual(before);
});
it('all other roles, anonymous requests and write methods are denied without roster exposure', async () => {
  for (const role of ['reception','doctorA','doctorB','accountant','cashier'] as const) {
    for (const method of ['GET','POST']) {
      const response=await api(method,method==='POST'?{}:undefined,h.sessions[role].cookie);
      expect(response.status).toBe(403); expect(await response.text()).not.toContain('شخص اصطناعي واحد');
    }
  }
  expect((await api('GET',undefined,'')).status).toBe(401);
  for (const method of ['PATCH','PUT','DELETE']) expect((await api(method,{})).status).toBe(405);
});
it('unconfirmed/tampered input is rejected and changed sources invalidate a temporary choice', async () => {
  const baseline = await (await api()).json() as IdentityPreview;
  expect((await api('POST',{sourceDigest:baseline.sourceDigest,decisions:[{userIds:[accountId,doctorId],partyIds:[],staffId:null,confirmedSamePerson:false}]})).status).toBe(400);
  expect((await api('POST',{sourceDigest:baseline.sourceDigest,decisions:[],permissions:{admin:true}})).status).toBe(400);
  await isolated.db.query('UPDATE users SET is_active=FALSE WHERE id=$1',[doctorId]);
  const before=await identityDatabaseState(isolated.db);
  try {
    expect((await api('POST',{sourceDigest:baseline.sourceDigest,decisions:[]})).status).toBe(409);
    expect(await identityDatabaseState(isolated.db)).toEqual(before);
  } finally { await isolated.db.query('UPDATE users SET is_active=TRUE WHERE id=$1',[doctorId]); }
});
for (const width of [390,1280]) it(`HR identity preview and explicit same-person review at ${width}`, async () => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const pair=h.sessions.admin.cookie.split(';')[0],separator=pair.indexOf('=');
  await context.addCookies([{name:pair.slice(0,separator),value:pair.slice(separator+1),url:isolated.baseUrl}]);
  const page=await context.newPage(), errors:string[]=[], requests:Array<{method:string;url:string}>=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',request=>{if(request.method()!=='GET')requests.push({method:request.method(),url:new URL(request.url()).pathname});});
  try {
    await page.goto(`${isolated.baseUrl}/hr?tab=identity`,{waitUntil:'domcontentloaded'});
    await expect.poll(()=>page.locator(`[data-identity-key="user:${accountId}"]`).count()).toBe(1);
    await page.getByText('مراجعة شخص بمعرفات صريحة — مؤقتة',{exact:true}).click();
    await page.getByLabel(`اختيار الحساب ${accountId}`,{exact:true}).check();
    await page.getByLabel(`اختيار الحساب ${doctorId}`,{exact:true}).check();
    await page.getByLabel(`اختيار الجهة ${partyId}`,{exact:true}).check();
    expect(await page.getByRole('button',{name:'معاينة الاختيار دون حفظ'}).isDisabled()).toBe(true);
    await page.getByLabel('أؤكد لهذه المعاينة فقط أن المعرفات المختارة تخص الشخص نفسه.').check();
    const before=await identityDatabaseState(isolated.db);
    const received=page.waitForResponse(r=>r.url().includes('/api/hr/identity-preview')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'معاينة الاختيار دون حفظ'}).click();
    expect((await received).status()).toBe(200);
    await expect.poll(()=>page.locator('[data-identity-key="review:1"]').textContent()).toContain('إنشاء مقترح');
    expect(await identityDatabaseState(isolated.db)).toEqual(before);
    expect(await page.getByRole('button',{name:/تطبيق|حفظ الربط/}).count()).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:join(evidence,`hr-identity-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'تحديث المصادر'}).click();
    await expect.poll(()=>page.locator(`[data-identity-key="user:${accountId}"]`).count()).toBe(1);
    expect(await page.locator('[data-identity-key="review:1"]').count()).toBe(0);
    expect(requests.filter(r=>r.url.startsWith('/api/'))).toEqual([{method:'POST',url:'/api/hr/identity-preview'}]);
    expect(errors).toEqual([]);
    writeFileSync(join(evidence,`hr-identity-${width}.json`),JSON.stringify({width,requests,errors,zeroDatabaseChanges:true},null,2));
  } finally { await context.close(); }
});
