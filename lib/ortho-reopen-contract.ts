import type { CaseStatus, OrthoPhase } from './ortho';
import type { JourneyScope } from './ortho-case-journey-records';
export type OrthoReopenTarget = 'assessment' | 'active' | 'retention';
export type OrthoClosedStatus = 'completed' | 'discontinued';
export interface OrthoReopenCommand {
  schemaVersion: 1;
  clientRequestId: string;
  /** CAS covers status and closure fields only. Independent phase/device data
   * is read and preserved under the case lock, never supplied by this command. */
  expectedLifecycleVersion: number;
  expectedStatus: OrthoClosedStatus;
  targetStatus: OrthoReopenTarget;
  reason: string;
}
export interface OrthoLifecycleSnapshot {
  version: number;
  status: CaseStatus;
  phase: OrthoPhase;
  closedAt: string | null;
  closedBy: string | null;
  closedNote: string | null;
}
export interface OrthoReopenReceipt {
  id: number;
  commandId: string;
  requestFingerprint: string;
  actorId: number;
  createdBy: string;
  createdAt: string;
  reason: string;
  before: OrthoLifecycleSnapshot;
  afterVersion: number;
  targetStatus: OrthoReopenTarget;
}
export interface OrthoReopenRead {
  ok: true;
  scope: JourneyScope;
  actorId: number;
  current: OrthoLifecycleSnapshot;
  history: OrthoReopenReceipt[];
  next: number | null;
  /** Only the current actor's explicitly requested command. Never implies that
   * the case is still open: current is independently read from the same lock. */
  receipt: OrthoReopenReceipt | null;
}
export const isReopenRequestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
export function readOrthoReopenCommand(raw: unknown): OrthoReopenCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_reopen_command');
  const r = raw as Record<string, unknown>;
  const keys = ['schemaVersion', 'clientRequestId', 'expectedLifecycleVersion', 'expectedStatus', 'targetStatus', 'reason'];
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))
    || r.schemaVersion !== 1 || !isReopenRequestId(r.clientRequestId)
    || typeof r.expectedLifecycleVersion !== 'number' || !Number.isInteger(r.expectedLifecycleVersion)
    || r.expectedLifecycleVersion < 0 || r.expectedLifecycleVersion >= 2147483647
    || typeof r.expectedStatus !== 'string' || !['completed', 'discontinued'].includes(r.expectedStatus)
    || typeof r.targetStatus !== 'string' || !['assessment', 'active', 'retention'].includes(r.targetStatus)
    || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 500
    || [...r.reason].some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)))) throw Error('invalid_reopen_command');
  return { schemaVersion: 1, clientRequestId: r.clientRequestId, expectedLifecycleVersion: r.expectedLifecycleVersion,
    expectedStatus: r.expectedStatus as OrthoClosedStatus, targetStatus: r.targetStatus as OrthoReopenTarget, reason: r.reason };
}
