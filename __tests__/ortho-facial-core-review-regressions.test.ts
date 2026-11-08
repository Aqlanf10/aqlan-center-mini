import { facialScenario } from './fixtures/ortho-facial-core';
import { createHash } from 'node:crypto';
const syntheticMismatchSha = createHash('sha256').update('synthetic companion refresh v1: independent facial mismatch').digest('hex');
// Provenance: core-derived values use the approved synthetic fixture. SQL/schema/error strings,
// negative identity sentinels, integer revisions, PNG signature and byte/count limits are test constants.
/** Authentic review regressions against frozen baseline. No production adapter.
 * Mutations use the exact SELECT-return objects captured by the query port. */
import { describe, expect, it } from 'vitest';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import type { FacialCommand, FacialResults } from '../lib/ortho-facial-analysis';
import type { FacialReadAuthority, FacialWriteAuthority, FacialWritePorts } from '../lib/ortho-facial-core-contract';
import { appendFacialRevisionWith } from '../lib/ortho-facial-revision-core';
import { reserveFacialSubmissionWith, transitionFacialSubmissionWith } from '../lib/ortho-facial-submission-core';
import { readFacialAnalysisWith } from '../lib/ortho-facial-read-core';
import { Harness, basis, command, expected, revision, scope, submission, type Row } from './fixtures/ortho-facial-core';
const request = () => ({ ...expected, command: command() });
const transitionRequest = (action: 'cancel' | 'acknowledge') => ({ ...expected, action, commandId: command().clientRequestId, requestFingerprint: journeyContentHash(command()) });
const identity = () => ({ id: 750913085, commandId: command().clientRequestId, requestFingerprint: journeyContentHash(command()) });

describe('review R1: detach persisted query data before later awaits', () => {
  it.each(['command', 'results'] as const)('ignores later mutation of the SELECT-return replay %s alias', async field => {
    const h = new Harness(), original = revision(); h.revisions = [structuredClone(original)]; let selected: Row | undefined;
    h.onQuery = (sql, _values, rows) => { if (sql.startsWith('SELECT * FROM ortho_facial_revisions') && sql.includes('actor_user_id=$2')) selected = rows[0]; };
    h.onVerify = () => {
      expect(selected).toBeDefined(); expect(Object.isFrozen(selected)).toBe(false);
      if (field === 'command') (selected!.command as FacialCommand).reason = 'Mutated after saved hash validation';
      else (selected!.results as FacialResults).measures[0].message = 'Mutated after saved result validation';
    };
    const saved = await appendFacialRevisionWith(h.client, scope, command(), h.write());
    expect(saved.revision.command).toEqual(original.command); expect(saved.revision.results).toEqual(original.results);
    expect(saved.revision.requestFingerprint).toBe(journeyContentHash(saved.revision.command));
    expect(saved.revision.contentHash).toBe(journeyContentHash({ content: saved.revision.command.content, results: saved.revision.results }));
    expect(h.revisions[0]).toEqual(original); expect(h.audits).toHaveLength(0);
  });
  it.each(['command_id', 'request_fingerprint', 'state', 'recorded_patient_id'] as const)('ignores later mutation of the SELECT-return journal %s alias', async field => {
    const h = new Harness(); h.submissions = [submission()]; let selected: Row | undefined;
    h.onQuery = (sql, _values, rows) => {
      if (sql.startsWith('SELECT * FROM ortho_facial_submissions') && sql.includes('actor_user_id=$2')) selected = rows[0];
      if (selected && sql.includes('FROM ortho_cases') && sql.includes('FOR SHARE')) {
        expect(Object.isFrozen(selected)).toBe(false);
        selected[field] = field === 'command_id' ? 'another-private-key-0001' : field === 'request_fingerprint' ? syntheticMismatchSha : field === 'state' ? 'cancelled' : 999;
      }
    };
    expect(await reserveFacialSubmissionWith(h.client, request(), h.write())).toEqual({ ok: true, identity: identity() });
    expect(h.submissions[0]).toEqual(submission()); expect(h.verify).not.toHaveBeenCalled(); expect(h.audits).toHaveLength(0);
  });
  it('detaches the returned head witness before the post-query authority await', async () => {
    const h = new Harness(); h.revisions = [revision()]; let selected: Row | undefined, mutated = false;
    h.onQuery = (sql, _values, rows) => { if (sql.startsWith('SELECT id,version FROM ortho_facial_revisions')) selected = rows[0]; };
    h.onCurrent = () => { if (selected && !mutated) { selected.id = 999; selected.version = 99; mutated = true; } };
    const c = command({ clientRequestId: 'new-head-review-00001', expectedHeadId: 674648274 });
    const saved = await appendFacialRevisionWith(h.client, scope, c, h.write());
    expect(mutated).toBe(true); expect(saved.revision.version).toBe(2); expect(saved.revision.command.expectedHeadId).toBe(674648274);
    expect(h.revisions[1]).toMatchObject({ version: 2, previous_revision_id: 674648274 });
  });
  it.each(['title', 'sha256', 'takenOn'] as const)('detaches listed document %s before image verification awaits', async field => {
    const h = new Harness(); let selected: Row | undefined;
    h.onQuery = (sql, _values, rows) => { if (sql.includes('FROM patient_documents') && sql.includes('LIMIT 101')) selected = rows[0]; };
    h.onVerify = () => { expect(selected).toBeDefined(); selected![field] = field === 'title' ? 'Other private title' : field === 'sha256' ? syntheticMismatchSha : facialScenario.driftDay; };
    const read = await readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, h.read());
    expect(read.documents).toEqual([{ id: 679108321, title: "Synthetic privacy fixture 13 04f3086d", sha256: basis.sha256, takenOn: null }]);
    expect(h.documents).toEqual([{ id: 679108321, title: "Synthetic privacy fixture 13 04f3086d", sha256: basis.sha256, takenOn: null }]);
  });
  it('keeps valid unchanged replay and document projections intact', async () => {
    const h = new Harness(); h.revisions = [revision()];
    expect((await appendFacialRevisionWith(h.client, scope, command(), h.write())).replayed).toBe(true);
    expect((await readFacialAnalysisWith(h.client, { ...scope, documentId: 679108321 }, h.read())).documents).toEqual(h.documents);
  });
});

