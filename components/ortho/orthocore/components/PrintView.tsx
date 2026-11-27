"use client";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import React, { useEffect, useMemo, useState } from 'react';
import { EyeOff, FileCheck2, Printer, Settings2, X } from 'lucide-react';
import { ClinicSettings, Language, PatientCase, ToothStatus } from '../types/ortho';
import { STAGE_LABELS, tr } from '../i18n/translations';
import { CEPH_NORM_BANDS, computeBoltonAndSpace } from '../utils/orthoMath';

export interface PrintSectionsConfig {
  demographicsAndHistory: boolean;
  clinicalExamAndFdi: boolean;
  diagnosticMedia: boolean;
  cephalometricAndBolton: boolean;
  diagnosisAndProblems: boolean;
  treatmentPlanAndMechanics: boolean;
  sessionsSummary: boolean;
  retentionProtocol: boolean;
  editableNarrative: boolean;
}

export const DEFAULT_PRINT_SECTIONS: PrintSectionsConfig = {
  demographicsAndHistory: true,
  clinicalExamAndFdi: true,
  diagnosticMedia: true,
  cephalometricAndBolton: true,
  diagnosisAndProblems: true,
  treatmentPlanAndMechanics: true,
  sessionsSummary: true,
  retentionProtocol: true,
  editableNarrative: false,
};

interface PrintViewProps {
  open: boolean;
  patient: PatientCase;
  settings: ClinicSettings;
  lang: Language;
  initialAnonymize?: boolean;
  initialExcludeInternalNotes?: boolean;
  initialSelectedMediaIds?: string[];
  customNarrativeTitle?: string;
  customNarrativeBody?: string;
  onClose: () => void;
}

const TOOTH_STATUS_PRINT: Record<ToothStatus, { ar: string; en: string; fill: string; stroke: string }> = {
  present: { ar: 'سليم', en: 'Present', fill: '#ffffff', stroke: '#64748b' },
  bracketed: { ar: 'حاصرة', en: 'Bracketed', fill: '#ccfbf1', stroke: '#0f766e' },
  restored: { ar: 'حشوة', en: 'Restored', fill: '#e0f2fe', stroke: '#0284c7' },
  caries: { ar: 'تسوس', en: 'Caries', fill: '#fef3c7', stroke: '#d97706' },
  unerupted: { ar: 'غير بازغ', en: 'Unerupted', fill: '#f1f5f9', stroke: '#94a3b8' },
  impacted: { ar: 'منطمر', en: 'Impacted', fill: '#ede9fe', stroke: '#7c3aed' },
  extract_planned: { ar: 'للخلع', en: 'Extract', fill: '#fee2e2', stroke: '#dc2626' },
  missing: { ar: 'مفقود', en: 'Missing', fill: '#f8fafc', stroke: '#cbd5e1' },
};

