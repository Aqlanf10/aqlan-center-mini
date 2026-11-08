// Independently authored scenario clock. Slots represent test roles, not a patient timeline.
export const facialScenario = {
  today: '2016-09-21',
  driftDay: '2016-09-23', // Different day for source/clock drift, not a clinical interval.
  futureDay: '2016-09-22', // Injected clock + one day: new occurrence must be rejected.
  beforeSupportedEra: '1800-01-01', // Deliberately outside the supported image date domain.
  revision: '2016-09-21T14:15:00.000Z',
  acknowledged: '2016-09-21T15:25:00.000Z',
  removed: '2016-09-21T16:35:00.000Z',
} as const;
// Synthetic data regenerated locally for privacy audit; no file, database, or image reads.

import { vi } from 'vitest';
import { blankFacialContent, computeFacialResults, type FacialCommand } from '../../lib/ortho-facial-analysis';
import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
import {
  FacialFault, type FacialActor, type FacialAuditEvent, type FacialDocumentSource, type FacialQuery,
  type FacialWritePorts, type FacialReadPorts, type FacialLegacyReadPorts, type FacialScope,
} from '../../lib/ortho-facial-core-contract';
export const scope = { patientId: 734599007, orthoCaseId: 639752548 };
export const expected = { ...scope, clinicalCaseId: 788771589, actorId: 695444321 };
export const basis = { sha256: "9b302f23a15c4bef03b64c8187d37d2e5c905683072d32036937dd3e50e3c730", width: 640, height: 640, exifOrientation: 1 };
export function command(overrides: Partial<FacialCommand> = {}): FacialCommand {
  return { schemaVersion: 1, clientRequestId: "synthetic-fccb3be9-9ff3-471b-8e82-779ad9f31e70", documentId: 679108321, expectedHeadId: null, reason: "Synthetic privacy fixture 11 04f3086d", content: blankFacialContent({ ...basis }), ...overrides };
}
export type Row = Record<string, unknown>;
export function revision(c: FacialCommand = command(), version = 1, id = 674648274): Row {
  const results = computeFacialResults(c.content);
  return { id, patient_id: scope.patientId, recorded_patient_id: scope.patientId, ortho_case_id: scope.orthoCaseId, clinical_case_id: 788771589,
    document_id: c.documentId, version, previous_revision_id: c.expectedHeadId, actor_user_id: 695444321, created_by: "Synthetic reviewer B 04f3086d", created_at: new Date(facialScenario.revision),
    command_id: c.clientRequestId, request_fingerprint: journeyContentHash(c), content_sha256: journeyContentHash({ content: c.content, results }), command: structuredClone(c), results };
}
export function chain(count: number): Row[] {
  const rows: Row[] = [];
  for (let version = 1; version <= count; version++) rows.push(revision(command({ clientRequestId: `synthetic-chain-04f3086d-620f-47a7-9024-ec3fae80ed23-${String(version).padStart(6, '0')}`, expectedHeadId: version === 1 ? null : 674648273 + version - 1 }), version, 674648273 + version));
  return rows;
}
export function submission(c = command(), overrides: Row = {}): Row {
  return { id: 750913085, patient_id: 734599007, recorded_patient_id: 734599007, ortho_case_id: 639752548, clinical_case_id: 788771589, actor_user_id: 695444321,
    document_id: c.documentId, command_id: c.clientRequestId, request_fingerprint: journeyContentHash(c), command: structuredClone(c), previous_version: c.expectedHeadId === null ? 0 : 1,
    state: 'pending', revision_id: null, acknowledged_at: null, ...overrides };
}
export class Harness {
  actor: FacialActor = { userId: 695444321, name: "Synthetic reviewer B 04f3086d", role: 'verified-existing-role' };
  patientId = 734599007; caseId = 639752548; bridgeId = 788771589; status = 'assessment'; bridges = 1;
  doc: FacialDocumentSource = { id: 679108321, patient_id: 734599007, ortho_case_id: 639752548, photo_stage: null, photo_view: 'extraoral_frontal', removed_at: null,
    sha256: basis.sha256, storage_key: "synthetic-fixtures/04f3086d-620f-47a7-9024-ec3fae80ed23/frontal.png", mime_type: 'image/png', size_bytes: 4096, title: "Synthetic privacy fixture 13 04f3086d", taken_on: null };
  documents: Row[] = [{ id: 679108321, title: "Synthetic privacy fixture 13 04f3086d", sha256: basis.sha256, takenOn: null }];
  revisions: Row[] = []; submissions: Row[] = []; audits: FacialAuditEvent[] = [];
  logs: string[] = []; imageAllowed = true; writeAllowed = true; expired = false; epoch = 1; active = true;
  today = facialScenario.today; verifyError: Error | null = null; auditError: Error | null = null;
  onVerify: (() => void | Promise<void>) | null = null;
  onCurrent: (() => void | Promise<void>) | null = null;
  onAudit: (() => void | Promise<void>) | null = null;
  onQuery: ((sql: string, values: unknown[], rows: Row[]) => void | Promise<void>) | null = null;
  verify = vi.fn(async (source: FacialDocumentSource) => {
    this.logs.push('verify'); await this.onVerify?.(); if (this.verifyError) throw this.verifyError;
    if (source.storage_key !== this.doc.storage_key || source.sha256 !== this.doc.sha256) throw new FacialFault(409, 'facial_image_integrity');
    return { ...basis };
  });
  client: FacialQuery = { query: async <R extends object = Row>(sql: string, values: unknown[] = []) => {
    this.logs.push(sql); let rows: Row[] = [];
    if (sql.startsWith('LOCK TABLE')) { /* In-memory lock: no rows to return. */ }
    else if (sql.includes('FROM ortho_cases')) rows = [{ id: this.caseId, patient_id: this.patientId, status: this.status, plan_id: null }];
    else if (sql.includes('FROM clinical_cases')) rows = Array.from({ length: this.bridges }, (_, n) => ({ id: this.bridgeId + n, patient_id: this.patientId, ortho_case_id: this.caseId, specialty: 'orthodontics' }));
    else if (sql.includes('FROM patient_documents')) rows = sql.includes('WHERE id=$1') ? [{ ...structuredClone(this.doc) }] : structuredClone(this.documents);
    else if (sql.startsWith('SELECT') && sql.includes('FROM ortho_facial_revisions')) {
      rows = this.revisions.filter(r => r.ortho_case_id === values[sql.includes('WHERE id=$1') ? 1 : 0]);
      if (sql.includes('WHERE id=$1')) rows = rows.filter(r => r.id === values[0] && r.document_id === values[2]);
      else if (sql.includes('actor_user_id=$2')) rows = rows.filter(r => r.actor_user_id === values[1] && r.command_id === values[2]);
      else {
        rows = rows.filter(r => r.document_id === values[1]);
        if (sql.includes('version<$3')) rows = rows.filter(r => Number(r.version) < Number(values[2]));
        rows = rows.slice().sort((a, b) => Number(b.version) - Number(a.version)).slice(0, sql.endsWith('LIMIT 1') ? 1 : 31);
      }
      rows = structuredClone(rows);
    } else if (sql.startsWith('SELECT') && sql.includes('FROM ortho_facial_submissions')) {
      rows = this.submissions.filter(r => r.ortho_case_id === values[0]);
      rows = sql.includes('actor_user_id=$2') ? rows.filter(r => r.actor_user_id === values[1] && r.command_id === values[2]) : rows.filter(r => r.acknowledged_at === null);
      rows = structuredClone(rows);
    } else if (sql.startsWith('INSERT INTO ortho_facial_revisions')) {
      const c = JSON.parse(String(values[11])) as FacialCommand;
      const row = { ...revision(c, Number(values[4]), 674648274 + this.revisions.length), patient_id: values[0], recorded_patient_id: values[0], ortho_case_id: values[1], clinical_case_id: values[2], document_id: values[3], previous_revision_id: values[5], actor_user_id: values[6], created_by: values[7], command_id: values[8], request_fingerprint: values[9], content_sha256: values[10], results: JSON.parse(String(values[12])) };
      this.revisions.push(row); rows = [structuredClone(row)];
    } else if (sql.startsWith('INSERT INTO ortho_facial_submissions')) {
      const tombstone = sql.includes("NULL,NULL,'cancelled'");
      const row = { id: 750913085 + this.submissions.length, patient_id: values[0], recorded_patient_id: values[0], ortho_case_id: values[1], clinical_case_id: values[2], actor_user_id: values[3], command_id: values[4], request_fingerprint: values[5],
        command: tombstone ? null : JSON.parse(String(values[6])), previous_version: tombstone ? null : values[7], state: tombstone ? 'cancelled' : values[8], revision_id: tombstone ? null : values[9], document_id: tombstone ? null : values[10], acknowledged_at: null };
      this.submissions.push(row); rows = [structuredClone(row)];
    } else if (sql.startsWith('UPDATE ortho_facial_submissions')) {
      const row = this.submissions.find(r => r.id === values[0]);
      if (!row) throw Error('mock missing row');
      if (sql.includes("state='committed'")) { row.state = 'committed'; row.revision_id = values[1]; }
      else if (sql.includes("state='cancelled'")) row.state = 'cancelled';
      else { row.acknowledged_at = new Date(facialScenario.acknowledged); row.command = null; }
      rows = [structuredClone(row)];
    } else throw Error(`Unexpected SQL: ${sql}`);
    await this.onQuery?.(sql, values, rows);
    return { rows: rows as R[] };
  } };
  private authority() {
    const epoch = this.epoch;
    const current = async (client: FacialQuery, requested: FacialScope) => {
      this.logs.push('assert'); await this.onCurrent?.();
      if (client !== this.client || epoch !== this.epoch || !this.active) throw new FacialFault(500, 'facial_core_context_changed');
      if (this.expired) throw Error('expired_authority');
      if (requested.patientId !== 734599007 || requested.orthoCaseId !== 639752548) throw new FacialFault(403, 'scope_mismatch');
      return { ...this.actor };
    };
    const image = async (client: FacialQuery, requested: FacialScope) => {
      this.logs.push('images'); const actor = await current(client, requested);
      if (!this.imageAllowed) throw new FacialFault(403, 'image_access_denied');
      return actor;
    };
    const write = async (client: FacialQuery, requested: FacialScope) => {
      const actor = await current(client, requested); if (!this.writeAllowed) throw Error('write_denied'); return actor;
    };
    return { authorizeWrite: write, assertWrite: write, authorizeRead: current, assertRead: current, assertImages: image,
      readWriteEligibility: async (client: FacialQuery, requested: FacialScope) => { await current(client, requested); this.logs.push('eligibility'); return this.writeAllowed; } };
  }
  write(locking: 'wait' | 'nowait' = 'wait'): FacialWritePorts {
    return { mode: 'write', locking, authority: this.authority(), images: { verify: this.verify }, clock: { today: () => this.today },
      audit: { append: async (client, event) => { if (client !== this.client) throw Error('audit_client'); this.logs.push('audit'); await this.onAudit?.(); if (this.auditError) throw this.auditError; this.audits.push(structuredClone(event)); } } };
  }
  read(mode: 'snapshot-read' | 'legacy-read' = 'snapshot-read'): FacialReadPorts {
    return { mode, authority: this.authority(), images: { verify: this.verify }, clock: { today: () => this.today } };
  }
  legacy(): FacialLegacyReadPorts { return { ...this.read(), mode: 'legacy-read' }; }
  async transaction<T>(body: () => Promise<T>, commit: 'ok' | 'uncertain' = 'ok'): Promise<T> {
    
    const before = structuredClone({ revisions: this.revisions, submissions: this.submissions, audits: this.audits });
    this.logs.push('caller.begin'); this.epoch++;
    try { const result = await body(); this.logs.push('caller.commit'); if (commit === 'uncertain') throw Error('uncertain_commit'); return result; }
    catch (error) { this.logs.push('caller.rollback'); this.revisions = before.revisions; this.submissions = before.submissions; this.audits = before.audits; throw error; }
    finally { this.epoch++; }
  }
}
