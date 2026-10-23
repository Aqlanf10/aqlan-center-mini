/** Cursors are navigation hints, never patient authority. Exact PG microseconds
 * avoid dropping rows when deadlines differ below JavaScript's millisecond precision. */
export interface FollowupCursor { due: string; id: number; generation: string; patientId: number | null }
export interface FollowupPageOptions { limit: number; patientId: number | null; cursor: FollowupCursor | null }
export function parseFollowupPage(params: URLSearchParams): FollowupPageOptions | null {
  if ([...params.keys()].some(k => !['limit', 'patientId', 'cursor'].includes(k) || params.getAll(k).length !== 1)) return null;
  const limit = params.get('limit') ?? '25';
  const patient = params.get('patientId');
  if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit) || (patient !== null && (!/^[1-9]\d*$/.test(patient) || Number(patient) > 2147483647))) return null;
  const patientId = patient === null ? null : Number(patient);
  let cursor: FollowupCursor | null = null;
  const token = params.get('cursor');
  if (token !== null) {
    if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    try {
      const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      if (!value || Object.keys(value).sort().join(',') !== 'due,generation,id,patientId'
        || typeof value.due !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.due)
        || !Number.isFinite(Date.parse(value.due)) || new Date(value.due).toISOString().slice(0,19) !== value.due.slice(0,19) || !Number.isInteger(value.id) || value.id <= 0 || value.id > 2147483647
        || typeof value.generation !== 'string' || !/^[a-f0-9]{32}$/.test(value.generation) || value.patientId !== patientId) return null;
      cursor = value;
    } catch { return null; }
  }
  return { limit: Number(limit), patientId, cursor };
}
export function encodeFollowupCursor(value: FollowupCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