export const PrintView: React.FC<PrintViewProps> = ({
  open,
  patient,
  settings,
  lang,
  initialAnonymize = false,
  initialExcludeInternalNotes = true,
  initialSelectedMediaIds,
  customNarrativeTitle,
  customNarrativeBody,
  onClose,
}) => {
  const [anonymize, setAnonymize] = useState(initialAnonymize);
  const [excludeInternalNotes, setExcludeInternalNotes] = useState(initialExcludeInternalNotes);
  const [sections, setSections] = useState<PrintSectionsConfig>(() => ({
    ...DEFAULT_PRINT_SECTIONS,
    editableNarrative: Boolean(customNarrativeBody?.trim()),
  }));
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setAnonymize(initialAnonymize);
      setExcludeInternalNotes(initialExcludeInternalNotes);
      setSections({
        ...DEFAULT_PRINT_SECTIONS,
        editableNarrative: Boolean(customNarrativeBody?.trim()),
      });
    }
  }, [open, initialAnonymize, initialExcludeInternalNotes, customNarrativeBody]);

  const cephAnalysis = useMemo(
    () => patient.analyses.find((a) => a.analysisType === 'cephalometric') || null,
    [patient.analyses],
  );

  const boltonAnalysis = useMemo(
    () => patient.analyses.find((a) => a.analysisType === 'cast_bolton') || null,
    [patient.analyses],
  );

  const extraImagingAnalyses = useMemo(
    () =>
      patient.analyses.filter(
        (a) =>
          a.analysisType === 'mixed_dentition' ||
          a.analysisType === 'photo_analysis' ||
          a.analysisType === 'model3d_mesh' ||
          a.analysisType === 'cbct_3d',
      ),
    [patient.analyses],
  );

  const boltonComputed = useMemo(() => {
    if (!boltonAnalysis?.toothWidths) return null;
    return computeBoltonAndSpace(
      boltonAnalysis.toothWidths,
      boltonAnalysis.spaceAvailableUpper ?? 0,
      boltonAnalysis.spaceAvailableLower ?? 0,
    );
  }, [boltonAnalysis]);

  const printableMedia = useMemo(() => {
    const imgs = patient.media.filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph');
    if (initialSelectedMediaIds && initialSelectedMediaIds.length > 0) {
      return imgs.filter((m) => initialSelectedMediaIds.includes(m.id));
    }
    return imgs.slice(0, 6);
  }, [patient.media, initialSelectedMediaIds]);

  const notedTeeth = useMemo(
    () => Object.values(patient.clinicalExam.fdiChart).filter((t) => t.status !== 'present' || t.note.trim()),
    [patient.clinicalExam.fdiChart],
  );

  if (!open) return null;

  const clinicName = lang === 'ar' ? settings.clinicNameAr : settings.clinicNameEn;
  const patientTitle = anonymize
    ? `${tr(lang, 'ملف سريري مجهول الهوية', 'Anonymized Clinical Case')} (${patient.caseNumber})`
    : `${lang === 'ar' ? patient.fullName : patient.fullNameEn || patient.fullName}`;
  const stageLabel = lang === 'ar' ? STAGE_LABELS[patient.stage].ar : STAGE_LABELS[patient.stage].en;

  const upperFdi = ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'];
  const lowerFdi = ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'];

  const toggleSection = (k: keyof PrintSectionsConfig) => {
    setSections((prev) => ({ ...prev, [k]: !prev[k] }));
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/75 overflow-y-auto print-container">
      {/* Interactive Print Control Bar — hidden during actual print/PDF */}
      <div className="sticky top-0 z-20 bg-slate-950 text-white border-b border-slate-800 px-4 md:px-6 py-3 no-print">
        <div className="max-w-[210mm] mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">
              {tr(lang, 'معاينة الطباعة والتصدير إلى PDF', 'Clinical Summary Print & PDF Preview')}
            </h2>
            <span className="text-xs font-mono text-slate-400 tabular-nums">{patient.caseNumber}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAnonymize((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                anonymize ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
              }`}
            >
              <EyeOff className="w-3.5 h-3.5" />
              <span>{tr(lang, 'إخفاء الهوية', 'Anonymize')}</span>
            </button>

            <button
              type="button"
              onClick={() => setExcludeInternalNotes((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                excludeInternalNotes ? 'bg-teal-700 border-teal-600 text-white' : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
              }`}
            >
              <FileCheck2 className="w-3.5 h-3.5" />
              <span>{tr(lang, 'استبعاد الملاحظات الداخلية', 'Hide Internal Notes')}</span>
            </button>

            <button
              type="button"
              onClick={() => setConfigOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>{tr(lang, 'أقسام الطباعة', 'Sections')}</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-500 text-white rounded-lg"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>{tr(lang, 'طباعة / حفظ PDF', 'Print / Save PDF')}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {configOpen && (
          <div className="max-w-[210mm] mx-auto mt-3 pt-3 border-t border-slate-800 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 text-xs">
            {[
              ...(customNarrativeBody?.trim()
                ? [{ k: 'editableNarrative', ar: 'ملخص التقرير المحرّر', en: 'Edited Narrative' }]
                : []),
              { k: 'demographicsAndHistory', ar: 'البيانات والشكوى والاستبيان', en: 'Demographics & History' },
              { k: 'clinicalExamAndFdi', ar: 'الفحص ومخطط FDI', en: 'Clinical Exam & FDI Chart' },
              { k: 'diagnosticMedia', ar: 'الصور والأشعة التشخيصية', en: 'Photos & Radiographs' },
              { k: 'cephalometricAndBolton', ar: 'الرسوم والقياسات (Ceph/Bolton)', en: 'Ceph & Bolton Charts' },
              { k: 'diagnosisAndProblems', ar: 'المشكلات والتشخيص', en: 'Problems & Diagnosis' },
              { k: 'treatmentPlanAndMechanics', ar: 'خطة العلاج والميكانيكا', en: 'Plan & Mechanotherapy' },
              { k: 'sessionsSummary', ar: 'سجل الجلسات', en: 'Sessions History' },
              { k: 'retentionProtocol', ar: 'التثبيت والمتابعة', en: 'Retention Protocol' },
            ].map((item) => (
              <label key={item.k} className="flex items-center gap-2 cursor-pointer text-slate-200">
                <input
                  type="checkbox"
                  checked={sections[item.k as keyof PrintSectionsConfig]}
                  onChange={() => toggleSection(item.k as keyof PrintSectionsConfig)}
                  className="accent-teal-500"
                />
                <span>{lang === 'ar' ? item.ar : item.en}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* A4 Printable Dossier Sheet */}
      <div className="py-6 px-4 print-container">
        <article className="max-w-[210mm] mx-auto bg-white text-slate-900 rounded-xl shadow-2xl p-8 md:p-10 space-y-7 print-sheet">
          {/* Document Masthead */}
          <header className="print-masthead border-b-2 border-navy-900 pb-4 flex items-start justify-between gap-4 print-avoid-break">
            <div className="flex items-start gap-3">
              <img src="/logo.png" alt={clinicName} className="w-12 h-12 object-contain shrink-0 rounded" />
              <div>
                <p className="text-xs font-bold text-navy-800 tracking-wide">{clinicName}</p>
                <h1 className="text-xl font-bold text-navy-900 mt-1">
                  {customNarrativeTitle || tr(lang, 'ملخص الحالة السريرية وخطة تقويم الأسنان', 'Orthodontic Clinical Case Summary & Treatment Dossier')}
                </h1>
                <p className="text-xs text-navy-600 mt-1">
                  {patientTitle}
                  <span className="mx-2 text-navy-300">·</span>
                  <span className="font-mono tabular-nums">{patient.caseNumber}</span>
                  <span className="mx-2 text-navy-300">·</span>
                  <span>{stageLabel}</span>
                </p>
              </div>
            </div>
            <div className="text-end text-xs text-navy-600 font-mono tabular-nums space-y-0.5 shrink-0">
              <p>
                {tr(lang, 'تاريخ التقرير:', 'Date:')} {clinicDateString(new Date(), CLINIC_ZONE_FALLBACK)}
              </p>
              <p className="font-sans text-navy-900 font-semibold">{patient.assignedDoctor}</p>
              {!anonymize && patient.dateOfBirth && (
                <p>
                  {tr(lang, 'الميلاد:', 'DOB:')} {patient.dateOfBirth}
                </p>
              )}
            </div>
          </header>

          {/* Optional Editable Report Narrative */}
          {sections.editableNarrative && customNarrativeBody && (
            <section className="space-y-2 print-avoid-break">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, 'ملخص التقرير المحرّر', 'Edited Report Narrative')}
              </h2>
              <pre className="whitespace-pre-wrap font-sans text-xs text-slate-800 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                {customNarrativeBody}
              </pre>
            </section>
          )}

          {/* 1. Demographics, Chief Complaint & Medical Questionnaire */}
          {sections.demographicsAndHistory && (
            <section className="space-y-3 print-avoid-break">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '1. بيانات المريض والشكوى والتاريخ الطبي', '1. Patient Profile, Chief Complaint & Medical History')}
              </h2>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div>
                  <span className="text-slate-500 block">{tr(lang, 'رقم الملف', 'Case Number')}</span>
                  <span className="font-mono tabular-nums font-semibold">{patient.caseNumber}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr(lang, 'الجنس', 'Gender')}</span>
                  <span className="font-medium">{patient.gender === 'female' ? tr(lang, 'أنثى', 'Female') : tr(lang, 'ذكر', 'Male')}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr(lang, 'الإحالة', 'Referral')}</span>
                  <span className="font-medium">{anonymize ? tr(lang, 'محجوب', 'Redacted') : patient.referralSource || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr(lang, 'التواصل', 'Contact')}</span>
                  <span className="font-mono tabular-nums">{anonymize ? '—' : patient.phone || '—'}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="border border-slate-200 rounded-lg p-3">
                  <p className="font-semibold text-slate-800 mb-1">{tr(lang, 'الشكوى الرئيسية (بكلمات المريض)', 'Chief Complaint')}</p>
                  <p className="text-slate-700 leading-relaxed">{patient.chiefComplaintPatientWords || '—'}</p>
                </div>
                <div className="border border-slate-200 rounded-lg p-3">
                  <p className="font-semibold text-slate-800 mb-1">{tr(lang, 'التوقعات العلاجية', 'Patient Expectations')}</p>
                  <p className="text-slate-700 leading-relaxed">{patient.patientExpectations || '—'}</p>
                </div>
              </div>

              <table className="w-full text-xs border border-slate-200">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="p-2 text-start border-b border-slate-200 w-44">{tr(lang, 'بند الاستبيان', 'History Domain')}</th>
                    <th className="p-2 text-start border-b border-slate-200 w-24">{tr(lang, 'الحالة', 'Status')}</th>
                    <th className="p-2 text-start border-b border-slate-200">{tr(lang, 'التفاصيل المسجلة', 'Recorded Details')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {[
                    { ar: 'التاريخ الطبي العام', en: 'Medical History', f: patient.questionnaire.medicalHistory },
                    { ar: 'الأدوية الحالية', en: 'Medications', f: patient.questionnaire.medications },
                    { ar: 'الحساسية', en: 'Allergies', f: patient.questionnaire.allergies },
                    { ar: 'العادات الفموية', en: 'Oral Habits', f: patient.questionnaire.oralHabits },
                    { ar: 'الشكاوى الوظيفية والمفصل', en: 'TMJ / Functional', f: patient.questionnaire.functionalComplaints },
                  ].map((row, idx) => (
                    <tr key={idx}>
                      <td className="p-2 font-medium text-slate-800">{lang === 'ar' ? row.ar : row.en}</td>
                      <td className="p-2 font-mono text-[11px] text-slate-600">{row.f.status}</td>
                      <td className="p-2 text-slate-700">{row.f.value || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* 2. Clinical Exam & Printable FDI Dental Chart */}
          {sections.clinicalExamAndFdi && (
            <section className="space-y-4 print-avoid-break">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '2. الفحص السريري ومخطط الأسنان (FDI)', '2. Extraoral / Intraoral Examination & FDI Dental Chart')}
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <table className="w-full text-xs border border-slate-200">
                  <thead className="bg-slate-100">
                    <tr>
                      <th colSpan={2} className="p-2 text-start font-semibold text-slate-800 border-b border-slate-200">
                        {tr(lang, 'خارج الفم (Extraoral)', 'Extraoral Findings')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {[
                      { ar: 'تناسق الوجه', en: 'Symmetry', f: patient.clinicalExam.extraoral.symmetry },
                      { ar: 'البروفايل الجانبي', en: 'Profile', f: patient.clinicalExam.extraoral.profile },
                      { ar: 'كفاءة الشفتين', en: 'Lip Competence', f: patient.clinicalExam.extraoral.lipCompetence },
                      { ar: 'قوس الابتسامة واللثة', en: 'Smile & Gingiva', f: patient.clinicalExam.extraoral.smileArc },
                      { ar: 'المفصل الفكي', en: 'TMJ Function', f: patient.clinicalExam.extraoral.tmjFunction },
                    ].map((r, i) => (
                      <tr key={i}>
                        <td className="p-2 font-medium text-slate-700 w-36">{lang === 'ar' ? r.ar : r.en}</td>
                        <td className="p-2 text-slate-800">{r.f.value || r.f.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <table className="w-full text-xs border border-slate-200">
                  <thead className="bg-slate-100">
                    <tr>
                      <th colSpan={2} className="p-2 text-start font-semibold text-slate-800 border-b border-slate-200">
                        {tr(lang, 'داخل الفم والإطباق (Intraoral)', 'Intraoral & Occlusal Findings')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {[
                      { ar: 'الأرحاء (يمين / يسار)', en: 'Molar (R / L)', v: `${patient.clinicalExam.intraoral.molarRelRight.value} / ${patient.clinicalExam.intraoral.molarRelLeft.value}` },
                      { ar: 'الأنياب (يمين / يسار)', en: 'Canine (R / L)', v: `${patient.clinicalExam.intraoral.canineRelRight.value} / ${patient.clinicalExam.intraoral.canineRelLeft.value}` },
                      { ar: 'Overjet / Overbite', en: 'Overjet / Overbite', v: `${patient.clinicalExam.intraoral.overjetMm.value} / ${patient.clinicalExam.intraoral.overbiteMm.value}` },
                      { ar: 'الخطوط المتوسطة', en: 'Midlines (U / L)', v: `${patient.clinicalExam.intraoral.midlineUpper.value} · ${patient.clinicalExam.intraoral.midlineLower.value}` },
                      { ar: 'الازدحام (علوي / سفلي)', en: 'Crowding (U / L)', v: `${patient.clinicalExam.intraoral.crowdingUpper.value} · ${patient.clinicalExam.intraoral.crowdingLower.value}` },
                    ].map((r, i) => (
                      <tr key={i}>
                        <td className="p-2 font-medium text-slate-700 w-36">{lang === 'ar' ? r.ar : r.en}</td>
                        <td className="p-2 text-slate-800">{r.v || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Vector Printable FDI Chart */}
              <div className="border border-slate-200 rounded-lg p-3.5 space-y-2.5 bg-slate-50/40">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-slate-800">{tr(lang, 'مخطط الأسنان FDI', 'FDI Dental Chart')}</span>
                  <div className="flex flex-wrap gap-2.5 text-slate-600">
                    {(['present', 'bracketed', 'restored', 'caries', 'unerupted', 'impacted', 'extract_planned', 'missing'] as ToothStatus[]).map((st) => (
                      <span key={st} className="inline-flex items-center gap-1">
                        <span
                          className="w-2.5 h-2.5 rounded-sm border inline-block"
                          style={{ backgroundColor: TOOTH_STATUS_PRINT[st].fill, borderColor: TOOTH_STATUS_PRINT[st].stroke }}
                        />
                        <span>{lang === 'ar' ? TOOTH_STATUS_PRINT[st].ar : TOOTH_STATUS_PRINT[st].en}</span>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5" dir="ltr">
                  {[upperFdi, lowerFdi].map((row, rowIdx) => (
                    <div key={rowIdx} className="grid grid-cols-16 gap-1">
                      {row.map((fdi, i) => {
                        const t = patient.clinicalExam.fdiChart[fdi] || { fdi, status: 'present' as ToothStatus, note: '' };
                        const st = TOOTH_STATUS_PRINT[t.status];
                        return (
                          <div key={fdi} className={`flex flex-col items-center ${i === 7 ? 'me-1' : ''}`}>
                            {rowIdx === 0 && <span className="text-[9px] font-mono text-slate-600">{fdi}</span>}
                            <svg width="20" height="22" viewBox="0 0 24 26">
                              <rect
                                x="2"
                                y="2"
                                width="20"
                                height="22"
                                rx="5"
                                fill={st.fill}
                                stroke={st.stroke}
                                strokeWidth="1.5"
                                strokeDasharray={t.status === 'unerupted' ? '2 2' : undefined}
                              />
                              {t.status === 'missing' && <path d="M5 5 L19 21 M19 5 L5 21" stroke="#94a3b8" strokeWidth="1.5" />}
                              {t.status === 'bracketed' && <rect x="8" y="9" width="8" height="7" rx="1" fill="#0f766e" />}
                            </svg>
                            {rowIdx === 1 && <span className="text-[9px] font-mono text-slate-600">{fdi}</span>}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>

                {notedTeeth.length > 0 && (
                  <p className="text-[11px] text-slate-700 pt-1 border-t border-slate-200">
                    <strong>{tr(lang, 'ملاحظات الأسنان:', 'Tooth Notes:')}</strong>{' '}
                    {notedTeeth
                      .map((t) => `#${t.fdi} (${lang === 'ar' ? TOOTH_STATUS_PRINT[t.status].ar : TOOTH_STATUS_PRINT[t.status].en}${t.note ? `: ${t.note}` : ''})`)
                      .join(' · ')}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* 3. Cephalometric, Photo, 3D Scanner, CBCT & Bolton Charts */}
          {sections.cephalometricAndBolton && (cephAnalysis || boltonAnalysis || extraImagingAnalyses.length > 0) && (
            <section className="space-y-4">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '3. القياسات السيفالومترية وتحليل الصور والنماذج و CBCT', '3. Cephalometric, Photo, 3D Scanner & CBCT Analyses')}
              </h2>

              {cephAnalysis && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between text-xs text-slate-600">
                    <span>
                      <strong>{cephAnalysis.templateName}</strong> ({cephAnalysis.stage} · v{cephAnalysis.version})
                    </span>
                    <span className="font-mono text-[11px]">
                      {cephAnalysis.calibrationValid ? cephAnalysis.calibrationSource : tr(lang, 'غير معاير للأطوال', 'Uncalibrated linear')}
                    </span>
                  </div>

                  {/* SVG Horizontal Norm-Deviation Chart */}
                  <div className="border border-slate-200 rounded-lg p-3.5 bg-white print-avoid-break">
                    <p className="text-[11px] font-semibold text-slate-700 mb-2">
                      {tr(lang, 'مخطط الانحراف عن المرجع الطبيعي (النطاق المظلّل يمثل القيم المرجعية)', 'Cephalometric Deviation Chart (Shaded band = Reference Norm)')}
                    </p>
                    <div dir="ltr">
                      <svg viewBox="0 0 640 215" className="w-full h-auto">
                        {cephAnalysis.metrics
                          .filter((m) => m.value !== null && CEPH_NORM_BANDS[m.key])
                          .slice(0, 8)
                          .map((m, idx) => {
                            const band = CEPH_NORM_BANDS[m.key];
                            const y = 14 + idx * 24;
                            const xStart = 180;
                            const w = 360;
                            const normX1 = xStart + ((band.min - band.scaleMin) / (band.scaleMax - band.scaleMin)) * w;
                            const normX2 = xStart + ((band.max - band.scaleMin) / (band.scaleMax - band.scaleMin)) * w;
                            const valClamped = Math.max(band.scaleMin, Math.min(band.scaleMax, m.value!));
                            const valX = xStart + ((valClamped - band.scaleMin) / (band.scaleMax - band.scaleMin)) * w;
                            const inNorm = m.value! >= band.min && m.value! <= band.max;
                            return (
                              <g key={m.key}>
                                <text x="4" y={y + 10} fontSize="10" fill="#1e293b" fontFamily="IBM Plex Sans, sans-serif">
                                  {m.key} ({m.normRange})
                                </text>
                                <line x1={xStart} y1={y + 6} x2={xStart + w} y2={y + 6} stroke="#e2e8f0" strokeWidth="4" strokeLinecap="round" />
                                <rect
                                  x={normX1}
                                  y={y}
                                  width={Math.max(4, normX2 - normX1)}
                                  height="12"
                                  rx="2"
                                  fill="#ccfbf1"
                                  stroke="#0f766e"
                                  strokeWidth="0.75"
                                />
                                <circle cx={valX} cy={y + 6} r="4.5" fill={inNorm ? '#0f766e' : '#d97706'} stroke="#ffffff" strokeWidth="1.2" />
                                <text x={xStart + w + 12} y={y + 10} fontSize="10" fontWeight="600" fill="#0f172a" fontFamily="IBM Plex Mono, monospace">
                                  {m.value} {m.unit}
                                </text>
                              </g>
                            );
                          })}
                      </svg>
                    </div>
                  </div>

                  <table className="w-full text-xs border border-slate-200">
                    <thead className="bg-slate-100 text-slate-700">
                      <tr>
                        <th className="p-2 text-start border-b border-slate-200">{tr(lang, 'القياس', 'Metric')}</th>
                        <th className="p-2 text-end border-b border-slate-200">{tr(lang, 'القيمة', 'Value')}</th>
                        <th className="p-2 text-end border-b border-slate-200">{tr(lang, 'المرجع', 'Norm')}</th>
                        <th className="p-2 text-start border-b border-slate-200">{tr(lang, 'التفسير', 'Interpretation')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {cephAnalysis.metrics.map((m) => (
                        <tr key={m.key}>
                          <td className="p-2 font-medium text-slate-900">{lang === 'ar' ? m.labelAr : m.labelEn}</td>
                          <td className="p-2 text-end font-mono tabular-nums font-semibold">
                            {m.value !== null ? `${m.value} ${m.unit}` : '—'}
                          </td>
                          <td className="p-2 text-end font-mono tabular-nums text-slate-600">{m.normRange}</td>
                          <td className="p-2 text-slate-700">{m.interpretation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {boltonComputed && (
                <div className="border border-slate-200 rounded-lg p-3.5 space-y-2.5">
                  <p className="text-xs font-semibold text-slate-800">
                    {tr(lang, 'ملخص تحليل النماذج وبولتون وفارق المسافة', 'Model Analyses, Bolton Ratio & Arch Space Discrepancy')}
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
                    <div>
                      <span className="font-sans text-slate-500 block">{tr(lang, 'بولتون الأمامية', 'Bolton Anterior')}</span>
                      <span className="font-bold text-slate-900">{boltonComputed.anteriorRatio}%</span>
                      <span className="text-[10px] text-slate-500 block">
                        Norm: 77.2% · {boltonComputed.anteriorExcessArch === 'lower' ? 'L' : 'U'} +{boltonComputed.anteriorExcess} mm
                      </span>
                    </div>
                    <div>
                      <span className="font-sans text-slate-500 block">{tr(lang, 'بولتون الكلية', 'Bolton Overall')}</span>
                      <span className="font-bold text-slate-900">{boltonComputed.overallRatio}%</span>
                      <span className="text-[10px] text-slate-500 block">
                        Norm: 91.3% · {boltonComputed.overallExcessArch === 'lower' ? 'L' : 'U'} +{boltonComputed.overallExcess} mm
                      </span>
                    </div>
                    <div>
                      <span className="font-sans text-slate-500 block">{tr(lang, 'فرق المسافة العلوي (5–5)', 'Upper Discrepancy (5–5)')}</span>
                      <span className="font-bold text-slate-900">{boltonComputed.upperDiscrepancy} mm</span>
                      <span className="text-[10px] text-slate-500 block">Req: {boltonComputed.u10} mm</span>
                    </div>
                    <div>
                      <span className="font-sans text-slate-500 block">{tr(lang, 'فرق المسافة السفلي (5–5)', 'Lower Discrepancy (5–5)')}</span>
                      <span className="font-bold text-slate-900">{boltonComputed.lowerDiscrepancy} mm</span>
                      <span className="text-[10px] text-slate-500 block">Req: {boltonComputed.l10} mm</span>
                    </div>
                  </div>
                  {boltonAnalysis && boltonAnalysis.metrics.length > 4 && (
                    <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                      {boltonAnalysis.metrics
                        .slice(4)
                        .filter((m) => m.value !== null)
                        .map((m) => (
                          <span key={m.key} className="font-mono tabular-nums text-slate-700">
                            <span className="font-sans text-slate-500">{lang === 'ar' ? m.labelAr : m.labelEn}:</span>{' '}
                            <strong>{m.value} {m.unit}</strong>
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {extraImagingAnalyses.length > 0 && (
                <div className="space-y-2.5 print-avoid-break">
                  {extraImagingAnalyses.map((ana) => (
                    <div key={ana.id} className="border border-slate-200 rounded-lg p-3 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-900">{ana.templateName}</span>
                        <span className="font-mono text-[11px] text-slate-500">{ana.stage} · v{ana.version}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                        {ana.metrics
                          .filter((m) => m.value !== null)
                          .map((m) => (
                            <span key={m.key} className="font-mono tabular-nums text-slate-700">
                              <span className="font-sans text-slate-500">{lang === 'ar' ? m.labelAr : m.labelEn}:</span>{' '}
                              <strong>{m.value} {m.unit}</strong>
                            </span>
                          ))}
                      </div>
                      {ana.cbctFindings?.notes && (
                        <p className="text-[11px] text-slate-600">{ana.cbctFindings.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 4. Diagnostic Photos & Radiographs */}
          {sections.diagnosticMedia && printableMedia.length > 0 && (
            <section className="space-y-3 print-avoid-break">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '4. السجلات التصويرية والأشعة التشخيصية', '4. Diagnostic Photographs & Radiographs')}
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {printableMedia.map((m) => (
                  <div key={m.id} className="border border-slate-200 rounded-lg p-2 space-y-1.5 print-avoid-break">
                    <img
                      src={m.derivedUrl || m.originalUrl}
                      alt={m.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-36 object-contain bg-slate-950 rounded"
                    />
                    <p className="text-[11px] font-semibold text-slate-900 truncate">{m.title}</p>
                    <p className="text-[10px] font-mono tabular-nums text-slate-500">
                      {m.stage} · {m.captureDate}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 5. Problem List & Clinical Diagnosis */}
          {sections.diagnosisAndProblems && (
            <section className="space-y-3 print-avoid-break">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '5. قائمة المشكلات والتشخيص السريري', '5. Problem List & Clinical Diagnosis')}
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="border border-slate-200 rounded-lg p-3">
                  <p className="font-semibold text-slate-800 mb-1">{tr(lang, 'النتائج الموضوعية المسجلة', 'Objective Recorded Findings')}</p>
                  <p className="text-slate-700 leading-relaxed">{patient.diagnosis.objectiveFindingsSummary || '—'}</p>
                </div>
                <div className="border border-slate-200 rounded-lg p-3">
                  <p className="font-semibold text-slate-800 mb-1">{tr(lang, 'التفسير والتشخيص السريري', 'Clinical Interpretation')}</p>
                  <p className="text-slate-700 leading-relaxed">{patient.diagnosis.clinicalInterpretation || '—'}</p>
                </div>
              </div>

              {patient.problems.length > 0 && (
                <table className="w-full text-xs border border-slate-200">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="p-2 text-start border-b border-slate-200 w-24">{tr(lang, 'التصنيف', 'Category')}</th>
                      <th className="p-2 text-start border-b border-slate-200">{tr(lang, 'المشكلة', 'Problem')}</th>
                      <th className="p-2 text-start border-b border-slate-200 w-20">{tr(lang, 'الأولوية', 'Priority')}</th>
                      <th className="p-2 text-start border-b border-slate-200 w-24">{tr(lang, 'الحالة', 'Status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {patient.problems.map((p) => (
                      <tr key={p.id}>
                        <td className="p-2 font-mono text-[11px] text-slate-600">{p.category}</td>
                        <td className="p-2 font-medium text-slate-900">
                          {p.title}
                          {p.description && <span className="block font-normal text-slate-600 mt-0.5">{p.description}</span>}
                        </td>
                        <td className="p-2 font-mono text-[11px]">{p.priority}</td>
                        <td className="p-2 font-mono text-[11px]">{p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {/* 6. Treatment Plan Matrix & Mechanotherapy */}
          {sections.treatmentPlanAndMechanics && (
            <section className="space-y-3 print-avoid-break">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '6. خطة العلاج والميكانيكا العلاجية', '6. Treatment Plan Matrix & Mechanotherapy')}
              </h2>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs bg-navy-50/70 border border-navy-200 rounded-lg p-3">
                <div>
                  <span className="text-navy-500 block">{tr(lang, 'المدة التقديرية', 'Est. Duration')}</span>
                  <span className="font-mono tabular-nums font-semibold">
                    {patient.treatmentPlan.estimatedDurationMonths ?? '—'} {tr(lang, 'شهراً', 'months')}
                  </span>
                </div>
                <div>
                  <span className="text-navy-500 block">{tr(lang, 'نظام الجهاز', 'Appliance')}</span>
                  <span className="font-medium">{patient.treatmentPlan.mechanotherapy.bracketSlot || '—'}</span>
                </div>
                <div>
                  <span className="text-navy-500 block">{tr(lang, 'تسلسل الأسلاك', 'Wire Sequence')}</span>
                  <span className="font-mono text-[11px]">
                    U: {(patient.treatmentPlan.mechanotherapy.wireSequenceUpper || patient.treatmentPlan.mechanotherapy.wireSequence).join(' → ') || '—'}
                  </span>
                </div>
                <div>
                  <span className="text-navy-500 block">{tr(lang, 'المطاطات والارتكاز', 'Elastics & Anchorage')}</span>
                  <span className="font-medium">{patient.treatmentPlan.mechanotherapy.elasticsProtocol || '—'}</span>
                </div>
              </div>

              {((patient.treatmentPlan.mechanotherapy.secondaryAppliances?.length || 0) > 0 ||
                (patient.treatmentPlan.mechanotherapy.auxiliaryItems?.length || 0) > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  {(patient.treatmentPlan.mechanotherapy.secondaryAppliances?.length || 0) > 0 && (
                    <div className="border border-navy-200 rounded-lg p-2.5">
                      <p className="font-semibold text-navy-900 mb-1">{tr(lang, 'الأجهزة المرافقة والتوسيع', 'Secondary & Orthopedic Appliances')}</p>
                      <ul className="space-y-1 text-[11px] text-navy-700">
                        {patient.treatmentPlan.mechanotherapy.secondaryAppliances!.map((sa) => (
                          <li key={sa.id}>
                            • <strong>{lang === 'ar' ? sa.nameAr : sa.nameEn}</strong> ({sa.status}) — {sa.activationProtocol}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(patient.treatmentPlan.mechanotherapy.auxiliaryItems?.length || 0) > 0 && (
                    <div className="border border-navy-200 rounded-lg p-2.5">
                      <p className="font-semibold text-navy-900 mb-1">{tr(lang, 'الأجهزة المساعدة (TADs / Coils / Turbos)', 'Auxiliary Appliances & Anchorage')}</p>
                      <ul className="space-y-1 text-[11px] text-navy-700">
                        {patient.treatmentPlan.mechanotherapy.auxiliaryItems!.map((ax) => (
                          <li key={ax.id}>
                            • <strong>{lang === 'ar' ? ax.nameAr : ax.nameEn}</strong> · {ax.site} ({ax.spec})
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {patient.treatmentPlan.goals.length > 0 && (
                <table className="w-full text-xs border border-slate-200">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="p-2 text-start border-b border-slate-200">{tr(lang, 'الهدف العلاجي', 'Treatment Goal')}</th>
                      <th className="p-2 text-start border-b border-slate-200">{tr(lang, 'الإجراء المخطط', 'Planned Procedure')}</th>
                      <th className="p-2 text-start border-b border-slate-200 w-32">{tr(lang, 'المرحلة', 'Stage')}</th>
                      <th className="p-2 text-start border-b border-slate-200 w-24">{tr(lang, 'النتيجة', 'Outcome')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {patient.treatmentPlan.goals.map((g) => (
                      <tr key={g.id}>
                        <td className="p-2 font-medium text-slate-900">{g.title}</td>
                        <td className="p-2 text-slate-700">{g.plannedProcedure}</td>
                        <td className="p-2 text-slate-600">{g.executionStage}</td>
                        <td className="p-2 font-mono text-[11px]">{g.outcomeStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {/* 7. Sessions History */}
          {sections.sessionsSummary && patient.sessions.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '7. ملخص الجلسات والشدات', '7. Clinical Sessions Summary')}
              </h2>
              <table className="w-full text-xs border border-slate-200">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="p-2 text-start border-b border-slate-200 w-10">#</th>
                    <th className="p-2 text-start border-b border-slate-200 w-24">{tr(lang, 'التاريخ', 'Date')}</th>
                    <th className="p-2 text-start border-b border-slate-200">{tr(lang, 'الإجراء والأسلاك', 'Procedures & Wires')}</th>
                    <th className="p-2 text-start border-b border-slate-200 w-20">{tr(lang, 'التعاون', 'Coop')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {patient.sessions.slice(0, 12).map((s) => (
                    <tr key={s.id}>
                      <td className="p-2 font-mono tabular-nums font-semibold">{s.visitNumber}</td>
                      <td className="p-2 font-mono tabular-nums text-slate-600">{s.date}</td>
                      <td className="p-2 text-slate-800">
                        {s.proceduresDone}
                        {!excludeInternalNotes && s.progressNotes && (
                          <span className="block text-slate-500 mt-0.5">{s.progressNotes}</span>
                        )}
                        <span className="block font-mono text-[10px] text-slate-500 mt-0.5">
                          U: {s.archwireUpper || '—'} · L: {s.archwireLower || '—'}
                        </span>
                      </td>
                      <td className="p-2 font-mono text-[11px]">{s.cooperationLevel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* 8. Retention Protocol */}
          {sections.retentionProtocol && (
            <section className="space-y-2.5 print-avoid-break">
              <h2 className="text-sm font-bold text-slate-900 border-b border-slate-200 pb-1">
                {tr(lang, '8. خطة التثبيت والمتابعة', '8. Finishing & Retention Protocol')}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs border border-slate-200 rounded-lg p-3">
                <div>
                  <span className="text-slate-500 block">{tr(lang, 'المثبت العلوي', 'Upper Retainer')}</span>
                  <span className="font-medium text-slate-900">{patient.retention.upperRetainerType || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr(lang, 'المثبت السفلي', 'Lower Retainer')}</span>
                  <span className="font-medium text-slate-900">{patient.retention.lowerRetainerType || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr(lang, 'بروتوكول الارتداء', 'Wear Protocol')}</span>
                  <span className="font-medium text-slate-900">{patient.retention.wearProtocol || '—'}</span>
                </div>
              </div>
            </section>
          )}

          {/* Clinician Sign-off Footer */}
          <footer className="pt-6 mt-6 border-t-2 border-slate-200 grid grid-cols-2 gap-6 text-xs print-avoid-break">
            <div>
              <p className="text-slate-500">{tr(lang, 'اعتماد أخصائي تقويم الأسنان', 'Attending Orthodontist Sign-off')}</p>
              <p className="font-semibold text-slate-900 mt-2">{patient.treatmentPlan.approvedBy || patient.assignedDoctor}</p>
              <div className="mt-6 border-b border-dashed border-slate-400 w-52" />
            </div>
            <div className="text-end">
              <p className="text-slate-500">{tr(lang, 'ختم العيادة والتاريخ', 'Clinic Stamp & Date')}</p>
              <p className="font-mono tabular-nums text-slate-700 mt-2">{clinicDateString(new Date(), CLINIC_ZONE_FALLBACK)}</p>
              <div className="mt-6 border-b border-dashed border-slate-400 w-52 ms-auto" />
            </div>
          </footer>
        </article>
      </div>
    </div>
  );
};
