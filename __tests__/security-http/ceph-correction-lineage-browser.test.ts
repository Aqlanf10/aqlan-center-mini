import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { authedGet, authedMutation, baseUrl, harness } from './_server';
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function fixture(width: number) {
  const patientId = Number((await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic ceph correction') RETURNING id", [randomUUID()])).rows[0].id);
  const caseId = Number((await db.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id", [patientId])).rows[0].id);
  const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#abcdee' } }).png().toBuffer();
  const hash = createHash('sha256').update(bytes).digest('hex'), key = `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.png`;
  const file = join(process.cwd(), '.sec-http-storage', 'documents', key); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
  const documentId = Number((await db.query("INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,width,height,uploaded_by) VALUES($1,$2,'xray','Synthetic pixels','image/png',$3,$4,$5,120,80,'synthetic') RETURNING id", [patientId, caseId, bytes.length, hash, key])).rows[0].id);
  // Documentary legacy completion, explicitly without a versioned witness.
  const id = Number((await db.query("INSERT INTO ceph_analyses(patient_id,ortho_case_id,document_id,status,created_by,completed_by,completed_at) VALUES($1,$2,$3,'completed','synthetic','synthetic',now()) RETURNING id", [patientId, caseId, documentId])).rows[0].id);
  await db.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'S',20,20,'manual','synthetic'),($1,'N',50,30,'manual','synthetic')", [id]);
  const read = await authedGet(`/api/ceph/${id}`, h.sessions.admin); expect(read.status).toBe(200);
  const source = (await read.json()).correctionSource; expect(source.state).toBe('available');
  expect(source.token.sourceSha256).not.toBe(source.origin.sourceSnapshotSha256);
  expect(source.origin.parentCompletion).toEqual({ state: 'unversioned', reason: 'historical_completion_without_witness' });
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ar-YE' });
  const [name, ...value] = h.sessions.admin.cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  const page = await context.newPage(), posts: unknown[] = [], errors: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/ceph/${id}/duplicate`) posts.push(request.postDataJSON()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseUrl}/ceph/${id}`);
  const button = page.getByRole('button', { name: 'نسخة تصحيح جديدة', exact: true }); await button.waitFor();
  expect(await button.isEnabled()).toBe(true);
  return { patientId, caseId, documentId, id, source, context, page, button, posts, errors };
}
const parent = async (id: number) => (await db.query('SELECT to_jsonb(a) row FROM ceph_analyses a WHERE id=$1', [id])).rows;
const noMoney = async (patientId: number) => expect((await db.query('SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits', [patientId])).rows[0]).toEqual({ invoices: 0, payments: 0, visits: 0 });
it.each([390, 1280])('creates one source-bound correction through the actual workspace at %ipx', async width => {
  const f = await fixture(width), before = await parent(f.id);
  try {
    f.page.once('dialog', dialog => void dialog.accept()); await f.button.click();
    await f.page.waitForURL(url => /^\/ceph\/\d+$/.test(url.pathname) && url.pathname !== `/ceph/${f.id}`);
    const child = Number(new URL(f.page.url()).pathname.split('/').at(-1));
    expect(f.posts).toEqual([{ schemaVersion: 1, expectedCorrectionSource: f.source.token }]);
    const rows = (await db.query('SELECT id,patient_id,ortho_case_id,document_id,status,corrects_analysis_id,correction_source FROM ceph_analyses WHERE corrects_analysis_id=$1', [f.id])).rows;
    expect(rows).toHaveLength(1); expect(Number(rows[0].id)).toBe(child);
    expect(rows[0]).toMatchObject({ patient_id: f.patientId, ortho_case_id: f.caseId, document_id: f.documentId, status: 'draft', correction_source: f.source.origin });
    expect(Number(rows[0].corrects_analysis_id)).toBe(f.id);
    expect(await parent(f.id)).toEqual(before);
    await f.page.getByText('نسخة تصحيح مرتبطة بـ', { exact: false }).waitFor();
    const reread = await authedGet(`/api/ceph/${child}`, h.sessions.admin);
    expect((await reread.json()).analysis.correctionOrigin).toEqual(f.source.origin);
    expect((await authedMutation(`/api/ceph/${f.id}/duplicate`, h.sessions.admin, 'POST', '{}')).status).toBe(400);
    await noMoney(f.patientId); expect(f.errors).toEqual([]);
  } finally { await f.context.close(); }
});
it('rejects a changed parent after the doctor opened its correction source', async () => {
  const f = await fixture(1280);
  try {
    await db.query("UPDATE ceph_analyses SET device='Synthetic changed metadata' WHERE id=$1", [f.id]);
    const response = f.page.waitForResponse(response => response.url().endsWith(`/api/ceph/${f.id}/duplicate`) && response.request().method() === 'POST');
    f.page.once('dialog', dialog => void dialog.accept()); await f.button.click();
    expect((await response).status()).toBe(409);
    expect((await db.query('SELECT count(*)::int n FROM ceph_analyses WHERE corrects_analysis_id=$1', [f.id])).rows[0].n).toBe(0);
    expect(new URL(f.page.url()).pathname).toBe(`/ceph/${f.id}`); expect(f.posts).toHaveLength(1); await noMoney(f.patientId);
  } finally { await f.context.close(); }
});
it('retains one committed child and disables resubmission when its response is lost', async () => {
  const f = await fixture(390);
  try {
    await f.page.route(`**/api/ceph/${f.id}/duplicate`, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed');
    });
    f.page.once('dialog', dialog => void dialog.accept()); await f.button.click();
    await f.page.getByText('تعذّر التحقق من نتيجة فتح النسخة. قد تكون حُفظت؛ أعد فتح سجل الدراسات للتحقق قبل تكرار الطلب.', { exact: true }).waitFor();
    expect(await f.button.isDisabled()).toBe(true); expect(f.posts).toHaveLength(1);
    expect((await db.query('SELECT count(*)::int n FROM ceph_analyses WHERE corrects_analysis_id=$1', [f.id])).rows[0].n).toBe(1);
    expect(new URL(f.page.url()).pathname).toBe(`/ceph/${f.id}`); await noMoney(f.patientId); expect(f.errors).toEqual([]);
  } finally { await f.context.close(); }
});
