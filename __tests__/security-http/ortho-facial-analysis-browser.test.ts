import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { chromium, type Browser, type Page } from 'playwright';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hashPassword } from '../../lib/auth';
import type { FacialCommand, FacialLandmark, FacialResults } from '../../lib/ortho-facial-analysis';
import { authedGet, authedMutation, baseUrl, harness, loginStaff } from './_server';

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const eventually = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: 20000 });
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir('.settings-ui-artifacts', { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
interface Revision { id: number; version: number; document_id: number; content_sha256: string; command: FacialCommand; results: FacialResults }
const revisions = async (caseId: number) => (await db.query<Revision>('SELECT id,version,document_id,content_sha256,command,results FROM ortho_facial_revisions WHERE ortho_case_id=$1 ORDER BY id', [caseId])).rows;
async function fixture(width: number) {
  const partyId = Number((await db.query("INSERT INTO parties(name,kind) VALUES('Synthetic facial clinician','doctor') RETURNING id")).rows[0].id);
  const username = `syntheticface${randomUUID().replaceAll('-', '')}`, password = 'SyntheticFace#Pass1';
  const userId = Number((await db.query("INSERT INTO users(username,display_name,password_hash,role,party_id,permissions) VALUES($1,'Synthetic facial clinician',$2,'doctor',$3,$4) RETURNING id", [username, await hashPassword(password), partyId, JSON.stringify({ canViewAllPatients: false, canViewXrays: true, canUploadXrays: true, canViewPlans: true, canEditPlans: true })])).rows[0].id);
  const patientId = Number((await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'Synthetic facial geometry only',$2) RETURNING id", [randomUUID(), partyId])).rows[0].id);
  const opened = await authedMutation('/api/ortho/intake', h.sessions.admin, 'POST', JSON.stringify({ patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: 'Synthetic facial acceptance' } }));
  expect(opened.status).toBe(201); const { orthoCaseId } = await opened.json();
  const clinicalCaseId = Number((await db.query('SELECT id FROM clinical_cases WHERE ortho_case_id=$1', [orthoCaseId])).rows[0].id);
  const documents: Array<{ id: number; sha256: string; width: number }> = [];
  for (const [index, imageWidth] of [400, 800].entries()) {
    // Two plain synthetic rasters, deliberately different width/hash; never a patient photograph.
    const bytes = await sharp({ create: { width: imageWidth, height: 400, channels: 3, background: index ? '#cfbfee' : '#a6cbdc' } }).png().toBuffer();
    const sha256 = createHash('sha256').update(bytes).digest('hex'), key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.png`;
    const file = join(process.cwd(), '.sec-http-storage', 'documents', key); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
    const id = Number((await db.query("INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,width,height,uploaded_by,photo_view) VALUES($1,$2,'photo',$3,'image/png',$4,$5,$6,$7,400,'synthetic','extraoral_frontal') RETURNING id", [patientId, orthoCaseId, `Synthetic face raster ${index + 1}`, bytes.length, sha256, key, imageWidth])).rows[0].id);
    documents.push({ id, sha256, width: imageWidth });
  }
  const session = await loginStaff(username, password), context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ar-YE' });
  const [name, ...value] = session.cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = []; page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  return { patientId, orthoCaseId, clinicalCaseId, userId, documents, session, context, page, errors };
}
async function selectImage(page: Page, document: { id: number; width: number }) {
  const select = page.getByLabel('الصورة المرتبطة بالحالة', { exact: true });
  await eventually(() => select.isEnabled()).toBe(true); await select.selectOption(String(document.id));
  const image = page.getByRole('img', { name: 'أصل صورة الوجه باتجاه العرض المتحقق', exact: true });
  await eventually(() => image.evaluate((node: HTMLImageElement) => ({ complete: node.complete, width: node.naturalWidth, height: node.naturalHeight })) ).toEqual({ complete: true, width: document.width, height: 400 });
}
async function pixel(page: Page, key: FacialLandmark, x: number, y: number) {
  await page.getByLabel('المعلم الحالي', { exact: true }).selectOption(key);
  await page.getByLabel('إحداثي X بالبكسل', { exact: true }).fill(String(x));
  await page.getByLabel('إحداثي Y بالبكسل', { exact: true }).fill(String(y));
  await page.getByRole('button', { name: 'تطبيق الإحداثيين على المعلم', exact: true }).click();
}
async function points(page: Page, width: number) {
  // Real pointer placement, an exact manual correction and twelve further entries. Expectations
  // below use elementary known distances, never the production calculator as oracle.
  await page.getByLabel('المعلم الحالي', { exact: true }).selectOption('axisTop');
  const canvas = page.getByLabel('لوحة معالم الوجه', { exact: true });
  await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); if (!box) throw Error('Synthetic landmark canvas unavailable');
  await canvas.click({ position: { x: box.width / 2, y: box.height * .05 } });
  await eventually(() => canvas.locator('circle').count()).toBe(1);
  // Browser CSS pixels may round the pointer location: explicitly correct the
  // same landmark before asserting the known orthogonal geometry.
  await pixel(page, 'axisTop', width / 2, 20);
  for (const [key, x, y] of [
    ['axisBottom', width / 2, 380], ['tr', width / 2, 40], ['gl', width / 2, 140], ['sn', width / 2, 240], ['me', width / 2, 340], ['sto', width / 2, 275],
    ['paImageLeft', width * .125, 180], ['exImageLeft', width * .275, 180], ['enImageLeft', width * .425, 180],
    ['enImageRight', width * .575, 180], ['exImageRight', width * .725, 180], ['paImageRight', width * .875, 180],
  ] as Array<[FacialLandmark, number, number]>) await pixel(page, key, x, y);
  await eventually(() => canvas.locator('circle').count()).toBe(13);
}
async function save(page: Page, reason: string) {
  const note = page.getByLabel('توضيح مصدر التاريخ', { exact: true });
  const text = 'Synthetic source; acquisition date deliberately unknown';
  if (await note.inputValue() !== text) await note.fill(text);
  await page.getByLabel('سبب حفظ هذه المراجعة', { exact: true }).fill(reason);
  await page.getByRole('button', { name: 'حفظ مراجعة قياسات الصورة', exact: true }).click();
  await page.getByText('حُفظت مراجعة الصورة وتأكد تسجيلها على الخادم.', { exact: true }).waitFor();
  await eventually(() => page.getByRole('button', { name: 'فتح مراجعة جديدة من آخر نسخة', exact: true }).isEnabled()).toBe(true);
}
function assertMeasurements(row: Revision, widths: number[], thirds = [100, 100, 100]) {
  expect(row.results.units).toBe('image_pixels_and_percent'); expect(row.results.clinicalInterpretation).toBe('clinician_only');
  for (const [id, expected] of [['thirds', thirds], ['fifths_postaurale', widths]] as const) {
    const result = row.results.measures.find(value => value.id === id)!; expect(result.state).toBe('ready');
    expect(result.segments).toHaveLength(expected.length);
    result.segments.forEach((value, index) => { expect(value.pixels).toBeCloseTo(expected[index], 4); expect(value.percent).toBeCloseTo(expected[index] / expected.reduce((a, b) => a + b, 0) * 100, 4); });
  }
}
it.each([390, 1280])('records and revises image-bound thirds/fifths without inferred diagnosis at %ipx', async width => {
  const f = await fixture(width), [first, second] = f.documents;
  const href = `${baseUrl}/ortho/${f.orthoCaseId}/facial?patientId=${f.patientId}`;
  try {
    await f.page.goto(href); await selectImage(f.page, first);
    await f.page.getByRole('button', { name: 'بدء قياسات هذه الصورة', exact: true }).click(); await points(f.page, first.width);
    const results = f.page.getByRole('region', { name: 'نتائج قياسات الوجه', exact: true });
    expect(await results.innerText()).toContain('33.3% · 100.0 px'); expect(await results.innerText()).toContain('20.0% · 60.0 px');
    await save(f.page, 'Synthetic first documentary measurements');
    const original = (await revisions(f.orthoCaseId))[0]; expect(original.command.content.review.state).toBe('draft'); assertMeasurements(original, [60, 60, 60, 60, 60]);
    expect(original.command.content.image).toMatchObject({ sha256: first.sha256, width: 400, height: 400 });
    await f.page.getByRole('button', { name: 'فتح مراجعة جديدة من آخر نسخة', exact: true }).click(); await pixel(f.page, 'gl', 200, 160);
    for (const label of ['الصورة أمامية وفي وضع الراحة', 'راجعت وضع الرأس والميل والدوران', 'المعالم المستخدمة ظاهرة بوضوح', 'راجعت المنظور والمسافة والعدسة وحدود المقارنة']) await f.page.getByRole('checkbox', { name: label, exact: true }).check();
    await f.page.getByLabel('تفسير الطبيب وملاحظة المراجعة', { exact: true }).fill('Synthetic clinician review; 2D proportions only, no diagnostic conclusion');
    await f.page.getByRole('checkbox', { name: 'راجعت المعالم والنتائج وحدود هذه الصورة بصفتي الطبيب', exact: true }).check();
    await save(f.page, 'Synthetic corrected Gl with explicit clinician review');
    const firstRows = await revisions(f.orthoCaseId), reviewed = firstRows[1]; expect(firstRows[0]).toEqual(original); expect(reviewed.command.expectedHeadId).toBe(original.id);
    expect(reviewed.command.content.review.state).toBe('reviewed'); assertMeasurements(reviewed, [60, 60, 60, 60, 60], [120, 80, 100]);
    await f.page.getByRole('button', { name: 'فتح مراجعة جديدة من آخر نسخة', exact: true }).click(); await pixel(f.page, 'gl', 200, 180);
    // Cancel keeps the local edit and image; confirm discards it without writing.
    f.page.once('dialog', dialog => void dialog.dismiss()); await f.page.getByLabel('الصورة المرتبطة بالحالة', { exact: true }).selectOption(String(second.id));
    expect(await f.page.getByLabel('الصورة المرتبطة بالحالة', { exact: true }).inputValue()).toBe(String(first.id));
    expect(await f.page.getByLabel('إحداثي Y بالبكسل', { exact: true }).inputValue()).toBe('180');
    f.page.once('dialog', dialog => void dialog.accept()); await selectImage(f.page, second);
    expect(await f.page.getByLabel('لوحة معالم الوجه', { exact: true }).locator('circle').count()).toBe(0);
    expect(await f.page.getByLabel('المراجعة المحفوظة', { exact: true }).count()).toBe(0);
    await f.page.getByRole('button', { name: 'بدء قياسات هذه الصورة', exact: true }).click(); await points(f.page, second.width);
    await save(f.page, 'Synthetic independent second-image measurements');
    const all = await revisions(f.orthoCaseId); expect(all).toHaveLength(3); expect(all.slice(0, 2)).toEqual(firstRows);
    const secondRevision = all[2]; expect(secondRevision.version).toBe(1); expect(secondRevision.document_id).toBe(second.id);
    expect(secondRevision.command.content.image).toMatchObject({ sha256: second.sha256, width: 800, height: 400 }); assertMeasurements(secondRevision, [120, 120, 120, 120, 120]);
    await selectImage(f.page, first); await f.page.getByLabel('المراجعة المحفوظة', { exact: true }).selectOption(String(original.id));
    expect(await results.innerText()).toContain('33.3% · 100.0 px'); expect(await f.page.getByRole('button', { name: 'فتح مراجعة جديدة من آخر نسخة', exact: true }).isDisabled()).toBe(true);
    await f.page.reload(); await selectImage(f.page, first); expect(await results.innerText()).toContain('40.0% · 120.0 px');
    expect(await f.page.getByText('نسخة 2 محفوظة — راجعها الطبيب', { exact: true }).isVisible()).toBe(true);
    expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await f.page.getByRole('heading', { name: 'قياسات صورة الوجه', exact: true }).scrollIntoViewIfNeeded();
    await f.page.screenshot({ path: `.settings-ui-artifacts/ortho-facial-${width}.png` });
    // Fresh patient authority is checked on real API and page loads.
    const foreignPatient = Number((await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic foreign facial patient') RETURNING id", [randomUUID()])).rows[0].id);
    const foreignCase = Number((await db.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id", [foreignPatient])).rows[0].id);
    await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic foreign bridge',$2,'synthetic')", [foreignPatient, foreignCase]);
    expect((await authedGet(`/api/ortho/${foreignCase}/facial-analysis?patientId=${foreignPatient}&documentId=${first.id}`, f.session)).status).toBe(403);
    expect((await authedGet(`/api/ortho/${foreignCase}/facial-image?patientId=${foreignPatient}&documentId=${first.id}&sha256=${first.sha256}`, h.sessions.admin)).status).toBe(404);
    await f.page.goto(`${baseUrl}/ortho/${foreignCase}/facial?patientId=${foreignPatient}`);
    await f.page.getByRole('alert').filter({ hasText: 'الصورة والتحليل محجوبان' }).waitFor(); expect(await f.page.getByLabel('لوحة معالم الوجه', { exact: true }).count()).toBe(0);
    await f.page.goto(href); await selectImage(f.page, first);
    await db.query("UPDATE users SET permissions=jsonb_set(permissions::jsonb,'{canViewXrays}','false'::jsonb)::text WHERE id=$1", [f.userId]);
    await f.page.getByRole('button', { name: 'تحديث سجل الصور والقياسات', exact: true }).click();
    await eventually(() => f.page.getByRole('img', { name: 'أصل صورة الوجه باتجاه العرض المتحقق', exact: true }).count()).toBe(0);
    await eventually(() => f.page.getByRole('region', { name: 'نتائج قياسات الوجه', exact: true }).count()).toBe(0);
    expect((await authedGet(`/api/ortho/${f.orthoCaseId}/facial-analysis?patientId=${f.patientId}&documentId=${first.id}`, f.session)).status).toBe(403);
    expect((await authedGet(`/api/ortho/${f.orthoCaseId}/facial-image?patientId=${f.patientId}&documentId=${first.id}&sha256=${first.sha256}`, f.session)).status).toBe(403);
    expect((await authedMutation(`/api/ortho/${f.orthoCaseId}/facial-analysis`, f.session, 'POST', JSON.stringify({ patientId: f.patientId, clinicalCaseId: f.clinicalCaseId, actorId: f.userId, command: reviewed.command }))).status).toBe(403);
    expect(await revisions(f.orthoCaseId)).toEqual(all);
    expect((await db.query('SELECT (SELECT count(*)::int FROM patient_diagnoses WHERE patient_id=$1) diagnoses,(SELECT count(*)::int FROM patient_problems WHERE patient_id=$1) problems,(SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments', [f.patientId])).rows[0]).toEqual({ diagnoses: 0, problems: 0, invoices: 0, payments: 0 });
    expect(f.errors).toEqual([]);
  } finally { await f.context.close(); }
});
