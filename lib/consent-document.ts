import { getConsentTemplate, type ConsentTemplate } from "./consent-templates";

/** A bounded snapshot in the existing document note, never a second consent store. */
export const CONSENT_NOTE_MAX_BYTES = 16 * 1024;
export const CONSENT_ACKNOWLEDGEMENT = "أقر بأنني قرأت وفهمت كافة الشروط والمضاعفات المذكورة أعلاه، وأمنح موافقتي التامة للطبيب المعالج لإجراء المعالجة المطلوبة.";

export interface ConsentDocumentContext {
  patientId: number;
  visitId: number | null;
  orthoCaseId: number | null;
  adjustmentId: number | null;
  takenOn: string | null;
}

export interface ConsentDocumentContent {
  title: string;
  procedureName: string;
  summary: string;
  terms: string[];
  risks: string[];
  acknowledgement: string;
}

export interface ConsentDocumentMetadata extends ConsentDocumentContext {
  format: "aqlan-consent";
  schemaVersion: 1;
  takenOn: string;
  patientName: string;
  templateId: string;
  signatoryName: string;
  signatoryRelation: "self" | "guardian";
  guardianRelation: string | null;
  content: ConsentDocumentContent;
}

type MetadataResult = { ok: true; metadata: ConsentDocumentMetadata; note: string }
  | { ok: false; message: string };