describe('review R2: no admission downgrade during pre-admission fences', () => {
  it.each(['reserve', 'cancel', 'acknowledge'] as const)('rejects %s write-to-snapshot mode drift without taking read admission', async action => {
    await modeDrift(action, 'snapshot-read');
  });
  it.each(['reserve', 'cancel', 'acknowledge'] as const)('rejects %s write-to-legacy-read mode drift without taking read admission', async action => {
    await modeDrift(action, 'legacy-read');
  });
  it.each(['locking', 'images', 'clock', 'audit'] as const)('pins %s configuration before the first fence await', async field => {
    const h = new Harness(), ports = h.write(); h.writeAllowed = false; let mutated = false;
    h.onQuery = sql => {
      if (!mutated && sql.startsWith('LOCK TABLE')) {
        mutated = true; const mutable = ports as { -readonly [K in keyof FacialWritePorts]: FacialWritePorts[K] };
        if (field === 'locking') mutable.locking = 'nowait';
        else if (field === 'images') mutable.images = { ...ports.images };
        else if (field === 'clock') mutable.clock = { ...ports.clock };
        else mutable.audit = { ...ports.audit };
      }
    };
    await expect(reserveFacialSubmissionWith(h.client, request(), ports)).rejects.toMatchObject({ code: 'facial_core_context_changed' });
    expect(h.submissions).toHaveLength(0); expect(h.audits).toHaveLength(0);
  });
  it('still observes real write-grant revocation behind unchanged callback identities', async () => {
    const h = new Harness(), ports = h.write();
    h.onQuery = sql => { if (sql.startsWith('LOCK TABLE')) h.writeAllowed = false; };
    await expect(reserveFacialSubmissionWith(h.client, request(), ports)).rejects.toThrow('write_denied');
    expect(h.submissions).toHaveLength(0);
  });
});
async function modeDrift(action: 'reserve' | 'cancel' | 'acknowledge', target: 'snapshot-read' | 'legacy-read') {
  const h = new Harness(), ports = h.write(); h.writeAllowed = false;
  if (action !== 'reserve') h.submissions = [submission(command(), { state: action === 'cancel' ? 'pending' : 'cancelled' })];
  const authority = ports.authority as FacialWriteAuthority & FacialReadAuthority;
  const originalRead = authority.authorizeRead; let readAdmissions = 0, mutated = false;
  authority.authorizeRead = async (...args) => { readAdmissions++; return originalRead(...args); };
  h.onQuery = sql => { if (!mutated && sql.startsWith('LOCK TABLE')) { mutated = true; (ports as unknown as { mode: string }).mode = target; } };
  const operation = action === 'reserve' ? reserveFacialSubmissionWith(h.client, request(), ports)
    : transitionFacialSubmissionWith(h.client, transitionRequest(action), ports);
  await expect(operation).rejects.toMatchObject({ code: 'facial_core_context_changed' });
  expect(readAdmissions).toBe(0); expect(h.audits).toHaveLength(0);
  if (action === 'reserve') expect(h.submissions).toHaveLength(0);
  else expect(h.submissions[0]).toEqual(submission(command(), { state: action === 'cancel' ? 'pending' : 'cancelled' }));
}

