import { caseLayout } from "./ortho-case-template";
import type { JourneyScope } from "./ortho-case-journey-records";
import type { StudyRevision } from "./ortho-case-study-history";
import type { StudySavedContent } from "./ortho-case-study-capture";
import { projectStudyRecordedFacts } from "./ortho-case-study-recorded-facts";

export const STUDY_TEXT_RENDERER = "ortho-text-v1";
export interface StudyTextPage { title: string; lines: string[]; sourceKeys: string[] }
export interface StudyTextPresentation { caseId: number; revisionId: number; revisionHash: string; version: number; kind: "draft" | "documented"; capturedAt: string; pages: StudyTextPage[] }

/** Bounded text-only export of a saved version. No current facts are mixed into
 * the snapshot, no image transform is guessed, and overflow is paginated. */
export function studyTextPresentation(revision: StudyRevision<StudySavedContent>, scope: JourneyScope): StudyTextPresentation {
  const pages: StudyTextPage[] = [];
  for (const panel of revision.content.authored.panels.filter(panel => panel.included)) {
    const facts = projectStudyRecordedFacts(revision.content, scope, panel.instanceId, revision.kind);
    const title = caseLayout(panel.layoutKey)!.titleAr;
    const lines: string[] = [];
    if (panel.state !== "available") lines.push(`حالة القسم: ${panel.state === "not_recorded" ? "غير مسجل" : panel.state === "restricted" ? "مقيّد" : "غير متاح"}`);
    for (const block of facts.blocks) {
      if (block.kind === "paragraph") lines.push(block.text);
      else for (const row of block.rows) lines.push(row.cells.map((cell, i) => `${block.headers[i]}: ${cell}`).join(" — "));
    }
    for (const comment of [revision.content.authored.comment, panel.comment].filter(Boolean)) lines.push(`تعليق الطبيب: ${comment}`);
    if (panel.images.length || panel.sourceKeys.some(key => revision.content.sources.some(source => source.selection.key === key && source.selection.kind === "document"))) {
      lines.push("هذه نسخة نصية. الصور المختارة وتحويلاتها لا تُصدّر في هذه النسخة؛ راجع صور الحالة الأصلية داخل الملف.");
    }
    for (const item of facts.unavailable) lines.push(`مصدر غير متاح: ${item.sourceKey} (${item.reason})`);
    for (const item of facts.unmapped) lines.push(`مصدر محفوظ لم يُعرض نصياً: ${item.sourceKey} (${item.reason})`);
    if (!lines.length) lines.push("لا توجد حقائق نصية مسجلة في هذا القسم.");
    // Split long words/lines without dropping a character. No font shrinking
    // substitutes for pagination, including a long visit/assessment history.
    const wrapped = lines.flatMap(line => line.split("\n").flatMap(part => {
      const chars = Array.from(part), chunks: string[] = [];
      for (let index = 0; index < chars.length; index += 100) chunks.push(chars.slice(index, index + 100).join(""));
      return chunks.length ? chunks : [""];
    }));
    for (let offset = 0; offset < wrapped.length; offset += 12) {
      pages.push({ title: offset ? `${title} — تابع` : title, lines: wrapped.slice(offset, offset + 12), sourceKeys: [...panel.sourceKeys] });
      if (pages.length > 300) throw new Error("study_text_export_limit");
    }
  }
  if (!pages.length) throw new Error("study_text_export_empty");
  return { caseId: scope.orthoCaseId, revisionId: revision.id, revisionHash: revision.contentHash, version: revision.version,
    kind: revision.kind, capturedAt: revision.content.capturedAt, pages };
}
