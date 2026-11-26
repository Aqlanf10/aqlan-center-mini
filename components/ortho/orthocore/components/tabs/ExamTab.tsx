"use client";
import React, { useRef } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import { ClinicalExam, ExamField, ExamTriState, Language, PatientCase, UserRole } from '../../types/ortho';
import { tr } from '../../i18n/translations';
import { FdiToothChart } from '../FdiToothChart';
import {
  EXTRAORAL_DEFAULT_NORMAL,
  EXTRAORAL_NOTES_PRESETS,
  EXTRAORAL_QUICK_OPTIONS,
  ExtraoralKey,
  INTRAORAL_DEFAULT_NORMAL,
  INTRAORAL_NOTES_PRESETS,
  INTRAORAL_QUICK_OPTIONS,
  IntraoralKey,
  QuickExamOption,
} from '../../data/clinicalQuickOptions';

interface ExamTabProps {
  patient: PatientCase;
  lang: Language;
  role: UserRole;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

const EXAM_STATES: Array<{ v: ExamTriState; ar: string; en: string }> = [
  { v: 'normal', ar: 'طبيعي', en: 'Normal' },
  { v: 'finding', ar: 'نتيجة / ملاحظة', en: 'Finding' },
  { v: 'not_examined', ar: 'غير مفحوص', en: 'Not Examined' },
  { v: 'not_applicable', ar: 'غير منطبق', en: 'N/A' },
];

const EXTRAORAL_FIELDS: Array<{ key: ExtraoralKey; ar: string; en: string }> = [
  { key: 'symmetry', ar: 'تناسق الوجه', en: 'Facial Symmetry' },
  { key: 'facialProportions', ar: 'النسب الوجهية (الأثلاث)', en: 'Facial Proportions' },
  { key: 'profile', ar: 'البروفايل الجانبي', en: 'Profile' },
  { key: 'lipCompetence', ar: 'كفاءة ووضع الشفتين', en: 'Lip Competence & Posture' },
  { key: 'smileArc', ar: 'قوس الابتسامة', en: 'Smile Arc' },
  { key: 'gingivalDisplay', ar: 'ظهور الأسنان واللثة', en: 'Tooth & Gingival Display' },
  { key: 'tmjFunction', ar: 'المفصل الفكي والوظيفة', en: 'TMJ & Function' },
];

const INTRAORAL_FIELDS: Array<{ key: IntraoralKey; ar: string; en: string }> = [
  { key: 'dentitionStage', ar: 'مرحلة الإطباق والأسنان', en: 'Dentition Stage' },
  { key: 'gingivalHealth', ar: 'حالة اللثة والأنسجة الداعمة', en: 'Gingival & Periodontal Health' },
  { key: 'molarRelRight', ar: 'علاقة الأرحاء — يمين', en: 'Molar Relationship — Right' },
  { key: 'molarRelLeft', ar: 'علاقة الأرحاء — يسار', en: 'Molar Relationship — Left' },
  { key: 'canineRelRight', ar: 'علاقة الأنياب — يمين', en: 'Canine Relationship — Right' },
  { key: 'canineRelLeft', ar: 'علاقة الأنياب — يسار', en: 'Canine Relationship — Left' },
  { key: 'overjetMm', ar: 'البروز الأفقي (Overjet)', en: 'Overjet (mm)' },
  { key: 'overbiteMm', ar: 'التغطية العمودية (Overbite)', en: 'Overbite (mm / %)' },
  { key: 'midlineUpper', ar: 'الخط المتوسط العلوي', en: 'Upper Midline' },
  { key: 'midlineLower', ar: 'الخط المتوسط السفلي', en: 'Lower Midline' },
  { key: 'crowdingUpper', ar: 'الازدحام / الفراغات — علوي', en: 'Upper Crowding / Spacing' },
  { key: 'crowdingLower', ar: 'الازدحام / الفراغات — سفلي', en: 'Lower Crowding / Spacing' },
  { key: 'crossbite', ar: 'العضة المعكوسة (أمامية/خلفية)', en: 'Crossbite' },
  { key: 'openBite', ar: 'العضة المفتوحة', en: 'Open Bite' },
  { key: 'deepBite', ar: 'العضة العميقة وقوس سبي', en: 'Deep Bite & Curve of Spee' },
  { key: 'archFormUpper', ar: 'شكل القوس العلوي', en: 'Upper Arch Form' },
  { key: 'archFormLower', ar: 'شكل القوس السفلي', en: 'Lower Arch Form' },
];

export const ExamTab: React.FC<ExamTabProps> = ({ patient, lang, role, actorName, onChange }) => {
  const exam = patient.clinicalExam;
  const readOnly = role === 'reception';
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const updateExtraoral = (key: ExtraoralKey, patch: Partial<ExamField>) => {
    if (readOnly) return;
    const next: ClinicalExam = {
      ...exam,
      extraoral: {
        ...exam.extraoral,
        [key]: { ...exam.extraoral[key], ...patch },
      },
    };
    onChange({ ...patient, clinicalExam: next });
  };

  const updateIntraoral = (key: IntraoralKey, patch: Partial<ExamField>) => {
    if (readOnly) return;
    const next: ClinicalExam = {
      ...exam,
      intraoral: {
        ...exam.intraoral,
        [key]: { ...exam.intraoral[key], ...patch },
      },
    };
    onChange({ ...patient, clinicalExam: next });
  };

  const fillRemainingExtraoralNormal = () => {
    if (readOnly) return;
    const nextExtraoral = { ...exam.extraoral };
    let changed = false;
    for (const f of EXTRAORAL_FIELDS) {
      if (nextExtraoral[f.key].status === 'not_examined') {
        const def = EXTRAORAL_DEFAULT_NORMAL[f.key];
        nextExtraoral[f.key] = {
          ...nextExtraoral[f.key],
          status: 'normal',
          value: lang === 'ar' ? def.valueAr : def.valueEn,
        };
        changed = true;
      }
    }
    if (!changed) return;
    onChange(
      { ...patient, clinicalExam: { ...exam, extraoral: nextExtraoral } },
      { ar: 'تعيين البنود غير المفحوصة خارج الفم كـ طبيعي', en: 'Marked remaining extraoral fields as Normal' },
    );
  };

  const fillRemainingIntraoralNormal = () => {
    if (readOnly) return;
    const nextIntraoral = { ...exam.intraoral };
    let changed = false;
    for (const f of INTRAORAL_FIELDS) {
      if (nextIntraoral[f.key].status === 'not_examined') {
        const def = INTRAORAL_DEFAULT_NORMAL[f.key];
        nextIntraoral[f.key] = {
          ...nextIntraoral[f.key],
          status: 'normal',
          value: lang === 'ar' ? def.valueAr : def.valueEn,
        };
        changed = true;
      }
    }
    if (!changed) return;
    onChange(
      { ...patient, clinicalExam: { ...exam, intraoral: nextIntraoral } },
      { ar: 'تعيين البنود غير المفحوصة داخل الفم كـ طبيعي', en: 'Marked remaining intraoral fields as Normal' },
    );
  };

  const fillAllRemainingNormal = () => {
    if (readOnly) return;
    const nextExtraoral = { ...exam.extraoral };
    const nextIntraoral = { ...exam.intraoral };
    let changed = false;

    for (const f of EXTRAORAL_FIELDS) {
      if (nextExtraoral[f.key].status === 'not_examined') {
        const def = EXTRAORAL_DEFAULT_NORMAL[f.key];
        nextExtraoral[f.key] = { ...nextExtraoral[f.key], status: 'normal', value: lang === 'ar' ? def.valueAr : def.valueEn };
        changed = true;
      }
    }
    for (const f of INTRAORAL_FIELDS) {
      if (nextIntraoral[f.key].status === 'not_examined') {
        const def = INTRAORAL_DEFAULT_NORMAL[f.key];
        nextIntraoral[f.key] = { ...nextIntraoral[f.key], status: 'normal', value: lang === 'ar' ? def.valueAr : def.valueEn };
        changed = true;
      }
    }
    if (!changed) return;
    onChange(
      { ...patient, clinicalExam: { ...exam, extraoral: nextExtraoral, intraoral: nextIntraoral } },
      { ar: 'تعيين جميع بنود الفحص غير المفحوصة كـ طبيعي', en: 'Marked all unexamined clinical exam fields as Normal' },
    );
  };

  const renderFieldRow = (
    refKey: string,
    label: string,
    field: ExamField,
    presets: QuickExamOption[],
    onPatch: (patch: Partial<ExamField>) => void,
  ) => {
    const matchedIdx = presets.findIndex(
      (opt) => opt.valueAr === field.value || opt.valueEn === field.value,
    );
    const selectVal =
      matchedIdx >= 0
        ? String(matchedIdx)
        : field.status === 'normal' || field.status === 'finding'
        ? field.value
          ? '__custom__'
          : ''
        : '';

    return (
      <div className="p-3.5 border border-slate-200 rounded-lg space-y-2 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-800">{label}</span>
          <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg">
            {EXAM_STATES.map((st) => (
              <button
                key={st.v}
                type="button"
                disabled={readOnly}
                onClick={() => onPatch({ status: st.v })}
                className={`px-2 py-1 text-[11px] rounded-md whitespace-nowrap shrink-0 transition-colors ${
                  field.status === st.v
                    ? st.v === 'not_examined'
                      ? 'bg-amber-100 text-amber-900 font-medium'
                      : st.v === 'finding'
                      ? 'bg-teal-700 text-white font-medium'
                      : 'bg-white text-slate-900 font-medium shadow-sm'
                    : 'text-slate-600'
                }`}
              >
                {lang === 'ar' ? st.ar : st.en}
              </button>
            ))}
          </div>
        </div>

        {/* Always-visible quick dropdown + editable clinical detail */}
        <div className="space-y-1.5">
          <select
            disabled={readOnly}
            value={selectVal}
            onChange={(e) => {
              const val = e.target.value;
              if (!val) {
                onPatch({ status: 'not_examined', value: '' });
                return;
              }
              if (val === '__custom__') {
                onPatch({ status: 'finding' });
                setTimeout(() => inputRefs.current[refKey]?.focus(), 30);
                return;
              }
              const chosen = presets[Number(val)];
              if (chosen) {
                onPatch({
                  status: chosen.status,
                  value: lang === 'ar' ? chosen.valueAr : chosen.valueEn,
                });
              }
            }}
            className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:opacity-60"
          >
            <option value="">{tr(lang, '— اختر نتيجة سريعة —', '— Quick Finding Select —')}</option>
            {presets.map((opt, idx) => (
              <option key={idx} value={String(idx)}>
                {opt.status === 'normal' ? '✓ ' : opt.status === 'not_applicable' ? '— ' : '• '}
                {lang === 'ar' ? opt.valueAr : opt.valueEn}
              </option>
            ))}
            <option value="__custom__">
              {tr(lang, '✎ كتابة / تعديل مخصص (بالملم أو وصف)...', '✎ Custom / Manual Measurement...')}
            </option>
          </select>

          {field.status !== 'not_examined' && field.status !== 'not_applicable' && (
            <input
              ref={(el) => {
                inputRefs.current[refKey] = el;
              }}
              type="text"
              disabled={readOnly}
              value={field.value}
              onChange={(e) => onPatch({ value: e.target.value })}
              placeholder={tr(lang, 'تفاصيل إضافية أو قياس بالملم...', 'Additional detail or exact mm...')}
              className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-slate-600 font-mono tabular-nums">
          {tr(lang, 'تاريخ الفحص:', 'Exam Date:')} {exam.examDate} · {tr(lang, 'الفاحص:', 'Examiner:')} {exam.examiner}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && (
            <button
              type="button"
              onClick={fillAllRemainingNormal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 rounded-lg"
            >
              <Sparkles className="w-3.5 h-3.5 text-teal-700" />
              <span>{tr(lang, 'تعيين كل غير المفحوص: طبيعي', 'Fill All Unexamined: Normal')}</span>
            </button>
          )}
          {exam.approvedBy ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-800">
              <CheckCircle2 className="w-4 h-4" />
              <span>
                {tr(lang, 'معتمد سريرياً:', 'Clinically Approved:')} {exam.approvedBy}
              </span>
            </span>
          ) : (
            role === 'doctor' && (
              <button
                type="button"
                onClick={() =>
                  onChange(
                    {
                      ...patient,
                      clinicalExam: { ...exam, approvedBy: actorName, approvedAt: new Date().toISOString() },
                    },
                    { ar: 'اعتماد نتائج الفحص السريري ومخطط FDI', en: 'Approved Clinical Exam & FDI Chart' },
                  )
                }
                className="px-3.5 py-2 text-xs font-medium bg-teal-700 hover:bg-teal-800 text-white rounded-lg"
              >
                {tr(lang, 'اعتماد الفحص السريري', 'Approve Clinical Exam')}
              </button>
            )
          )}
        </div>
      </div>

      {/* Extraoral Exam */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">
            {tr(lang, 'أولاً: الفحص خارج الفم (Extraoral Examination)', '1. Extraoral Examination')}
          </h3>
          {!readOnly && (
            <button
              type="button"
              onClick={fillRemainingExtraoralNormal}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md"
            >
              <Sparkles className="w-3 h-3 text-teal-700" />
              <span>{tr(lang, 'الباقي طبيعي (خارج الفم)', 'Remaining Normal')}</span>
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {EXTRAORAL_FIELDS.map((f) => (
            <React.Fragment key={f.key}>
              {renderFieldRow(
                `extra-${f.key}`,
                lang === 'ar' ? f.ar : f.en,
                exam.extraoral[f.key],
                EXTRAORAL_QUICK_OPTIONS[f.key],
                (patch) => updateExtraoral(f.key, patch),
              )}
            </React.Fragment>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="block text-xs font-medium text-slate-700">
              {tr(lang, 'ملاحظات حرة — خارج الفم', 'Extraoral Free Notes')}
            </label>
            {!readOnly && (
              <select
                value=""
                onChange={(e) => {
                  const idx = e.target.value;
                  if (!idx) return;
                  const preset = EXTRAORAL_NOTES_PRESETS[Number(idx)];
                  if (!preset) return;
                  const text = lang === 'ar' ? preset.ar : preset.en;
                  const nextNotes = exam.extraoral.notes.trim() ? `${exam.extraoral.notes.trim()} · ${text}` : text;
                  onChange({ ...patient, clinicalExam: { ...exam, extraoral: { ...exam.extraoral, notes: nextNotes } } });
                }}
                className="px-2 py-1 text-[11px] bg-slate-50 border border-slate-300 rounded-md text-slate-700"
              >
                <option value="">{tr(lang, '+ إدراج ملاحظة سريعة...', '+ Insert quick note...')}</option>
                {EXTRAORAL_NOTES_PRESETS.map((p, idx) => (
                  <option key={idx} value={String(idx)}>
                    {lang === 'ar' ? p.ar : p.en}
                  </option>
                ))}
              </select>
            )}
          </div>
          <textarea
            rows={2}
            disabled={readOnly}
            value={exam.extraoral.notes}
            onChange={(e) =>
              onChange({ ...patient, clinicalExam: { ...exam, extraoral: { ...exam.extraoral, notes: e.target.value } } })
            }
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>
      </div>

      {/* Interactive FDI Chart */}
      <FdiToothChart
        chart={exam.fdiChart}
        lang={lang}
        readOnly={readOnly}
        onChange={(fdiChart) => onChange({ ...patient, clinicalExam: { ...exam, fdiChart } })}
      />

      {/* Intraoral Exam */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">
            {tr(lang, 'ثانياً: الفحص داخل الفم والإطباق (Intraoral Examination)', '2. Intraoral & Occlusal Examination')}
          </h3>
          {!readOnly && (
            <button
              type="button"
              onClick={fillRemainingIntraoralNormal}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md"
            >
              <Sparkles className="w-3 h-3 text-teal-700" />
              <span>{tr(lang, 'الباقي طبيعي (داخل الفم)', 'Remaining Normal')}</span>
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {INTRAORAL_FIELDS.map((f) => (
            <React.Fragment key={f.key}>
              {renderFieldRow(
                `intra-${f.key}`,
                lang === 'ar' ? f.ar : f.en,
                exam.intraoral[f.key],
                INTRAORAL_QUICK_OPTIONS[f.key],
                (patch) => updateIntraoral(f.key, patch),
              )}
            </React.Fragment>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="block text-xs font-medium text-slate-700">
              {tr(lang, 'ملاحظات حرة — داخل الفم', 'Intraoral Free Notes')}
            </label>
            {!readOnly && (
              <select
                value=""
                onChange={(e) => {
                  const idx = e.target.value;
                  if (!idx) return;
                  const preset = INTRAORAL_NOTES_PRESETS[Number(idx)];
                  if (!preset) return;
                  const text = lang === 'ar' ? preset.ar : preset.en;
                  const nextNotes = exam.intraoral.notes.trim() ? `${exam.intraoral.notes.trim()} · ${text}` : text;
                  onChange({ ...patient, clinicalExam: { ...exam, intraoral: { ...exam.intraoral, notes: nextNotes } } });
                }}
                className="px-2 py-1 text-[11px] bg-slate-50 border border-slate-300 rounded-md text-slate-700"
              >
                <option value="">{tr(lang, '+ إدراج ملاحظة سريعة...', '+ Insert quick note...')}</option>
                {INTRAORAL_NOTES_PRESETS.map((p, idx) => (
                  <option key={idx} value={String(idx)}>
                    {lang === 'ar' ? p.ar : p.en}
                  </option>
                ))}
              </select>
            )}
          </div>
          <textarea
            rows={2}
            disabled={readOnly}
            value={exam.intraoral.notes}
            onChange={(e) =>
              onChange({ ...patient, clinicalExam: { ...exam, intraoral: { ...exam.intraoral, notes: e.target.value } } })
            }
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>
      </div>
    </div>
  );
};
