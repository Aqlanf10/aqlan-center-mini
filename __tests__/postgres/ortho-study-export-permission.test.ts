import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { putFile, readFileByKey } from '../../lib/files';
import { getOrthoCaseStudy } from '../../lib/ortho-case-study-store';
import * as imageStore from '../../lib/ortho-study-image-store';
import { getSavedStudyPanelImage, withIllustratedStudy } from '../../lib/ortho-study-illustrated-store';
import { defaultOrthoMediaRecipe } from '../../lib/ortho-study-media';
import { syntheticStudyCommand } from '../fixtures/ortho-case-study';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import { saveConfirmedStudy } from '../helpers/ortho-study-submit';
import { openPeriodontalFixture } from './_periodontal-fixture';

const request = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => name === 'aqlan_flow_session' ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));

let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let directory = '';
beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', 'synthetic-export-permission-secret-at-least32');
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
  directory = await mkdtemp(join(tmpdir(), 'synthetic-ortho-export-'));
  vi.stubEnv('DOCUMENTS_DIR', directory);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try { await fixture?.close(); }
  finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

async function actor(role: SessionPayload['role'], permissions: Record<string, unknown> = {}) {
  const username = `synthetic-export-${randomUUID()}`, password = 'synthetic-export-password';
  const { rows: [user] } = await fixture.pool.query(
    'INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [username, 'Synthetic export operator', password, role, JSON.stringify(permissions)],
  );
  const session: SessionPayload = {
    userId: user.id, username, role, credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 600000,
  };
  return session;
}
function login(session: SessionPayload) { request.token = createSessionToken(session); }
async function permissions(session: SessionPayload, values: Record<string, unknown>) {
  await fixture.pool.query('UPDATE users SET permissions=$1 WHERE id=$2', [JSON.stringify(values), session.userId]);
}
const patientAndImageAccess = { canViewAllPatients: true, canViewXrays: true };
const exportAccess = { ...patientAndImageAccess, canExportOrthoStudies: true };

async function savedStudy(imageCount = 0) {
  const session = await actor('admin'); login(session);
  const patientId = (await fixture.pool.query(
    "INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic export patient') RETURNING id", [randomUUID()],
  )).rows[0].id;
  const orthoCaseId = (await fixture.pool.query(
    "INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patientId],
  )).rows[0].id;
  const clinicalCaseId = (await fixture.pool.query(
    "INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic export case',$2,'synthetic') RETURNING id",
    [patientId, orthoCaseId],
  )).rows[0].id;
  const scope = { session, patientId, orthoCaseId, clinicalCaseId };
  const command = syntheticStudyCommand();
  const images: { documentId: number; key: string; sha256: string; bytes: Buffer; useId: string; slot: string }[] = [];
  for (let index = 0; index < imageCount; index++) {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: index ? '#993366' : '#336699' } }).png().toBuffer();
    const stored = await putFile(bytes, 'png');
    const documentId = (await fixture.pool.query(
      "INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,'photo','Synthetic export image','image/png',$3,$4,$5,'synthetic') RETURNING id",
      [patientId, orthoCaseId, bytes.length, stored.sha256, stored.key],
    )).rows[0].id;
    const useId = `synthetic_use_${index}`, slot = index ? 'face-smile' : 'face-front', key = `image_${index}`;
    images.push({ documentId, key: stored.key, sha256: stored.sha256, bytes, useId, slot });
    command.content.sources.push({ key, kind: 'document', id: documentId, version: null, contentHash: stored.sha256 });
    command.content.mediaUses.push({
      useId, documentId, sourceSha256: stored.sha256, groupId: null, slotId: slot, order: index,
      view: index ? 'face-smile' : 'face-rest', caption: 'Synthetic caption', recipe: defaultOrthoMediaRecipe(12, 8, 1),
    });
  }
  if (imageCount) command.content.panels = [{
    instanceId: 'face', layoutKey: 'face-overview', included: true, state: 'available',
    sourceKeys: command.content.sources.map(source => source.key),
    images: images.map(image => ({ useId: image.useId, slot: image.slot })), comment: '',
  }];
  const saved = await saveConfirmedStudy({ ...scope, command });
  if (!saved.ok) throw Error(`Synthetic study fixture: ${saved.code}`);
  return { scope, revisionId: saved.revision.id, revisionHash: saved.revision.contentHash, images };
}

