"use client";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Download,
  FileText,
  Globe,
  Loader2,
  Presentation,
  Printer,
  RotateCcw,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { ClinicSettings, Language, PatientCase } from '../../types/ortho';
import { STAGE_LABELS, tr } from '../../i18n/translations';
import { DEFAULT_SLIDES, PresentationSlideConfig, exportCaseToPowerPoint } from '../../services/pptxExport';
import { syncAutoProblems } from '../../utils/problemExtractor';
import { api } from '../../services/api';

interface ReportsTabProps {
  orthoCaseId: number | null;
  patient: PatientCase;
  settings: ClinicSettings;
  lang: Language;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
  onOpenPrintView?: (opts: {
    anonymize?: boolean;
    excludeInternalNotes?: boolean;
    selectedMediaIds?: string[];
    customNarrativeTitle?: string;
    customNarrativeBody?: string;
  }) => void;
}

type ReportType = 'initial' | 'diagnosis_plan' | 'progress' | 'referral' | 'completion_retention';

function buildReportText(patient: PatientCase, settings: ClinicSettings, type: ReportType, lang: Language, anonymize: boolean): string {
  const clinic = lang === 'ar' ? settings.clinicNameAr : settings.clinicNameEn;
  const pName = anonymize ? `[${patient.caseNumber}]` : `${patient.fullName} (${patient.caseNumber})`;
  const stage = lang === 'ar' ? STAGE_LABELS[patient.stage].ar : STAGE_LABELS[patient.stage].en;

  if (type === 'initial') {
    return `${clinic}\n${tr(lang, 'تقرير الزيارة الأولى والاستبيان', 'Initial Consultation Report')}\n` +
      `${tr(lang, 'المريض:', 'Patient:')} ${pName} · ${tr(lang, 'الطبيب:', 'Clinician:')} ${patient.assignedDoctor}\n\n` +
      `${tr(lang, 'الشكوى الرئيسية:', 'Chief Complaint:')}\n${patient.chiefComplaintPatientWords}\n\n` +
      `${tr(lang, 'التوقعات:', 'Expectations:')}\n${patient.patientExpectations}\n\n` +
      `${tr(lang, 'التاريخ الطبي:', 'Medical History:')} ${patient.questionnaire.medicalHistory.value || patient.questionnaire.medicalHistory.status}\n` +
      `${tr(lang, 'الحساسية:', 'Allergies:')} ${patient.questionnaire.allergies.value || patient.questionnaire.allergies.status}\n` +
      `${tr(lang, 'ملاحظات الفحص الأولي:', 'Initial Exam Summary:')} ${patient.clinicalExam.extraoral.profile.value} · Overjet: ${patient.clinicalExam.intraoral.overjetMm.value}`;
  }
  if (type === 'diagnosis_plan') {
    const syncedProblems = syncAutoProblems(patient, lang).nextProblems;
    return `${clinic}\n${tr(lang, 'تقرير التشخيص وخطة العلاج المعتمدة', 'Diagnosis & Treatment Plan Report')}\n` +
      `${tr(lang, 'المريض:', 'Patient:')} ${pName} · ${tr(lang, 'المرحلة:', 'Stage:')} ${stage}\n\n` +
      `${tr(lang, 'النتائج المسجلة:', 'Objective Findings:')}\n${patient.diagnosis.objectiveFindingsSummary}\n\n` +
      `${tr(lang, 'التشخيص السريري:', 'Clinical Interpretation:')}\n${patient.diagnosis.clinicalInterpretation}\n\n` +
      `${tr(lang, 'قائمة المشكلات:', 'Problem List:')}\n` +
      syncedProblems.map((p, i) => `${i + 1}. ${p.title} (${p.priority})`).join('\n') +
      `\n\n${tr(lang, 'الخطة المختارة والمدة التقديرية:', 'Selected Plan & Est. Duration:')} ${patient.treatmentPlan.estimatedDurationMonths ?? '—'} ${tr(lang, 'شهراً', 'months')}\n` +
      `${tr(lang, 'الميكانيكا العلاجية:', 'Mechanotherapy:')} ${patient.treatmentPlan.mechanotherapy.bracketSlot}`;
  }
  if (type === 'progress') {
    return `${clinic}\n${tr(lang, 'تقرير تقدم العلاج والشدات', 'Treatment Progress Report')}\n` +
      `${tr(lang, 'المريض:', 'Patient:')} ${pName} · ${tr(lang, 'عدد الجلسات:', 'Total Visits:')} ${patient.sessions.length}\n\n` +
      patient.sessions
        .slice(0, 5)
        .map((s) => `#${s.visitNumber} (${s.date}): ${s.proceduresDone} | U:${s.archwireUpper} L:${s.archwireLower}`)
        .join('\n');
  }
  if (type === 'referral') {
    return `${clinic}\n${tr(lang, 'خطاب إحالة تخصصية', 'Specialist Referral Letter')}\n` +
      `${tr(lang, 'المريض:', 'Patient:')} ${pName}\n` +
      `${tr(lang, 'سبب الإحالة / التخصص المطلوب:', 'Referral Reason / Requested Consult:')}\n${patient.treatmentPlan.referrals.join(' · ') || 'تقييم تخصصي مشترك'}\n\n` +
      `${tr(lang, 'ملخص الحالة:', 'Clinical Summary:')}\n${patient.diagnosis.objectiveFindingsSummary}`;
  }
  return `${clinic}\n${tr(lang, 'تقرير إنهاء العلاج والتثبيت', 'Completion & Retention Report')}\n` +
    `${tr(lang, 'المريض:', 'Patient:')} ${pName}\n` +
    `${tr(lang, 'تاريخ إزالة الأجهزة:', 'Debond Date:')} ${patient.retention.debondDate || '—'}\n` +
    `${tr(lang, 'النتائج النهائية:', 'Final Outcomes:')}\n${patient.retention.finalOutcomeVsGoals || '—'}\n` +
    `${tr(lang, 'المثبت العلوي:', 'Upper Retainer:')} ${patient.retention.upperRetainerType}\n` +
    `${tr(lang, 'المثبت السفلي:', 'Lower Retainer:')} ${patient.retention.lowerRetainerType}\n` +
    `${tr(lang, 'تعليمات الارتداء:', 'Wear Protocol:')} ${patient.retention.wearProtocol}`;
}

