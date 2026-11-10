import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Client } from 'pg';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assessmentCommandV2 } from '../fixtures/ortho-assessment-schema2';
import type { ProblemSourceRead, ProblemSourceCommand } from '../../lib/ortho-problem-sources';
import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
import { authedGet, authedMutation, baseUrl, harness } from './_server';

// Setup uses actual HTTP owners; browser acceptance starts at the saved case.
// No synthetic endpoint responses, inferred clinical approval or visit signature.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir('.settings-ui-artifacts', { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
const eventually = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: 20000 });
async function post(path: string, body: unknown, status = 201) {
  const response = await authedMutation(path, h.sessions.admin, 'POST', JSON.stringify(body));
  expect(response.status).toBe(status); return response.json();
}
async function get(path: string) {
  const response = await authedGet(path, h.sessions.admin); expect(response.status).toBe(200); return response.json();
}
async function immutableSources(caseId: number) {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ortho_assessment_revisions a WHERE ortho_case_id=$1) assessment,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_problem_source_reviews r WHERE ortho_case_id=$1) reviews,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM ortho_strategy_revisions s WHERE ortho_case_id=$1) strategy`, [caseId])).rows[0];
}
it('connects real HTTP assessment/review/strategy owners to one browser-saved visit after a lost response', async () => {
  const patientName = 'Synthetic same-case session journey';
  const patientId = Number((await db.query('INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id', [randomUUID(), patientName])).rows[0].id);
  const intake = { patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: 'Synthetic assessment intake' } };
  const opened = await post('/api/ortho/intake', intake), caseId = opened.orthoCaseId, clinicalCaseId = opened.clinicalCaseId;
  expect(await post('/api/ortho/intake', intake, 200)).toMatchObject({ orthoCaseId: caseId, clinicalCaseId, mode: 'replayed' });
  const actorId = (await get('/api/auth/me')).userId; expect(Number.isSafeInteger(actorId)).toBe(true);
  const assessment = await post(`/api/ortho/${caseId}/assessment`, { ...assessmentCommandV2(), commandId: randomUUID() });
  const sources = await get(`/api/ortho/${caseId}/problem-sources?patientId=${patientId}`) as ProblemSourceRead;
  expect(sources.problems).toEqual([]);
  const candidate = sources.candidates.find(row => row.ref.kind === 'assessment_observation' && row.ref.id === assessment.revision.id && row.ref.member === 'width_11');
  expect(candidate).toBeDefined(); if (!candidate) throw Error('Saved measurement source unavailable for explicit clinician review');
  const command: ProblemSourceCommand = { schemaVersion: 1, commandId: randomUUID(), source: candidate.ref,
    expectedReviewId: null, action: 'create', problemId: null, label: 'Synthetic explicitly reviewed concern',
    reason: 'Synthetic clinician review only; no numerical diagnosis inference', clinicianReviewed: true };
  const problem = await post(`/api/ortho/${caseId}/problem-sources`, { patientId, clinicalCaseId, actorId, command });
  await post(`/api/ortho/${caseId}/problem-sources/recovery`, { patientId, clinicalCaseId, actorId, commandId: command.commandId,
    requestFingerprint: journeyContentHash(command), action: 'acknowledge' }, 200);
  const strategy = { schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null, reason: 'Synthetic clinician-authored documentation',
    rows: [{ problemId: problem.problemId, objective: 'Synthetic reviewed objective', strategy: 'Synthetic documented approach', rationale: null, planItemIds: [] }] };
  await post(`/api/ortho/${caseId}/strategy`, strategy);
  const listed = await get(`/api/ortho?patientId=${patientId}`);
  expect(listed.cases).toHaveLength(1); expect(listed.cases[0]).toMatchObject({ id: caseId, status: 'assessment' });
  // An explicit synthetic start command, separate from source review/strategy.
  await post(`/api/ortho/${caseId}/treatment-start`, { patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(),
    reason: 'Synthetic explicit treatment start for workflow acceptance', confirmed: true, appliance: 'aligners', arches: 'upper',
    slot: null, startDate: listed.today, plannedMonths: 12, bracketSystem: '' } });
  const visit = await post('/api/visits', { patientId, patientName });
  const before = await immutableSources(caseId);
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'ar-YE' });
  const [name, ...value] = h.sessions.admin.cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = [], writes: { key: string | undefined; body: string | null }[] = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const href = `${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${caseId}&pillar=diagnostics`;
  try {
    await page.goto(href);
    await page.getByRole('button', { name: 'فتح التقييم السريري والقياسات', exact: true }).click();
    await page.getByTestId('assessment-v2-saved').waitFor();
    await page.getByRole('button', { name: /خطة العلاج والميكانيكا/ }).click();
    await eventually(() => page.getByTestId('ortho-strategy-saved').innerText()).toContain(strategy.rows[0].objective);
    await page.getByRole('button', { name: 'مسار الأسلاك والشدّات', exact: true }).click();
    await page.getByRole('button', { name: '⚡ سجّل شدّة وجلسة جديدة الآن', exact: true }).click();
    const form = page.locator('form').filter({ has: page.getByRole('textbox', { name: 'ما نُفّذ في الشدّة', exact: true }) });
    const done = 'Synthetic actual session entry; no inferred clinical intervention';
    await form.getByRole('textbox', { name: 'ما نُفّذ في الشدّة', exact: true }).fill(done);
    const path = `${baseUrl}/api/ortho/${caseId}`;
    await page.route(path, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      const response = await route.fetch();
      expect(response.status()).toBe(writes.length === 1 ? 201 : 200);
      if (writes.length === 1) return route.abort('failed'); // Actual commit; only the reply is lost.
      await route.fulfill({ response });
    });
    await form.getByRole('button', { name: 'احفظ الشدّة والصور', exact: true }).click();
    await form.getByTestId('adjustment-reconcile').waitFor();
    await eventually(async () => (await db.query('SELECT count(*)::int n FROM ortho_adjustments WHERE case_id=$1', [caseId])).rows[0].n).toBe(1);
    await form.getByTestId('adjustment-reconcile').click();
    await page.getByText('سُجّلت الشدّة في زيارة اليوم.', { exact: true }).waitFor();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(writes[0].key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    const rows = (await db.query('SELECT id,case_id,visit_id,done FROM ortho_adjustments WHERE case_id=$1', [caseId])).rows;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ case_id: caseId, visit_id: visit.id, done });
    const clinical = await get(`/api/visits/${visit.id}/clinical`);
    expect(clinical).toMatchObject({ id: visit.id, patientId, signedAt: null, ortho: { caseId, visitAdjustmentId: rows[0].id } });
    await page.reload(); await page.getByText('سُجّلت الشدّة في زيارة اليوم.', { exact: true }).waitFor();
    // Open the actual chairside page; viewing it must not create or sign a record.
    await page.goto(`${baseUrl}/visits/${visit.id}`); await page.locator('#visit-ortho-session').waitFor();
    await page.screenshot({ path: '.settings-ui-artifacts/ortho-daily-visit-390.png' });
    expect(await immutableSources(caseId)).toEqual(before);
    expect((await db.query(`SELECT c.patient_id,c.ortho_case_id,p.case_id AS problem_case,a.visit_id,v.patient_id AS visit_patient,v.signed_at
      FROM clinical_cases c JOIN patient_problems p ON p.case_id=c.id
      JOIN ortho_adjustments a ON a.case_id=c.ortho_case_id JOIN visits v ON v.id=a.visit_id
      WHERE c.id=$1 AND p.id=$2 AND a.id=$3`, [clinicalCaseId, problem.problemId, rows[0].id])).rows)
      .toEqual([{ patient_id: patientId, ortho_case_id: caseId, problem_case: clinicalCaseId, visit_id: visit.id, visit_patient: patientId, signed_at: null }]);
    expect((await db.query(`SELECT (SELECT count(*)::int FROM ortho_cases WHERE patient_id=$1) cases,
      (SELECT count(*)::int FROM visits WHERE patient_id=$1) visits,(SELECT count(*)::int FROM patient_problems WHERE patient_id=$1) problems,
      (SELECT count(*)::int FROM patient_diagnoses WHERE patient_id=$1) diagnoses,(SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,
      (SELECT count(*)::int FROM payments WHERE patient_id=$1) payments`, [patientId])).rows[0])
      .toEqual({ cases: 1, visits: 1, problems: 1, diagnoses: 0, invoices: 0, payments: 0 });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
