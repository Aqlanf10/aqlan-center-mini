import { facialScenario } from './fixtures/ortho-facial-core';
import { createHash } from 'node:crypto';
const syntheticMismatchSha = createHash('sha256').update('synthetic companion refresh v1: independent facial mismatch').digest('hex');
// Provenance: core-derived values use the approved synthetic fixture. SQL/schema/error strings,
// negative identity sentinels, integer revisions, PNG signature and byte/count limits are test constants.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { computeFacialResults, type FacialCommand } from '../lib/ortho-facial-analysis';
import {
  FacialFault, openFacialOperation, closeFacialOperation,
  type FacialQuery, type FacialReadPorts, type FacialWritePorts,
} from '../lib/ortho-facial-core-contract';
import {
  appendFacialRevisionWith, prepareFacialRevisionWith, inspectFacialPreparation, appendPreparedFacialRevisionWith,
  type PreparedFacialRevision,
} from '../lib/ortho-facial-revision-core';
import {
  reserveFacialSubmissionWith, executeReservedFacialWith, readFacialSubmissionRecoveryWith, transitionFacialSubmissionWith,
} from '../lib/ortho-facial-submission-core';
import { readFacialAnalysisWith, readFacialPNGWith } from '../lib/ortho-facial-read-core';
import { readFacialHistoryWith } from '../lib/ortho-facial-history-core';
import { Harness, basis, scope, expected, command, revision, submission, chain, type Row } from './fixtures/ortho-facial-core';
const reserve = (h: Harness, c = command()) => reserveFacialSubmissionWith(h.client, { ...expected, command: c }, h.write());
const execute = (h: Harness, c = command()) => executeReservedFacialWith(h.client, { ...expected, command: c }, h.write());
const transition = (h: Harness, action: 'cancel' | 'acknowledge', c = command(), ports = h.write()) => transitionFacialSubmissionWith(h.client, { ...expected, commandId: c.clientRequestId, requestFingerprint: journeyContentHash(c), action }, ports);
const recovery = (h: Harness, ports: FacialReadPorts = h.read()) => readFacialSubmissionRecoveryWith(h.client, scope, ports);
const append = (h: Harness, c = command()) => appendFacialRevisionWith(h.client, scope, c, h.write());
const history = (h: Harness, anchor: Row = h.revisions[h.revisions.length - 1], ports = h.read()) => readFacialHistoryWith(h.client, { ...scope, documentId: 679108321, beforeRevisionId: Number(anchor.id), beforeContentHash: String(anchor.content_sha256) }, ports);
const fault = (code: string) => ({ code });
function reviewedInvalidGeometry(): FacialCommand {
  const c = command(); c.content.quality = { frontalRest: true, headPosition: true, visibleLandmarks: true, perspectiveReviewed: true, note: '' };
  c.content.review = { state: 'reviewed', note: 'Synthetic crossed-eye geometry replay scenario' };
  // Constructed normalized grid, not measured from an image. Reverse the two
  // left eye endpoints deliberately while retaining ordered vertical thirds.
  const point = (column: number, row: number) => ({ state: 'located' as const, x: column / 100, y: row / 100 });
  c.content.landmarks = { axisTop: point(47, 4), axisBottom: point(47, 96),
    tr: point(47, 13), gl: point(47, 34), sn: point(47, 61), me: point(47, 88),
    exImageLeft: point(39, 34), enImageLeft: point(23, 34), enImageRight: point(63, 34), exImageRight: point(81, 34) };
  return c;
}