export const ReportsTab: React.FC<ReportsTabProps> = ({
  orthoCaseId,
  patient,
  settings,
  lang,
  actorName,
  onChange,
  onOpenPrintView,
}) => {
  const [reportType, setReportType] = useState<ReportType>('diagnosis_plan');
  const [anonymize, setAnonymize] = useState(false);
  const [excludeInternalNotes, setExcludeInternalNotes] = useState(true);
  const [reportText, setReportText] = useState('');

  const [slides, setSlides] = useState<PresentationSlideConfig[]>(DEFAULT_SLIDES);
  const [pptxLang, setPptxLang] = useState<Language>('en');
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>(() =>
    patient.media.filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph').map((m) => m.id),
  );
  const [exportingPptx, setExportingPptx] = useState(false);

  // Spoken Patient Care Instructions (Gemini 3.8 TTS) state
  const [ttsTopic, setTtsTopic] = useState<'elastics_care' | 'retainer_care' | 'plan_summary' | 'post_adjustment' | 'custom'>('elastics_care');
  const [ttsLang, setTtsLang] = useState<Language>(lang);
  const [ttsVoice, setTtsVoice] = useState<'Kore' | 'Aoede' | 'Puck' | 'Charon' | 'Zephyr'>('Kore');
  const [ttsScript, setTtsScript] = useState('');
  const [ttsAudioUrl, setTtsAudioUrl] = useState<string>('');
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState('');

  const aiConsentReady = Boolean(settings.allowExternalAi && patient.consents.externalAiConsent);

  useEffect(() => {
    return () => {
      if (ttsAudioUrl) URL.revokeObjectURL(ttsAudioUrl);
    };
  }, [ttsAudioUrl]);

  useEffect(() => {
    setTtsScript('');
    setTtsError('');
    setTtsAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return '';
    });
  }, [patient.id]);

  const handleGeneratePatientAudio = async (opts: { scriptOnly?: boolean; useEditedScript?: boolean }) => {
    if (!aiConsentReady || ttsLoading) return;
    setTtsError('');
    setTtsLoading(true);
    try {
      const customText = opts.useEditedScript || ttsTopic === 'custom' ? ttsScript.trim() : undefined;
      const res = await api.aiPatientAudio({
        patientId: patient.id,
        topic: ttsTopic,
        language: ttsLang,
        voice: ttsVoice,
        customScript: customText,
        scriptOnly: opts.scriptOnly,
      });
      setTtsScript(res.script);
      if (res.audioBase64) {
        const binary = atob(res.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: res.mimeType || 'audio/wav' });
        const nextUrl = URL.createObjectURL(blob);
        setTtsAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextUrl;
        });
      }
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : 'TTS generation error');
    } finally {
      setTtsLoading(false);
    }
  };

  useEffect(() => {
    setSelectedMediaIds(
      patient.media.filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph').map((m) => m.id),
    );
  }, [patient.id, patient.media.length]);

  useEffect(() => {
    setReportText(buildReportText(patient, settings, reportType, lang, anonymize));
  }, [reportType, anonymize, lang, patient, settings]);

  const moveSlide = (index: number, dir: -1 | 1) => {
    const next = [...slides];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSlides(next);
  };

  const handleSaveReport = () => {
    onChange(
      {
        ...patient,
        customReports: [
          {
            id: `rep-${Date.now()}`,
            reportType,
            title: `${reportType} (${clinicDateString(new Date(), CLINIC_ZONE_FALLBACK)})`,
            body: reportText,
            createdAt: new Date().toISOString(),
            createdBy: actorName,
          },
          ...patient.customReports,
        ],
      },
      { ar: `حفظ تقرير سريري (${reportType})`, en: `Saved clinical report (${reportType})` },
    );
  };

  const handleExportPptx = async () => {
    setExportingPptx(true);
    try {
      await exportCaseToPowerPoint({
        orthoCaseId,
        patient,
        settings,
        lang: pptxLang,
        slides,
        selectedMediaIds,
        anonymize,
        excludeInternalNotes,
      });
    } finally {
      setExportingPptx(false);
    }
  };

  const handleExportPatientJson = () => {
    const blob = new Blob([JSON.stringify(patient, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${patient.caseNumber}_full_record.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Shared Export Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 no-print">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="inline-flex items-center gap-2 cursor-pointer font-medium text-slate-800">
            <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} className="accent-teal-700" />
            <span>{tr(lang, 'إخفاء هوية المريض عند التصدير (Anonymize)', 'Anonymize Patient Identity')}</span>
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer font-medium text-slate-800">
            <input
              type="checkbox"
              checked={excludeInternalNotes}
              onChange={(e) => setExcludeInternalNotes(e.target.checked)}
              className="accent-teal-700"
            />
            <span>{tr(lang, 'استبعاد الملاحظات الداخلية', 'Exclude Internal Notes')}</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportPatientJson}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{tr(lang, 'تصدير ملف الحالة (JSON)', 'Export Full Case JSON')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (onOpenPrintView) {
                const titles: Record<ReportType, { ar: string; en: string }> = {
                  initial: { ar: 'تقرير الزيارة الأولى والاستبيان', en: 'Initial Consultation Report' },
                  diagnosis_plan: { ar: 'تقرير التشخيص وخطة العلاج المعتمدة', en: 'Diagnosis & Treatment Plan Report' },
                  progress: { ar: 'تقرير تقدم العلاج والشدات', en: 'Treatment Progress Report' },
                  referral: { ar: 'خطاب إحالة تخصصية', en: 'Specialist Referral Letter' },
                  completion_retention: { ar: 'تقرير إنهاء العلاج والتثبيت', en: 'Completion & Retention Report' },
                };
                onOpenPrintView({
                  anonymize,
                  excludeInternalNotes,
                  selectedMediaIds,
                  customNarrativeTitle: lang === 'ar' ? titles[reportType].ar : titles[reportType].en,
                  customNarrativeBody: reportText,
                });
              } else {
                window.print();
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-white rounded-lg"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>{tr(lang, 'طباعة / حفظ PDF', 'Print / Save PDF')}</span>
          </button>
          <button
            type="button"
            disabled={exportingPptx}
            onClick={handleExportPptx}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-teal-700 hover:bg-teal-800 text-white rounded-lg"
          >
            <Presentation className="w-3.5 h-3.5" />
            <span>
              {exportingPptx
                ? tr(lang, 'جاري إنشاء PowerPoint...', 'Generating PPTX...')
                : tr(lang, 'تصدير عرض حالة (.pptx)', 'Export PowerPoint (.pptx)')}
            </span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 no-print">
        {/* Report Generator */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <FileText className="w-4 h-4 text-teal-700" />
              <span>{tr(lang, 'مولّد التقارير السريرية القابل للتحرير', 'Editable Clinical Report Generator')}</span>
            </div>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value as ReportType)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="initial">{tr(lang, 'تقرير الزيارة الأولى', 'Initial Visit Report')}</option>
              <option value="diagnosis_plan">{tr(lang, 'التشخيص وخطة العلاج', 'Diagnosis & Treatment Plan')}</option>
              <option value="progress">{tr(lang, 'تقرير تقدم العلاج', 'Treatment Progress')}</option>
              <option value="referral">{tr(lang, 'خطاب إحالة', 'Referral Letter')}</option>
              <option value="completion_retention">{tr(lang, 'إنهاء العلاج والتثبيت', 'Completion & Retention')}</option>
            </select>
          </div>

          <textarea
            rows={14}
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            className="w-full px-3.5 py-3 text-sm leading-relaxed border border-slate-300 rounded-lg font-sans"
          />

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleSaveReport}
              className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-lg"
            >
              {tr(lang, 'حفظ نسخة التقرير في الملف', 'Save Report Snapshot')}
            </button>
          </div>
        </div>

        {/* Case Presentation Slide & Photo Builder */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {tr(lang, 'منسّق شرائح عرض الحالة الأكاديمي (Case Presentation)', 'Academic Case Presentation Slide Builder')}
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {tr(
                  lang,
                  'مرتّب وفق تسلسل عرض الحالات السريرية (المقابلة ← الصور ← الأشعة والتحليلات ← التشخيص ← الخطة والشدات)',
                  'Ordered by standard orthodontic case conference sequence (Interview → Records → Analyses → Diagnosis → Plan & Progress)',
                )}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSlides(DEFAULT_SLIDES)}
                title={tr(lang, 'إعادة الترتيب العلمي الافتراضي', 'Reset Academic Order')}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{tr(lang, 'الترتيب القياسي', 'Reset Order')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const allOn = slides.every((s) => s.enabled);
                  setSlides(slides.map((s) => ({ ...s, enabled: !allOn })));
                }}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-teal-50 hover:bg-teal-100 text-teal-800 rounded-lg"
              >
                <CheckSquare className="w-3 h-3" />
                <span>{slides.every((s) => s.enabled) ? tr(lang, 'إلغاء الكل', 'Uncheck All') : tr(lang, 'تفعيل الكل', 'Enable All')}</span>
              </button>
            </div>
          </div>

          {/* PPTX Output Language Selector */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs">
            <div className="flex items-center gap-1.5 font-medium text-slate-700">
              <Globe className="w-3.5 h-3.5 text-teal-700" />
              <span>{tr(lang, 'لغة شرائح البوربوينت (.pptx):', 'Presentation Slide Language (.pptx):')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPptxLang('en')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                  pptxLang === 'en'
                    ? 'bg-slate-900 text-white'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                English (Academic Conference)
              </button>
              <button
                type="button"
                onClick={() => setPptxLang('ar')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                  pptxLang === 'ar'
                    ? 'bg-slate-900 text-white'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                العربية (عرض عربي)
              </button>
            </div>
          </div>

          <div className="px-3 py-2 bg-teal-50/70 border border-teal-200/80 rounded-lg text-[11px] text-teal-950 leading-relaxed">
            {tr(
              lang,
              'يشمل ملف PowerPoint تلقائياً: الصور الخارجية والداخلية مع الرسم التوضيحي للتحليل، أشعة السيفالو المرسومة وجداول تحاليلها، قياسات الأسنان الدائمة والمختلطة كاملة، التشخيص وقائمة المشكلات المتزامنة، الأهداف والخطة العلاجية لكل مشكلة، البيوميكانيك التفصيلي (3 مراحل)، وصور وإجراءات كل جلسة.',
              'Exports traced extraoral/intraoral photo overlays, traced Lateral Ceph + full Ceph table, complete Permanent & Mixed cast analyses, synced Problem List & Problem-to-Plan matrix, 3-stage Biomechanics, and 5-photo conference Session slides.',
            )}
          </div>

          <div className="space-y-1.5 max-h-72 overflow-y-auto pe-1">
            {slides.map((s, idx) => (
              <div key={s.id} className="flex items-center justify-between px-3 py-1.5 border border-slate-200 rounded-lg text-xs hover:bg-slate-50/70">
                <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => {
                      const next = [...slides];
                      next[idx] = { ...s, enabled: e.target.checked };
                      setSlides(next);
                    }}
                    className="accent-teal-700 shrink-0"
                  />
                  <span className="font-medium text-slate-800 truncate">{lang === 'ar' ? s.labelAr : s.labelEn}</span>
                </label>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => moveSlide(idx, -1)} className="p-1 hover:bg-slate-100 rounded">
                    <ArrowUp className="w-3.5 h-3.5 text-slate-600" />
                  </button>
                  <button type="button" onClick={() => moveSlide(idx, 1)} className="p-1 hover:bg-slate-100 rounded">
                    <ArrowDown className="w-3.5 h-3.5 text-slate-600" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-700">
                {tr(lang, 'الصور والأشعة المضمّنة في العرض:', 'Included Diagnostic Images:')}
              </p>
              <button
                type="button"
                onClick={() => {
                  const allDiag = patient.media.filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph').map((m) => m.id);
                  setSelectedMediaIds(selectedMediaIds.length === allDiag.length ? [] : allDiag);
                }}
                className="text-[11px] font-medium text-teal-700 hover:underline"
              >
                {selectedMediaIds.length > 0 ? tr(lang, 'تحديد/إلغاء الكل', 'Toggle All') : tr(lang, 'تحديد الكل', 'Select All')}
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-44 overflow-y-auto">
              {patient.media
                .filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph')
                .map((m) => {
                  const active = selectedMediaIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        setSelectedMediaIds((prev) =>
                          prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                        )
                      }
                      className={`p-1.5 rounded-lg border text-start text-[11px] ${
                        active ? 'border-teal-700 bg-teal-50/60' : 'border-slate-200 bg-white'
                      }`}
                    >
                      <img src={m.originalUrl} alt={m.title} className="w-full h-16 object-cover rounded mb-1" />
                      <p className="truncate font-medium">{m.title}</p>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      </div>

      {/* Spoken Patient Care Instructions (Gemini 3.8 TTS) */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 no-print">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-navy-50 border border-navy-200 flex items-center justify-center shrink-0 mt-0.5">
              <Volume2 className="w-4 h-4 text-brand-orange" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                {tr(lang, 'الموجز الصوتي لتعليمات المريض (Gemini 3.8 TTS)', 'Spoken Patient Care Instructions (Gemini 3.8 TTS)')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {tr(
                  lang,
                  'ولّد رسالة صوتية واضحة بالعربية أو الإنجليزية مخصّصة لحالة المريض (تعليمات المطاط، المثبّت، أو ما بعد الشدّة) للاستماع أو التحميل وإرسالها عبر واتساب.',
                  'Generate a clear Arabic or English voice briefing tailored to this patient (elastics, retainer, or post-adjustment care) ready to play or download.',
                )}
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-teal-50 border border-teal-200 text-[11px] font-semibold text-teal-900">
            <Sparkles className="w-3 h-3" />
            <span>gemini-3.8-flash-tts</span>
          </span>
        </div>

        {!aiConsentReady && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
            <span>
              {tr(
                lang,
                'لتشغيل التوليد الصوتي، فعّل «المعالجة بالذكاء الاصطناعي الخارجي» في إعدادات الإدارة وتأكد من موافقة المريض في تبويب «البيانات».',
                'Enable External AI in Admin Settings and grant Patient AI Consent in Overview tab to generate spoken instructions.',
              )}
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div>
            <label className="block font-medium text-slate-600 mb-1">
              {tr(lang, 'موضوع التعليمات الصوتية', 'Instruction Topic')}
            </label>
            <select
              value={ttsTopic}
              onChange={(e) => setTtsTopic(e.target.value as typeof ttsTopic)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="elastics_care">{tr(lang, 'تعليمات المطاط والعناية بالتقويم', 'Elastics & Braces Care')}</option>
              <option value="retainer_care">{tr(lang, 'تعليمات ارتداء المثبّت والعناية به', 'Retainer Wear & Care')}</option>
              <option value="post_adjustment">{tr(lang, 'تعليمات ما بعد الشدّة', 'Post-Adjustment Care')}</option>
              <option value="plan_summary">{tr(lang, 'شرح مبسّط لخطة العلاج للمريض', 'Patient-Friendly Plan Summary')}</option>
              <option value="custom">{tr(lang, 'نص مخصص من الطبيب', 'Custom Clinician Script')}</option>
            </select>
          </div>

          <div>
            <label className="block font-medium text-slate-600 mb-1">
              {tr(lang, 'لغة الصوت', 'Spoken Language')}
            </label>
            <select
              value={ttsLang}
              onChange={(e) => setTtsLang(e.target.value as Language)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ar">العربية (فصحى واضحة للمريض)</option>
              <option value="en">English (Patient-friendly)</option>
            </select>
          </div>

          <div>
            <label className="block font-medium text-slate-600 mb-1">
              {tr(lang, 'نبرة الصوت (Voice)', 'Voice Persona')}
            </label>
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value as typeof ttsVoice)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="Kore">Kore — {tr(lang, 'متوازن ودافئ', 'Warm & Balanced')}</option>
              <option value="Aoede">Aoede — {tr(lang, 'واضح وهادئ', 'Clear & Calm')}</option>
              <option value="Zephyr">Zephyr — {tr(lang, 'ناعم ومطمئن', 'Gentle & Reassuring')}</option>
              <option value="Puck">Puck — {tr(lang, 'ودود وحيوي', 'Friendly & Upbeat')}</option>
              <option value="Charon">Charon — {tr(lang, 'عميق ورسمي', 'Deep & Formal')}</option>
            </select>
          </div>
        </div>

        <div className="space-y-2 text-xs">
          <label className="block font-medium text-slate-700">
            {tr(lang, 'نص الرسالة الصوتية (قابل للتحرير قبل التحويل إلى صوت):', 'Spoken Script (editable before synthesis):')}
          </label>
          <textarea
            rows={4}
            value={ttsScript}
            onChange={(e) => setTtsScript(e.target.value)}
            placeholder={tr(
              lang,
              'اضغط «توليد النص والصوت» لإنشاء نص تلقائي من ملف الحالة وتحويله إلى صوت، أو اكتب نصك الخاص هنا...',
              'Click Generate Script & Audio to draft from the case file and synthesize speech, or type a custom script here...',
            )}
            className="w-full px-3.5 py-2.5 text-sm leading-relaxed border border-slate-300 rounded-lg"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            disabled={!aiConsentReady || ttsLoading || (ttsTopic === 'custom' && !ttsScript.trim())}
            onClick={() => void handleGeneratePatientAudio({ scriptOnly: false, useEditedScript: false })}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-teal-700 hover:bg-teal-800 disabled:opacity-45 text-white font-semibold rounded-lg"
          >
            {ttsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
            <span>
              {ttsLoading
                ? tr(lang, 'جاري التوليد الصوتي...', 'Generating audio...')
                : tr(lang, 'توليد النص والصوت تلقائياً', 'Auto-Draft & Generate Audio')}
            </span>
          </button>

          {ttsTopic !== 'custom' && (
            <button
              type="button"
              disabled={!aiConsentReady || ttsLoading}
              onClick={() => void handleGeneratePatientAudio({ scriptOnly: true, useEditedScript: false })}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-45 text-slate-800 font-medium rounded-lg"
            >
              <Sparkles className="w-3.5 h-3.5 text-teal-700" />
              <span>{tr(lang, 'توليد النص فقط للمراجعة', 'Draft Script Only')}</span>
            </button>
          )}

          {ttsScript.trim() && (
            <button
              type="button"
              disabled={!aiConsentReady || ttsLoading}
              onClick={() => void handleGeneratePatientAudio({ scriptOnly: false, useEditedScript: true })}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-navy-900 hover:bg-navy-800 disabled:opacity-45 text-white font-medium rounded-lg"
            >
              <Volume2 className="w-3.5 h-3.5 text-brand-orange" />
              <span>{tr(lang, 'تحويل النص الحالي إلى صوت', 'Synthesize Edited Script')}</span>
            </button>
          )}
        </div>

        {ttsError && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">{ttsError}</div>}

        {ttsAudioUrl && (
          <div className="p-4 bg-slate-50 border border-teal-200 rounded-xl flex flex-wrap items-center justify-between gap-3">
            <audio controls src={ttsAudioUrl} className="flex-1 min-w-[240px]" />
            <a
              href={ttsAudioUrl}
              download={`${patient.caseNumber}_${ttsTopic}_${ttsLang}.wav`}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-brand-orange hover:bg-accent-600 text-white text-xs font-semibold rounded-lg shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{tr(lang, 'تحميل الصوت (.wav)', 'Download Audio (.wav)')}</span>
            </a>
          </div>
        )}
      </div>

      {/* Print-ready PDF Sheet (Always visible in @media print and previewed below) */}
      <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-6">
        <div className="flex items-start justify-between border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">{lang === 'ar' ? settings.clinicNameAr : settings.clinicNameEn}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {anonymize ? `${tr(lang, 'حالة مجهولة الهوية', 'Anonymized Case')} (${patient.caseNumber})` : `${patient.fullName} · ${patient.caseNumber}`}
              {' · '}
              {patient.assignedDoctor}
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-500">{clinicDateString(new Date(), CLINIC_ZONE_FALLBACK)}</span>
        </div>

        <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800 leading-relaxed">{reportText}</pre>

        {selectedMediaIds.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-4 border-t border-slate-100">
            {patient.media
              .filter((m) => selectedMediaIds.includes(m.id))
              .slice(0, 4)
              .map((m) => (
                <div key={m.id} className="border border-slate-200 rounded-lg p-2">
                  <img src={m.originalUrl} alt={m.title} className="w-full h-28 object-contain bg-slate-900 rounded mb-1.5" />
                  <p className="text-[11px] text-slate-700 truncate">{m.title}</p>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
};
