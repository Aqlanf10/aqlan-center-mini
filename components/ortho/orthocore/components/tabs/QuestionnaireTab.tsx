"use client";
import React, { useRef, useState } from 'react';
import { Copy, Check, History, Plus, ExternalLink, Sparkles } from 'lucide-react';
import { Language, PatientCase, TriStateField, TriStateStatus, UserRole } from '../../types/ortho';
import { tr } from '../../i18n/translations';
import {
  CHIEF_COMPLAINT_PRESETS,
  CoreQuestionKey,
  EXPECTATIONS_PRESETS,
  QUESTIONNAIRE_QUICK_OPTIONS,
} from '../../data/clinicalQuickOptions';

interface QuestionnaireTabProps {
  patient: PatientCase;
  lang: Language;
  role: UserRole;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

const CORE_QUESTIONS: Array<{ key: CoreQuestionKey; ar: string; en: string }> = [
  { key: 'medicalHistory', ar: 'التاريخ الطبي والأمراض المزمنة', en: 'Medical History & Systemic Conditions' },
  { key: 'dentalHistory', ar: 'التاريخ السني والعلاجات السابقة', en: 'Dental History' },
  { key: 'medications', ar: 'الأدوية المستخدمة حالياً', en: 'Current Medications' },
  { key: 'allergies', ar: 'الحساسية (أدوية / لاتكس / معادن كالنيكل)', en: 'Allergies (Drugs / Latex / Nickel)' },
  { key: 'previousOrtho', ar: 'علاج تقويمي سابق', en: 'Previous Orthodontic Treatment' },
  { key: 'oralHabits', ar: 'العادات الفموية (تنفس فموي / دفع لسان / صرير)', en: 'Oral Habits (Mouth breathing / Tongue thrust / Bruxism)' },
  { key: 'functionalComplaints', ar: 'شكاوى المفصل الفكي والوظيفة (TMJ)', en: 'TMJ & Functional Complaints' },
];

const TRI_OPTIONS: Array<{ v: TriStateStatus; ar: string; en: string }> = [
  { v: 'recorded', ar: 'مسجل', en: 'Recorded' },
  { v: 'none', ar: 'لا يوجد', en: 'None' },
  { v: 'unknown', ar: 'غير معروف', en: 'Unknown' },
  { v: 'unrecorded', ar: 'غير مسجل', en: 'Unrecorded' },
];

export const QuestionnaireTab: React.FC<QuestionnaireTabProps> = ({ patient, lang, role, actorName, onChange }) => {
  const [copied, setCopied] = useState(false);
  const [newLabelAr, setNewLabelAr] = useState('');
  const [newLabelEn, setNewLabelEn] = useState('');
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const intakeUrl = `${window.location.origin}/?intake=${patient.intakeToken}`;

  const updateCore = (
    key: CoreQuestionKey,
    patch: Partial<TriStateField>,
  ) => {
    const prev = patient.questionnaire[key];
    const nextField = { ...prev, ...patch };
    const prevStr = `${prev.status}: ${prev.value}`;
    const nextStr = `${nextField.status}: ${nextField.value}`;
    const revisions =
      prevStr !== nextStr
        ? [
            {
              id: `rev-${Date.now()}`,
              timestamp: new Date().toISOString(),
              author: actorName,
              authorRole: role,
              source: 'clinic' as const,
              fieldKey: key,
              previousValue: prevStr,
              newValue: nextStr,
            },
            ...patient.questionnaire.revisions,
          ]
        : patient.questionnaire.revisions;

    onChange({
      ...patient,
      questionnaire: {
        ...patient.questionnaire,
        [key]: nextField,
        revisions,
      },
    });
  };

  const fillUnrecordedNegative = () => {
    const updatedQuestionnaire = { ...patient.questionnaire };
    let changed = false;

    for (const qItem of CORE_QUESTIONS) {
      const curr = updatedQuestionnaire[qItem.key];
      if (curr.status === 'unrecorded' || (!curr.value && curr.status === 'unknown')) {
        const negativeOpt = QUESTIONNAIRE_QUICK_OPTIONS[qItem.key].find((o) => o.status === 'none');
        updatedQuestionnaire[qItem.key] = {
          ...curr,
          status: 'none',
          value: negativeOpt ? (lang === 'ar' ? negativeOpt.valueAr : negativeOpt.valueEn) : '',
        };
        changed = true;
      }
    }

    if (!changed) return;
    onChange(
      { ...patient, questionnaire: updatedQuestionnaire },
      { ar: 'تعبئة سريعة للبنود غير المسجلة في الاستبيان (لا يوجد / سليم)', en: 'Quick-filled unrecorded questionnaire items as negative' },
    );
  };

  const addCustomQuestion = () => {
    if (!newLabelAr.trim() && !newLabelEn.trim()) return;
    onChange({
      ...patient,
      questionnaire: {
        ...patient.questionnaire,
        customFields: [
          ...patient.questionnaire.customFields,
          {
            id: `cf-${Date.now()}`,
            labelAr: newLabelAr.trim() || newLabelEn.trim(),
            labelEn: newLabelEn.trim() || newLabelAr.trim(),
            field: { status: 'unrecorded', value: '' },
          },
        ],
      },
    });
    setNewLabelAr('');
    setNewLabelEn('');
  };

  const matchedComplaintIdx = CHIEF_COMPLAINT_PRESETS.findIndex(
    (p) => p.ar === patient.chiefComplaintPatientWords || p.en === patient.chiefComplaintPatientWords,
  );
  const matchedExpIdx = EXPECTATIONS_PRESETS.findIndex(
    (p) => p.ar === patient.patientExpectations || p.en === patient.patientExpectations,
  );

  return (
    <div className="space-y-6">
      {/* Secure Pre-visit Link Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            {tr(lang, 'رابط الاستبيان الآمن للمريض قبل الزيارة', 'Secure Pre-Visit Patient Intake Link')}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5 font-mono truncate max-w-xl" dir="ltr">
            {intakeUrl}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(intakeUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-teal-700" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? tr(lang, 'تم النسخ', 'Copied') : tr(lang, 'نسخ الرابط', 'Copy Link')}</span>
          </button>
          <a
            href={intakeUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-teal-700 hover:bg-teal-800 text-white rounded-lg"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{tr(lang, 'فتح نموذج المريض', 'Open Form')}</span>
          </a>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {tr(lang, 'الاستبيان الطبي والسني ومقابلة المريض (تعبئة سريعة)', 'Medical & Dental Interview (Quick Select)')}
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {tr(lang, 'اختر من القائمة المنسدلة لكل بند للتسجيل الفوري أو عدّل النص يدوياً عند الحاجة.', 'Pick from each quick dropdown for 1-click entry, or edit text manually.')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={fillUnrecordedNegative}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 rounded-lg"
              >
                <Sparkles className="w-3.5 h-3.5 text-teal-700" />
                <span>{tr(lang, 'الباقي سليم / لا يوجد', 'Fill Remaining: None')}</span>
              </button>
              {role === 'doctor' && (
                <button
                  type="button"
                  onClick={() =>
                    onChange(
                      {
                        ...patient,
                        questionnaire: {
                          ...patient.questionnaire,
                          lastReviewedBy: actorName,
                          lastReviewedAt: new Date().toISOString(),
                        },
                      },
                      { ar: 'مراجعة واعتماد الاستبيان الطبي في المقابلة', en: 'Reviewed questionnaire in clinical interview' },
                    )
                  }
                  className="px-3 py-1.5 text-xs font-medium bg-teal-50 text-teal-800 border border-teal-200 hover:bg-teal-100 rounded-lg"
                >
                  {tr(lang, 'تأكيد مراجعة المقابلة', 'Mark Interview Reviewed')}
                </button>
              )}
            </div>
          </div>

          {patient.questionnaire.lastReviewedBy && (
            <p className="text-xs text-teal-800 font-mono tabular-nums">
              {tr(lang, 'آخر مراجعة في المقابلة:', 'Last reviewed:')} {patient.questionnaire.lastReviewedBy} ·{' '}
              {patient.questionnaire.lastReviewedAt?.slice(0, 10)}
            </p>
          )}

          {/* Fast Interview Chief Complaint & Expectations Bar */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-800">
                  {tr(lang, 'الشكوى الرئيسية (المقابلة)', 'Chief Complaint')}
                </label>
                <select
                  value={matchedComplaintIdx >= 0 ? String(matchedComplaintIdx) : ''}
                  onChange={(e) => {
                    const idx = e.target.value;
                    if (!idx) return;
                    const preset = CHIEF_COMPLAINT_PRESETS[Number(idx)];
                    if (preset) {
                      onChange({
                        ...patient,
                        chiefComplaintPatientWords: lang === 'ar' ? preset.ar : preset.en,
                      });
                    }
                  }}
                  className="max-w-[200px] px-2 py-1 text-[11px] bg-white border border-slate-300 rounded-md text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  <option value="">{tr(lang, '— اختر شكوى سريعة —', '— Quick Complaint —')}</option>
                  {CHIEF_COMPLAINT_PRESETS.map((p, idx) => (
                    <option key={idx} value={String(idx)}>
                      {lang === 'ar' ? p.ar : p.en}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                value={patient.chiefComplaintPatientWords}
                onChange={(e) => onChange({ ...patient, chiefComplaintPatientWords: e.target.value })}
                placeholder={tr(lang, 'سبب الزيارة بكلمات المريض...', 'Patient chief complaint...')}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-800">
                  {tr(lang, 'توقعات المريض', 'Patient Expectations')}
                </label>
                <select
                  value={matchedExpIdx >= 0 ? String(matchedExpIdx) : ''}
                  onChange={(e) => {
                    const idx = e.target.value;
                    if (!idx) return;
                    const preset = EXPECTATIONS_PRESETS[Number(idx)];
                    if (preset) {
                      onChange({
                        ...patient,
                        patientExpectations: lang === 'ar' ? preset.ar : preset.en,
                      });
                    }
                  }}
                  className="max-w-[200px] px-2 py-1 text-[11px] bg-white border border-slate-300 rounded-md text-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  <option value="">{tr(lang, '— اختر توقعاً سريعاً —', '— Quick Expectation —')}</option>
                  {EXPECTATIONS_PRESETS.map((p, idx) => (
                    <option key={idx} value={String(idx)}>
                      {lang === 'ar' ? p.ar : p.en}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                value={patient.patientExpectations}
                onChange={(e) => onChange({ ...patient, patientExpectations: e.target.value })}
                placeholder={tr(lang, 'توقعات المريض من العلاج...', 'Treatment expectations...')}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="space-y-3">
            {CORE_QUESTIONS.map((qItem) => {
              const entry = patient.questionnaire[qItem.key];
              const presets = QUESTIONNAIRE_QUICK_OPTIONS[qItem.key];
              const matchedIdx = presets.findIndex(
                (opt) => opt.valueAr === entry.value || opt.valueEn === entry.value,
              );
              const selectValue =
                matchedIdx >= 0
                  ? String(matchedIdx)
                  : entry.status === 'recorded' || entry.value
                  ? '__custom__'
                  : '';

              return (
                <div key={qItem.key} className="p-3.5 border border-slate-200 rounded-lg space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-800">{lang === 'ar' ? qItem.ar : qItem.en}</span>
                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                      {TRI_OPTIONS.map((opt) => (
                        <button
                          key={opt.v}
                          type="button"
                          onClick={() => updateCore(qItem.key, { status: opt.v })}
                          className={`px-2 py-1 text-[11px] rounded-md transition-colors whitespace-nowrap shrink-0 ${
                            entry.status === opt.v
                              ? opt.v === 'unrecorded'
                                ? 'bg-amber-100 text-amber-900 font-medium'
                                : opt.v === 'none'
                                ? 'bg-teal-700 text-white font-medium'
                                : 'bg-white text-slate-900 font-medium shadow-sm'
                              : 'text-slate-600'
                          }`}
                        >
                          {lang === 'ar' ? opt.ar : opt.en}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Quick Select Dropdown (always visible for 1-click interview entry) */}
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                    <div className={entry.status === 'recorded' || entry.value ? 'sm:col-span-5' : 'sm:col-span-12'}>
                      <select
                        value={selectValue}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (!val) {
                            updateCore(qItem.key, { status: 'unrecorded', value: '' });
                            return;
                          }
                          if (val === '__custom__') {
                            updateCore(qItem.key, { status: 'recorded' });
                            setTimeout(() => inputRefs.current[qItem.key]?.focus(), 30);
                            return;
                          }
                          const chosen = presets[Number(val)];
                          if (chosen) {
                            updateCore(qItem.key, {
                              status: chosen.status,
                              value: lang === 'ar' ? chosen.valueAr : chosen.valueEn,
                            });
                          }
                        }}
                        className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                      >
                        <option value="">{tr(lang, '— اختر إجابة سريعة —', '— Quick Select —')}</option>
                        {presets.map((opt, idx) => (
                          <option key={idx} value={String(idx)}>
                            {opt.status === 'none' ? '✓ ' : '• '}
                            {lang === 'ar' ? opt.valueAr : opt.valueEn}
                          </option>
                        ))}
                        <option value="__custom__">
                          {tr(lang, '✎ كتابة / تعديل مخصص...', '✎ Custom / Manual Entry...')}
                        </option>
                      </select>
                    </div>

                    {(entry.status === 'recorded' || entry.value) && (
                      <div className="sm:col-span-7">
                        <input
                          ref={(el) => {
                            inputRefs.current[qItem.key] = el;
                          }}
                          type="text"
                          value={entry.value}
                          onChange={(e) => updateCore(qItem.key, { value: e.target.value })}
                          placeholder={tr(lang, 'سجّل التفاصيل أو ملاحظة المقابلة...', 'Enter recorded details...')}
                          className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Custom Clinician Fields */}
            {patient.questionnaire.customFields.map((cf, idx) => (
              <div key={cf.id} className="p-3.5 border border-slate-200 rounded-lg space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">{lang === 'ar' ? cf.labelAr : cf.labelEn}</span>
                  <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                    {TRI_OPTIONS.map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => {
                          const next = [...patient.questionnaire.customFields];
                          next[idx] = { ...cf, field: { ...cf.field, status: opt.v } };
                          onChange({ ...patient, questionnaire: { ...patient.questionnaire, customFields: next } });
                        }}
                        className={`px-2 py-1 text-[11px] rounded-md ${
                          cf.field.status === opt.v ? 'bg-white text-slate-900 font-medium shadow-sm' : 'text-slate-600'
                        }`}
                      >
                        {lang === 'ar' ? opt.ar : opt.en}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="text"
                  value={cf.field.value}
                  onChange={(e) => {
                    const next = [...patient.questionnaire.customFields];
                    next[idx] = { ...cf, field: { ...cf.field, value: e.target.value, status: 'recorded' } };
                    onChange({ ...patient, questionnaire: { ...patient.questionnaire, customFields: next } });
                  }}
                  placeholder={tr(lang, 'إجابة السؤال المخصص...', 'Enter response...')}
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-slate-100 flex flex-wrap gap-2 items-center">
            <input
              type="text"
              value={newLabelAr}
              onChange={(e) => setNewLabelAr(e.target.value)}
              placeholder={tr(lang, 'إضافة سؤال مخصص للعيادة (عربي)...', 'Add custom question (Arabic)...')}
              className="flex-1 min-w-[180px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={newLabelEn}
              onChange={(e) => setNewLabelEn(e.target.value)}
              placeholder={tr(lang, 'الاسم بالإنجليزية (اختياري)', 'English label (optional)')}
              className="flex-1 min-w-[160px] px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <button
              type="button"
              onClick={addCustomQuestion}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{tr(lang, 'إضافة سؤال', 'Add Field')}</span>
            </button>
          </div>
        </div>

        {/* Revision History */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <History className="w-4 h-4 text-slate-600" />
            <span>{tr(lang, 'سجل تعديلات الإجابات', 'Answer Revision History')}</span>
          </div>
          {patient.questionnaire.revisions.length === 0 ? (
            <p className="text-xs text-slate-500">{tr(lang, 'لا توجد تعديلات مسجلة بعد.', 'No revisions logged yet.')}</p>
          ) : (
            <div className="space-y-3 max-h-[520px] overflow-y-auto">
              {patient.questionnaire.revisions.map((r) => (
                <div key={r.id} className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1">
                  <div className="flex items-center justify-between font-medium text-slate-900">
                    <span>{r.fieldKey}</span>
                    <span className="text-[11px] font-mono text-slate-500">{r.timestamp.slice(0, 10)}</span>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {r.author} · {r.source === 'pre_visit_link' ? tr(lang, 'رابط ما قبل الزيارة', 'Pre-visit Link') : tr(lang, 'داخل العيادة', 'Clinic')}
                  </p>
                  <p className="text-slate-600 line-through">{r.previousValue}</p>
                  <p className="text-teal-800 font-medium">{r.newValue}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
