/** Synthetic-only local rendering fixture. No app DB, credentials, or network. */
import { mkdirSync, writeFileSync } from "node:fs";
import { renderStudyTextPptx } from "../lib/ortho-study-pptx";
import { studyTextPresentation } from "../lib/ortho-study-text-export";
import { syntheticStudyCommand } from "./fixtures/ortho-case-study";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import type { StudySavedContent } from "../lib/ortho-case-study-capture";
import type { StudyRevision } from "../lib/ortho-case-study-history";
async function main() {
  const authored = syntheticStudyCommand().content;
  authored.comment = "حالة اصطناعية للتحقق فقط. لا توجد بيانات مرضى حقيقيين.";
  const rows = ["T1", "T2", "T3", "T4"].map((phase, index) => {
    const content = { skeletal: "مثال اصطناعي: لا يُستنتج تشخيص", dental: null, crowding: "غير مسجل", overjet: null, bite: null, note: "ملاحظة محفوظة دون إعادة حساب" };
    const selection = { key: `synthetic_${phase}`, kind: "diagnosis" as const, id: 901 + index, version: index + 1, contentHash: journeyContentHash(content) };
    return { phase, content, selection };
  });
  authored.sources = rows.map(row => row.selection);
  authored.groups = rows.map(({ phase, selection }, index) => ({ id: `timepoint_${phase}`, label: phase, phase,
    occurrence: index === 0 ? { occurredOn: null, dateProvenance: "unknown", sourceNote: "تاريخ غير معروف في المثال" }
      : { occurredOn: `2026-0${index + 1}-01`, dateProvenance: "historical_source", sourceNote: "مصدر اصطناعي للتحقق" }, sourceKeys: [selection.key] }));
  authored.panels = [{ instanceId: "diagnosis1", layoutKey: "diagnosis", included: true, state: "available", images: [], sourceKeys: rows.map(row => row.selection.key), comment: "المعلومات الناقصة تبقى غير مسجلة" }];
  const content: StudySavedContent = { schemaVersion: 1, capturedAt: "2026-11-05T00:00:00.000Z", recordedPatientId: 900001,
    orthoCaseId: 900002, clinicalCaseId: 900003, caseStatusAtCapture: "assessment", authored,
    sources: rows.map(({ selection, content }) => ({ selection, state: "available", unavailableReason: null,
      access: { images: false, plans: false }, payload: { id: selection.id, version: selection.version, createdAt: "2026-11-01T00:00:00.000Z", createdBy: "Synthetic clinician", content } })) };
  const revision: StudyRevision<StudySavedContent> = { id: 900004, patientId: 900001, recordedPatientId: 900001, orthoCaseId: 900002, clinicalCaseId: 900003,
    version: 1, kind: "draft", schemaVersion: 1, predecessorId: null, documentedFromId: null, baseDocumentedId: null, actorId: 900005, createdAt: content.capturedAt,
    content, contentHash: journeyContentHash(content), reason: "Synthetic visual verification" };
  const presentation = studyTextPresentation(revision, revision);
  mkdirSync("docs/ortho/evidence/saved-study-20261105", { recursive: true });
  writeFileSync("docs/ortho/evidence/saved-study-20261105/synthetic-text.pptx", await renderStudyTextPptx(presentation));
  writeFileSync("docs/ortho/evidence/saved-study-20261105/synthetic-presentation.json", JSON.stringify(presentation, null, 2));
}
void main();
