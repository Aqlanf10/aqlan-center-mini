import type { SessionPayload } from './auth';
export interface OrthoBaselineRequest { patientId: number; session: SessionPayload }
export class OrthoBaselineAuthorityError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409, readonly code: string, message: string) { super(message); }
}
