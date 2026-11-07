/** Nested evidence format only. The saved study and source selection stay v1.
 * Capture2 preserves completion-time capture; capture3 pins submitted source
 * identity matching. Neither establishes independent clinical validation. */
import { decodeCephCompletionWitness, decodeCephCompletionWitnessV1,
  type CephCompletionWitnessV1, type CephCompletionWitnessV2 } from "./ceph-completion-provenance";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyId, journeyHash, type Checked } from "./ortho-case-journey-records";
import type { StudySourceSelection } from "./ortho-case-study";

interface StudyCephCaptureMetadata {
  id: number; status: "completed"; phase: string; acquisitionDate: string | null;
  device: string | null; studyKind: string; note: string | null; createdAt: string; createdBy: string;
}
export interface WitnessedStudyCephCaptureV2 extends StudyCephCaptureMetadata {
  captureVersion: 2;
  completion: { witness: CephCompletionWitnessV1; witnessSha256: string };
}
export interface WitnessedStudyCephCaptureV3 extends StudyCephCaptureMetadata {
  captureVersion: 3;
  completion: { witness: CephCompletionWitnessV2; witnessSha256: string };
}
export type WitnessedStudyCephCapture = WitnessedStudyCephCaptureV2 | WitnessedStudyCephCaptureV3;
const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === "object" && !Array.isArray(raw);
const fields = (raw: Record<string, unknown>, names: readonly string[]) => Object.keys(raw).length === names.length && names.every(k => Object.hasOwn(raw, k));
const text = (raw: unknown, max: number, nullable = false) => raw === null && nullable || typeof raw === "string" && raw.length <= max;
const failure = { ok: false, code: "invalid_study_ceph_capture" } as const;
/** Use only on payloads that already passed decodeStudySavedContent. This is a
 * representation discriminant, never a substitute for integrity/authority. */
export function isWitnessedStudyCephCapture(raw: unknown): raw is WitnessedStudyCephCapture {
  return object(raw) && (raw.captureVersion === 2 || raw.captureVersion === 3);
}
function captureEnvelope(raw: unknown, selection: StudySourceSelection, version: 2 | 3) {
  if (!object(raw) || !fields(raw, ["captureVersion", "id", "status", "phase", "acquisitionDate", "device", "studyKind", "note", "createdAt", "createdBy", "completion"])
    || raw.captureVersion !== version || raw.status !== "completed" || !journeyId(raw.id)
    || selection.kind !== "ceph_study" || selection.version !== null || raw.id !== selection.id
    || !journeyHash(selection.contentHash) || journeyContentHash(raw) !== selection.contentHash
    || !text(raw.phase, 100) || !text(raw.acquisitionDate, 20, true) || !text(raw.device, 500, true)
    || !text(raw.studyKind, 100) || !text(raw.note, 4000, true) || !text(raw.createdBy, 200)
    || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))
    || !object(raw.completion) || !fields(raw.completion, ["witness", "witnessSha256"])) return null;
  return { capture: raw, completion: raw.completion };
}
/** The original capture2 bytes/hash and exact witness1 contract stay frozen. */
export function decodeWitnessedStudyCephCaptureV2(raw: unknown, selection: StudySourceSelection): Checked<WitnessedStudyCephCaptureV2> {
  try {
    const envelope = captureEnvelope(raw, selection, 2);
    if (!envelope) return failure;
    const witness = decodeCephCompletionWitnessV1(envelope.completion.witness, envelope.completion.witnessSha256);
    if (!witness || witness.analysisId !== envelope.capture.id) return failure;
    return { ok: true, value: envelope.capture as unknown as WitnessedStudyCephCaptureV2 };
  } catch { return failure; }
}
/** Separate representation for source-bound witness2; never relabel witness1. */
export function decodeWitnessedStudyCephCaptureV3(raw: unknown, selection: StudySourceSelection): Checked<WitnessedStudyCephCaptureV3> {
  try {
    const envelope = captureEnvelope(raw, selection, 3);
    if (!envelope) return failure;
    const witness = decodeCephCompletionWitness(envelope.completion.witness, envelope.completion.witnessSha256);
    if (!witness || witness.schemaVersion !== 2 || witness.analysisId !== envelope.capture.id) return failure;
    return { ok: true, value: envelope.capture as unknown as WitnessedStudyCephCaptureV3 };
  } catch { return failure; }
}
export function decodeWitnessedStudyCephCapture(raw: unknown, selection: StudySourceSelection): Checked<WitnessedStudyCephCapture> {
  if (!object(raw)) return failure;
  if (raw.captureVersion === 2) return decodeWitnessedStudyCephCaptureV2(raw, selection);
  if (raw.captureVersion === 3) return decodeWitnessedStudyCephCaptureV3(raw, selection);
  return failure;
}
