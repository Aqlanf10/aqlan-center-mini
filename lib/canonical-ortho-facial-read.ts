import 'server-only';
import { patientInDoctorScopeWith } from './db';
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from './canonical-read-snapshot';
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from './staff-durable-session';
import { FacialFault, facialFail, facialScope, facialId, facialHash, validateFacialBasis,
  type FacialScope, type FacialActor, type FacialQuery, type FacialReadAuthority, type FacialSnapshotReadPorts,
  type FacialImagePort, type FacialPNGPort, type FacialClockPort, type FacialBasis,
} from './ortho-facial-core-contract';
import { canonicalJourneyJSON } from './ortho-case-journey-json';
import { discoverFacialRecoveryWith, readFacialSubmissionRecoveryWith } from './ortho-facial-submission-core';
import { readFacialAnalysisWith } from './ortho-facial-read-core';
import { readFacialHistoryWith, type FacialHistoryRequest } from './ortho-facial-history-core';
import { FACIAL_READ_BYTES, facialReadBytes, boundFacialRead, guardFacialReadRows, discoverFacialReadWitness,
  assertFacialReadSource, assertFacialReadWitness, type FacialReadWitness,
} from './ortho-facial-read-witness';

type Anchors = Pick<CanonicalSnapshotScope, 'realmId' | 'subjectId' | 'generationId' | 'userId' | 'username' | 'role' | 'clinicianPartyId'>;
const anchorKeys = ['realmId', 'subjectId', 'generationId', 'userId', 'username', 'role', 'clinicianPartyId'] as const;
function anchors(scope: CanonicalSnapshotScope): Anchors {
  return Object.freeze({ realmId: scope.realmId, subjectId: scope.subjectId, generationId: scope.generationId,
    userId: scope.userId, username: scope.username, role: scope.role, clinicianPartyId: scope.clinicianPartyId });
}
function alive(session: VerifiedDurableSession) {
  const claims = revalidateVerifiedDurableSession(session);
  if (!claims) facialFail(401, 'facial_authority_changed');
  return claims;
}
function exactInput(raw: FacialScope, keys: string[]) {
  if (!raw || Object.keys(raw).sort().join(',') !== [...keys, 'patientId', 'orthoCaseId'].sort().join(',')) facialFail(400, 'invalid_scope');
  return facialScope(raw);
}
/** Required trusted server services. No default singleton and no request-owned
 * service, callback, key, pool or schema selector. Not imported by routes. */
