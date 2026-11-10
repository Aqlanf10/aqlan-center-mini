import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Client } from 'pg';
import JSZip from 'jszip';
import sharp from 'sharp';
import { defaultOrthoMediaRecipe } from '../../lib/ortho-study-media';
import { chromium, type Browser } from 'playwright';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { syntheticStudyCommand } from '../fixtures/ortho-case-study';
import { authedGet, authedMutation, baseUrl, harness, type Session } from './_server';
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  // The isolated harness documents an explicit durable root. Provision only its
  // synthetic directory, as deployment must do; no readiness bypass is injected.
  await mkdir(join(process.cwd(), '.sec-http-storage', 'documents'), { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
async function savedStudy(withImage = false, imageSlot: 'face-front' | 'face-smile' = 'face-front') {
  const patientId = h.seeded.patientAId;
  const caseId = (await db.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','secadmin') RETURNING id", [patientId])).rows[0].id as number;
  await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic archive',$2,'secadmin')", [patientId, caseId]);
  const route = `/api/ortho/${caseId}/case-study`, command = syntheticStudyCommand();
  command.content.comment = `SYNTHETIC-ARCHIVE-${randomUUID()}`;
  let sourceImage: { id: number; sha256: string; path: string } | null = null;
  if (withImage) {
    const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ee3322' } })
      .composite([{ input: await sharp({ create: { width: 60, height: 80, channels: 3, background: '#2244ee' } }).png().toBuffer(), left: 60, top: 0 }])
      .withMetadata({ orientation: 1 }).png().toBuffer();
    const sha256 = createHash('sha256').update(png).digest('hex'), key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.png`;
    const path = join(process.cwd(), '.sec-http-storage', 'documents', key);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, png);
    const id = (await db.query("INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'photo','Synthetic colored squares','image/png',$3,$4,$5,'secadmin') RETURNING id", [patientId, caseId, png.length, sha256, key])).rows[0].id as number;
    sourceImage = { id, sha256, path };
    command.content.sources = [{ key: 'synthetic_image', kind: 'document', id, version: null, contentHash: sha256 }];
    command.content.mediaUses = [{ useId: 'cropped_face', documentId: id, sourceSha256: sha256, groupId: null,
      slotId: imageSlot, order: 0, view: 'face-rest', caption: 'Synthetic image only; no patient',
      recipe: { ...defaultOrthoMediaRecipe(120, 80, 1), cropPpm: { top: 0, bottom: 1000000, left: 500000, right: 1000000 } } }];
    command.content.panels = [{ instanceId: 'synthetic_records', layoutKey: 'records-overview', included: true,
      state: 'available', sourceKeys: ['synthetic_image'], images: [{ slot: imageSlot, useId: 'cropped_face' }], comment: 'Synthetic crop' }];
  }

  const recovery = await authedGet(`${route}/recovery?patientId=${patientId}`, h.sessions.admin);
  expect(recovery.status).toBe(200); const binding = await recovery.json();
  const scope = { patientId, clinicalCaseId: binding.scope.clinicalCaseId, actorId: binding.actorId };
  const response = await authedMutation(route, h.sessions.admin, 'POST', JSON.stringify({ ...scope, command }));
  const saved = await response.json(); expect(response.status, JSON.stringify(saved)).toBe(201);
  const recovered = await authedGet(`${route}/recovery?patientId=${patientId}`, h.sessions.admin);
  const receipt = (await recovered.json()).recovery;
  expect((await authedMutation(`${route}/recovery`, h.sessions.admin, 'POST', JSON.stringify({ ...scope,
    commandId: command.clientRequestId, requestFingerprint: receipt.identity.requestFingerprint, action: 'acknowledge' }))).status).toBe(200);
  return { caseId, patientId, sourceImage, route: `${route}/exports`, revisionId: saved.revision.id as number, revisionHash: saved.revision.contentHash as string };
}
const money = async () => (await db.query('SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits')).rows;
const downloadPath = (study: Awaited<ReturnType<typeof savedStudy>>, id: number) => `${study.route}/${id}/download?patientId=${study.patientId}`;
const body = (study: Awaited<ReturnType<typeof savedStudy>>, format: 'text-pptx' | 'illustrated-pptx') => ({ patientId: study.patientId,
  command: { schemaVersion: 1, clientRequestId: randomUUID(), revisionId: study.revisionId, revisionHash: study.revisionHash, format } });
async function run(study: Awaited<ReturnType<typeof savedStudy>>, job: { id: number; generation: number }, session: Session) {
  return authedMutation(`${study.route}/${job.id}/run`, session, 'POST', JSON.stringify({ patientId: study.patientId, expectedGeneration: job.generation }));
}
it.each(['text-pptx', 'illustrated-pptx'] as const)('%s reserves once, archives verified bytes, recovers the receipt and changes no clinical or financial rows', async format => {
  const study = await savedStudy(format === 'illustrated-pptx'), before = await money(), command = body(study, format);
  const reservations = await Promise.all([1, 2].map(() => authedMutation(study.route, h.sessions.admin, 'POST', JSON.stringify(command))));
  const receipts = await Promise.all(reservations.map(response => response.json()));
  expect(reservations.map(response => response.status)).toEqual([201, 201]);
  expect(receipts[0].job.id).toBe(receipts[1].job.id); expect(receipts[0].job.state).toBe('queued');
  const job = receipts[0].job;
  expect((await authedGet(downloadPath(study, job.id), h.sessions.admin)).status).toBe(409);
  const list = await authedGet(`${study.route}?patientId=${study.patientId}&revisionId=${study.revisionId}`, h.sessions.admin);
  expect(list.status).toBe(200); expect((await list.json()).jobs).toHaveLength(1);
  expect((await db.query('SELECT state FROM ortho_study_export_jobs WHERE id=$1', [job.id])).rows[0].state).toBe('queued');
  const outcomes = await Promise.all([run(study, job, h.sessions.admin), run(study, job, h.sessions.admin)]);
  const parsed = await Promise.all(outcomes.map(response => response.json()));
  expect(outcomes.some(response => response.status === 200), JSON.stringify(parsed)).toBe(true);
  expect(outcomes.every(response => [200, 409].includes(response.status))).toBe(true);
  const ready = parsed.find(result => result.ok)?.job; expect(ready.state).toBe('ready');
  const file = await authedGet(downloadPath(study, job.id), h.sessions.admin);
  expect(file.status).toBe(200); expect(file.headers.get('cache-control')).toBe('private, no-store');
  expect(file.headers.get('x-content-type-options')).toBe('nosniff');
  const bytes = new Uint8Array(await file.arrayBuffer());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ready.artifact.sha256);
  const zip = await JSZip.loadAsync(bytes);
  expect(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(ready.artifact.pageCount);
  if (study.sourceImage) {
    const manifest = (await db.query('SELECT manifest FROM ortho_study_export_artifacts WHERE job_id=$1', [job.id])).rows[0].manifest;
    expect(manifest.renditions).toHaveLength(1);
    expect(manifest.renditions[0]).toMatchObject({ documentId: study.sourceImage.id, useId: 'cropped_face', sourceSha256: study.sourceImage.sha256 });
    const media = Object.keys(zip.files).filter(name => /^ppt\/media\/.*\.png$/.test(name)); expect(media).toHaveLength(1);
    const processed = await zip.file(media[0])!.async('uint8array');
    expect(createHash('sha256').update(processed).digest('hex')).toBe(manifest.renditions[0].renditionSha256);
    expect(manifest.renditions[0].renditionSha256).not.toBe(study.sourceImage.sha256);
    expect(createHash('sha256').update(await readFile(study.sourceImage.path)).digest('hex')).toBe(study.sourceImage.sha256);
  }
  const replay = await run(study, job, h.sessions.admin); expect(replay.status).toBe(200);
  expect((await replay.json()).job.artifact).toEqual(ready.artifact);
  const publicList = await (await authedGet(`${study.route}?patientId=${study.patientId}&revisionId=${study.revisionId}`, h.sessions.admin)).text();
  expect(publicList).not.toMatch(/storageKey|storage_key|lease_token|leaseToken|manifest|sourceSelections/);
  expect((await db.query('SELECT count(*)::int n FROM ortho_study_export_artifacts WHERE job_id=$1', [job.id])).rows[0].n).toBe(1);
  expect(await money()).toEqual(before);
  const conflicting = { ...command, command: { ...command.command, format: format === 'text-pptx' ? 'illustrated-pptx' : 'text-pptx' } };
  expect((await authedMutation(study.route, h.sessions.admin, 'POST', JSON.stringify(conflicting))).status).toBe(409);
});
it('requires independent current export permission, isolates patients and rejects forged fields and cross-origin mutation', async () => {
  const study = await savedStudy(), command = body(study, 'text-pptx');
  const original = (await db.query("SELECT permissions FROM users WHERE username='secreception'")).rows[0].permissions as string | null;
  const permissions = original ? JSON.parse(original) : {};
  try {
    await db.query("UPDATE users SET permissions=$1 WHERE username='secreception'", [JSON.stringify({ ...permissions, canExportOrthoStudies: false })]);
    expect((await authedMutation(study.route, h.sessions.reception, 'POST', JSON.stringify(command))).status).toBe(403);
    await db.query("UPDATE users SET permissions=$1 WHERE username='secreception'", [JSON.stringify({ ...permissions, canExportOrthoStudies: true })]);
    const reserved = await authedMutation(study.route, h.sessions.reception, 'POST', JSON.stringify(command));
    expect(reserved.status).toBe(201); const { job } = await reserved.json();
    expect((await run(study, job, h.sessions.admin)).status).toBe(403); // Creator-only run, even for admin.
    const rendered = await run(study, job, h.sessions.reception); expect(rendered.status, await rendered.clone().text()).toBe(200);
    expect((await authedGet(downloadPath(study, job.id), h.sessions.reception)).status).toBe(200);
    expect((await authedGet(`${study.route}/${job.id}/download?patientId=${h.seeded.patientBId}`, h.sessions.admin)).status).toBe(404);
    await db.query("UPDATE users SET permissions=$1 WHERE username='secreception'", [JSON.stringify({ ...permissions, canExportOrthoStudies: false })]);
    expect((await authedGet(downloadPath(study, job.id), h.sessions.reception)).status).toBe(403);
    expect((await authedMutation(study.route, h.sessions.admin, 'POST', JSON.stringify({ ...command, storageKey: 'forged.pptx' }))).status).toBe(400);
    expect((await authedMutation(`${study.route}/${job.id}/run`, h.sessions.admin, 'POST', JSON.stringify({ patientId: study.patientId, expectedGeneration: 0, artifact: {} }))).status).toBe(400);
    const csrf = await fetch(`${baseUrl}${study.route}`, { method: 'POST', headers: { Cookie: h.sessions.admin.cookie, Origin: 'https://invalid.example', 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    expect(csrf.status).toBe(403);
  } finally { await db.query("UPDATE users SET permissions=$1 WHERE username='secreception'", [original]); }
});

it.each([390, 1280])('archives the selected saved revision through explicit browser actions at %ipx', async width => {
  const study = await savedStudy();
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ar-YE' });
  const [name, ...cookie] = h.sessions.admin.cookie.split('=');
  await context.addCookies([{ name, value: cookie.join('='), url: baseUrl }]);
  const page = await context.newPage(), writes: string[] = [], errors: string[] = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/case-study/exports')) writes.push(request.url()); });
  try {
    await page.goto(`${baseUrl}/patients/${study.patientId}?tab=treatment&sub=ortho&orthoCaseId=${study.caseId}`);
    await page.getByRole('button', { name: 'دراسة الحالة المحفوظة', exact: true }).click();
    await page.getByText('ملفات التصدير المحفوظة', { exact: true }).click();
    await page.getByText('لا توجد ملفات محفوظة لهذه النسخة بعد.', { exact: true }).waitFor();
    expect(writes).toEqual([]);
    await page.getByRole('combobox', { name: 'نوع ملف التصدير المحفوظ', exact: true }).selectOption('text-pptx');
    await page.getByRole('button', { name: 'حفظ طلب تصدير جديد', exact: true }).click();
    const prepare = page.getByRole('button', { name: 'تجهيز الملف', exact: true }); await prepare.waitFor();
    expect(writes).toHaveLength(1);
    await prepare.click();
    const link = page.getByRole('link', { name: /تنزيل الملف المحفوظ/ }); await link.waitFor();
    expect(writes).toHaveLength(2);
    const href = await link.getAttribute('href'); expect(href).toContain(study.route);
    const response = await context.request.get(`${baseUrl}${href}`); expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('presentationml');
    const firstHash = createHash('sha256').update(await response.body()).digest('hex');
    await page.reload(); await page.getByRole('button', { name: 'دراسة الحالة المحفوظة', exact: true }).click();
    await page.getByText('ملفات التصدير المحفوظة', { exact: true }).click(); await link.waitFor();
    expect(await link.getAttribute('href')).toBe(href); expect(writes).toHaveLength(2);
    const recovered = await context.request.get(`${baseUrl}${href}`);
    expect(createHash('sha256').update(await recovered.body()).digest('hex')).toBe(firstHash);
    expect((await db.query('SELECT count(*)::int n FROM ortho_study_export_jobs WHERE ortho_case_id=$1', [study.caseId])).rows[0].n).toBe(1);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const panel = page.locator('details').filter({ has: page.getByText('ملفات التصدير المحفوظة', { exact: true }) });
    await panel.scrollIntoViewIfNeeded();
    // A padded inline anchor can overlap the preceding timestamp and exceed
    // its row. Verify real browser geometry rather than a class-name snapshot.
    const downloadBox = await link.boundingBox();
    const timeBox = await panel.locator('li').filter({ has: link }).locator('time').boundingBox();
    const rowBox = await panel.locator('li').filter({ has: link }).boundingBox();
    expect(downloadBox).not.toBeNull(); expect(timeBox).not.toBeNull(); expect(rowBox).not.toBeNull();
    expect(downloadBox!.height).toBeGreaterThanOrEqual(44);
    expect(downloadBox!.y).toBeGreaterThanOrEqual(timeBox!.y + timeBox!.height);
    expect(downloadBox!.y + downloadBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height);
    await mkdir('.settings-ui-artifacts', { recursive: true });
    await panel.screenshot({ path: `.settings-ui-artifacts/ortho-archive-${width}.png` });
    // Seed queued history through the real reserve API, then recover the original
    // ready artifact from page two. Paging must never start any queued export.
    for (let index = 0; index < 26; index++) {
      expect((await authedMutation(study.route, h.sessions.admin, 'POST', JSON.stringify(body(study, 'text-pptx')))).status).toBe(201);
    }
    await page.getByRole('button', { name: 'تحديث حالة الملفات', exact: true }).click();
    await expect.poll(() => panel.locator('li').count()).toBe(25);
    expect(await link.count()).toBe(0);
    const older = page.getByRole('button', { name: 'عرض ملفات أقدم', exact: true }); await older.click();
    await expect.poll(() => panel.locator('li').count()).toBe(27);
    expect(await link.getAttribute('href')).toBe(href); expect(await older.count()).toBe(0);
    expect(createHash('sha256').update(await (await context.request.get(`${baseUrl}${href}`)).body()).digest('hex')).toBe(firstHash);
    expect(writes).toHaveLength(2);
    expect((await db.query("SELECT state,count(*)::int n FROM ortho_study_export_jobs WHERE ortho_case_id=$1 GROUP BY state ORDER BY state", [study.caseId])).rows)
      .toEqual([{ state: 'queued', n: 26 }, { state: 'ready', n: 1 }]);
    await page.getByRole('button', { name: 'تحديث حالة الملفات', exact: true }).click();
    await expect.poll(() => panel.locator('li').count()).toBe(25);
    expect(await link.count()).toBe(0); expect(writes).toHaveLength(2); expect(errors).toEqual([]);
  } finally { await context.close(); }
});


it('prints the actual saved full study with its approved crop and intact clinical pixels beneath the global watermark', async () => {
  // The middle slot overlaps the central watermark: a right-side image would
  // prove cropping but would not exercise image protection from decoration.
  const study = await savedStudy(true, 'face-smile');
  expect(study.sourceImage).not.toBeNull();
  const source = study.sourceImage!;
  const reserved = await authedMutation(study.route, h.sessions.admin, 'POST', JSON.stringify(body(study, 'illustrated-pptx')));
  expect(reserved.status).toBe(201); const { job } = await reserved.json();
  const rendered = await run(study, job, h.sessions.admin);
  expect(rendered.status, await rendered.clone().text()).toBe(200);
  expect((await rendered.json()).job.state).toBe('ready');
  const artifact = await authedGet(downloadPath(study, job.id), h.sessions.admin);
  expect(artifact.status).toBe(200);
  const zip = await JSZip.loadAsync(await artifact.arrayBuffer());
  const media = Object.keys(zip.files).filter(name => /^ppt\/media\/.*\.png$/.test(name));
  expect(media).toHaveLength(1);
  const approvedPng = await zip.file(media[0])!.async('nodebuffer');
  const approvedHash = createHash('sha256').update(approvedPng).digest('hex');
  const manifest = (await db.query('SELECT manifest FROM ortho_study_export_artifacts WHERE job_id=$1', [job.id])).rows[0].manifest;
  expect(manifest.renditions).toHaveLength(1);
  expect(manifest.renditions[0]).toMatchObject({ documentId: source.id, useId: 'cropped_face', sourceSha256: source.sha256, renditionSha256: approvedHash });
  expect(approvedHash).not.toBe(source.sha256);
  const original = await readFile(source.path);
  expect(createHash('sha256').update(original).digest('hex')).toBe(source.sha256);
  const pixel = async (bytes: Buffer, left: number, top: number) => [...await sharp(bytes).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  expect(await pixel(original, 20, 40)).toEqual([238, 51, 34]);
  expect(await pixel(original, 100, 40)).toEqual([34, 68, 238]);
  const approved = await sharp(approvedPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let blue = 0, red = 0;
  for (let offset = 0; offset < approved.data.length; offset += approved.info.channels) {
    if (approved.data[offset] === 34 && approved.data[offset + 1] === 68 && approved.data[offset + 2] === 238) blue++;
    if (approved.data[offset] > 180 && approved.data[offset + 1] < 100 && approved.data[offset + 2] < 100) red++;
  }
  expect(blue).toBeGreaterThan(approved.info.width * approved.info.height / 2);
  expect(red).toBe(0); // Independent pixel evidence: the discarded left half cannot survive.

  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ar-YE' });
  const [name, ...cookie] = h.sessions.admin.cookie.split('=');
  await context.addCookies([{ name, value: cookie.join('='), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = [], unexpected: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== baseUrl || !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`); return route.abort();
    }
    return route.continue();
  });
  try {
    const response = await page.goto(`${baseUrl}/print/ortho-study/${study.caseId}?patientId=${study.patientId}&revisionId=${study.revisionId}&mode=full`);
    expect(response?.status()).toBe(200); expect(response?.headers()['cache-control']).toContain('no-store');
    await expect.poll(() => page.locator('[data-full-study-print]').getAttribute('data-print-ready'), { timeout: 20000 }).toBe('true');
    expect(await page.getByRole('button', { name: 'طباعة / حفظ PDF', exact: true }).isEnabled()).toBe(true);
    const image = page.getByRole('img', { name: 'صورة محفوظة cropped_face', exact: true });
    expect(await image.count()).toBe(1);
    const src = await image.getAttribute('src'); expect(src).toMatch(/^data:image\/png;base64,/);
    const inline = Buffer.from(src!.slice('data:image/png;base64,'.length), 'base64');
    expect(inline).toEqual(approvedPng);
    expect(createHash('sha256').update(inline).digest('hex')).toBe(approvedHash);
    const visible = await page.locator('[data-full-study-print]').innerText();
    for (const identifier of ['synthetic_image', 'cropped_face', source.sha256, approvedHash, study.revisionHash]) expect(visible).toContain(identifier);
    const capturedAt = await page.locator('[data-study-captured-at]').first().innerText();
    expect(capturedAt).not.toBe('');
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(item => item.decode())); window.dispatchEvent(new Event('beforeprint')); });
    await expect.poll(() => page.locator('[data-full-study-print]').getAttribute('data-print-ready')).toBe('true');
    const watermark = page.locator('body > .print-document-watermark');
    expect(await watermark.getAttribute('data-logo-state')).toBe('ready');
    expect(await watermark.isVisible()).toBe(true);
    expect(await watermark.evaluate(node => Number(getComputedStyle(node).opacity))).toBeGreaterThan(0);
    const placement = await image.evaluate(node => {
      const sheet = node.closest('[data-print-sheet]')!, imageBox = node.getBoundingClientRect(), sheetBox = sheet.getBoundingClientRect();
      return { page: [...document.querySelectorAll('[data-print-sheet]')].indexOf(sheet) + 1, sheetWidth: sheetBox.width,
        x: imageBox.left - sheetBox.left + imageBox.width / 2, y: imageBox.top - sheetBox.top + imageBox.height / 2 };
    });
    const sheetCount = await page.locator('[data-print-sheet]').count();
    await mkdir('.settings-ui-artifacts', { recursive: true });
    const pdf = '.settings-ui-artifacts/ortho-full-study-approved-crop.pdf';
    await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
    const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
    expect(Number(info.match(/^Pages:\s+(\d+)/m)?.[1])).toBe(sheetCount);
    expect(info).toMatch(/841\.\d+ x 594\.\d+ pts/);
    let allText = '';
    for (let index = 1; index <= sheetCount; index++) {
      const text = execFileSync('pdftotext', ['-f', String(index), '-l', String(index), '-layout', pdf, '-'], { encoding: 'utf8' })
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
      expect(text).toContain(study.revisionHash); expect(text).toContain(capturedAt);
      expect(text).toContain(`${index} / ${sheetCount}`); allText += text;
    }
    for (const identifier of ['synthetic_image', 'cropped_face', source.sha256, approvedHash]) expect(allText.replace(/\s/g, '')).toContain(identifier);
    const raster = execFileSync('pdftoppm', ['-f', String(placement.page), '-l', String(placement.page), '-r', '96', '-png', '-singlefile', pdf], { maxBuffer: 12 * 1024 * 1024 });
    await writeFile('.settings-ui-artifacts/ortho-full-study-approved-crop.png', raster);
    const rasterInfo = await sharp(raster).metadata(), pxPerMm = 96 / 25.4;
    const centerX = Math.round((rasterInfo.width! - placement.sheetWidth) / 2 + placement.x);
    const centerY = Math.round(10 * pxPerMm + placement.y);
    // The named landscape profile has equal10mm margins and a centered76x65mm
    // global watermark. Prove the sample actually lies in that decoration area.
    expect(Math.abs(centerX - rasterInfo.width! / 2)).toBeLessThan(38 * pxPerMm);
    expect(Math.abs(centerY - rasterInfo.height! / 2)).toBeLessThan(32.5 * pxPerMm);
    const patch = await sharp(raster).extract({ left: centerX - 6, top: centerY - 6, width: 12, height: 12 }).removeAlpha().raw().toBuffer();
    // Interior crop pixels are constant blue. Only2 levels of PDF raster rounding
    // are tolerated; watermark blending or original red pixels must fail.
    for (let offset = 0; offset < patch.length; offset += 3) {
      expect(Math.abs(patch[offset] - 34)).toBeLessThanOrEqual(2);
      expect(Math.abs(patch[offset + 1] - 68)).toBeLessThanOrEqual(2);
      expect(Math.abs(patch[offset + 2] - 238)).toBeLessThanOrEqual(2);
    }
    expect(createHash('sha256').update(await readFile(source.path)).digest('hex')).toBe(source.sha256);
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  } finally { await context.close(); }
});
