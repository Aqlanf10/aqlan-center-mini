import { wrapStudyTextLine } from "./ortho-study-display";
import { projectStudyTimepoints } from "./ortho-case-study-timepoints";
import { studySourceName } from "./ortho-case-presentation-i18n";
import { caseLayout } from "./ortho-case-template";
import type { JourneyScope } from "./ortho-case-journey-records";
import type { StudyRevision } from "./ortho-case-study-history";
import type { StudySavedContent } from "./ortho-case-study-capture";
import { projectStudyRecordedFacts } from "./ortho-case-study-recorded-facts";

import { studyLongitudinalExportPages } from "./ortho-study-longitudinal-export";

export const STUDY_TEXT_RENDERER = "ortho-text-v6-space-prefix-provenance";
export interface StudyTextPage { title: string; lines: string[]; sourceKeys: string[] }
export interface StudyTextPresentation { caseId: number; revisionId: number; revisionHash: string; version: number; kind: "draft" | "documented"; capturedAt: string; pages: StudyTextPage[] }

/** Bounded text-only export of a saved version. No current facts are mixed into
 * the snapshot, no image transform is guessed, and overflow is paginated. */
export function studyTextPresentation(revision: StudyRevision<StudySavedContent>, scope: JourneyScope, illustrated = false, panelId?: string): StudyTextPresentation {
  const pages: StudyTextPage[] = [];
  const append = (title: string, lines: string[], sourceKeys: string[]) => {
    const wrapped = lines.flatMap(line => line.split("\n").flatMap(part => wrapStudyTextLine(part)));
    for (let offset = 0; offset < wrapped.length; offset += 12) {
      pages.push({ title: offset ? `${title} — تابع` : title, lines: wrapped.slice(offset, offset + 12), sourceKeys: [...sourceKeys] });
      if (pages.length > 300) throw new Error("study_text_export_limit");
    }
  };
  const includedPanels = revision.content.authored.panels.filter(panel => panel.included && (panelId === undefined || panel.instanceId === panelId));
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
    if (panel.state !== "available") lines.push(`حالة القسم: ${panel.state === "not_recorded" ? "غير مسجل" : panel.state === "restricted" ? "مقيّد" : "غير متاح"}`);
    for (const block of facts.blocks) {
      if (block.kind === "paragraph") lines.push(block.text);
      else for (const row of block.rows) lines.push(row.cells.map((cell, i) => `${block.headers[i]}: ${cell}`).join(" — "));
    }
    for (const comment of [revision.content.authored.comment, panel.comment].filter(Boolean)) lines.push(`تعليق الطبيب: ${comment}`);
    if (panel.images.length || panel.sourceKeys.some(key => revision.content.sources.some(source => source.selection.key === key && source.selection.kind === "document"))) {
      lines.push(illustrated ? (panel.images.length ? "الصور المختارة لهذا القسم مرفقة بإطاراتها المحفوظة في الصفحات التالية." : "يوجد مرجع مستند دون صورة مختارة للتصدير في هذا القسم.") : "هذه نسخة نصية. الصور المختارة وتحويلاتها لا تُصدّر في هذه النسخة؛ راجع صور الحالة الأصلية داخل الملف.");
    }
    const sourceName = (key: string) => { const source = revision.content.authored.sources.find(s => s.key === key); return source ? `${studySourceName(source.kind, "ar")} #${source.id}` : "مرجع الدراسة"; };
    for (const item of facts.unavailable) lines.push(`مصدر غير متاح: ${sourceName(item.sourceKey)}. راجع المصدر داخل ملف الحالة.`);
    for (const item of facts.unmapped) lines.push(`تفاصيل المصدر غير معروضة نصياً في هذا القسم: ${sourceName(item.sourceKey)}. راجعها داخل ملف الحالة.`);
    if (!lines.length) lines.push("لا توجد حقائق نصية مسجلة في هذا القسم.");
    append(title, lines, panel.state === "available" ? panel.sourceKeys : []);
  }
  if (!pages.length) throw new Error("study_text_export_empty");
  return { caseId: scope.orthoCaseId, revisionId: revision.id, revisionHash: revision.contentHash, version: revision.version,
    kind: revision.kind, capturedAt: revision.content.capturedAt, pages };
}