describe('inactive facial boundaries and caller-owned authority', () => {
  it('has no runtime session, pool, file, image decoder or adapter activation imports', () => {
    for (const name of ['core-contract', 'revision-core', 'submission-core', 'read-core', 'history-core']) {
      const text = readFileSync(join(process.cwd(), 'lib', `ortho-facial-${name}.ts`), 'utf8');
      expect(text).not.toMatch(/from\s+['"](?:\.\/(?:db|auth|session|files|ortho-case-journey-authority|staff-operation-runtime)|sharp)['"]/);
      expect(text).not.toMatch(/\b(?:getPool|ensureSchema|SessionPayload|saveJournaledFacial|recordAudit)\b/);
      expect(text).not.toMatch(/\.query\(\s*['"](?:BEGIN|COMMIT|ROLLBACK)\b/);
    }
  });
  it('pins real attribution and passes the exact client to mandatory audit', async () => {
    const h = new Harness(); const saved = await append(h);
    expect(saved.revision).toMatchObject({ actorId: 695444321, createdBy: "Synthetic reviewer B 04f3086d" });
    expect(h.audits[0].actor).toEqual(h.actor);
    expect(JSON.stringify(h.audits)).not.toMatch(/landmarks|storage_key|private-key|"command"/);
  });
  it.each(['userId', 'name', 'role'] as const)('refuses changed %s after image decoding', async key => {
    const h = new Harness(); h.onVerify = () => { h.actor = { ...h.actor, [key]: key === 'userId' ? 42 : 'Changed' }; };
    await expect(append(h)).rejects.toMatchObject(fault('facial_authority_changed')); expect(h.revisions).toHaveLength(0);
  });
  it.each(['expiry', 'image', 'lifetime', 'port'] as const)('rejects %s drift across the verifier await', async kind => {
    const h = new Harness(), ports = h.write();
    h.onVerify = () => {
      if (kind === 'expiry') h.expired = true;
      if (kind === 'image') h.imageAllowed = false;
      if (kind === 'lifetime') h.epoch++;
      if (kind === 'port') ports.images.verify = async () => ({ ...basis });
    };
    await expect(appendFacialRevisionWith(h.client, scope, command(), ports)).rejects.toThrow();
    expect(h.revisions).toHaveLength(0); expect(h.audits).toHaveLength(0);
  });
  it('rejects expired authority after insert and after audit, requiring caller rollback', async () => {
    for (const stage of ['insert', 'audit']) {
      const h = new Harness();
      if (stage === 'insert') h.onQuery = sql => { if (sql.startsWith('INSERT')) h.expired = true; };
      else h.onAudit = () => { h.expired = true; };
      await expect(h.transaction(() => append(h))).rejects.toThrow('expired_authority');
      expect(h.revisions).toHaveLength(0); expect(h.audits).toHaveLength(0);
    }
  });
  it('rejects forged, another-client, another-ports, closed and reused preparation', async () => {
    const h = new Harness(), ports = h.write(), op = await openFacialOperation(h.client, scope, ports);
    const p = await prepareFacialRevisionWith(op, h.client, ports, command());
    await expect(appendPreparedFacialRevisionWith({} as PreparedFacialRevision, op, h.client, ports)).rejects.toMatchObject(fault('facial_core_context_changed'));
    await expect(inspectFacialPreparation(p, op, { query: h.client.query }, ports)).rejects.toMatchObject(fault('facial_core_context_changed'));
    await expect(inspectFacialPreparation(p, op, h.client, h.write())).rejects.toMatchObject(fault('facial_core_context_changed'));
    await appendPreparedFacialRevisionWith(p, op, h.client, ports);
    await expect(appendPreparedFacialRevisionWith(p, op, h.client, ports)).rejects.toMatchObject(fault('facial_core_context_changed'));
    const another = await prepareFacialRevisionWith(op, h.client, ports, command()); closeFacialOperation(op);
    await expect(inspectFacialPreparation(another, op, h.client, ports)).rejects.toMatchObject(fault('facial_core_context_changed'));
  });
  it('reasserts the private transaction proof before reusing an opaque preparation', async () => {
    const h = new Harness(), ports = h.write(), op = await openFacialOperation(h.client, scope, ports);
    const p = await prepareFacialRevisionWith(op, h.client, ports, command()); h.epoch++;
    await expect(appendPreparedFacialRevisionWith(p, op, h.client, ports)).rejects.toMatchObject(fault('facial_core_context_changed'));
    expect(h.revisions).toHaveLength(0); closeFacialOperation(op);
  });
  it('pins request scope before a table-fence await', async () => {
    const h = new Harness(), input = { ...expected, command: command() };
    h.onQuery = sql => { if (sql.startsWith('LOCK')) input.patientId = 999; };
    await reserveFacialSubmissionWith(h.client, input, h.write()); expect(h.submissions[0].patient_id).toBe(734599007);
  });
  it('cannot turn a read preview into write admission', async () => {
    const h = new Harness(); expect((await readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, h.read())).canWrite).toBe(true);
    h.writeAllowed = false; await expect(append(h)).rejects.toThrow('write_denied');
    await expect(appendFacialRevisionWith(h.client, scope, command(), h.read() as unknown as FacialWritePorts)).rejects.toMatchObject(fault('facial_core_context_changed'));
  });
});

describe('immutable revision and exact source replay', () => {
  it('appends once, replays the same key and rejects changed content', async () => {
    const h = new Harness(); expect((await append(h)).replayed).toBe(false);
    expect((await append(h)).replayed).toBe(true); expect(h.revisions).toHaveLength(1); expect(h.audits).toHaveLength(1);
    await expect(append(h, command({ reason: 'Changed command' }))).rejects.toMatchObject(fault('request_key_conflict'));
    expect(h.verify).toHaveBeenCalledTimes(2);
  });
  it('requires a new head for a new key and preserves exact predecessor/version', async () => {
    const h = new Harness(); await append(h);
    await expect(append(h, command({ clientRequestId: 'new-command-0000002' }))).rejects.toMatchObject(fault('facial_head_changed'));
    const saved = await append(h, command({ clientRequestId: 'new-command-0000002', expectedHeadId: 674648274 }));
    expect(saved.revision.version).toBe(2); expect(saved.revision.command.expectedHeadId).toBe(674648274);
  });
  it('old exact replay ignores new head/date gates but still verifies current bytes', async () => {
    const h = new Harness(), old = command(); old.content.occurrence = { occurredOn: facialScenario.beforeSupportedEra, dateProvenance: 'historical_source', sourceNote: 'Synthetic out-of-range historical replay' };
    h.revisions = [revision(old), revision(command({ clientRequestId: 'later-command-00002', expectedHeadId: 674648274 }), 2, 102)];
    expect((await append(h, old)).replayed).toBe(true); expect(h.verify).toHaveBeenCalledOnce();
    await expect(append(h, { ...old, clientRequestId: 'new-command-0000003', expectedHeadId: 102 })).rejects.toMatchObject(fault('invalid_image_date'));
    h.verifyError = new FacialFault(409, 'facial_image_integrity');
    await expect(append(h, old)).rejects.toMatchObject(fault('facial_image_integrity'));
  });
  it('preserves historical reviewed invalid geometry but refuses a new copy', async () => {
    const h = new Harness(), c = reviewedInvalidGeometry();
    expect(computeFacialResults(c.content).measures.some(m => m.state === 'ready')).toBe(true);
    expect(computeFacialResults(c.content).measures.some(m => m.state === 'invalid_geometry')).toBe(true);
    h.revisions = [revision(c)]; expect((await append(h, c)).replayed).toBe(true);
    await expect(append(h, { ...c, clientRequestId: 'new-invalid-geometry', expectedHeadId: 674648274 })).rejects.toMatchObject(fault('invalid_facial_analysis'));
  });
  it.each([facialScenario.beforeSupportedEra, facialScenario.futureDay])('rejects new date %s without silently substituting today', async occurredOn => {
    const h = new Harness(), c = command(); c.content.occurrence = { occurredOn, dateProvenance: 'historical_source', sourceNote: '' };
    await expect(append(h, c)).rejects.toMatchObject(fault('invalid_image_date')); expect(h.revisions).toHaveLength(0);
  });
  it.each(['hidden', 'archived', 'nonfrontal', 'foreign-patient', 'foreign-case'])('refuses %s source even on exact replay', async kind => {
    const h = new Harness(); h.revisions = [revision()];
    h.doc = { ...h.doc, ...(kind === 'hidden' ? { removed_at: new Date(facialScenario.removed) } : kind === 'archived' ? { photo_stage: 'archived' } : kind === 'nonfrontal' ? { photo_view: 'extraoral_profile' } : kind === 'foreign-patient' ? { patient_id: 12 } : { ortho_case_id: 22 }) };
    await expect(append(h)).rejects.toMatchObject(fault('facial_document_unavailable')); expect(h.verify).not.toHaveBeenCalled();
  });
  it.each(['sha256', 'width', 'height', 'exifOrientation'] as const)('refuses changed image basis %s', async field => {
    const h = new Harness(); h.verify.mockImplementation(async () => ({ ...basis, [field]: field === 'sha256' ? syntheticMismatchSha : basis[field] + 1 }));
    await expect(append(h)).rejects.toMatchObject(fault(field === 'sha256' ? 'facial_image_integrity' : 'facial_image_changed'));
  });
  it.each(['request_fingerprint', 'content_sha256', 'previous_revision_id', 'clinical_case_id', 'results'])('refuses corrupt saved %s', async key => {
    const h = new Harness(); h.revisions = [revision()]; h.revisions[0][key] = key === 'results' ? {} : key.endsWith('_id') ? 999 : syntheticMismatchSha;
    await expect(append(h)).rejects.toMatchObject(fault('facial_history_invalid'));
  });
  it.each(['completed', 'discontinued', 'active', 'retention', 'assessment'])('preserves %s documentation without lifecycle writes', async status => {
    const h = new Harness(); h.status = status; await append(h);
    expect(h.logs.filter(s => /^(INSERT|UPDATE|DELETE)/.test(s)).every(s => s.startsWith('INSERT INTO ortho_facial_revisions'))).toBe(true);
  });
  it('refuses missing/ambiguous bridge and foreign owner', async () => {
    for (const count of [0, 2]) { const h = new Harness(); h.bridges = count; await expect(append(h)).rejects.toMatchObject(fault(count ? 'ambiguous_bridge' : 'bridge_missing')); }
    const h = new Harness(); h.patientId = 12; await expect(append(h)).rejects.toMatchObject(fault('ortho_case_not_found'));
  });
});

describe('separately committed submission protocol (mocked, not PG durability)', () => {
  it('reserves before a distinct execution, then settles revision and receipt together', async () => {
    const h = new Harness(); await h.transaction(() => reserve(h));
    expect(h.revisions).toHaveLength(0); expect(h.submissions[0].state).toBe('pending');
    const boundary = h.logs.lastIndexOf('caller.commit'); await h.transaction(() => execute(h));
    expect(h.logs.indexOf('caller.begin', boundary)).toBeGreaterThan(boundary);
    expect(h.revisions).toHaveLength(1); expect(h.submissions[0]).toMatchObject({ state: 'committed', revision_id: 674648274 });
    expect(h.audits.map(a => a.action === 'ortho.facial_submission' ? a.details.event : 'revision')).toEqual(['reserved', 'revision', 'committed']);
    expect(h.logs).not.toContain('BEGIN'); expect(h.logs).not.toContain('COMMIT'); expect(h.logs).not.toContain('ROLLBACK');
  });
  it('reserve commit uncertainty stops caller orchestration rather than executing', async () => {
    const h = new Harness(); const executeSpy = vi.fn(() => h.transaction(() => execute(h)));
    await expect((async () => { await h.transaction(() => reserve(h), 'uncertain'); await executeSpy(); })()).rejects.toThrow('uncertain_commit');
    expect(executeSpy).not.toHaveBeenCalled(); expect(h.revisions).toHaveLength(0);
  });
  it('execution audit failure rolls back the second mocked transaction, retaining prior pending intent', async () => {
    const h = new Harness(); await h.transaction(() => reserve(h)); h.auditError = Error('audit failed');
    await expect(h.transaction(() => execute(h))).rejects.toThrow('audit failed');
    expect(h.revisions).toHaveLength(0); expect(h.submissions[0].state).toBe('pending'); expect(h.audits).toHaveLength(1);
  });
  it('uncertain execution and acknowledgment commits propagate; no core success fabrication', async () => {
    const h = new Harness(); await h.transaction(() => reserve(h));
    await expect(h.transaction(() => execute(h), 'uncertain')).rejects.toThrow('uncertain_commit');
    await h.transaction(() => execute(h));
    await expect(h.transaction(() => transition(h, 'acknowledge'), 'uncertain')).rejects.toThrow('uncertain_commit');
    // This model restores state for convenience. Actual uncertain commit outcome
    // is deliberately unknown and must be recovered by the caller with same key.
  });
  it('adopts a pre-journal exact revision as committed without a second fact', async () => {
    const h = new Harness(); h.revisions = [revision()]; await reserve(h);
    expect(h.submissions[0]).toMatchObject({ state: 'committed', revision_id: 674648274, previous_version: 0 });
    expect((await execute(h)).replayed).toBe(true); expect(h.revisions).toHaveLength(1); expect(h.audits).toHaveLength(1);
  });
  it('existing identity needs no image grant or verifier but still fresh actor/scope proof', async () => {
    const h = new Harness(); h.submissions = [submission()]; h.imageAllowed = false; h.doc = { ...h.doc, removed_at: new Date(facialScenario.removed) };
    expect(await reserve(h)).toEqual({ ok: true, identity: { id: 750913085, commandId: command().clientRequestId, requestFingerprint: journeyContentHash(command()) } });
    expect(h.verify).not.toHaveBeenCalled(); expect(h.logs).not.toContain('images'); expect(h.audits).toHaveLength(0);
    await expect(reserve(h, command({ reason: 'Changed' }))).rejects.toMatchObject(fault('request_key_conflict'));
    h.actor = { ...h.actor, userId: 42 }; await expect(reserve(h)).rejects.toMatchObject(fault('facial_submission_actor_changed'));
  });
  it.each(['pending', 'committed', 'cancelled'])('refuses a different outstanding %s intent, including another actor', async state => {
    const h = new Harness(); h.submissions = [submission(command({ clientRequestId: 'different-key-000001' }), { actor_user_id: 42, state, revision_id: state === 'committed' ? 674648274 : null })];
    await expect(reserve(h)).rejects.toMatchObject(fault('facial_submission_unacknowledged')); expect(h.verify).not.toHaveBeenCalled();
  });
  it('refuses request actor and clinical bridge drift before source access', async () => {
    const h = new Harness();
    await expect(reserveFacialSubmissionWith(h.client, { ...expected, actorId: 42, command: command() }, h.write())).rejects.toMatchObject(fault('facial_submission_actor_changed'));
    h.bridgeId = 32; await expect(reserve(h)).rejects.toMatchObject(fault('facial_submission_context_changed')); expect(h.verify).not.toHaveBeenCalled();
  });
  it('unresolved recorded ownership is not adopted; acknowledged merged ownership may replay', async () => {
    const h = new Harness(); h.revisions = [{ ...revision(), recorded_patient_id: 10 }];
    h.submissions = [submission(command(), { state: 'committed', revision_id: 674648274, recorded_patient_id: 10 })];
    await expect(reserve(h)).rejects.toMatchObject(fault('facial_submission_context_changed'));
    h.submissions[0].acknowledged_at = new Date(facialScenario.acknowledged); h.submissions[0].command = null;
    expect((await reserve(h)).ok).toBe(true); expect((await execute(h)).replayed).toBe(true);
    expect(h.revisions[0].recorded_patient_id).toBe(10);
  });
  it('acknowledged execution uses exact supplied command, still checking current image', async () => {
    const h = new Harness(); h.revisions = [revision()]; h.submissions = [submission(command(), { state: 'committed', revision_id: 674648274, command: null, acknowledged_at: new Date(facialScenario.acknowledged) })];
    expect((await execute(h)).replayed).toBe(true);
    await expect(execute(h, command({ reason: 'Changed' }))).rejects.toMatchObject(fault('request_key_conflict'));
    h.imageAllowed = false; await expect(execute(h)).rejects.toMatchObject(fault('image_access_denied'));
  });
  it('refuses corrupt retained command and committed result mismatch', async () => {
    const h = new Harness(); h.submissions = [submission(command(), { command: {} })];
    await expect(execute(h)).rejects.toMatchObject(fault('invalid_facial_submission'));
    h.revisions = [revision()]; h.submissions = [submission(command(), { state: 'committed', revision_id: 102 })];
    await expect(execute(h)).rejects.toMatchObject(fault('facial_submission_result_mismatch'));
  });
  it('new reservation audit failure leaves no modeled journal row', async () => {
    const h = new Harness(); h.auditError = Error('audit failed');
    await expect(h.transaction(() => reserve(h))).rejects.toThrow('audit failed'); expect(h.submissions).toHaveLength(0);
  });
});

describe('recovery privacy and metadata-only transition', () => {
  it('returns no outstanding outcome without image access', async () => {
    const h = new Harness(); h.imageAllowed = false; expect((await recovery(h)).recovery).toBeNull(); expect(h.verify).not.toHaveBeenCalled();
  });
  it.each(['actor_user_id', 'recorded_patient_id', 'patient_id', 'clinical_case_id'])('hides another original %s identity and command', async field => {
    const h = new Harness(); h.submissions = [submission(command(), { [field]: 999 })];
    expect((await recovery(h)).recovery).toEqual({ state: 'blocked', identity: null, canCancel: false });
    expect(h.verify).not.toHaveBeenCalled();
  });
  it.each(['pending', 'committed'] as const)('returns valid same-original %s command after full verification', async state => {
    const h = new Harness(); h.submissions = [submission(command(), { state, revision_id: state === 'committed' ? 674648274 : null })]; if (state === 'committed') h.revisions = [revision()];
    const result = (await recovery(h)).recovery;
    expect(result).toMatchObject({ state, expected: { actorId: 695444321, scope: expectedScope(), command: command(), previousVersion: 0 } });
    expect(h.verify).toHaveBeenCalledOnce();
  });
  it.each(['grant', 'hidden', 'nonfrontal', 'bytes', 'decode', 'head'])('blocked pending %s exposes only freshly cancellable identity', async kind => {
    const h = new Harness(); h.submissions = [submission()];
    if (kind === 'grant') h.imageAllowed = false;
    if (kind === 'hidden') h.doc = { ...h.doc, removed_at: new Date(facialScenario.removed) };
    if (kind === 'nonfrontal') h.doc = { ...h.doc, photo_view: 'other' };
    if (kind === 'bytes') h.verifyError = new FacialFault(409, 'facial_image_integrity');
    if (kind === 'decode') h.verifyError = new FacialFault(409, 'facial_image_decode');
    if (kind === 'head') h.revisions = [revision(command({ clientRequestId: 'different-save-00001' }))];
    const result = (await recovery(h)).recovery;
    expect(result).toMatchObject({ state: 'blocked', canCancel: true, identity: { id: 750913085 } });
    expect(JSON.stringify(result)).not.toContain('landmarks'); expect(JSON.stringify(result)).not.toContain('expected');
    h.writeAllowed = false; expect((await recovery(h)).recovery).toEqual({ state: 'blocked', identity: null, canCancel: false });
  });
  it('blocked committed outcome is not cancellable even for a current writer', async () => {
    const h = new Harness(); h.submissions = [submission(command(), { state: 'committed', revision_id: 674648274 })]; h.imageAllowed = false;
    expect((await recovery(h)).recovery).toEqual({ state: 'blocked', identity: null, canCancel: false });
  });
  it('cancelled metadata needs neither image source nor image permission', async () => {
    const h = new Harness(); h.submissions = [submission(command(), { state: 'cancelled' })]; h.imageAllowed = false;
    expect((await recovery(h)).recovery).toMatchObject({ state: 'cancelled', identity: { id: 750913085 } }); expect(h.verify).not.toHaveBeenCalled();
  });
  it.each(['corrupt', 'expired', 'server', 'eligibility-expired'])('does not disguise %s failures as blocked/null recovery', async kind => {
    const h = new Harness(); h.submissions = [submission()]; const ports = h.read();
    if (kind === 'corrupt') h.submissions[0].command = {};
    if (kind === 'expired') h.onVerify = () => { h.expired = true; };
    if (kind === 'server') h.verifyError = new FacialFault(500, 'facial_history_invalid');
    if (kind === 'eligibility-expired') { h.imageAllowed = false; ports.authority.readWriteEligibility = async () => { throw Error('eligibility expired'); }; }
    await expect(recovery(h, ports)).rejects.toThrow();
  });
  it('rechecks cancelled original ownership after the final owner await', async () => {
    const h = new Harness(); h.submissions = [submission(command(), { state: 'cancelled' })]; let bridgeReads = 0;
    h.onQuery = (sql, _values, rows) => { if (sql.includes('FROM clinical_cases') && ++bridgeReads === 2) rows[0].id = 32; };
    expect((await recovery(h)).recovery).toEqual({ state: 'blocked', identity: null, canCancel: false });
  });
  it('pre-arrival cancellation creates a permanent null-document tombstone', async () => {
    const h = new Harness(); h.imageAllowed = false;
    expect(await transition(h, 'cancel')).toMatchObject({ state: 'cancelled', acknowledged: false });
    expect(h.submissions[0]).toMatchObject({ command: null, document_id: null, previous_version: null, state: 'cancelled' });
    await transition(h, 'cancel'); expect(h.audits).toHaveLength(1);
    await transition(h, 'acknowledge'); await transition(h, 'acknowledge'); expect(h.audits).toHaveLength(2);
    expect(h.submissions).toHaveLength(1); expect(h.verify).not.toHaveBeenCalled();
    await expect(reserve(h)).rejects.toMatchObject(fault('facial_submission_cancelled')); await expect(execute(h)).rejects.toMatchObject(fault('facial_submission_cancelled'));
  });
  it('missing acknowledge refuses; pre-journal revision and different outstanding key prevent tombstone', async () => {
    const h = new Harness(); await expect(transition(h, 'acknowledge')).rejects.toMatchObject(fault('facial_submission_not_found'));
    h.revisions = [revision()]; await expect(transition(h, 'cancel')).rejects.toMatchObject(fault('facial_submission_already_committed'));
    h.revisions[0].request_fingerprint = syntheticMismatchSha; await expect(transition(h, 'cancel')).rejects.toMatchObject(fault('request_key_conflict'));
    h.revisions = []; h.submissions = [submission(command({ clientRequestId: 'other-pending-000001' }))];
    await expect(transition(h, 'cancel')).rejects.toMatchObject(fault('facial_submission_unacknowledged'));
  });
  it('pending cannot acknowledge and committed cannot cancel', async () => {
    const h = new Harness(); h.submissions = [submission()]; await expect(transition(h, 'acknowledge')).rejects.toMatchObject(fault('facial_submission_pending'));
    h.submissions[0].state = 'committed'; h.submissions[0].revision_id = 674648274;
    await expect(transition(h, 'cancel')).rejects.toMatchObject(fault('facial_submission_already_committed'));
  });
  it('pending cancel and terminal acknowledge still work for hidden source without image permission', async () => {
    const h = new Harness(); h.submissions = [submission()]; h.doc = { ...h.doc, removed_at: new Date(facialScenario.removed) }; h.imageAllowed = false;
    await transition(h, 'cancel', command(), h.write('nowait')); await transition(h, 'acknowledge', command(), h.write('nowait'));
    expect(h.submissions[0].command).toBeNull(); expect(h.submissions[0].acknowledged_at).toBeInstanceOf(Date); expect(h.verify).not.toHaveBeenCalled();
    const parent = h.logs.findIndex(s => s.startsWith('SELECT id,patient_id,ortho_case_id FROM patient_documents'));
    const lockedOwner = h.logs.findIndex(s => s.includes('FROM ortho_cases') && s.includes('FOR UPDATE'));
    expect(parent).toBeGreaterThan(-1); expect(parent).toBeLessThan(lockedOwner); expect(h.logs[parent]).toContain('FOR SHARE NOWAIT');
  });
  it('legacy transition preserves deferred parent lock behavior; it does not read image source', async () => {
    const h = new Harness(); h.submissions = [submission()]; await transition(h, 'cancel');
    expect(h.logs.some(s => s.includes('FROM patient_documents'))).toBe(false);
  });
  it('acknowledgment audit failure retains command in caller rollback model', async () => {
    const h = new Harness(); h.submissions = [submission(command(), { state: 'committed', revision_id: 674648274 })]; h.auditError = Error('ack audit failed');
    await expect(h.transaction(() => transition(h, 'acknowledge'))).rejects.toThrow('ack audit failed');
    expect(h.submissions[0].command).toEqual(command()); expect(h.submissions[0].acknowledged_at).toBeNull();
  });
  it('terminal repeated transitions still enforce actor/bridge/key/current authority', async () => {
    const h = new Harness(); h.submissions = [submission(command(), { state: 'cancelled' })]; await transition(h, 'cancel');
    await expect(transition(h, 'cancel', command({ reason: 'changed' }))).rejects.toMatchObject(fault('request_key_conflict'));
    h.bridgeId = 32; await expect(transition(h, 'cancel')).rejects.toMatchObject(fault('facial_submission_context_changed'));
    h.bridgeId = 788771589; h.expired = true; await expect(transition(h, 'cancel')).rejects.toThrow('expired_authority');
  });
});
function expectedScope() { return { ...scope, clinicalCaseId: 788771589 }; }

describe('lock-free JSON reads, bounded pinned history and separate PNG', () => {
  it.each(['analysis', 'history', 'recovery'])('snapshot %s emits no locking or mutating SQL', async kind => {
    const h = new Harness(); h.revisions = chain(2);
    if (kind === 'analysis') await readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, h.read());
    if (kind === 'history') await history(h);
    if (kind === 'recovery') await recovery(h);
    expect(h.logs.filter(s => /^(SELECT|LOCK|INSERT|UPDATE|DELETE)/.test(s)).every(s => /^SELECT/.test(s) && !/FOR (UPDATE|SHARE)|LOCK TABLE|pg_advisory/.test(s))).toBe(true);
  });
  it('legacy recovery retains its table and outstanding-row locks', async () => {
    const h = new Harness(); await recovery(h, h.legacy());
    expect(h.logs).toContain('LOCK TABLE ortho_facial_revisions IN ROW EXCLUSIVE MODE');
    expect(h.logs.some(s => s.includes('FROM ortho_facial_submissions') && s.includes('FOR UPDATE'))).toBe(true);
  });
  it('lists 101, exposes 100, retains selected source and exposes only 30 history rows', async () => {
    const h = new Harness(); h.documents = Array.from({ length: 101 }, (_, n) => ({ id: 1000 + n, title: 'Synthetic generated document choice', sha256: basis.sha256, takenOn: null })); h.revisions = chain(32);
    const result = await readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, h.read());
    expect(result.documents).toHaveLength(100); expect(result.documents.at(-1)?.id).toBe(679108321); expect(result.documentsTruncated).toBe(true);
    expect(result.history).toHaveLength(30); expect(result.historyTruncated).toBe(true); expect(JSON.stringify(result)).not.toContain("synthetic-fixtures/04f3086d-620f-47a7-9024-ec3fae80ed23/frontal.png");
  });
  it('initial page preserves nonvalidated sentinel semantics while validating exposed duplicates', async () => {
    const h = new Harness(); h.revisions = chain(31); h.revisions[0].results = { corrupt: true };
    expect((await readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, h.read())).historyTruncated).toBe(true);
    h.revisions[29].id = h.revisions[30].id;
    await expect(readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, h.read())).rejects.toMatchObject(fault('facial_history_invalid'));
  });
  it('null selection has null image and empty history but still requires image disclosure grant for document choices', async () => {
    const h = new Harness(); expect(await readFacialAnalysisWith(h.client, { ...scope, documentId: null }, h.read())).toMatchObject({ image: null, history: [] });
    expect(h.verify).not.toHaveBeenCalled(); h.imageAllowed = false;
    await expect(readFacialAnalysisWith(h.client, { ...scope, documentId: null }, h.read())).rejects.toMatchObject(fault('image_access_denied'));
  });
  it('rechecks image permission after eligibility await before publishing JSON', async () => {
    const h = new Harness(), ports = h.read(); ports.authority.readWriteEligibility = async () => { h.imageAllowed = false; return true; };
    await expect(readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, ports)).rejects.toMatchObject(fault('image_access_denied'));
  });
  it('older pages remain pinned after a later append, with exact 30-terminal and version-1-empty pages', async () => {
    const h = new Harness(); h.revisions = chain(31); const anchor = h.revisions[30];
    const first = await history(h, anchor); expect(first.history).toHaveLength(30); expect(first.hasMore).toBe(false);
    h.revisions = chain(32); expect(await history(h, anchor)).toEqual(first);
    const empty = await history(h, h.revisions[0]); expect(empty.history).toHaveLength(0); expect(empty.hasMore).toBe(false);
  });
  it('older pages validate the 31st sentinel, not merely exposed rows', async () => {
    const h = new Harness(); h.revisions = chain(33); const result = await history(h);
    expect(result.history).toHaveLength(30); expect(result.hasMore).toBe(true);
    h.revisions[1].results = {}; await expect(history(h)).rejects.toMatchObject(fault('facial_history_invalid'));
  });
  it.each(['gap', 'predecessor', 'duplicate', 'foreign-document', 'image'])('refuses corrupt older history %s', async kind => {
    const h = new Harness(); h.revisions = chain(3);
    if (kind === 'gap') h.revisions.splice(1, 1);
    if (kind === 'predecessor') h.revisions[2].previous_revision_id = 999;
    if (kind === 'duplicate') h.revisions[1].id = h.revisions[2].id;
    if (kind === 'foreign-document') h.onQuery = (sql, _values, rows) => { if (sql.includes('version<$3')) rows[0].document_id = 99; };
    if (kind === 'image') h.verify.mockImplementation(async () => ({ ...basis, width: basis.width + 1 }));
    await expect(history(h)).rejects.toMatchObject(fault(kind === 'image' ? 'facial_image_changed' : 'facial_history_invalid'));
  });
  it('empty/gapped terminal history cannot become hasMore', async () => {
    const h = new Harness(); h.revisions = chain(2); h.revisions.splice(0, 1);
    await expect(history(h)).rejects.toMatchObject(fault('facial_history_invalid'));
  });
  it('rejects changed/missing/foreign anchor and invalid cursor before page loading', async () => {
    const h = new Harness(); h.revisions = chain(2); const anchor = h.revisions[1];
    await expect(history(h, { ...anchor, content_sha256: syntheticMismatchSha })).rejects.toMatchObject(fault('facial_history_anchor_changed'));
    await expect(history(h, { ...anchor, id: 999 })).rejects.toMatchObject(fault('facial_history_anchor_unavailable'));
    h.revisions[1].patient_id = 99; await expect(history(h)).rejects.toMatchObject(fault('facial_history_invalid'));
    await expect(history(h, { ...anchor, id: -1 })).rejects.toMatchObject(fault('invalid_history_cursor'));
  });
  it('checks raw row, raw sentinel and raw page budgets before decoding', async () => {
    for (const target of ['anchor', 'sentinel', 'page']) {
      const h = new Harness(); h.revisions = chain(33);
      if (target === 'anchor') h.revisions[32].padding = 'x'.repeat(128 * 1024);
      if (target === 'sentinel') h.revisions[1].padding = 'x'.repeat(128 * 1024);
      if (target === 'page') for (const row of h.revisions) row.padding = 'x'.repeat(70 * 1024);
      await expect(history(h)).rejects.toMatchObject(fault('facial_history_too_large'));
    }
  });
  it('PNG renders only a verified exact SHA under legacy read ports, never as JSON', async () => {
    const h = new Harness(), png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const render = vi.fn(async () => ({ basis: { ...basis }, png }));
    expect((await readFacialPNGWith(h.client, { ...scope, documentId: 679108321, sha256: basis.sha256 }, h.legacy(), { render })).png).toBe(png);
    await expect(readFacialPNGWith(h.client, { ...scope, documentId: 679108321, sha256: syntheticMismatchSha }, h.legacy(), { render })).rejects.toMatchObject(fault('facial_image_changed'));
    await expect(readFacialPNGWith(h.client, { ...scope, documentId: 679108321, sha256: basis.sha256 }, h.read() as ReturnType<Harness['legacy']>, { render })).rejects.toMatchObject(fault('facial_core_context_changed'));
    expect(render).toHaveBeenCalledOnce();
  });
  it('PNG has no side-channel result when final authority fails or bytes/basis are invalid', async () => {
    for (const kind of ['authority', 'signature', 'basis']) {
      const h = new Harness(); const render = async () => {
        if (kind === 'authority') h.expired = true;
        return { basis: { ...basis, sha256: kind === 'basis' ? syntheticMismatchSha : basis.sha256 }, png: Buffer.from('bad-png') };
      };
      await expect(readFacialPNGWith(h.client, { ...scope, documentId: 679108321, sha256: basis.sha256 }, h.legacy(), { render })).rejects.toThrow();
    }
  });
});
