import { CONSENT_NOTE_MAX_BYTES, createConsentDocumentMetadata } from "../../lib/consent-document";

/** Synthetic historical snapshot for pagination only; no upload, human signature or DB. */
export function longConsentPrintFixture() {
  const built = createConsentDocumentMetadata({ patientId: 91, patientName: "SYNTHETIC-CONSENT-PATIENT مريض اصطناعي لاختبار استمرار سياق الإقرار",
    visitId: null, orthoCaseId: null, adjustmentId: null, takenOn: "2026-10-03", templateId: "root_canal",
    signatoryName: "SYNTHETIC-SIGNATORY-801", signatoryRelation: "guardian", guardianRelation: "وصي اصطناعي" });
  if (!built.ok) throw new Error(built.message);
  const metadata = structuredClone(built.metadata);
  metadata.content.procedureName = "SYNTHETIC-PROCEDURE-801 إجراء اصطناعي لاختبار الطباعة";
  metadata.content.summary = "Synthetic historical snapshot. These are layout fixture clauses, not medical advice or a human consent.";
  const markers = Array.from({ length: 20 }, (_, index) => `CONSENT-CLAUSE-${String(index + 1).padStart(2, "0")}`);
  metadata.content.terms = markers.map((marker) => `${marker} فقرة اصطناعية محفوظة للتأكد من بقاء النص كاملاً على صفحات الطباعة.`);
  metadata.content.risks = ["CONSENT-RISK-END خطر اصطناعي لاختبار حفظ ترتيب النص فقط"];
  // Grow to just below 16KiB with many wrapped lines; each individual term stays
  // within the parser's 2,000-character bound. Tokens identify missing/duplicated clauses.
  const filler = " نص محفوظ للاختبار Synthetic stored text.";
  for (let index = 0; ; index = (index + 1) % markers.length) {
    const next = metadata.content.terms[index] + filler;
    if (next.length > 2000) break;
    const previous = metadata.content.terms[index];
    metadata.content.terms[index] = next;
    if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > CONSENT_NOTE_MAX_BYTES - 100) {
      metadata.content.terms[index] = previous; break;
    }
  }
  return { metadata, note: JSON.stringify(metadata), markers };
}
