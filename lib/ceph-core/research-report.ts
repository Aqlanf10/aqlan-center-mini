/** Standalone research report. No clinical route, IO, patient identifiers or diagnosis. */
import { evaluateSteinerCore, type CoreMeasurementId } from './steiner-core';

export const REPORT_VERSION = 'ceph-research-report/0.1.0' as const;
export const RESEARCH_NOTICE = 'تقرير بحثي تجريبي — غير صالح للتشخيص أو اتخاذ قرار علاجي';
const definitions: Record<CoreMeasurementId, { group: string; label: string; construction: string }> = {
  SNA: { group: 'العلاقات الهيكلية', label: 'SNA', construction: 'angle(N→S, N→A)' },
  SNB: { group: 'العلاقات الهيكلية', label: 'SNB', construction: 'angle(N→S, N→B)' },
  ANB: { group: 'العلاقات الهيكلية', label: 'ANB', construction: 'SNA − SNB; branch validation required' },
  U1_NA_ANGLE: { group: 'ميل القواطع', label: 'U1–NA', construction: 'angle(N→A, U1_APEX→U1_TIP)' },
  L1_NB_ANGLE: { group: 'ميل القواطع', label: 'L1–NB', construction: 'angle(N→B, L1_TIP→L1_APEX)' },
  INTERINCISAL: { group: 'ميل القواطع', label: 'Interincisal', construction: 'angle(U1_TIP→U1_APEX, L1_TIP→L1_APEX)' },
  U1_NA_DISTANCE: { group: 'موضع تاج القواطع', label: 'U1–NA distance', construction: 'signed distance(U1_LABIAL, N→A)' },
  L1_NB_DISTANCE: { group: 'موضع تاج القواطع', label: 'L1–NB distance', construction: 'signed distance(L1_LABIAL, N→B)' },
};
export const REPORT_SOURCES = [
  { id: 'steiner-1960', title: 'Steiner (1960), The use of cephalometrics as an aid to planning and assessing orthodontic treatment', url: 'https://bbo.org.br/bbo/files/bibliografia/artigos/56_The_use_of_cep_halometrics.pdf', limit: 'مصدر تاريخي، وليس تحققًا سريريًا من هذا المحرك. تعريف نقاط التاج وفروع الزوايا يحتاج مراجعة.' },
  { id: 'dicom-2026b', title: 'DICOM PS3.3 2026b §10.7: Basic Pixel Spacing Calibration Macro', url: 'https://dicom.nema.org/medical/dicom/2026b/output/chtml/part03/sect_10.7.html', limit: 'ترتيب تباعد الصفوف ثم الأعمدة؛ مصدر المعايرة وعمقها لا يُثبتان من الأرقام وحدها.' },
] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
const escape = (v: unknown): string => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Evaluate the input again: callers cannot smuggle forged results or clinical approval flags. */
export function createResearchReport(study: unknown) {
  const result = evaluateSteinerCore(study);
  const calibration = record(study) && record(study.calibration) ? study.calibration : {};
  const kind = ['patient-plane', 'detector-plane', 'ratio-only'].includes(String(calibration.kind)) ? String(calibration.kind) : 'unknown';
  return {
    reportVersion: REPORT_VERSION, clinicalUseAllowed: false as const, notice: RESEARCH_NOTICE,
    analysisVersion: result.analysisVersion, studyRevision: result.studyRevision,
    imageGeometryRevision: result.imageGeometryRevision,
    calibration: { kind, rowScale: finite(calibration.rowScale), columnScale: finite(calibration.columnScale),
      scopeAssertedByCaller: calibration.scopeConfirmed === true, independentlyValidated: false as const },
    normsStatus: 'not-enabled' as const, diagnosticInterpretation: null,
    rows: result.measures.map(m => ({ ...m, ...definitions[m.id],
      displayValue: m.value === null ? 'غير قابل للحساب' : m.value.toFixed(2),
      // A valid numeric calculation never becomes a clinically accepted measurement.
      calculationLabel: m.status === 'ok' ? 'محسوب هندسيًا فقط' : m.status === 'needs-review' ? 'يحتاج مراجعة' : 'غير قابل للحساب',
      evidenceLabel: m.evidence === 'primary-text-reviewed' ? 'نص المصدر مراجع؛ التعريف السريري غير معتمد' : 'تعريف القياس يحتاج مراجعة إضافية',
    })),
    sources: REPORT_SOURCES,
  };
}
export type ResearchReport = ReturnType<typeof createResearchReport>;
/** Standalone HTML document; no scripts, remote fonts, image URLs, patient data or network IO. */
export function renderResearchReportHtml(study: unknown): string {
  const r = createResearchReport(study);
  const sections = [...new Set(r.rows.map(row => row.group))].map(group => `<section><h2>${escape(group)}</h2><table><thead><tr><th scope="col">القياس</th><th scope="col">القيمة</th><th scope="col">الوحدة</th><th scope="col">الحالة والتعريف</th></tr></thead><tbody>${r.rows.filter(row => row.group === group).map(row => `<tr><th scope="row"><bdi>${escape(row.label)}</bdi></th><td><bdi>${escape(row.displayValue)}</bdi></td><td>${row.unit === 'deg' ? '°' : 'mm'}</td><td>${escape(row.calculationLabel)}<br><bdi>${escape(row.construction)}</bdi><br>${escape(row.evidenceLabel)}${'issue' in row ? `<br><bdi>${escape(row.issue.code)}${row.issue.landmark ? ': ' + escape(row.issue.landmark) : ''}</bdi>` : ''}</td></tr>`).join('')}</tbody></table></section>`).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تقرير سيفالومتري بحثي</title><style>body{font-family:Arial,sans-serif;color:#17343e;background:#fff;max-width:1000px;margin:24px auto;padding:24px;line-height:1.6}h1{border-bottom:3px solid #168da7;padding-bottom:12px}h2{font-size:1.15rem}aside{border:2px solid #8b4200;padding:12px;color:#6e3400;font-weight:bold}table{width:100%;border-collapse:collapse}th,td{border:1px solid #a7b7bd;padding:8px;text-align:start;vertical-align:top}thead{background:#e8f6fa}bdi{direction:ltr}a{overflow-wrap:anywhere}footer{border-top:2px solid #168da7;margin-top:24px}section{margin:20px 0}@media print{body{margin:0;padding:0;font-size:10pt}thead{display:table-header-group}tr{break-inside:avoid}aside{position:static}@page{size:A4;margin:15mm}}</style></head><body><header><h1>تقرير سيفالومتري بحثي</h1><aside>${escape(r.notice)}</aside><p>تحليل Steiner Core-8 جزئي، وليس تحليل Steiner الكامل.</p></header><section><h2>الإصدار والمعايرة</h2><p>المحرك: <bdi>${escape(r.analysisVersion)}</bdi><br>التقرير: <bdi>${escape(r.reportVersion)}</bdi><br>مراجعة الدراسة: ${r.studyRevision ?? 'غير متاحة'}؛ مراجعة هندسة الصورة: ${r.imageGeometryRevision ?? 'غير متاحة'}</p><p>نوع المعايرة: <bdi>${escape(r.calibration.kind)}</bdi>؛ الصف: <bdi>${r.calibration.rowScale ?? 'غير متاح'}</bdi>؛ العمود: <bdi>${r.calibration.columnScale ?? 'غير متاح'}</bdi>. ${r.calibration.kind === 'ratio-only' ? 'قيم نسبية وليست مليمترات.' : 'القيم المعلنة بوحدة مم/بكسل؛ لم تُعتمد معايرتها سريريًا.'}</p><p>لا يُعاد تطبيق معامل تكبير. المسافات موجّهة حسب تعريف المحرك؛ الإشارة ليست تشخيصًا. التقريب إلى منزلتين للعرض فقط، وليس دليلًا على الدقة السريرية.</p></section>${sections}<section><h2>حدود الاستخدام</h2><p>المعايير الطبيعية والتصنيفات والتوصيات العلاجية معطلة. لا تعني قابلية الحساب اعتماد النقطة أو القياس. مراجعة اختصاصي والتحقق السريري المستقل لازمان قبل أي استخدام على المرضى. لا تُقارن نتائج إصدارات أو معايرات مختلفة آليًا.</p></section><section><h2>المراجع وحدود الاستدلال</h2><ol>${r.sources.map(s => `<li><a href="${escape(s.url)}">${escape(s.title)}</a><p>${escape(s.limit)}</p></li>`).join('')}</ol></section><footer>${escape(r.notice)}</footer></body></html>`;
}
