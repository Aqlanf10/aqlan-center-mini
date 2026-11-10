/** Additive source envelope; its base retains the original evidence version. */
import { parseCephCorrectionOrigin, type CephCorrectionOrigin } from './ceph-correction-origin';
export interface StudyCephLineageCapture { captureVersion: 4; base: Record<string, unknown>; correctionOrigin: CephCorrectionOrigin }
export function isStudyCephLineageCapture(value: unknown): value is StudyCephLineageCapture {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as {captureVersion?:unknown}).captureVersion === 4;
}
/** The caller must also decode the base and verify the outer selection hash. */
export function readStudyCephLineageEnvelope(raw: unknown): StudyCephLineageCapture {
  if (!isStudyCephLineageCapture(raw) || Object.keys(raw).length !== 3 || !Object.hasOwn(raw,'base') || !Object.hasOwn(raw,'correctionOrigin')
    || !raw.base || typeof raw.base !== 'object' || Array.isArray(raw.base) || isStudyCephLineageCapture(raw.base)) throw Error('invalid_ceph_lineage_capture');
  const origin = parseCephCorrectionOrigin(raw.correctionOrigin);
  if (!origin || raw.base.id === origin.parentAnalysisId) throw Error('invalid_ceph_lineage_capture');
  return {captureVersion:4,base:raw.base,correctionOrigin:origin};
}
/** Only use after the complete saved-content decoder has validated the payload. */
export function studyCephBase(raw: unknown): unknown { return isStudyCephLineageCapture(raw) ? raw.base : raw; }
export function withStudyCephLineage(base: unknown, origin: CephCorrectionOrigin | null): unknown {
  return origin ? readStudyCephLineageEnvelope({captureVersion:4,base,correctionOrigin:origin}) : base;
}