it.each([
  ['doctor', undefined, false], ['doctor', false, false], ['doctor', 'true', false], ['doctor', true, true],
  ['reception', undefined, false], ['reception', false, false], ['reception', 'true', false], ['reception', true, true],
  ['admin', undefined, true], ['admin', false, true],
] as const)('uses current %s export grant %s without changing ordinary saved-study access', async (role, grant, allowed) => {
  const study = await savedStudy();
  const session = await actor(role, { ...patientAndImageAccess, ...(grant === undefined ? {} : { canExportOrthoStudies: grant }) });
  login(session);
  const input = { ...study.scope, session, revisionId: study.revisionId };
  const ordinary = await getOrthoCaseStudy(input);
  expect(ordinary).toMatchObject({ ok: true, revision: { id: study.revisionId } });
  const exported = await getOrthoCaseStudy({ ...input, exportAccess: true });
  if (allowed) expect(exported).toEqual(ordinary);
  else expect(exported).toMatchObject({ ok: false, status: 403, code: 'study_export_forbidden' });
  const consume = vi.fn(async () => Buffer.from('synthetic export'));
  const illustrated = await withIllustratedStudy(input, consume);
  if (allowed) {
    expect(illustrated).toMatchObject({ ok: true, output: Buffer.from('synthetic export') });
    expect(consume).toHaveBeenCalledOnce();
  } else {
    expect(illustrated).toMatchObject({ ok: false, status: 403, code: 'study_export_forbidden' });
    expect(illustrated).not.toHaveProperty('output');
    expect(consume).not.toHaveBeenCalled();
  }
});

it('reads grants from the current database account rather than forged session fields or stale cookies', async () => {
  const study = await savedStudy();
  const session = await actor('doctor', patientAndImageAccess);
  const forged = { ...session, permissions: { canExportOrthoStudies: true }, canExportStudies: true };
  login(forged);
  const token = request.token, input = { ...study.scope, session: forged, revisionId: study.revisionId, exportAccess: true as const };
  expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: false, code: 'study_export_forbidden' });
  await permissions(session, exportAccess);
  expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: true });
  expect(request.token).toBe(token);
  await permissions(session, patientAndImageAccess);
  expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: false, code: 'study_export_forbidden' });
});

it('keeps saved gallery and image preview available while denying image export without its independent grant', async () => {
  const study = await savedStudy(1), image = study.images[0];
  const session = await actor('doctor', patientAndImageAccess); login(session);
  const input = { ...study.scope, session, revisionId: study.revisionId };
  const imageInput = { ...input, command: {
    patientId: input.patientId, documentId: image.documentId, sha256: image.sha256, useId: image.useId,
    purpose: 'selected-use' as const, recipe: defaultOrthoMediaRecipe(12, 8, 1), frame: { width: 12, height: 8 },
  } };
  expect(await imageStore.getStudyImagePreview(imageInput)).toMatchObject({ ok: true });
  const exported = await imageStore.getStudyImagePreview({ ...imageInput, exportAccess: true });
  expect(exported).toMatchObject({ ok: false, status: 403, code: 'study_export_forbidden' });
  expect(exported).not.toHaveProperty('png');
  expect(await getSavedStudyPanelImage({ ...input, revisionHash: study.revisionHash, panelId: 'face', useId: image.useId, slot: image.slot })).toMatchObject({ ok: true });
});

