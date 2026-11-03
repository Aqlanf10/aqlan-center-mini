/** First source-specific semantic projection, working/unreviewed.
 * Captured facts only. Current authorization belongs to the caller's locked reader.
 * No source fetch, clinical inference, approval, formatting of money or render job. */
import { decodeAnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { projectStudyAssessment, STUDY_CLINICAL_PANEL_FIELDS, type StudyClinicalPanel } from "./ortho-case-study-assessment-projection";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { decodeDecisionSavedContent } from "./ortho-case-decision-content";
import { decodeRetentionSavedContent } from "./ortho-retention-history-store";
import { decodeStrategyRevision } from "./ortho-treatment-strategy";
import { decodeStudySavedContent } from "./ortho-case-study-capture";
import type { JourneyScope } from "./ortho-case-journey-records";
import type { CaseParagraph, CaseTable } from "./ortho-case-render-contract";
export const STUDY_RECORDED_FACTS_VERSION = "ortho-study-recorded-facts-v1";
type Block = CaseParagraph | CaseTable;
const missing = "غير مسجل";
function scalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return missing;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("unsupported_recorded_scalar");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_recorded_object");
  return value as Record<string, unknown>;
}
/** review describes documentary study kind, never clinical approval. */
export function projectStudyRecordedFacts(raw: unknown, scope: JourneyScope, panelInstanceId: string, review: "draft" | "documented") {
  if (review !== "draft" && review !== "documented") throw new Error("invalid_documentary_review");
  const decoded = decodeStudySavedContent(raw, scope); if (!decoded.ok) throw new Error(decoded.code);
  const study = decoded.value, panel = study.authored.panels.find(value => value.instanceId === panelInstanceId);
  if (!panel) throw new Error("study_panel_not_found");
  const blocks: Block[] = [];
  const unmapped: { sourceKey: string; kind: string; reason: string }[] = [];
  const unavailable: { sourceKey: string; reason: string }[] = [];
  // The author's persisted presentation state is independent of current source
  // permission. Retain the capture, but never promote a non-available panel into
  // ordinary clinical facts merely because its references are still readable.
  if (panel.state !== "available") return { version: STUDY_RECORDED_FACTS_VERSION, panelInstanceId, layoutKey: panel.layoutKey,
    panelState: panel.state, blocks, unavailable, unmapped, complete: false };
  const paragraph = (key: string, text: string) => blocks.push({ kind: "paragraph", text, sourceKeys: [key], review });
  const table = (key: string, fields: readonly [string, unknown][]) => blocks.push({ kind: "table", headers: ["الحقل المسجل", "القيمة المسجلة"],
    rows: fields.map(([label, value]) => ({ cells: [label, scalar(value)], sourceKeys: [key], review })) });
  for (const key of panel.sourceKeys) {
    const captured = study.sources.find(value => value.selection.key === key);
    if (!captured) throw new Error("study_source_binding_missing");
    if (captured.state !== "available") { unavailable.push({ sourceKey: key, reason: captured.unavailableReason ?? "source_unavailable" }); continue; }
    const source = captured.selection, value = record(captured.payload);
    if (source.kind === "assessment") {
      const assessment = decodeAnyAssessmentRevision(value, { ...scope, patientId: study.recordedPatientId });
      if (!assessment.ok || assessment.value.schemaVersion !== 2) throw new Error("assessment_projection_schema_unavailable");
      const revision = assessment.value;
      // These are the explicitly selected sets/analyses stored inside the selected revision.
      // No new formula or selection is fabricated by the display adapter.
      const projected = projectStudyAssessment(revision, { measurementSetIds: revision.content.draft.measurementSets.map(set => set.id),
        analysisIds: revision.content.draft.analyses.map(analysis => analysis.id) });
      const observationRows = Object.hasOwn(STUDY_CLINICAL_PANEL_FIELDS, panel.layoutKey)
        ? projected.panels[panel.layoutKey as StudyClinicalPanel] : panel.layoutKey === "cast-analysis" ? projected.cast.observations : null;
      if (observationRows) {
        paragraph(key, `تقييم مسجل ${revision.version}؛ ${revision.createdBy}؛ ${revision.createdAt}. النتائج المعروضة غير معتمدة سريريًا من خلال هذا العرض.`);
        if (panel.layoutKey === "cast-analysis") {
          for (const set of projected.cast.measurementSets) table(key, [["معرف مجموعة القياسات المحفوظة", set.id],
            ["عضوية قياسات عرض الأسنان بالترتيب المحفوظ", canonicalJourneyJSON(set.toothWidthObservationIds)],
            ["مرجع المسافة المتاحة العلوية", set.upperAvailableObservationId], ["مرجع المسافة المتاحة السفلية", set.lowerAvailableObservationId]]);
        }
        for (const observation of observationRows) {
          const result = observation.value;
          table(key, [["معرف الملاحظة", observation.id], ["العنوان المسجل", observation.label], ["التعريف", observation.definition],
            ["نسخة التعريف", observation.definitionVersion], ["الهدف المسجل", canonicalJourneyJSON(observation.target)],
            ["حالة القيمة", result.state], ["القيمة كما سجلت", result.state === "measured" ? result.value : result.state === "recorded" ? result.text : "reason" in result ? result.reason : null],
            ["الوحدة المسجلة", observation.unit], ["تاريخ الواقعة وأساسه", observation.occurredOn === null ? null : canonicalJourneyJSON(observation.occurredOn)],
            ["المنفذ والطريقة والمصادر كما وثقت", observation.provenance === null ? null : canonicalJourneyJSON(observation.provenance)]]);
        }
        if (!observationRows.length) paragraph(key, "لا توجد ملاحظات محفوظة مطابقة لتعريفات هذا القسم؛ لا تُفترض نتائج طبيعية.");
      } else if (panel.layoutKey === "model-measurements") {
        for (const analysis of projected.analyses) table(key, [["معرف التحليل المختار", analysis.selection.id],
          ["الاختيار المحفوظ", canonicalJourneyJSON(analysis.selection)], ["حالة النتيجة المحفوظة", analysis.stored.result.state],
          ["النتيجة والشواهد والوحدات المحفوظة", canonicalJourneyJSON(analysis.stored.result)], ["بصمة النتيجة المحفوظة", analysis.stored.resultHash],
          ["الاعتماد السريري", "غير معتمد"]]);
        if (!projected.analyses.length) paragraph(key, "لم تُحفظ تحليلات مختارة في هذه النسخة؛ لم يُحسب تحليل جديد للعرض.");
      } else { unmapped.push({ sourceKey: key, kind: source.kind, reason: "assessment_layout_not_mapped" }); continue; }
      paragraph(key, `عدد الملاحظات في التقييم المحفوظ: ${revision.content.draft.observations.observations.length}؛ الملاحظات المعروضة مباشرة في هذا القسم: ${observationRows?.length ?? 0}. بقية الملاحظات تبقى في التقييم ومقاطعها المختارة، ولا يعني غيابها هنا أنها غير مسجلة.`);
      if (projected.unmappedCount) paragraph(key, `تحتفظ النسخة بـ ${projected.unmappedCount} ملاحظة غير معيّنة إلى العرض المحدد. يلزم الرجوع إلى التقييم المحفوظ؛ لم تُحذف هذه الملاحظات أو تُنقل إلى قسم مفترض.`);
    } else if (source.kind === "diagnosis" && panel.layoutKey === "diagnosis") {
      const content = record(value.content);
      paragraph(key, `تشخيص مسجل: النسخة ${source.version}؛ سجلها ${scalar(value.createdBy)} في ${scalar(value.createdAt)}. لا يمنح العرض اعتمادًا سريريًا جديدًا.`);
      table(key, [["الهيكلي", content.skeletal], ["السني", content.dental], ["الازدحام", content.crowding],
        ["البروز الأفقي كما سجل", content.overjet], ["العضة", content.bite], ["الملاحظة", content.note]]);
    } else if (source.kind === "adjustment" && panel.layoutKey === "visit") {
      table(key, [["معرف المتابعة", value.id], ["معرف الزيارة المرتبطة", value.visitId], ["التاريخ المسجل", value.doneOn],
        ["المرحلة المسجلة", value.phase], ["السلك العلوي", value.upperWire], ["السلك السفلي", value.lowerWire],
        ["الإجراء المسجل", value.done], ["الملاحظة", value.note], ["وقت توقيع الزيارة المخزن", value.signedAt]]);
      paragraph(key, "هذه حقائق المتابعة المحفوظة في النسخة المختارة. العرض لا ينشئ توقيعًا أو تغييرًا علاجيًا.");
    } else if (source.kind === "ceph_study" && (panel.layoutKey === "ceph-image" || panel.layoutKey === "ceph-measurements")) {
      table(key, [["معرف دراسة السيفالومتري", value.id], ["الحالة المخزنة تاريخيًا", value.status], ["تاريخ الالتقاط المخزن", value.acquisitionDate],
        ["المرحلة", value.phase], ["الجهاز", value.device], ["معرف مجموعة المرجع المخزن", value.referenceSetKey],
        ["نوع الدراسة المخزن", value.studyKind], ["الملاحظة", value.note], ["وقت التسجيل", value.createdAt], ["المسجل", value.createdBy],
        ["وقت الإكمال التاريخي", value.completedAt], ["من أكملها تاريخيًا", value.completedBy], ["الدراسة المصححة", value.correctsStudyId]]);
      const image = record(value.image);
      table(key, [["معرف الصورة المختارة", image.documentId], ["بصمة الصورة المختارة", image.contentHash], ["حالة الصورة عند الالتقاط", image.state]]);
      paragraph(key, "الإكمال المعروض واقعة تاريخية مخزنة؛ لا يمثل تحققًا سريريًا جديدًا. التفسير المراجع غير متاح لأن شاهد المراجعة والمرجع لم يُحفظ بنسخة قابلة للتحقق.");
      if (panel.layoutKey === "ceph-measurements") {
        const measurements = value.measurements as Record<string, unknown>[];
        blocks.push({ kind: "table", headers: ["رمز القياس المخزن", "القيمة الخام المخزنة", "وحدة القياس", "حالة التفسير"],
          rows: measurements.map(row => ({ cells: [scalar(row.code), scalar(row.value), "غير موثقة بنسخة في المصدر", "لا تفسير جديد"], sourceKeys: [key], review })) });
        if (!measurements.length) paragraph(key, "لا توجد قياسات خام محفوظة في هذه النسخة؛ لا تُفترض قيم طبيعية.");
      }
      if (value.diagnosis !== null) {
        const diagnosis = record(value.diagnosis);
        paragraph(key, "النص التشخيصي التالي محفوظ تاريخيًا مع الدراسة؛ لا يثبت اعتمادًا جديدًا.");
        table(key, [["الهيكلي التاريخي", diagnosis.skeletal], ["السني التاريخي", diagnosis.dental], ["الأنسجة الرخوة التاريخية", diagnosis.softTissue],
          ["الملاحظة التاريخية", diagnosis.note], ["التشخيص النهائي المخزن", diagnosis.finalDx], ["مسجل النص", diagnosis.createdBy],
          ["وقت إنشاء النص", diagnosis.createdAt], ["وقت تعديل النص", diagnosis.updatedAt]]);
      }
    } else if (source.kind === "strategy" && ["objectives", "problem-plan-strategy"].includes(panel.layoutKey)) {
      const decodedStrategy = decodeStrategyRevision(value, { ...scope, patientId: study.recordedPatientId });
      if (!decodedStrategy.ok) throw new Error(decodedStrategy.code);
      paragraph(key, `نسخة استراتيجية مسجلة ${source.version}؛ ${decodedStrategy.value.createdBy}؛ ${decodedStrategy.value.createdAt}. لا يستنتج العرض اكتمال متطلبات علاجية.`);
      for (const row of decodedStrategy.value.rows) {
        table(key, [["معرف المشكلة", row.problem.id], ["المشكلة", row.problem.label], ["الموضع المسجل", row.problem.site], ["الهدف المسجل", row.objective],
          ["الاستراتيجية المسجلة", row.strategy], ["المبرر المسجل", row.rationale]]);
        for (const item of row.planItems) table(key, [["معرف بند الخطة", item.id], ["الخدمة", item.serviceName], ["رمز السن", item.toothCode], ["موضع الحالة", item.caseSite]]);
      }
    } else if (source.kind === "decision" && ["mechanotherapy", "plan-changes"].includes(panel.layoutKey)) {
      const decision = decodeDecisionSavedContent(value.content); if (!decision.ok) throw new Error(decision.code);
      const authored = decision.value.authored;
      table(key, [["معرف نسخة القرار", value.id], ["وقت التسجيل", value.createdAt], ["المسجل", value.createdBy],
        ["تاريخ الواقعة", authored.occurrence.occurredOn], ["أساس التاريخ", authored.occurrence.dateProvenance], ["مصدر التاريخ", authored.occurrence.sourceNote],
        ["حالة الاختيار المسجلة", authored.status], ["معرف البديل المختار", authored.selectedAlternativeId], ["المبرر", authored.rationale]]);
      for (const alternative of authored.alternatives) table(key, [["معرف البديل", alternative.id], ["اسم البديل", alternative.label], ["وصف البديل", alternative.description]]);
      table(key, [["مرجع التقييم التاريخي", authored.assessment?.id ?? null], ["نسخة التقييم التاريخية", authored.assessment?.version ?? null],
        ["بصمة التقييم التاريخية", authored.assessment?.contentHash ?? null], ["مرجع التشخيص التاريخي", authored.diagnosis?.id ?? null],
        ["نسخة التشخيص التاريخية", authored.diagnosis?.version ?? null], ["مرجع الاستراتيجية التاريخي", authored.strategy?.id ?? null],
        ["نسخة الاستراتيجية التاريخية", authored.strategy?.version ?? null], ["بصمة الاستراتيجية التاريخية", authored.strategy?.contentHash ?? null]]);
      paragraph(key, "هذه مراجع الأدلة التي وثقها القرار؛ لا تستبدلها بيانات أحدث ولا يعني ذكرها عرض محتوى المصدر هنا.");
      authored.missingEvidence.forEach(item => paragraph(key, `دليل ناقص كما سجله الطبيب: ${item}`));
      if (decision.value.consent) {
        const consent = decision.value.consent;
        table(key, [["معرف الخطة المرتبطة", consent.planId], ["حالة ملاحظة الموافقة المخزنة", consent.state],
          ["وقت الموافقة المخزن", consent.consentAt], ["من سجل الموافقة", consent.consentBy], ["وقت التقاط الملاحظة", consent.capturedAt]]);
        paragraph(key, "هذه ملاحظة للموافقة القائمة على الخطة وقت الالتقاط؛ لا ينشئ القرار أو العرض موافقة جديدة.");
      }
    } else if (source.kind === "retention_event" && ["retention", "debond"].includes(panel.layoutKey)) {
      const retention = decodeRetentionSavedContent(value.content); if (!retention.ok) throw new Error(retention.code);
      const saved = retention.value, event = saved.payload;
      if (panel.layoutKey === "debond" && event.kind !== "debond") { unmapped.push({ sourceKey: key, kind: source.kind, reason: "retention_event_not_debond" }); continue; }
      table(key, [["معرف نسخة الحدث", value.id], ["نوع الحدث", event.kind], ["الفك كما سجل", saved.arch], ["تصحيح النسخة", saved.supersedesEntryId],
        ["سبب تصحيح الفك", saved.archCorrectionReason], ["تاريخ الواقعة", event.occurrence.occurredOn], ["أساس التاريخ", event.occurrence.dateProvenance],
        ["مصدر التاريخ", event.occurrence.sourceNote], ["وقت التسجيل", value.createdAt], ["المسجل", value.createdBy], ["الملاحظة", event.note]]);
      if (event.documentIds.length) {
        table(key, [["معرفات مستندات الدليل المسجلة", canonicalJourneyJSON(event.documentIds)]]);
        paragraph(key, "مراجع مستندات تاريخية مسجلة مع الحدث؛ لم تُسجل نسخة محتوى أو معاينة في هذا المرجع، ولا تُستنتج صورة معروضة أو تحقق جديد منه.");
      }
      if ("device" in event && event.device) table(key, [["معرف الجهاز الفيزيائي", event.device.deviceId], ["نسخة الجهاز المرجعية", event.device.expectedDeviceRevisionId]]);
      if (event.kind === "device_delivery" || event.kind === "device_replacement") {
        table(key, [["نوع الجهاز", event.deviceType], ["وصف الجهاز", event.description], ["الامتداد", event.extent], ["طلب المختبر", event.labOrderId]]);
        if (event.kind === "device_replacement") table(key, [["الجهاز السابق المستبدل", event.replaces.deviceId], ["نسخته المرجعية", event.replaces.expectedDeviceRevisionId]]);
      } else if (event.kind === "device_review") {
        for (const [field, observation] of Object.entries(event.observations)) table(key, [["بند المراجعة", field], ["حالة تسجيل الملاحظة", observation.state], ["النص المسجل", observation.note]]);
      } else if (event.kind === "device_repair") table(key, [["الإصلاح المسجل", event.description]]);
      else if (event.kind === "device_status_change") table(key, [["الحالة المسجلة للجهاز", event.status]]);
      else if (event.kind === "debond") table(key, [["امتداد الفك المسجل", event.extent]]);
      else if (event.kind === "followup_intent") {
        table(key, [["تاريخ المتابعة المقصود", event.dueOn], ["الفاصل المقصود بالأيام", event.intervalDays], ["نطاق المتابعة", event.scope]]);
        paragraph(key, "هذه نية متابعة مسجلة وليست موعدًا محجوزًا أو حسابًا تلقائيًا من آخر تعديل.");
      }
      paragraph(key, "الحدث معروض كما وثق. لا يستنتج العرض حالة جهاز نشط أو تسلسلًا زمنيًا من تاريخ واقعة مجهول.");
    } else if (source.kind === "plan_consent" && panel.layoutKey === "problem-plan-strategy") {
      const consent = record(value.consent);
      table(key, [["معرف الخطة", value.planId], ["عنوان الخطة", value.title], ["حالة الخطة المخزنة", value.status],
        ["نطاق البنود", value.itemScope], ["عدد البنود خارج الحالة المستبعدة", value.excludedItemCount], ["نطاق ملاحظة الموافقة", value.consentScope],
        ["حالة الموافقة المخزنة", consent.state], ["وقت الموافقة", consent.consentAt], ["مسجل الموافقة", consent.consentBy]]);
      for (const item of value.items as Record<string, unknown>[]) table(key, [["معرف البند", item.id], ["معرف الحالة", item.caseId],
        ["الخدمة", item.serviceName], ["رمز السن", item.toothCode], ["الأسطح", item.surfaces], ["الكمية المسجلة", item.quantity], ["الحالة المسجلة", item.status]]);
      paragraph(key, "البنود تخص الحالة السريرية المختارة؛ ملاحظة الموافقة تخص الخطة الأصلية كاملة ولا تثبت موافقة جديدة على هذا العرض.");
    } else if (source.kind === "document" && panel.layoutKey === "records-overview") {
      table(key, [["معرف المستند", value.id], ["العنوان المسجل", value.title], ["النوع", value.mimeType], ["بصمة الأصل", value.contentHash],
        ["عدد بايتات الأصل", value.sizeBytes], ["العرض المشفر المسجل", value.width], ["الارتفاع المشفر المسجل", value.height]]);
      paragraph(key, "أبعاد الملف المسجلة ليست إثباتًا لاتجاه EXIF أو أبعاد العرض الموجهة. عرض الصورة يتطلب استخدامًا ووصفة ومشتقًا متحققًا مستقلًا.");
    } else unmapped.push({ sourceKey: key, kind: source.kind, reason: "layout_source_projection_not_implemented" });
  }
  return { version: STUDY_RECORDED_FACTS_VERSION, panelInstanceId, layoutKey: panel.layoutKey, panelState: panel.state, blocks, unavailable, unmapped,
    complete: unavailable.length === 0 && unmapped.length === 0 };
}