const invalid = (): { ok: false; message: string } => ({
  ok: false, message: "بيانات الإقرار غير مكتملة أو غير صالحة. راجع النموذج وبيانات الموقّع.",
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validId = (value: unknown): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const optionalId = (value: unknown) => value === null || validId(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string"
  && value.length > 0 && value.length <= maximum && value.trim() === value
  // eslint-disable-next-line no-control-regex -- Intentionally reject non-text C0/DEL controls; preserve tab/newline in displayed clinical clauses.
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const identityText = (value: unknown, maximum: number): value is string => text(value, maximum)
  // Keep Arabic letters, combining marks and joiners exactly as supplied. Only
  // the visibility check ignores invisible code points; stored text is not rewritten.
  && !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)
  && /[\p{L}\p{N}]/u.test(value.replace(/\p{Default_Ignorable_Code_Point}/gu, ""));
const textList = (value: unknown): value is string[] => Array.isArray(value)
  && value.length > 0 && value.length <= 20 && value.every((item) => text(item, 2000));
export const isConsentDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

function snapshot(template: ConsentTemplate): ConsentDocumentContent {
  // Only material actually shown in the signing modal is part of the snapshot.
  // The old print-only post-op clauses and declaration cannot become signed terms.
  return { title: template.title, procedureName: template.procedureName, summary: template.summary,
    terms: [...template.terms], risks: [...template.risks], acknowledgement: CONSENT_ACKNOWLEDGEMENT };
}

function contentFrom(value: unknown): ConsentDocumentContent | null {
  if (!record(value) || !exactKeys(value, ["title", "procedureName", "summary", "terms", "risks", "acknowledgement"])
    || !text(value.title, 500) || !text(value.procedureName, 500) || !text(value.summary, 4000)
    || !textList(value.terms) || !textList(value.risks) || !text(value.acknowledgement, 2000)) return null;
  return { title: value.title, procedureName: value.procedureName, summary: value.summary,
    terms: [...value.terms], risks: [...value.risks], acknowledgement: value.acknowledgement };
}

function metadataFrom(value: unknown): ConsentDocumentMetadata | null {
  if (!record(value) || !exactKeys(value, ["format", "schemaVersion", "patientId", "visitId", "orthoCaseId",
    "adjustmentId", "takenOn", "patientName", "templateId", "signatoryName", "signatoryRelation", "guardianRelation", "content"])
    || value.format !== "aqlan-consent" || value.schemaVersion !== 1
    || !validId(value.patientId) || !optionalId(value.visitId) || !optionalId(value.orthoCaseId)
    || !optionalId(value.adjustmentId) || !isConsentDate(value.takenOn)
    || typeof value.templateId !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(value.templateId)
    || !identityText(value.patientName, 200) || !identityText(value.signatoryName, 200)
    || (value.signatoryRelation !== "self" && value.signatoryRelation !== "guardian")
    || (value.signatoryRelation === "self" ? value.guardianRelation !== null : !identityText(value.guardianRelation, 120))) return null;
  const content = contentFrom(value.content);
  if (!content) return null;
  return { format: "aqlan-consent", schemaVersion: 1, patientId: value.patientId,
    visitId: value.visitId as number | null, orthoCaseId: value.orthoCaseId as number | null,
    adjustmentId: value.adjustmentId as number | null, takenOn: value.takenOn,
    patientName: value.patientName, templateId: value.templateId, signatoryName: value.signatoryName,
    signatoryRelation: value.signatoryRelation, guardianRelation: value.guardianRelation as string | null, content };
}

function matchesContext(metadata: ConsentDocumentMetadata, context: ConsentDocumentContext) {
  return metadata.patientId === context.patientId && metadata.visitId === context.visitId
    && metadata.orthoCaseId === context.orthoCaseId && metadata.adjustmentId === context.adjustmentId
    && metadata.takenOn === context.takenOn;
}

/** Used by the modal's current client bundle after the human reviews its displayed terms. */
export function createConsentDocumentMetadata(input: ConsentDocumentContext & {
  patientName: string;
  templateId: string;
  signatoryName: string;
  signatoryRelation: "self" | "guardian";
  guardianRelation: string | null;
}): MetadataResult {
  if (typeof input.patientName !== "string" || typeof input.signatoryName !== "string"
    || (input.guardianRelation !== null && typeof input.guardianRelation !== "string")) return invalid();
  const template = getConsentTemplate(input.templateId);
  if (!template) return invalid();
  const metadata = metadataFrom({ format: "aqlan-consent", schemaVersion: 1,
    patientId: input.patientId, visitId: input.visitId, orthoCaseId: input.orthoCaseId,
    adjustmentId: input.adjustmentId, takenOn: input.takenOn, patientName: input.patientName.trim(), templateId: input.templateId,
    signatoryName: input.signatoryName.trim(), signatoryRelation: input.signatoryRelation,
    guardianRelation: input.guardianRelation?.trim() ?? null, content: snapshot(template) });
  if (!metadata) return invalid();
  const note = JSON.stringify(metadata);
  return byteLength(note) <= CONSENT_NOTE_MAX_BYTES ? { ok: true, metadata, note } : invalid();
}

/** Historical reads use only the saved versioned content, even after template retirement. */
export function parseStoredConsentDocumentMetadata(note: string | null, context: ConsentDocumentContext): MetadataResult {
  if (!note || byteLength(note) > CONSENT_NOTE_MAX_BYTES) return invalid();
  try {
    const metadata = metadataFrom(JSON.parse(note));
    if (!metadata || !matchesContext(metadata, context)) return invalid();
    return { ok: true, metadata, note: JSON.stringify(metadata) };
  } catch { return invalid(); }
}

/**
 * Scanned documents/free-text and unversioned clients remain ordinary originals.
 * They are never promoted to generated signed templates or silently truncated.
 */
export function validateConsentUploadNote(rawNote: string, context: ConsentDocumentContext):
  { ok: true; note: string | null; generated: boolean } | { ok: false; status: 400 | 409; message: string } {
  const note = rawNote.trim();
  if (byteLength(note) > CONSENT_NOTE_MAX_BYTES) return {
    ok: false, status: 400, message: "بيانات الإقرار تتجاوز الحجم المسموح. لا يمكن حفظها مختصرة.",
  };
  let value: unknown;
  try { value = JSON.parse(note); } catch {
    // A truncated/broken v1 claim is invalid, not a legacy free-text escape hatch.
    if (/"aqlan-consent"|"schemaVersion"\s*:/.test(note)) return { ...invalid(), status: 400 };
    return { ok: true, note: note || null, generated: false };
  }
  const claimsGenerated = record(value) && (value.format === "aqlan-consent" || Object.hasOwn(value, "schemaVersion"));
  if (!claimsGenerated) return { ok: true, note: note || null, generated: false };
  const parsed = parseStoredConsentDocumentMetadata(note, context);
  if (!parsed.ok) return { ...parsed, status: 400 };
  const current = getConsentTemplate(parsed.metadata.templateId);
  if (!current) return { ...invalid(), status: 400 };
  if (JSON.stringify(parsed.metadata.content) !== JSON.stringify(snapshot(current))) return {
    ok: false, status: 409, message: "تغيّر نص نموذج الإقرار. أعد فتح النموذج وراجع النص الحالي ثم وقّع من جديد؛ لم يُحفظ التوقيع.",
  };
  return { ok: true, note: parsed.note, generated: true };
}
