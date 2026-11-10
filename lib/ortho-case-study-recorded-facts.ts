import {studyCephBase,isStudyCephLineageCapture} from './ortho-study-ceph-lineage';
/** First source-specific semantic projection, working/unreviewed.
 * Captured facts only. Current authorization belongs to the caller's locked reader.
 * No source fetch, clinical inference, approval, formatting of money or render job. */
import { projectStudySpaceFacts } from "./ortho-study-space-facts";
import { readStudyProblemReview } from "./ortho-study-problem-review";
import { decodeAnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { projectStudyAssessment, STUDY_CLINICAL_PANEL_FIELDS, type StudyClinicalPanel } from "./ortho-case-study-assessment-projection";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { decodeDecisionSavedContent } from "./ortho-case-decision-content";
import { decodeRetentionSavedContent } from "./ortho-retention-history-store";
import { decodeStrategyRevision } from "./ortho-treatment-strategy";
import { isWitnessedStudyCephCapture } from "./ortho-study-ceph-capture";
import { studyLongitudinalReasonText } from "./ortho-study-longitudinal-labels";
import { decodeStudySavedContent } from "./ortho-case-study-capture";
import type { JourneyScope } from "./ortho-case-journey-records";
import type { CaseParagraph, CaseTable } from "./ortho-case-render-contract";
export const STUDY_RECORDED_FACTS_VERSION = "ortho-study-recorded-facts-v4-problem-review";
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
    const source = captured.selection, value = record(source.kind === "ceph_study" ? studyCephBase(captured.payload) : captured.payload);
    if (source.kind === "problem_review" && ["diagnosis", "objectives", "problem-plan-strategy"].includes(panel.layoutKey)) {
      const problem = readStudyProblemReview(value, { ...scope, patientId: study.recordedPatientId });
      table(key, [["معرف المراجعة المحفوظة", problem.id], ["معرف المشكلة", problem.problemId], ["المشكلة كما راجعها الطبيب", problem.problemLabelAtReview],
        ["مراجع المصدر", problem.reviewedBy], ["وقت المراجعة", problem.reviewedAt], ["سبب المراجعة", problem.reason], ["المراجعة السابقة", problem.supersedesReviewId],
        ["المصدر المسجل", problem.source.title], ["نوع المصدر", problem.source.category], ["الملاحظة المحفوظة", problem.source.summary],
        ["الموضع", problem.source.site], ["مسجل المصدر", problem.source.recordedBy], ["وقت تسجيل المصدر", problem.source.recordedAt],
        ["هوية المصدر", problem.source.identity], ["نسخة المصدر الأصلية", problem.source.ref.version], ["بصمة لقطة المصدر", problem.source.snapshotHash]]);
      paragraph(key, "هذه مراجعة الطبيب المحفوظة للمصدر وربطها بالمشكلة وقت التسجيل. لا تُستبدل بالمشكلة الحالية ولا تتحول القياسات إلى تشخيص أو خطة علاج آلية.");
    } else if (source.kind === "assessment") {
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
        for (const analysis of projected.analyses) {
          const stored = analysis.stored.result;
          if (stored.state === "ready" && stored.witness.result.state === "calculated"
            && stored.witness.result.method === "tanaka_johnston_1974_approximation_v1") {
            const prediction = stored.witness.result, mm = (value: number) => `${Number(value.toFixed(3))} mm`;
            table(key, [["التحليل", "Tanaka–Johnston1974: تقدير المسافة المختلطة"],
              ["الفك", prediction.arch === "upper" ? "علوي" : "سفلي"],
              ["مجموع القواطع السفلية المقاس", mm(prediction.measuredLowerIncisorSumMm)],
              ["مجموع قواطع الفك المطلوب المقاس", mm(prediction.measuredTargetIncisorSumMm)],
              ["الناب والضاحكان لكل جهة — تقدير", mm(prediction.predictedCaninePremolarPerQuadrantMm)],
              ["الناب والضاحكان في الجهتين — تقدير", mm(prediction.predictedBothQuadrantsMm)],
              ["المساحة المتاحة المقاسة", mm(prediction.measuredAvailableMm)], ["المساحة المطلوبة المقدّرة", mm(prediction.estimatedRequiredMm)],
              ["المتاح ناقص المطلوب المقدّر", mm(prediction.availableMinusEstimatedRequiredMm)],
              ["إصدار الحساب", stored.witness.formula.engineVersion], ["المعادلة", stored.witness.formula.formulaVersion],
              ["مرجع النتيجة المحفوظة", stored.witness.reference?.source ?? null],
              ["معرف التحليل المختار", analysis.selection.id], ["بصمة النتيجة المحفوظة", analysis.stored.resultHash],
              ["الاعتماد السريري وملاءمة المرجع للحالة", "غير معتمد؛ تقدير يحتاج مراجعة الطبيب"]]);
          } else table(key, [["معرف التحليل المختار", analysis.selection.id],
          ["الاختيار المحفوظ", canonicalJourneyJSON(analysis.selection)], ["حالة النتيجة المحفوظة", analysis.stored.result.state],
          ["النتيجة والشواهد والوحدات المحفوظة", canonicalJourneyJSON(analysis.stored.result)], ["بصمة النتيجة المحفوظة", analysis.stored.resultHash],
          ["الاعتماد السريري", "غير معتمد"]]);
        }
        if (!projected.analyses.length) paragraph(key, "لم تُحفظ تحليلات مختارة في هذه النسخة؛ لم يُحسب تحليل جديد للعرض.");
      } else { unmapped.push({ sourceKey: key, kind: source.kind, reason: "assessment_layout_not_mapped" }); continue; }
      paragraph(key, `عدد الملاحظات في التقييم المحفوظ: ${revision.content.draft.observations.observations.length}؛ الملاحظات المعروضة مباشرة في هذا القسم: ${observationRows?.length ?? 0}. بقية الملاحظات تبقى في التقييم ومقاطعها المختارة، ولا يعني غيابها هنا أنها غير مسجلة.`);
      if (projected.unmappedCount) paragraph(key, `تحتفظ النسخة بـ ${projected.unmappedCount} ملاحظة غير معيّنة إلى العرض المحدد. يلزم الرجوع إلى التقييم المحفوظ؛ لم تُحذف هذه الملاحظات أو تُنقل إلى قسم مفترض.`);
    } else if (source.kind === "space_ledger" && panel.layoutKey === "model-measurements") {
      blocks.push(...projectStudySpaceFacts(value, source, { ...scope, patientId: study.recordedPatientId }, review));
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
      if (isStudyCephLineageCapture(captured.payload)) {
        const origin = captured.payload.correctionOrigin;
        table(key, [["الدراسة الأصلية للتصحيح", origin.parentAnalysisId], ["معرف صورة أصل التصحيح", origin.documentId],
          ["بصمة لقطة أصل التصحيح", origin.sourceSnapshotSha256], ["دليل إكمال الأصل", origin.parentCompletion.state === "versioned" ? `النسخة ${origin.parentCompletion.witnessVersion}: ${origin.parentCompletion.witnessSha256}` : "إكمال تاريخي دون شاهد محفوظ"]]);
        paragraph(key, "هذا رابط مصدر التصحيح المحفوظ؛ لا يستبدل الدراسة الأصلية، ولا يمنح اعتمادًا سريريًا أو مرحلة زمنية جديدة تلقائيًا.");
      } else paragraph(key, "أصل التصحيح غير موثق في هذه النسخة؛ لا تُستنتج العلاقة من الملاحظات.");
      if (isWitnessedStudyCephCapture(value)) {
        const c = value.completion, w = c.witness;
        table(key, [["معرف دراسة السيفالومتري", value.id], ["الحالة المحفوظة", value.status], ["تاريخ التقاط الصورة المحفوظ", value.acquisitionDate],
          ["المرحلة المحفوظة", value.phase], ["الجهاز", value.device], ["نوع الدراسة", value.studyKind], ["الملاحظة", value.note],
          ["وقت التسجيل", value.createdAt], ["المسجل", value.createdBy], ["بصمة دليل الإكمال SHA256", c.witnessSha256],
          ["وقت ختم دليل الإكمال", w.sealedAt], ["مسجل الإكمال", w.actor.username], ["معرف صورة المصدر", w.image.documentId], ["بصمة صورة المصدر", w.image.sha256],
          ["رمز مجموعة المرجع المحفوظ", w.referenceSet.key], ["نسخة مجموعة المرجع المحفوظة", w.referenceSet.version], ["بصمة مجموعة المرجع", w.referenceSetSha256],
          ["نقاط المعايرة والمسافة المحفوظة بدقة", canonicalJourneyJSON(w.snapshot.calibration)], ["المقياس المحفوظ مم لكل بكسل", w.snapshot.mmPerPixel],
          ["حدود هوية المصدر", w.sourceIdentityMeaning], ["حدود الاعتماد السريري", w.clinicalMeaning]]);
        if (value.captureVersion === 3) {
          table(key, [["نسخة بنية دليل الإكمال المحفوظ", value.completion.witness.schemaVersion],
            ["هوية المصدر المرسلة المتطابقة عند الإكمال", canonicalJourneyJSON(value.completion.witness.sourceReview)]]);
          paragraph(key, `${studyLongitudinalReasonText('clinical_comparability_not_validated', 'ar')} الرموز التالية محفوظة في المصدر؛ لم تُستنتج أسماء سريرية أو قيم مرجعية حالية.`);
        } else paragraph(key, "تم التحقق من سلامة سجل المصدر الثابت المحفوظ عند الإكمال، لكن لم يُثبت أنه المصدر الذي شاهده الطبيب. هذا ليس اعتمادًا سريريًا مستقلاً ولا يثبت قابلية المقارنة. الرموز التالية محفوظة في المصدر؛ لم تُستنتج أسماء سريرية أو قيم مرجعية حالية.");
        if (panel.layoutKey === "ceph-measurements") {
          const measurements = w.measurements.filter(row => row.code !== "EXT_INDEX");
          if (measurements.length) {
            blocks.push({ kind: "table", headers: ["رمز القياس المحفوظ", "القيمة المحفوظة", "الوحدة المحفوظة", "حالة التفسير"],
              rows: measurements.map(row => ({ cells: [row.code, String(row.value), row.unit, "لا تفسير جديد"], sourceKeys: [key], review })) });
            // One bounded provenance table, not one block per measurement. The
            // frozen witness permits 256 measurements; panel reviews allow 200 blocks.
            blocks.push({ kind: "table", headers: ["رمز القياس المحفوظ", "معرف الخوارزمية المحفوظ", "نسخة الخوارزمية المحفوظة", "بصمة مصدر الخوارزمية",
              "نسخة الحساب المحفوظة", "التقريب المحفوظ", "أصل المرجع المحفوظ", "مصدر المرجع المحفوظ", "رابط المرجع المحفوظ", "ملاءمة المرجع للمريض"],
              rows: measurements.map(row => ({ cells: [row.code, row.algorithm.id, row.algorithm.version, row.algorithm.sourceSha256,
                scalar(row.algorithm.calculationVersion), row.algorithm.rounding, row.reference.origin, row.reference.source,
                scalar(row.reference.sourceUrl), row.reference.patientSpecificSuitability], sourceKeys: [key], review })) });
          }
          if (!measurements.length) paragraph(key, "لا توجد قياسات مسموحة للعرض في هذه النسخة؛ لا تُفترض قيم طبيعية.");
        }
        if (w.snapshot.diagnosis) {
          const diagnosis = w.snapshot.diagnosis;
          paragraph(key, "النص التشخيصي التالي محفوظ في دليل الإكمال؛ لا يولّد العرض تشخيصًا أو تفسيرًا جديدًا.");
          table(key, [["الهيكلي المحفوظ", diagnosis.skeletal], ["السني المحفوظ", diagnosis.dental], ["الأنسجة الرخوة المحفوظة", diagnosis.softTissue],
            ["الملاحظة المحفوظة", diagnosis.note], ["التشخيص النهائي المحفوظ", diagnosis.finalDx]]);
        }
      } else {
        table(key, [["معرف دراسة السيفالومتري", value.id], ["الحالة المخزنة تاريخيًا", value.status], ["تاريخ الالتقاط المخزن", value.acquisitionDate],
          ["المرحلة", value.phase], ["الجهاز", value.device], ["معرف مجموعة المرجع المخزن", value.referenceSetKey],
          ["نوع الدراسة المخزن", value.studyKind], ["الملاحظة", value.note], ["وقت التسجيل", value.createdAt], ["المسجل", value.createdBy],
          ["وقت الإكمال التاريخي", value.completedAt], ["من أكملها تاريخيًا", value.completedBy], ["الدراسة المصححة", value.correctsStudyId]]);
        const image = record(value.image);
        table(key, [["معرف الصورة المختارة", image.documentId], ["بصمة الصورة المختارة", image.contentHash], ["حالة الصورة عند الالتقاط", image.state]]);
        paragraph(key, "الإكمال المعروض واقعة تاريخية مخزنة؛ لا يمثل تحققًا سريريًا جديدًا. التفسير المراجع غير متاح لأن شاهد المراجعة والمرجع لم يُحفظ بنسخة قابلة للتحقق.");
        if (panel.layoutKey === "ceph-measurements") {
          const measurements = (value.measurements as Record<string, unknown>[]).filter(row => row.code !== "EXT_INDEX");
          if (measurements.length) blocks.push({ kind: "table", headers: ["رمز القياس المخزن", "القيمة الخام المخزنة", "وحدة القياس", "حالة التفسير"],
            rows: measurements.map(row => ({ cells: [scalar(row.code), scalar(row.value), "غير موثقة بنسخة في المصدر", "لا تفسير جديد"], sourceKeys: [key], review })) });
          if (!measurements.length) paragraph(key, "لا توجد قياسات خام مسموحة للعرض في هذه النسخة؛ لا تُفترض قيم طبيعية.");
        }
        if (value.diagnosis !== null) {
          const diagnosis = record(value.diagnosis);
          paragraph(key, "النص التشخيصي التالي محفوظ تاريخيًا مع الدراسة؛ لا يثبت اعتمادًا جديدًا.");
          table(key, [["الهيكلي التاريخي", diagnosis.skeletal], ["السني التاريخي", diagnosis.dental], ["الأنسجة الرخوة التاريخية", diagnosis.softTissue],
            ["الملاحظة التاريخية", diagnosis.note], ["التشخيص النهائي المخزن", diagnosis.finalDx], ["مسجل النص", diagnosis.createdBy],
            ["وقت إنشاء النص", diagnosis.createdAt], ["وقت تعديل النص", diagnosis.updatedAt]]);
        }
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
        if ("savedVersion" in saved) {
          for (const witness of saved.documentWitnesses) table(key, [["معرف المستند عند التسجيل", witness.id], ["بصمة المحتوى المسجلة", witness.sha256], ["بصمة بيانات المستند المسجلة", witness.metadataHash]]);
          paragraph(key, "بصمات تاريخية محفوظة عند تسجيل الحدث؛ لا تتضمن نسخة صورة أو معاينة، ولا تثبت مطابقة المستند الحالي أو تحققًا جديدًا منه.");
        } else {
        paragraph(key, "مراجع مستندات تاريخية مسجلة مع الحدث؛ لم تُسجل نسخة محتوى أو معاينة في هذا المرجع، ولا تُستنتج صورة معروضة أو تحقق جديد منه.");
        }
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