describe('review R3: exact 0116 cancelled-and-acknowledged provenance exception', () => {
  it.each(['cancel', 'acknowledge'] as const)('repeats %s after same-patient document reassignment, with NOWAIT provenance lock', async action => {
    const h = new Harness(); h.imageAllowed = false;
    h.submissions = [submission(command(), { state: 'cancelled', command: null, acknowledged_at: new Date(facialScenario.acknowledged) })];
    h.doc = { ...h.doc, ortho_case_id: 22, removed_at: new Date(facialScenario.removed), photo_stage: 'archived', photo_view: 'other' };
    expect(await transitionFacialSubmissionWith(h.client, transitionRequest(action), h.write('nowait'))).toMatchObject({ ok: true, identity: identity(), state: 'cancelled', acknowledged: true });
    expect(h.logs.some(sql => sql.startsWith('SELECT id,patient_id,ortho_case_id FROM patient_documents') && sql.includes('FOR SHARE NOWAIT'))).toBe(true);
    expect(h.verify).not.toHaveBeenCalled(); expect(h.audits).toHaveLength(0); expect(h.logs).not.toContain('images');
  });
  it.each(['cancel', 'acknowledge'] as const)('still refuses %s when that acknowledged cancelled document changed patient', async action => {
    const h = new Harness(); h.submissions = [submission(command(), { state: 'cancelled', command: null, acknowledged_at: new Date(facialScenario.acknowledged) })];
    h.doc = { ...h.doc, patient_id: 12, ortho_case_id: 22 };
    await expect(transitionFacialSubmissionWith(h.client, transitionRequest(action), h.write('nowait'))).rejects.toMatchObject({ code: 'facial_submission_context_changed' });
    expect(h.audits).toHaveLength(0);
  });
  it.each(['pending', 'cancelled', 'committed'] as const)('does not apply the exception to %s without both cancelled and acknowledged', async state => {
    const h = new Harness(); h.submissions = [submission(command(), { state, revision_id: state === 'committed' ? 674648274 : null,
      ...(state === 'committed' ? { command: null, acknowledged_at: new Date(facialScenario.acknowledged) } : {}) })];
    h.doc = { ...h.doc, ortho_case_id: 22 };
    await expect(transitionFacialSubmissionWith(h.client, transitionRequest(state === 'committed' ? 'acknowledge' : 'cancel'), h.write('nowait'))).rejects.toMatchObject({ code: 'facial_submission_context_changed' });
    expect(h.audits).toHaveLength(0);
  });
});
