/**
 * سجل إقرار الموافقة كما تحفظه شاشة التوقيع في `patient_documents.note` — كتابته وقراءته في مكانٍ واحد.
 *
 * القراءة صارمة (fail closed): سجلٌّ ناقص الهوية أو غير مقروء ⇒ لا نسخة موقّعة. وما حُفظ من نص الإقرار يُعرض كما حُفظ:
 * قسمٌ غائب أو مشوَّه يبقى «غير محفوظ» صراحةً — لا يُستكمل من قالب اليوم ولا بقائمةٍ فارغة توحي بالاكتمال.
 */
import type { ConsentTemplate } from "./consent-templates";

/** حدّ الملاحظة في مسار رفع المستندات (`/api/patients/[id]/documents`) — يُقصّ ما بعده. */
export const DOCUMENT_NOTE_LIMIT = 300;

/** قسمٌ من نص الإقرار: محفوظٌ بقائمته (قد تكون فارغة صراحةً)، أو غير محفوظ/غير مقروء. */
export type StoredSection = { state: "stored"; items: string[] } | { state: "missing" } | { state: "malformed" };

export interface StoredConsent {
  templateId: string;
  signatoryName: string;
  signatoryRelation: "self" | "guardian";
  guardianRelation: string | null;
  procedureName: string | null;
  title: string | null;
  /**
   * نص الإقرار كما حُفظ وقت التوقيع. `null` = لم يحفظ السجل أيّ قسمٍ منه (السجلات الحالية لا تحفظه).
   * `complete` = البنود محفوظة غير فارغة وكل قسمٍ محفوظ؛ غير ذلك ناقص ويُعرض ناقصًا.
   */
  snapshot: { terms: StoredSection; risks: StoredSection; postOpInstructions: StoredSection; complete: boolean } | null;
}

function section(record: Record<string, unknown>, key: string): StoredSection {
  if (!(key in record) || record[key] === undefined || record[key] === null) return { state: "missing" };
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return { state: "malformed" };
  return { state: "stored", items: value as string[] };
}

/** سجل الإقرار كما حفظته شاشة التوقيع — ناقص الهوية أو مشوَّه ⇒ `null` (لا نسخة موقّعة). */
export function parseStoredConsent(note: string | null): StoredConsent | null {
  if (!note) return null;
  let value: unknown;
  try {
    value = JSON.parse(note);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string) : null);
  const templateId = text("templateId");
  const signatoryName = text("signatoryName");
  const relation = record.signatoryRelation;
  if (!templateId || !signatoryName || (relation !== "self" && relation !== "guardian")) return null;
  const terms = section(record, "terms");
  const risks = section(record, "risks");
  const postOpInstructions = section(record, "postOpInstructions");
  const anyText = [terms, risks, postOpInstructions].some((one) => one.state !== "missing");
  // Terms must be present, non-empty and non-blank to call the stored text complete; risks/care may be explicitly empty.
  const termsUsable = terms.state === "stored" && terms.items.length > 0 && terms.items.every((item) => item.trim() !== "");
  return {
    templateId,
    signatoryName,
    signatoryRelation: relation,
    guardianRelation: text("guardianRelation"),
    procedureName: text("procedureName"),
    title: text("title"),
    snapshot: anyText
      ? { terms, risks, postOpInstructions, complete: termsUsable && risks.state === "stored" && postOpInstructions.state === "stored" }
      : null,
  };
}

/** ما تحفظه شاشة التوقيع (`ConsentModal`) في ملاحظة المستند — المصدر الواحد لحمولتها. */
export function buildConsentNotePayload(input: {
  template: Pick<ConsentTemplate, "id" | "procedureName" | "title">;
  signatoryName: string;
  signatoryRelation: "self" | "guardian";
  guardianRelation: string | null;
}) {
  const { template, signatoryName: name, signatoryRelation, guardianRelation } = input;
  return {
    templateId: template.id,
    signatoryName: name,
    signatoryRelation,
    guardianRelation: guardianRelation || null,
    procedureName: template.procedureName,
    title: template.title,
    textNote: `الموقع: ${name} (${signatoryRelation === "self" ? "المريض شخصياً" : `ولي الأمر: ${guardianRelation || "قريب"}`}) · ${template.title}`,
  };
}
