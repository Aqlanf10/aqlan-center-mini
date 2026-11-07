import type { SessionPayload } from './auth';
export interface OrthoCloseRequest { patientId: number; session: SessionPayload }
export class OrthoCloseAuthorityError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409, readonly code: string, message: string) { super(message); }
}
