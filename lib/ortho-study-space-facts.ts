/** Display only a validated immutable space ledger prefix. Never read live
 * sources, infer prior IPR, or apply a replacement plan to an earlier event. */
import { readStudySpaceCapture } from './ortho-study-space-capture';
import { contactKey, projectIpr } from './ortho-space-ledger';
import type { StudySourceSelection } from './ortho-case-study';
import type { JourneyScope } from './ortho-case-journey-records';
import type { CaseParagraph, CaseTable } from './ortho-case-render-contract';

const unknown = 'غير معلوم';
const amount = (value: number | null) => value === null ? unknown : `${value / 1000} mm`;
const arch = (value: string) => value === 'upper' ? 'العلوي' : 'السفلي';
const optional = (value: string | number | null) => value === null || value === '' ? 'غير مسجل' : String(value);
const methods = { expansion: 'توسيع', distalization: 'إرجاع خلفي', uprighting: 'تصحيح الميل', derotation: 'تصحيح الدوران', proclination: 'إمالة أمامية', extraction: 'قلع مخطط', other: 'تقدير آخر' };

export function projectStudySpaceFacts(raw: unknown, selection: StudySourceSelection, scope: JourneyScope, review: 'draft' | 'documented'): (CaseParagraph | CaseTable)[] {
  const capture = readStudySpaceCapture(raw, selection, scope);
  const projection = projectIpr(capture.history.map(r => ({ id: r.id, version: r.version, content: r.content.authored })));
  if (!projection.ok) throw Error(projection.code);
  const blocks: (CaseParagraph | CaseTable)[] = [];
  const paragraph = (text: string) => blocks.push({ kind: 'paragraph', text, sourceKeys: [selection.key], review });
  let rowCount = 0, textCount = 0;
  const table = (headers: string[], rows: string[][]) => {
    if (!rows.length) return;
    rowCount += rows.length;
    for (const value of [...headers, ...rows.flat()]) {
      if (value.length > 20000) throw Error('study_space_display_limit');
      textCount += value.length;
    }
    if (rowCount > 4000 || textCount > 1024 * 1024) throw Error('study_space_display_limit');
    blocks.push({ kind: 'table', headers, rows: rows.map(cells => ({ cells, sourceKeys: [selection.key], review })) });
  };
  paragraph('لقطة وثائقية تاريخية واحدة لسجل المسافات وIPR حتى الرأس المختار. ليست قياسات Bolton جديدة أو اعتماداً سريرياً. لا تُستبدل الشواهد بمصادر حالية ولا تُضم المسودات غير المحفوظة.');
  table(['هوية اللقطة المحفوظة', 'القيمة'], [
    ['معرف المريض عند الالتقاط، وليس صلاحية وصول حالية', String(capture.patientId)], ['حالة التقويم', String(capture.orthoCaseId)],
    ['الحالة السريرية', String(capture.clinicalCaseId)], ['رأس السجل المختار', String(capture.headId)],
    ['نسخة الرأس وعدد القيود في المقدمة الكاملة', String(capture.headVersion)], ['بصمة اللقطة SHA256', selection.contentHash],
  ]);
  paragraph('المجاميع التالية تحسب الأحداث غير المستبدلة بتصحيح داخل هذه اللقطة فقط، مرة واحدة لكل فك وتماس. المجهول ليس صفراً؛ مجموع الأحداث الموثقة لا يثبت عدم وجود IPR سابق، ولا يحدد مقداراً متبقياً آمناً.');
  table(['الفك', 'التماس FDI', 'مجموع IPR المنفذ الموثق في اللقطة'], projection.value.totals.map(t => [arch(t.arch), t.contact, amount(t.performedUm)]));
  if (!projection.value.totals.length) paragraph('لا توجد أحداث IPR منفذة في المقدمة المختارة؛ هذا لا يثبت أن المقدار السريري السابق صفر.');
  const current = new Set(projection.value.current.map(e => e.id));
  const latestPlans = new Set(['upper', 'lower'].flatMap(a => {
    const r = capture.history.find(h => h.content.authored.kind === 'plan' && h.content.authored.arch === a);
    return r ? [r.id] : [];
  }));
  const chronological = [...capture.history].reverse();
  table(['القيد', 'النسخة', 'القيد السابق', 'النوع', 'الفك', 'مسجل القيد', 'وقت التسجيل', 'سبب التسجيل', 'سياق التسجيل وحالة الملف', 'المريض المسجل أصلاً', 'بصمة محتوى القيد'], chronological.map(r => [
    String(r.id), String(r.version), optional(r.predecessorId), r.content.authored.kind === 'plan' ? 'ميزانية مخططة' : 'IPR منفذ موثق', arch(r.content.authored.arch), r.createdBy, r.createdAt, r.reason,
    `${r.recordingContext} / ${r.caseStatusAtCapture}`, String(r.recordedPatientId), r.contentHash,
  ]));
  const plans: string[][] = [], gains: string[][] = [], uses: string[][] = [], contacts: string[][] = [], events: string[][] = [];
  for (const r of chronological) {
    const c = r.content.authored, id = String(r.id);
    if (c.kind === 'plan') {
      const b = r.content.baseline!;
      plans.push(...[
        ['موضع الخطة داخل اللقطة فقط', latestPlans.has(r.id) ? 'آخر خطة لهذا الفك داخل اللقطة' : 'خطة تاريخية داخل اللقطة'],
        ['معرف الاستراتيجية الأصلية', String(c.strategyRevisionId)], ['نوع المرجع الأصلي', c.baseline.kind],
        ['معرف التقييم الأصلي', String(c.baseline.id)], ['عضو تحليل التقييم الأصلي', c.baseline.member], ['نسخة مرجع التحليل الأصلي', c.baseline.version],
        ['المتاح ناقص المطلوب المحفوظ، وليس قياساً جديداً', `${b.discrepancyMm} mm`], ['صفة القيمة المرجعية', b.estimated ? 'مقدّرة' : 'مقاسة'],
        ['المبرر المسجل', c.rationale], ['البدائل المسجلة', c.alternatives],
      ].map(row => [id, ...row]));
      for (const g of c.gains) gains.push([id, g.key, methods[g.method], g.label, amount(g.estimateUm), g.included ? 'محتسب في الخطة' : 'غير محتسب / بديل', g.overlapGroup, g.rationale]);
      for (const u of c.uses) uses.push([id, u.key, u.label, amount(u.amountUm)]);
      for (const p of c.contacts) contacts.push([id, arch(c.arch), contactKey(p.teeth), amount(p.plannedUm), amount(p.budgetGainUm), amount(p.clinicianLimitUm), p.note]);
    } else {
      const w = r.content.adjustment!;
      events.push([id, current.has(r.id) ? 'محتسب مرة واحدة في مجموع اللقطة' : 'استُبدل بتصحيح؛ غير محتسب', `${arch(c.arch)} / ${contactKey(c.teeth)}`, amount(c.performedUm), String(c.planEntryId),
        String(c.adjustmentId), String(w.visitId), w.occurredOn, w.recordedBy, optional(c.supersedesEntryId), c.measurementNote, optional(c.reviewReason)]);
    }
  }
  table(['قيد الخطة', 'الحقل التاريخي', 'القيمة المحفوظة'], plans);
  table(['قيد الخطة', 'معرف المكسب', 'الطريقة', 'الوصف', 'التقدير المخطط', 'الاحتساب المخطط', 'مجموعة التداخل', 'المبرر'], gains);
  table(['قيد الخطة', 'معرف الاستخدام', 'الوصف', 'الاستخدام الإضافي المخطط'], uses);
  table(['قيد الخطة', 'الفك', 'التماس FDI', 'IPR المخطط', 'المساهمة الإضافية المخططة في الميزانية', 'حد الطبيب المسجل', 'ملاحظة التماس'], contacts);
  table(['قيد IPR', 'الاحتساب في اللقطة', 'الفك والتماس FDI', 'المقدار المنفذ الموثق', 'قيد الخطة الأصلية', 'الجلسة الأصلية', 'الزيارة المحفوظة', 'تاريخ الجلسة المحفوظ', 'مسجل الجلسة المحفوظ', 'تصحيح القيد', 'ملاحظة القياس', 'سبب المراجعة المسجل، وليس موافقة'], events);
  paragraph('IPR المخطط ومساهمته الإضافية في ميزانية المسافة منفصلان عن المقدار المنفذ. كل حدث يحتفظ بالخطة والجلسة الأصليتين؛ لا يُنسب إلى خطة أحدث ولا يُحتسب أصله وتصحيحه معاً. تاريخ التسجيل لا يحل محل تاريخ الجلسة.');
  // Include prose in the same review text budget; never return a truncated prefix.
  if (textCount + blocks.reduce((n, b) => n + (b.kind === 'paragraph' ? b.text.length : 0), 0) > 1024 * 1024) throw Error('study_space_display_limit');
  return blocks;
}
