import type { SessionPayload } from './auth';
/** Server-derived context for HTTP intake; omitted only by trusted internal callers. */
export interface OrthoCreateRequest { patientId: number; session: SessionPayload }
export class OrthoCreateAuthorityError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409, readonly code: string, message: string) { super(message); }
}