it('does not amplify patient ownership, case binding, or image-source authority when export is granted', async () => {
  const study = await savedStudy(1), other = await savedStudy();
  const session = await actor('doctor', { canExportOrthoStudies: true, canViewXrays: true }); login(session);
  const input = { ...study.scope, session, revisionId: study.revisionId, exportAccess: true as const };
  expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: false, status: 403, code: 'patient_access_denied' });
  await permissions(session, { ...exportAccess, canViewXrays: false });
  expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: false, status: 403 });
  await permissions(session, exportAccess);
  expect(await getOrthoCaseStudy({ ...input, patientId: other.scope.patientId })).toMatchObject({ ok: false, status: 404 });
  expect(await getOrthoCaseStudy({ ...input, revisionId: other.revisionId })).toMatchObject({ ok: false, status: 404 });
  await fixture.pool.query("UPDATE patient_documents SET removed_at=now(),removed_by='synthetic',removed_note='Synthetic restriction' WHERE id=$1", [study.images[0].documentId]);
  expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: false, status: 403 });
});

it.each(['doctor', 'reception'] as const)('withholds rendered output after %s export permission is revoked during consume', async role => {
  const study = await savedStudy(1), session = await actor(role, exportAccess); login(session);
  const input = { ...study.scope, session, revisionId: study.revisionId };
  const result = await withIllustratedStudy(input, async value => {
    expect(value.pages.filter(page => page.image)).toHaveLength(1);
    await permissions(session, patientAndImageAccess);
    return Buffer.from('must not escape');
  });
  expect(result).toMatchObject({ ok: false, status: 403, code: 'study_export_forbidden' });
  expect(result).not.toHaveProperty('output');
  expect(result).not.toHaveProperty('value');
  expect(await getOrthoCaseStudy(input)).toMatchObject({ ok: true });
});

it('checks export permission for every asset and stops before consume if revoked between two images', async () => {
  const study = await savedStudy(2), session = await actor('doctor', exportAccess); login(session);
  const original = imageStore.getStudyImagePreview;
  let completedImages = 0;
  vi.spyOn(imageStore, 'getStudyImagePreview').mockImplementation(async input => {
    expect(input.exportAccess).toBe(true);
    const result = await original(input);
    if (result.ok && ++completedImages === 1) await permissions(session, patientAndImageAccess);
    return result;
  });
  const consume = vi.fn(async () => Buffer.from('must not escape'));
  await expect(withIllustratedStudy({ ...study.scope, session, revisionId: study.revisionId }, consume)).rejects.toThrow('study_export_forbidden');
  expect(completedImages).toBe(1);
  expect(imageStore.getStudyImagePreview).toHaveBeenCalledTimes(2);
  expect(consume).not.toHaveBeenCalled();
});

it('withholds rendered output when the session expires before final authorization', async () => {
  const study = await savedStudy(), session = await actor('doctor', exportAccess); login(session);
  const result = await withIllustratedStudy({ ...study.scope, session, revisionId: study.revisionId }, async () => {
    request.token = createSessionToken({ ...session, expiresAt: Date.now() - 1 });
    return Buffer.from('must not escape');
  });
  expect(result).toMatchObject({ ok: false, status: 401 });
  expect(result).not.toHaveProperty('output');
});

it('keeps export reads side-effect free across financial, clinical, audit and sequence state and private source bytes', async () => {
  const study = await savedStudy(1), allowed = await actor('doctor', exportAccess), denied = await actor('reception');
  const before = await identityDatabaseState(fixture.pool);
  login(allowed);
  const input = { ...study.scope, session: allowed, revisionId: study.revisionId };
  expect(await getOrthoCaseStudy({ ...input, exportAccess: true })).toMatchObject({ ok: true });
  expect(await withIllustratedStudy(input, async value => value.pages.filter(page => page.image).length)).toMatchObject({ ok: true, output: 1 });
  login(denied);
  expect(await getOrthoCaseStudy({ ...input, session: denied, exportAccess: true })).toMatchObject({ ok: false, code: 'study_export_forbidden' });
  expect(await identityDatabaseState(fixture.pool)).toEqual(before);
  expect(await readFileByKey(study.images[0].key)).toEqual(study.images[0].bytes);
});
