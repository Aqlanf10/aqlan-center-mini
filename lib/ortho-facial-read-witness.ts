/** Inert, bounded witnesses only. No authority, image IO or transaction ownership. */
import { facialFail, openFacialOperation, closeFacialOperation, assertFacialOperation,
  type FacialDocumentSource, type FacialOwner, type FacialScope, type FacialQuery, type FacialSnapshotReadPorts,
} from './ortho-facial-core-contract';
import { readFacialSourceWith, readFacialOwnerWith } from './ortho-facial-revision-core';

export const FACIAL_READ_BYTES = Object.freeze({ witness: 16 * 1024, row: 128 * 1024, page: 2 * 1024 * 1024, recovery: 256 * 1024 });
export function facialReadBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { facialFail(500, 'facial_history_invalid'); }
}
export function boundFacialRead(value: unknown, maximum: number) {
  if (facialReadBytes(value) > maximum) facialFail(413, 'facial_history_too_large');
}
export interface FacialReadWitness { readonly source: FacialDocumentSource; readonly owner: FacialOwner }
/** Eligible sources have null removal time. Size preserves exact representation:
 * decimal strings must be canonical positive integers; no arbitrary coercion. */
export function copyFacialReadSource(source: FacialDocumentSource): FacialDocumentSource {
  boundFacialRead(source, FACIAL_READ_BYTES.witness);
  const size = source.size_bytes;
  if (!(typeof size === 'number' && Number.isSafeInteger(size) || typeof size === 'string' && /^[1-9][0-9]{0,7}$/.test(size))
    || Number(size) <= 0 || Number(size) > 25 * 1024 * 1024
    || source.removed_at !== null || !(source.photo_stage === null || typeof source.photo_stage === 'string')
    || !['image/jpeg', 'image/png', 'image/webp'].includes(source.mime_type)) facialFail(409, 'facial_image_integrity');
  return Object.freeze({ id: source.id, patient_id: source.patient_id, ortho_case_id: source.ortho_case_id,
    photo_stage: source.photo_stage, photo_view: source.photo_view, removed_at: null,
    sha256: source.sha256, storage_key: source.storage_key, mime_type: source.mime_type, size_bytes: size,
    title: source.title, taken_on: source.taken_on });
}
export function assertFacialReadSource(actual: FacialDocumentSource, expected: FacialDocumentSource) {
  const current = copyFacialReadSource(actual);
  if ((Object.keys(expected) as (keyof FacialDocumentSource)[]).some(key => current[key] !== expected[key])) facialFail(409, 'facial_image_changed');
}
export function assertFacialReadWitness(actual: FacialReadWitness, expected: FacialReadWitness) {
  assertFacialReadSource(actual.source, expected.source);
  if ((Object.keys(expected.owner) as (keyof FacialOwner)[]).some(key => actual.owner[key] !== expected.owner[key])) facialFail(409, 'facial_submission_context_changed');
}
export async function discoverFacialReadWitness(q: FacialQuery, scope: FacialScope, documentId: number, ports: FacialSnapshotReadPorts): Promise<FacialReadWitness> {
  if (ports.mode !== 'snapshot-read') facialFail(500, 'facial_core_context_changed');
  const operation = await openFacialOperation(q, scope, ports);
  try {
    const source = copyFacialReadSource(await readFacialSourceWith(operation, q, ports, documentId));
    const owner = await readFacialOwnerWith(operation, q, ports);
    await assertFacialOperation(operation, q, ports, true);
    const result = Object.freeze({ source, owner });
    boundFacialRead(result, FACIAL_READ_BYTES.witness);
    return result;
  } finally { closeFacialOperation(operation); }
}
/** Outstanding journal data only. Cardinality precedes all iteration/copying;
 * present malformed rows must never become the core's absent-row sentinel. */
export function guardFacialRecoveryRows(rows: readonly unknown[]) {
  if (!Array.isArray(rows) || rows.length > 1) facialFail(500, 'invalid_facial_submission');
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) facialFail(500, 'invalid_facial_submission');
    boundFacialRead(row, FACIAL_READ_BYTES.row);
  }
}
/** Deterministic data budgets, never SQL-based admission. Called synchronously
 * on raw driver results before the kernel's structuredClone or authority await. */
export function guardFacialReadRows(sql: string, rows: readonly unknown[]) {
  // Fixed internal SELECT recognition is a data guard, never admission.
  if (sql.startsWith('SELECT * FROM ortho_facial_submissions WHERE ortho_case_id=$1 AND acknowledged_at IS NULL ')) guardFacialRecoveryRows(rows);
  if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) facialFail(500, 'facial_core_port_invalid');
  if (sql.startsWith('SELECT id,patient_id') && (sql.includes('FROM ortho_cases') || sql.includes('FROM clinical_cases'))) {
    if (rows.length > 1) facialFail(sql.includes('FROM ortho_cases') ? 404 : 409,
      sql.includes('FROM ortho_cases') ? 'ortho_case_not_found' : 'ambiguous_bridge');
    for (const row of rows) boundFacialRead(row, FACIAL_READ_BYTES.witness);
    boundFacialRead(rows, FACIAL_READ_BYTES.witness);
  }
  if (sql.includes('FROM patient_documents')) {
    const listed = sql.includes('LIMIT 101');
    if (rows.length > (listed ? 101 : 1)) facialFail(500, 'facial_history_invalid');
    for (const row of rows) boundFacialRead(row, listed ? FACIAL_READ_BYTES.row : FACIAL_READ_BYTES.witness);
    boundFacialRead(rows, listed ? FACIAL_READ_BYTES.page : FACIAL_READ_BYTES.witness);
  }
  if (sql.includes('FROM ortho_facial_revisions')) {
    if (rows.length > (sql.includes('LIMIT 31') ? 31 : 1)) facialFail(500, 'facial_history_invalid');
    for (const row of rows) boundFacialRead(row, FACIAL_READ_BYTES.row);
    // Older kernel separately budgets anchor + 30; initial includes all raw rows.
    if (!sql.includes('version<$3')) boundFacialRead(rows, FACIAL_READ_BYTES.page);
  }
}
