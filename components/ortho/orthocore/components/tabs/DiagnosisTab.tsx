"use client";
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { Language, PatientCase, ProblemCategory, ProblemItem, UserRole } from '../../types/ortho';
import { tr } from '../../i18n/translations';
import { getCaseCompleteness } from '../../utils/orthoMath';
import { syncAutoProblems } from '../../utils/problemExtractor';

interface DiagnosisTabProps {
  patient: PatientCase;
  lang: Language;
  role: UserRole;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

const CATEGORIES: Array<{ v: ProblemCategory; ar: string; en: string }> = [
  { v: 'skeletal', ar: 'هيكلية (Skeletal)', en: 'Skeletal' },
  { v: 'dental', ar: 'سنية (Dental)', en: 'Dental' },
  { v: 'soft_tissue', ar: 'أنسجة رخوة (Soft Tissue)', en: 'Soft Tissue' },
  { v: 'functional', ar: 'وظيفية (Functional)', en: 'Functional' },
  { v: 'other', ar: 'أخرى', en: 'Other' },
];

const SKELETAL_CLASS_PRESETS: Array<{ ar: string; en: string }> = [
  { ar: 'Class I (علاقة هيكلية متوازنة)', en: 'Class I (Balanced Skeletal)' },
  { ar: 'Class II خفيف (تراجع فك سفلي خفيف)', en: 'Mild Skeletal Class II' },
  { ar: 'Class II واضح (تقدم علوي / تراجع سفلي)', en: 'Moderate-Severe Skeletal Class II' },
  { ar: 'Class III خفيف (تقدم سفلي / قصور علوي)', en: 'Mild Skeletal Class III' },
  { ar: 'Class III هيكلي واضح (جراحي/تقويمي)', en: 'Severe Skeletal Class III' },
  { ar: 'عدم تناظر وجهي هيكلي (Facial Asymmetry)', en: 'Skeletal Facial Asymmetry' },
];

const DENTAL_CLASS_PRESETS: Array<{ ar: string; en: string }> = [
  { ar: 'Class I (سوء إطباق صنف أول مع ازدحام/فراغات)', en: 'Class I Malocclusion (Crowding/Spacing)' },
  { ar: 'Class II div 1 (صنف ثانٍ قسم 1)', en: 'Class II Division 1' },
  { ar: 'Class II div 2 (صنف ثانٍ قسم 2 مع عضة عميقة)', en: 'Class II Division 2' },
  { ar: 'Class II Subdivision (أحادي الجانب)', en: 'Class II Subdivision' },
  { ar: 'Class III سني / عضة معكوسة أمامية', en: 'Dental Class III / Anterior Crossbite' },
];

const VERTICAL_PATTERN_PRESETS: Array<{ ar: string; en: string }> = [
  { ar: 'متوازن (Mesofacial / Normodivergent)', en: 'Balanced (Mesofacial)' },
  { ar: 'نمو عمودي زائد (High Angle / Dolichofacial)', en: 'High Angle (Hyperdivergent)' },
  { ar: 'نمو أفقي / زاوية منخفضة (Low Angle / Brachyfacial)', en: 'Low Angle (Hypodivergent)' },
  { ar: 'ميل لعضة مفتوحة هيكلية (Skeletal Open Bite)', en: 'Skeletal Open Bite Tendency' },
  { ar: 'ميل لعضة عميقة هيكلية (Skeletal Deep Bite)', en: 'Skeletal Deep Bite Tendency' },
];

function getProblemSourceLabel(id: string, lang: Language): { label: string; isAuto: boolean } {
  if (id.startsWith('auto-diag-')) {
    return { label: tr(lang, 'تلقائي · التشخيص', 'Auto · Diagnosis'), isAuto: true };
  }
  if (id.startsWith('auto-exam-') || id.startsWith('auto-fdi-')) {
    return { label: tr(lang, 'تلقائي · الفحص', 'Auto · Exam'), isAuto: true };
  }
  if (id.startsWith('auto-photo-')) {
    return { label: tr(lang, 'تلقائي · تحليل الصور', 'Auto · Photo Analysis'), isAuto: true };
  }
  if (id.startsWith('auto-ana-')) {
    return { label: tr(lang, 'تلقائي · القياسات', 'Auto · Measurements'), isAuto: true };
  }
  return { label: tr(lang, 'يدوي', 'Manual'), isAuto: false };
}

export const DiagnosisTab: React.FC<DiagnosisTabProps> = ({ patient, lang, role, actorName, onChange }) => {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ProblemCategory>('dental');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('high');
  const [description, setDescription] = useState('');
  const [evidenceLabel, setEvidenceLabel] = useState('');

  const canApprove = role === 'doctor';
  const completeness = getCaseCompleteness(patient);

  // Sync automatically on case open if un-synced findings exist in Exam / Diagnosis / Photo Analysis
  useEffect(() => {
    const res = syncAutoProblems(patient, lang);
    if (res.changed) {
      onChange({
        ...patient,
        problems: res.nextProblems,
        dismissedAutoProblemIds: res.nextDismissed,
      });
    }
  }, [patient.id]);

  const handleManualResync = () => {
    const res = syncAutoProblems(patient, lang, { ignoreDismissed: true });
    onChange(
      {
        ...patient,
        problems: res.nextProblems,
        dismissedAutoProblemIds: [],
      },
      {
        ar: 'مزامنة وتحديث قائمة المشكلات تلقائياً من التشخيص والفحص وتحليل الصور',
        en: 'Re-synced problem list automatically from diagnosis, exam & photo analyses',
      },
    );
  };

  const addProblem = () => {
    if (!title.trim()) return;
    const item: ProblemItem = {
      id: `prob-${Date.now()}`,
      category,
      title: title.trim(),
      description: description.trim(),
      evidenceLinks: evidenceLabel.trim()
        ? [{ type: 'exam', refId: 'manual', label: evidenceLabel.trim() }]
        : [],
      priority,
      status: 'active',
    };
    onChange(
      { ...patient, problems: [...patient.problems, item] },
      { ar: `إضافة مشكلة سريرية: ${item.title}`, en: `Added problem: ${item.title}` },
    );
    setTitle('');
    setDescription('');
    setEvidenceLabel('');
  };

  const updateProblem = (id: string, patch: Partial<ProblemItem>) => {
    onChange({
      ...patient,
      problems: patient.problems.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  const removeProblem = (id: string) => {
    const nextDismissed = id.startsWith('auto-')
      ? Array.from(new Set([...(patient.dismissedAutoProblemIds || []), id]))
      : patient.dismissedAutoProblemIds;
    onChange({
      ...patient,
      problems: patient.problems.filter((p) => p.id !== id),
      dismissedAutoProblemIds: nextDismissed,
    });
  };

  const autoCount = patient.problems.filter((p) => p.id.startsWith('auto-')).length;
  const dismissedCount = (patient.dismissedAutoProblemIds || []).length;

  return (
    <div className="space-y-6">
      {completeness.missingCount > 0 && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-900 space-y-1">
            <p className="font-semibold">
              {tr(lang, `بيانات لا تزال بحاجة للاستكمال (${completeness.missingCount}):`, `Missing Diagnostic Records (${completeness.missingCount}):`)}
            </p>
            <p className="text-amber-800">
              {completeness.missingItems
                .slice(0, 4)
                .map((m) => (lang === 'ar' ? m.labelAr : m.labelEn))
                .join(' · ')}
            </p>
          </div>
        </div>
      )}

      {/* Categorized Problem List */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                {tr(lang, 'قائمة المشكلات السريرية المصنفة', 'Categorized Orthodontic Problem List')}
              </h3>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-md">
                <Sparkles className="w-3 h-3" />
                <span>
                  {tr(lang, 'إدراج تلقائي نشط', 'Auto-Sync Active')} ({autoCount})
                </span>
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {tr(
                lang,
                'تُدرج المشكلات تلقائياً من التشخيص والفحص السريري وتحليل الصور (خارج وداخل الفم) والقياسات، مع إمكانية الإضافة أو التعديل اليدوي',
                'Problems are automatically populated from Diagnosis, Clinical Exam, Photo Analyses (Extraoral & Intraoral), and Measurements',
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={handleManualResync}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-navy-50 hover:bg-navy-100 text-navy-800 border border-navy-200 rounded-lg transition-colors"
            title={tr(lang, 'إعادة فحص السجلات واستعادة أي مشكلة مستبعدة', 'Re-scan all records and restore dismissed auto-problems')}
          >
            <RefreshCw className="w-3.5 h-3.5 text-brand-orange" />
            <span>
              {dismissedCount > 0
                ? tr(lang, `تحديث واستعادة الكل (${dismissedCount} مستبعدة)`, `Re-sync & Restore (${dismissedCount})`)
                : tr(lang, 'تحديث من التشخيص والفحص والصور', 'Sync from Diagnosis, Exam & Photos')}
            </span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-2.5 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ProblemCategory)}
            className="px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          >
            {CATEGORIES.map((c) => (
              <option key={c.v} value={c.v}>
                {lang === 'ar' ? c.ar : c.en}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr(lang, 'إضافة مشكلة يدوية...', 'Add manual problem title...')}
            className="md:col-span-2 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          />
          <input
            type="text"
            value={evidenceLabel}
            onChange={(e) => setEvidenceLabel(e.target.value)}
            placeholder={tr(lang, 'الدليل (مثال: ANB 5.2°)', 'Evidence link...')}
            className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          />
          <div className="flex gap-1.5">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as 'high' | 'medium' | 'low')}
              className="flex-1 px-2 py-2 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="high">{tr(lang, 'أولوية عالية', 'High')}</option>
              <option value="medium">{tr(lang, 'متوسطة', 'Medium')}</option>
              <option value="low">{tr(lang, 'منخفضة', 'Low')}</option>
            </select>
            <button
              type="button"
              onClick={addProblem}
              className="inline-flex items-center gap-1 px-3 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="space-y-2.5">
          {patient.problems.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-300 rounded-lg">
              {tr(
                lang,
                'لا توجد مشكلات مرصودة بعد — أي نتيجة تسجل في الفحص أو التشخيص أو تحليل الصور ستُدرج هنا تلقائياً.',
                'No problems detected yet — findings from Exam, Diagnosis, or Photo Analysis will populate here automatically.',
              )}
            </div>
          ) : (
            patient.problems.map((p) => {
              const catLabel = CATEGORIES.find((c) => c.v === p.category);
              const src = getProblemSourceLabel(p.id, lang);
              return (
                <div
                  key={p.id}
                  className={`p-3.5 border rounded-lg flex flex-wrap items-start justify-between gap-3 ${
                    src.isAuto ? 'border-slate-200 bg-slate-50/40' : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="space-y-1 flex-1 min-w-[240px]">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-teal-800">
                        {catLabel ? (lang === 'ar' ? catLabel.ar : catLabel.en) : p.category}
                      </span>
                      <span className="text-slate-300">·</span>
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${
                          src.isAuto
                            ? 'bg-navy-50 text-navy-700 border-navy-200'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}
                      >
                        {src.label}
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="font-semibold text-slate-900 text-sm">{p.title}</span>
                    </div>
                    {p.description && <p className="text-xs text-slate-600">{p.description}</p>}
                    {p.evidenceLinks.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-slate-500">
                        <Link2 className="w-3 h-3 text-slate-400" />
                        <span>{p.evidenceLinks.map((e) => e.label).join(' · ')}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={p.priority}
                      onChange={(e) => updateProblem(p.id, { priority: e.target.value as 'high' | 'medium' | 'low' })}
                      className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                    >
                      <option value="high">{tr(lang, 'عالية', 'High')}</option>
                      <option value="medium">{tr(lang, 'متوسطة', 'Medium')}</option>
                      <option value="low">{tr(lang, 'منخفضة', 'Low')}</option>
                    </select>
                    <select
                      value={p.status}
                      onChange={(e) => updateProblem(p.id, { status: e.target.value as 'active' | 'improving' | 'resolved' })}
                      className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                    >
                      <option value="active">{tr(lang, 'نشطة', 'Active')}</option>
                      <option value="improving">{tr(lang, 'في تحسن', 'Improving')}</option>
                      <option value="resolved">{tr(lang, 'تم حلها', 'Resolved')}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeProblem(p.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600"
                      title={tr(lang, 'حذف', 'Delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Diagnosis: Objective Findings vs Clinical Interpretation */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {tr(lang, 'صياغة التشخيص وملخص الحالة', 'Clinical Diagnosis & Case Summary')}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {tr(lang, 'فصل صريح بين النتائج المسجلة الموضوعية والتفسير السريري للطبيب', 'Explicit separation of objective recorded findings vs clinician interpretation')}
            </p>
          </div>
          {patient.diagnosis.approvedBy ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-800">
              <CheckCircle2 className="w-4 h-4" />
              <span>{tr(lang, 'معتمد من الطبيب:', 'Approved by:')} {patient.diagnosis.approvedBy}</span>
            </span>
          ) : (
            canApprove && (
              <button
                type="button"
                onClick={() =>
                  onChange(
                    {
                      ...patient,
                      diagnosis: { ...patient.diagnosis, approvedBy: actorName, approvedAt: new Date().toISOString() },
                    },
                    { ar: 'اعتماد التشخيص النهائي للحالة', en: 'Approved final clinical diagnosis' },
                  )
                }
                className="px-3.5 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-lg"
              >
                {tr(lang, 'اعتماد التشخيص النهائي', 'Approve Diagnosis')}
              </button>
            )
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-600">{tr(lang, 'التصنيف الهيكلي', 'Skeletal Class')}</label>
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                onChange({ ...patient, diagnosis: { ...patient.diagnosis, skeletalClass: e.target.value } });
              }}
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-slate-50 text-slate-700"
            >
              <option value="">{tr(lang, 'اختيار سريع للتصنيف الهيكلي...', 'Quick select Skeletal Class...')}</option>
              {SKELETAL_CLASS_PRESETS.map((opt) => {
                const v = lang === 'ar' ? opt.ar : opt.en;
                return (
                  <option key={v} value={v}>
                    {v}
                  </option>
                );
              })}
            </select>
            <input
              type="text"
              value={patient.diagnosis.skeletalClass}
              onChange={(e) => onChange({ ...patient, diagnosis: { ...patient.diagnosis, skeletalClass: e.target.value } })}
              placeholder={tr(lang, 'أو اكتب التصنيف الهيكلي...', 'Or type Skeletal Class...')}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-600">{tr(lang, 'التصنيف السني', 'Dental Class')}</label>
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                onChange({ ...patient, diagnosis: { ...patient.diagnosis, dentalClass: e.target.value } });
              }}
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-slate-50 text-slate-700"
            >
              <option value="">{tr(lang, 'اختيار سريع للتصنيف السني...', 'Quick select Dental Class...')}</option>
              {DENTAL_CLASS_PRESETS.map((opt) => {
                const v = lang === 'ar' ? opt.ar : opt.en;
                return (
                  <option key={v} value={v}>
                    {v}
                  </option>
                );
              })}
            </select>
            <input
              type="text"
              value={patient.diagnosis.dentalClass}
              onChange={(e) => onChange({ ...patient, diagnosis: { ...patient.diagnosis, dentalClass: e.target.value } })}
              placeholder={tr(lang, 'أو اكتب التصنيف السني...', 'Or type Dental Class...')}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-600">{tr(lang, 'النمط العمودي', 'Vertical Pattern')}</label>
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                onChange({ ...patient, diagnosis: { ...patient.diagnosis, verticalPattern: e.target.value } });
              }}
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-slate-50 text-slate-700"
            >
              <option value="">{tr(lang, 'اختيار سريع للنمط العمودي...', 'Quick select Vertical Pattern...')}</option>
              {VERTICAL_PATTERN_PRESETS.map((opt) => {
                const v = lang === 'ar' ? opt.ar : opt.en;
                return (
                  <option key={v} value={v}>
                    {v}
                  </option>
                );
              })}
            </select>
            <input
              type="text"
              value={patient.diagnosis.verticalPattern}
              onChange={(e) => onChange({ ...patient, diagnosis: { ...patient.diagnosis, verticalPattern: e.target.value } })}
              placeholder={tr(lang, 'أو اكتب النمط العمودي...', 'Or type Vertical Pattern...')}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {tr(lang, '1. النتائج المسجلة الموضوعية (Objective Findings)', '1. Objective Recorded Findings')}
            </label>
            <textarea
              rows={4}
              value={patient.diagnosis.objectiveFindingsSummary}
              onChange={(e) =>
                onChange({ ...patient, diagnosis: { ...patient.diagnosis, objectiveFindingsSummary: e.target.value } })
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {tr(lang, '2. التفسير السريري للطبيب (Clinical Interpretation)', '2. Clinician Clinical Interpretation')}
            </label>
            <textarea
              rows={4}
              value={patient.diagnosis.clinicalInterpretation}
              onChange={(e) =>
                onChange({ ...patient, diagnosis: { ...patient.diagnosis, clinicalInterpretation: e.target.value } })
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {tr(lang, 'ملاحظات البيانات الناقصة المطلوب استكمالها', 'Missing Data / Pending Verification Notes')}
          </label>
          <input
            type="text"
            value={patient.diagnosis.missingDataNotes}
            onChange={(e) => onChange({ ...patient, diagnosis: { ...patient.diagnosis, missingDataNotes: e.target.value } })}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>
      </div>
    </div>
  );
};