export interface CanonicalFacialReadServices { readonly images: FacialImagePort & FacialPNGPort; readonly clock: FacialClockPort }
export function createCanonicalFacialReads(services: CanonicalFacialReadServices) {
  function request(session: VerifiedDurableSession) {
    const images = services.images, clock = services.clock, verify = images.verify, render = images.render, today = clock.today;
    const check = () => {
      alive(session);
      if (services.images !== images || services.clock !== clock || images.verify !== verify || images.render !== render || clock.today !== today) facialFail(500, 'facial_core_context_changed');
    };
    check();
    return { check, verify: verify.bind(images), render: render.bind(images), clock: Object.freeze({ today: today.bind(clock) }) };
  }
  type Request = ReturnType<typeof request>;
  async function inside<T>(session: VerifiedDurableSession, q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope,
    wanted: FacialScope, pin: Request, work: (query: FacialQuery, ports: FacialSnapshotReadPorts, actor: Anchors) => Promise<T>,
    image: FacialImagePort, expectedActor?: Anchors): Promise<T> {
    let open = true, initialRawBytes = 0;
    const originalQuery = q.query, granted = scope.granted, actorAnchors = anchors(scope);
    const actor = Object.freeze({ userId: scope.userId, name: scope.username, role: scope.role });
    const query: FacialQuery & CanonicalSnapshotQuery = Object.freeze({ async query<Row>(sql: string, values?: unknown[]) {
      check();
      const result = await originalQuery.call(q, sql, values);
      guardFacialReadRows(sql, result.rows);
      if (sql.includes('FROM patient_documents') && sql.includes('LIMIT 101')
        || sql.includes('FROM ortho_facial_revisions') && sql.includes('LIMIT 31') && !sql.includes('version<$3')) {
        initialRawBytes += facialReadBytes(result.rows);
        if (initialRawBytes > FACIAL_READ_BYTES.page) facialFail(413, 'facial_history_too_large');
      }
      check();
      return result as { rows: Row[] };
    } });
    function check() {
      pin.check();
      if (!open || q.query !== originalQuery || scope.granted !== granted || anchorKeys.some(key => scope[key] !== actorAnchors[key])) facialFail(401, 'facial_authority_changed');
      const claims = alive(session), d = claims.durableIdentity;
      if (claims.userId !== actor.userId || claims.username !== actor.name || d.realmId !== scope.realmId || d.subjectId !== scope.subjectId || d.generationId !== scope.generationId
        || expectedActor && anchorKeys.some(key => actorAnchors[key] !== expectedActor[key])) facialFail(401, 'facial_authority_changed');
    }
    async function current(passed: FacialQuery, input: FacialScope, expected?: FacialActor) {
      check();
      if (passed !== query || input.patientId !== wanted.patientId || input.orthoCaseId !== wanted.orthoCaseId
        || expected && (expected.userId !== actor.userId || expected.name !== actor.name || expected.role !== actor.role)) facialFail(401, 'facial_authority_changed');
      if (!granted.call(scope, 'clinical.ortho.view')) facialFail(403, 'facial_authority_changed');
      const membership = scope.patientScope;
      const missing = () => facialFail(404, 'ortho_case_not_found');
      if (membership.kind === 'none') missing();
      const patients = await query.query<{ id: number }>('SELECT id FROM patients WHERE id=$1', [wanted.patientId]);
      if (patients.rows.length !== 1 || patients.rows[0].id !== wanted.patientId) missing();
      if (membership.kind === 'own' && !await patientInDoctorScopeWith(query, membership.clinicianPartyId, wanted.patientId)) missing();
      check();
      if (!granted.call(scope, 'clinical.ortho.view')) facialFail(403, 'facial_authority_changed');
      return actor;
    }
    const authority: FacialReadAuthority = Object.freeze({
      authorizeRead: current, assertRead: current,
      async assertImages(passed: FacialQuery, input: FacialScope, expected: FacialActor) {
        await current(passed, input, expected);
        if (!granted.call(scope, 'clinical.xrays.view')) facialFail(403, 'image_access_denied');
        return current(passed, input, expected);
      },
      async readWriteEligibility(passed: FacialQuery, input: FacialScope, expected: FacialActor) {
        await current(passed, input, expected);
        const result = granted.call(scope, 'clinical.ortho.edit');
        await current(passed, input, expected); return result;
      },
    });
    const ports: FacialSnapshotReadPorts = Object.freeze({ mode: 'snapshot-read', authority, images: image, clock: pin.clock });
    try { check(); return await work(query, ports, actorAnchors); }
    finally { open = false; }
  }
  const unavailable: FacialImagePort = Object.freeze({ async verify() { return facialFail(500, 'facial_core_context_changed'); } });
  const options = { errorPrefix: 'FACIAL_READ', maxBytes: FACIAL_READ_BYTES.page } as const;
  const recoveryOptions = { errorPrefix: 'FACIAL_READ', maxBytes: FACIAL_READ_BYTES.recovery } as const;
  const witnessOptions = { errorPrefix: 'FACIAL_READ', maxBytes: FACIAL_READ_BYTES.witness } as const;
  type Captured = { witness: FacialReadWitness; actor: Anchors };
  async function capture(session: VerifiedDurableSession, input: FacialScope & { documentId: number }, pin: Request,
    key: 'read:ortho.facial.analysis' | 'read:ortho.facial.history' | 'read:ortho.facial.image'): Promise<Captured> {
    return runCanonicalReadSnapshot(session, key, (q, scope) => inside(session, q, scope, input, pin, async (query, ports, actor) => {
      const witness = await discoverFacialReadWitness(query, input, input.documentId, ports);
      const result = { witness, actor }; boundFacialRead(result, FACIAL_READ_BYTES.witness); return result;
    }, unavailable), witnessOptions);
  }
  function verifier(captured: Captured, basis: FacialBasis, pin: Request): FacialImagePort {
    return Object.freeze({ async verify(source: FacialReadWitness['source']) { pin.check(); assertFacialReadSource(source, captured.witness.source); return basis; } });
  }
  async function finalProof(query: FacialQuery, ports: FacialSnapshotReadPorts, input: FacialScope & { documentId: number }, captured: Captured) {
    assertFacialReadWitness(await discoverFacialReadWitness(query, input, input.documentId, ports), captured.witness);
  }
  type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fault: FacialFault };
  async function decode<T>(pin: Request, work: () => Promise<T>): Promise<Decoded<T>> {
    let outcome: Decoded<T>;
    try { outcome = { ok: true, value: await work() }; }
    catch (error) {
      outcome = { ok: false, fault: error instanceof FacialFault
        ? new FacialFault(error.status, error.code) : new FacialFault(500, 'facial_core_context_changed') };
    }
    // Rejected native awaits do not bypass immediate expiry/configuration proof.
    pin.check(); return outcome;
  }
  // Never leak native decoder/driver paths or source fields through raw errors.
  async function boundedFailure<T>(work: () => Promise<T>, pin: Request): Promise<T> {
    try { const result = await work(); pin.check(); return result; }
    catch (error) { if (error instanceof FacialFault) throw new FacialFault(error.status, error.code); facialFail(500, 'facial_core_context_changed'); }
  }
  return Object.freeze({
    recovery(session: VerifiedDurableSession, raw: FacialScope) {
      const input = Object.freeze(exactInput(raw, [])), pin = request(session);
      return boundedFailure(async () => {
        const captured = await runCanonicalReadSnapshot(session, 'read:ortho.facial.recovery', (q, admitted) =>
          inside(session, q, admitted, input, pin, async (query, ports, actor) => {
            const plan = await discoverFacialRecoveryWith(query, input, ports);
            const result = { plan, actor, requested: input };
            boundFacialRead(result, FACIAL_READ_BYTES.recovery); return result;
          }, unavailable), recoveryOptions);
        pin.check();
        if (captured.plan.kind === 'metadata') return captured.plan.response;
        const plan = captured.plan;
        const decoded = await decode(pin, async () => validateFacialBasis(await pin.verify(plan.source), plan.source));
        const fixed: FacialImagePort = Object.freeze({ async verify(source: FacialReadWitness['source']) {
          pin.check(); assertFacialReadSource(source, plan.source);
          if (!decoded.ok) throw decoded.fault;
          return decoded.value;
        } });
        return runCanonicalReadSnapshot(session, 'read:ortho.facial.recovery', (q, admitted) =>
          inside(session, q, admitted, input, pin, async (query, ports) => {
            const current = await discoverFacialRecoveryWith(query, input, ports);
            // Metadata intentionally carries no private comparison witness. It
            // cannot settle this request or publish the earlier decoder fault.
            if (current.kind !== 'needs-image') facialFail(409, 'facial_submission_context_changed');
            assertFacialReadWitness(current, plan);
            if (canonicalJourneyJSON(current.row) !== canonicalJourneyJSON(plan.row)) facialFail(409, 'facial_submission_context_changed');
            const result = await readFacialSubmissionRecoveryWith(query, input, ports);
            boundFacialRead(result, FACIAL_READ_BYTES.recovery); return result;
          }, fixed, captured.actor), recoveryOptions);
      }, pin);
    },
    analysis(session: VerifiedDurableSession, raw: FacialScope & { documentId: number | null }) {
      const scope = exactInput(raw, ['documentId']), documentId = raw.documentId;
      if (!(documentId === null || facialId(documentId))) facialFail(400, 'invalid_scope');
      const input = Object.freeze({ ...scope, documentId }), pin = request(session);
      return boundedFailure(async () => {
        if (documentId === null) return runCanonicalReadSnapshot(session, 'read:ortho.facial.analysis', (q, admitted) =>
          inside(session, q, admitted, input, pin, async (query, ports) => {
            const result = await readFacialAnalysisWith(query, input, ports); boundFacialRead(result, FACIAL_READ_BYTES.page); return result;
          }, unavailable), options);
        const selected = { ...scope, documentId };
        const captured = await capture(session, selected, pin, 'read:ortho.facial.analysis'); pin.check();
        const decoded = await decode(pin, async () => validateFacialBasis(await pin.verify(captured.witness.source), captured.witness.source));
        const basis = decoded.ok ? decoded.value : null, failure = decoded.ok ? null : decoded.fault;
        return runCanonicalReadSnapshot(session, 'read:ortho.facial.analysis', (q, admitted) =>
          inside(session, q, admitted, input, pin, async (query, ports) => {
            await finalProof(query, ports, selected, captured);
            if (failure) throw failure;
            const result = await readFacialAnalysisWith(query, selected, ports); boundFacialRead(result, FACIAL_READ_BYTES.page); return result;
          }, basis ? verifier(captured, basis, pin) : unavailable, captured.actor), options);
      }, pin);
    },
    history(session: VerifiedDurableSession, raw: FacialHistoryRequest) {
      const scope = exactInput(raw, ['documentId', 'beforeRevisionId', 'beforeContentHash']);
      const { documentId, beforeRevisionId, beforeContentHash } = raw;
      if (!facialId(documentId) || !facialId(beforeRevisionId) || !facialHash(beforeContentHash)) facialFail(400, 'invalid_history_cursor');
      const input = Object.freeze({ ...scope, documentId, beforeRevisionId, beforeContentHash }), pin = request(session);
      return boundedFailure(async () => {
        const captured = await capture(session, input, pin, 'read:ortho.facial.history'); pin.check();
        const decoded = await decode(pin, async () => validateFacialBasis(await pin.verify(captured.witness.source), captured.witness.source));
        const basis = decoded.ok ? decoded.value : null, failure = decoded.ok ? null : decoded.fault;
        return runCanonicalReadSnapshot(session, 'read:ortho.facial.history', (q, admitted) =>
          inside(session, q, admitted, input, pin, async (query, ports) => {
            await finalProof(query, ports, input, captured);
            if (failure) throw failure;
            return readFacialHistoryWith(query, input, ports);
          }, basis ? verifier(captured, basis, pin) : unavailable, captured.actor), options);
      }, pin);
    },
    image(session: VerifiedDurableSession, raw: FacialScope & { documentId: number; sha256: string }) {
      const scope = exactInput(raw, ['documentId', 'sha256']), { documentId, sha256 } = raw;
      if (!facialId(documentId) || !facialHash(sha256)) facialFail(400, 'invalid_scope');
      const input = Object.freeze({ ...scope, documentId, sha256 }), pin = request(session);
      return boundedFailure(async () => {
        const captured = await capture(session, input, pin, 'read:ortho.facial.image'); pin.check();
        if (captured.witness.source.sha256 !== sha256) facialFail(409, 'facial_image_changed');
        const decoded = await decode(pin, async () => {
          const rendered = await pin.render(captured.witness.source);
          const basis = validateFacialBasis(rendered.basis, captured.witness.source);
          if (!Buffer.isBuffer(rendered.png) || rendered.png.length < 8 || rendered.png.length > 64 * 1024 * 1024
            || !rendered.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) facialFail(409, 'facial_image_decode');
          return { basis, png: Buffer.from(rendered.png) };
        });
        const basis = decoded.ok ? decoded.value.basis : null, failure = decoded.ok ? null : decoded.fault;
        // Only basis/failure enters final proof; bytes remain outside both callbacks.
        await runCanonicalReadSnapshot(session, 'read:ortho.facial.image', (q, admitted) =>
          inside(session, q, admitted, input, pin, async (query, ports) => {
            await finalProof(query, ports, input, captured);
            if (failure) throw failure;
            return { ok: true, documentId, sha256, basis };
          }, basis ? verifier(captured, basis, pin) : unavailable, captured.actor), witnessOptions);
        if (!decoded.ok) throw decoded.fault;
        pin.check(); // synchronous expiry/config proof immediately before publication
        return { ok: true as const, png: decoded.value.png };
      }, pin);
    },
  });
}
