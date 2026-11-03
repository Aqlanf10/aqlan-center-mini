import { WEBCEPH_RECORD_SLOTS, type PhotoStage, type PhotoView } from "./ortho-photos";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";

export type RecordUploadCommand = {
  schemaVersion: 1;
  clientRequestId: string;
  title: string;
  photoView: PhotoView;
  photoStage: PhotoStage | null;
  occurrence: { state: "known" | "unknown"; takenOn: string | null; sourceNote: string };
  file: { sha256: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; sizeBytes: number };
};
export type RecordUploadReceipt = {
  ok: true; patientId: number; orthoCaseId: number; clinicalCaseId: number;
  documentId: number; actorId: number; commandId: string; requestFingerprint: string; replayed: boolean;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(",") === expected.sort().join(",");
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const RECORD_IMAGE_LIMIT = 25 * 1024 * 1024;
export function readRecordUploadCommand(raw: unknown): RecordUploadCommand {
  const fail = (): never => { throw Error("invalid_record_upload"); };
  if (!object(raw) || !keys(raw, ["schemaVersion", "clientRequestId", "title", "photoView", "photoStage", "occurrence", "file"])
    || raw.schemaVersion !== 1 || typeof raw.clientRequestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(raw.clientRequestId)
    || typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 120
    || !WEBCEPH_RECORD_SLOTS.some(slot => slot.key === raw.photoView)
    || !(raw.photoStage === null || ["initial", "progress", "debond", "retention"].includes(String(raw.photoStage)))) return fail();
  const occurrence = raw.occurrence, file = raw.file;
  if (!object(occurrence) || !keys(occurrence, ["state", "takenOn", "sourceNote"])
    || typeof occurrence.sourceNote !== "string" || occurrence.sourceNote.trim().length < 3 || occurrence.sourceNote.length > 200
    || !(occurrence.state === "unknown" && occurrence.takenOn === null || occurrence.state === "known" && date(occurrence.takenOn))
    || !object(file) || !keys(file, ["sha256", "mimeType", "sizeBytes"])
    || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
    || !["image/jpeg", "image/png", "image/webp"].includes(String(file.mimeType))
    || typeof file.sizeBytes !== "number" || !Number.isInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > RECORD_IMAGE_LIMIT) return fail();
  return raw as unknown as RecordUploadCommand;
}
export async function verifyRecordUploadReceipt(raw: unknown, expected: { patientId: number; orthoCaseId: number; actorId: number; command: RecordUploadCommand }, status: number): Promise<RecordUploadReceipt> {
  if (!object(raw) || !keys(raw, ["ok", "patientId", "orthoCaseId", "clinicalCaseId", "documentId", "actorId", "commandId", "requestFingerprint", "replayed"])
    || raw.ok !== true || raw.patientId !== expected.patientId || raw.orthoCaseId !== expected.orthoCaseId || raw.actorId !== expected.actorId
    || raw.commandId !== expected.command.clientRequestId || typeof raw.replayed !== "boolean" || status !== (raw.replayed ? 200 : 201)
    || ![raw.clinicalCaseId, raw.documentId].every(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) throw Error("record_receipt_mismatch");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJourneyJSON(expected.command))))].map(v => v.toString(16).padStart(2, "0")).join("");
  if (raw.requestFingerprint !== hash) throw Error("record_receipt_mismatch");
  return raw as unknown as RecordUploadReceipt;
}
