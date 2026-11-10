import { studyNotesProjectionHash, type StudyNotesPage, type StudyNotesProjection } from "./ortho-study-presentation-notes";
import { wrapStudyTextLine } from "./ortho-study-display";
import { projectStudyTimepoints } from "./ortho-case-study-timepoints";
import { studyCapturedStatusLabel, studySourceName } from "./ortho-case-presentation-i18n";
import { caseLayout } from "./ortho-case-template";
import type { JourneyScope } from "./ortho-case-journey-records";
import type { StudyRevision } from "./ortho-case-study-history";
import type { StudySavedContent } from "./ortho-case-study-capture";
import { projectStudyRecordedFacts } from "./ortho-case-study-recorded-facts";

import { studyLongitudinalExportPages } from "./ortho-study-longitudinal-export";

export const STUDY_TEXT_RENDERER = "ortho-text-v8-readable-model";
export type StudyTextPage = StudyNotesPage;
export type StudyTextPresentation = StudyNotesProjection;

/** Bounded text-only export of a saved version. No current facts are mixed into
 * the snapshot, no image transform is guessed, and overflow is paginated. */
export function studyTextPresentation(revision: StudyRevision<StudySavedContent>, scope: JourneyScope, illustrated = false, panelId?: string): StudyTextPresentation {
  const pages: StudyTextPage[] = [];
  const append = (title: string, lines: string[], sourceKeys: string[], metadata?: Pick<StudyTextPage, "panelId" | "modelAnalyses">, repeatedNotice?: string) => {
    const wrapped = lines.flatMap(line => line.split("\n").flatMap(part => wrapStudyTextLine(part)));
    const pageLines = repeatedNotice ? 11 : 12;
    for (let offset = 0; offset < wrapped.length; offset += pageLines) {
      pages.push({ title: offset ? `${title} — تابع` : title, lines: [...(repeatedNotice ? [repeatedNotice] : []), ...wrapped.slice(offset, offset + pageLines)], sourceKeys: [...sourceKeys], ...(metadata ? { panelId: metadata.panelId, ...(offset === 0 && metadata.modelAnalyses?.length ? { modelAnalyses: metadata.modelAnalyses } : {}) } : {}) });
      if (pages.length > 300) throw new Error("study_text_export_limit");
    }
  };
  const includedPanels = revision.content.authored.panels.filter(panel => panel.included && (panelId === undefined || panel.instanceId === panelId));
  // Provenance must not make an otherwise empty selection exportable. Panel-only
  // projections omit this page so illustrated assembly includes it exactly once.
  if (!includedPanels.length) throw new Error("study_text_export_empty");
  if (panelId === undefined) append("سياق التقاط الدراسة المحفوظة", [
    `حالة التقويم عند التقاط الدراسة: ${studyCapturedStatusLabel(revision.content.caseStatusAtCapture, "ar")}`,
    `وقت التقاط الدراسة (UTC): ${revision.content.capturedAt}`,
    "تصف هذه البيانات وقت الالتقاط المحفوظ. توثيق نسخة لاحقًا يحافظ على هذا السياق.",
  ], []);
  const exportedKeys = new Set(includedPanels.filter(panel => panel.state === "available").flatMap(panel => panel.sourceKeys));
  // Excluded panels do not leak their source metadata via the timepoint appendix.
  for (const point of panelId === undefined ? projectStudyTimepoints(revision.content.authored) : []) {
    const selected = point.sources.filter(source => exportedKeys.has(source.key));
    if (!selected.length) continue;
    const provenance = { unknown: "غير معروف", historical_source: "مصدر تاريخي", contemporaneous_record: "سجل معاصر للحدث", retrospective_record: "توثيق بأثر رجعي" };
    const lines = [`التاريخ: ${point.occurrence.occurredOn ?? "غير معروف"}`, `توثيق التاريخ: ${provenance[point.occurrence.dateProvenance]}`];
    if (point.occurrence.sourceNote) lines.push(`مصدر التاريخ وحدود اليقين: ${point.occurrence.sourceNote}`);
    lines.push("هذه مرحلة وثائقية اختارها الطبيب؛ لا تعني وحدها تقدمًا سريريًا أو قابلية مقارنة القياسات.");
    for (const selection of selected) {
      const capture = revision.content.sources.find(source => source.selection.key === selection.key);
      lines.push(`${studySourceName(selection.kind, "ar")} #${selection.id}${selection.version === null ? "" : ` • النسخة ${selection.version}`} • ${capture?.state === "available" ? "متاح في الالتقاط المحفوظ" : "غير متاح في الالتقاط المحفوظ"}`);
      lines.push(`بصمة المصدر SHA256:`, selection.contentHash);
    }
    append(`المرحلة المحفوظة ${point.stage}`, lines, selected.map(source => source.key));
  }
  for (const page of panelId === undefined ? studyLongitudinalExportPages(revision, scope) : []) {
    append(page.title, page.lines, page.sourceKeys);
  }
  for (const panel of includedPanels) {
    const facts = projectStudyRecordedFacts(revision.content, scope, panel.instanceId, revision.kind);
    const title = caseLayout(panel.layoutKey)!.titleAr;
    const lines: string[] = [];
    let evidenceAttached = false;
    const emit = (pageTitle: string, pageLines: string[], model = false) => {
      if (!pageLines.length) return;
      append(pageTitle, pageLines, panel.state === "available" ? panel.sourceKeys : [], {
        panelId: panel.instanceId, ...(!evidenceAttached ? { modelAnalyses: facts.modelAnalyses } : {}),
      }, model ? "حساب محفوظ غير معتمد سريريًا؛ لا يمثل قرارًا علاجيًا." : undefined);
      evidenceAttached = true;
    };
    if (panel.state !== "available") lines.push(`حالة القسم: ${panel.state === "not_recorded" ? "غير مسجل" : panel.state === "restricted" ? "مقيّد" : "غير متاح"}`);
    for (const [blockIndex, block] of facts.blocks.entries()) {
      const model = facts.modelTables.find(table => table.blockIndex === blockIndex);
      if (model && block.kind === "table") {
        emit(title, lines.splice(0));
        // Keep each saved analysis together when it fits; longer analyses repeat
        // their method/arch title and approval warning on every continuation.
        emit(model.title, block.rows.map(row => row.cells.join(": ")), true);
      } else if (block.kind === "paragraph") lines.push(block.text);
      else for (const row of block.rows) lines.push(row.cells.map((cell, i) => `${block.headers[i]}: ${cell}`).join(" — "));
    }
    for (const comment of [revision.content.authored.comment, panel.comment].filter(Boolean)) lines.push(`تعليق الطبيب: ${comment}`);
    if (panel.images.length || panel.sourceKeys.some(key => revision.content.sources.some(source => source.selection.key === key && source.selection.kind === "document"))) {
      lines.push(illustrated ? (panel.images.length ? "الصور المختارة لهذا القسم مرفقة بإطاراتها المحفوظة في الصفحات التالية." : "يوجد مرجع مستند دون صورة مختارة للتصدير في هذا القسم.") : "هذه نسخة نصية. الصور المختارة وتحويلاتها لا تُصدّر في هذه النسخة؛ راجع صور الحالة الأصلية داخل الملف.");
    }
    const sourceName = (key: string) => { const source = revision.content.authored.sources.find(s => s.key === key); return source ? `${studySourceName(source.kind, "ar")} #${source.id}` : "مرجع الدراسة"; };
    for (const item of facts.unavailable) lines.push(`مصدر غير متاح: ${sourceName(item.sourceKey)}. راجع المصدر داخل ملف الحالة.`);
    for (const item of facts.unmapped) lines.push(`تفاصيل المصدر غير معروضة نصياً في هذا القسم: ${sourceName(item.sourceKey)}. راجعها داخل ملف الحالة.`);
    if (!lines.length && !evidenceAttached) lines.push("لا توجد حقائق نصية مسجلة في هذا القسم.");
    emit(title, lines);
  }
  if (!pages.length) throw new Error("study_text_export_empty");
  const value: StudyTextPresentation = { caseId: scope.orthoCaseId, revisionId: revision.id, revisionHash: revision.contentHash, version: revision.version,
    kind: revision.kind, capturedAt: revision.content.capturedAt, sources: structuredClone(revision.content.authored.sources.filter(source => exportedKeys.has(source.key))), pages, projectionHash: "" };
  value.projectionHash = studyNotesProjectionHash(value);
  return value;
}
