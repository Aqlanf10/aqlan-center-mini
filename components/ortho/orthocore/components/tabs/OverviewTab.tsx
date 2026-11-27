"use client";
import React from 'react';
import { CheckCircle2, Clock, FileSignature } from 'lucide-react';
import { CaseStage, Language, PatientCase, UserRole } from '../../types/ortho';
import { STAGE_LABELS, tr } from '../../i18n/translations';
import {
  CHIEF_COMPLAINT_PRESETS,
  EXPECTATIONS_PRESETS,
  REFERRAL_PRESETS,
} from '../../data/clinicalQuickOptions';

interface OverviewTabProps {
  patient: PatientCase;
  lang: Language;
  role: UserRole;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ patient, lang, role, onChange }) => {
  const canEditConsents = role === 'doctor' || role === 'admin' || role === 'reception';
  const stages = Object.keys(STAGE_LABELS) as CaseStage[];

  const updateField = <K extends keyof PatientCase>(key: K, val: PatientCase[K]) => {
    onChange({ ...patient, [key]: val });
  };

  const ageYears = patient.dateOfBirth
    ? Math.max(0, Math.floor((Date.now() - new Date(patient.dateOfBirth).getTime()) / (365.25 * 24 * 3600 * 1000)))
    : null;
  const isMinor = ageYears !== null && ageYears < 18;

  return (
    <div className="space-y-6">
      {/* Stage & Chief Complaint */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-900">
            {tr(lang, 'البيانات الشخصية وبيانات الحالة', 'Patient Demographics & Case File')}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'رقم الحالة', 'Case Number')}</label>
              <input
                type="text"
                value={patient.caseNumber}
                onChange={(e) => updateField('caseNumber', e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'المرحلة الحالية', 'Current Stage')}</label>
              <select
                value={patient.stage}
                disabled={role === 'reception'}
                onChange={(e) =>
                  onChange(
                    { ...patient, stage: e.target.value as CaseStage },
                    {
                      ar: `تغيير مرحلة الحالة إلى ${STAGE_LABELS[e.target.value as CaseStage].ar}`,
                      en: `Changed stage to ${STAGE_LABELS[e.target.value as CaseStage].en}`,
                    },
                  )
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {stages.map((st) => (
                  <option key={st} value={st}>
                    {lang === 'ar' ? STAGE_LABELS[st].ar : STAGE_LABELS[st].en}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'الاسم الكامل (عربي)', 'Full Name (Arabic)')}</label>
              <input
                type="text"
                value={patient.fullName}
                onChange={(e) => updateField('fullName', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'الاسم الكامل (إنجليزي)', 'Full Name (English)')}</label>
              <input
                type="text"
                value={patient.fullNameEn}
                onChange={(e) => updateField('fullNameEn', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'تاريخ الميلاد', 'Date of Birth')}</label>
              <input
                type="date"
                value={patient.dateOfBirth}
                onChange={(e) => updateField('dateOfBirth', e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'الجنس', 'Gender')}</label>
              <select
                value={patient.gender}
                onChange={(e) => updateField('gender', e.target.value as 'female' | 'male')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="female">{tr(lang, 'أنثى', 'Female')}</option>
                <option value="male">{tr(lang, 'ذكر', 'Male')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'رقم الجوال', 'Phone')}</label>
              <input
                type="text"
                value={patient.phone}
                onChange={(e) => updateField('phone', e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'البريد الإلكتروني', 'Email')}</label>
              <input
                type="email"
                value={patient.email}
                onChange={(e) => updateField('email', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="block text-xs font-medium text-slate-600">{tr(lang, 'مصدر الإحالة', 'Referral Source')}</label>
                <select
                  value=""
                  onChange={(e) => {
                    const idx = e.target.value;
                    if (!idx) return;
                    const preset = REFERRAL_PRESETS[Number(idx)];
                    if (preset) updateField('referralSource', lang === 'ar' ? preset.ar : preset.en);
                  }}
                  className="px-2 py-0.5 text-[11px] bg-slate-50 border border-slate-300 rounded text-slate-700"
                >
                  <option value="">{tr(lang, '— اختيار سريع —', '— Quick Pick —')}</option>
                  {REFERRAL_PRESETS.map((p, idx) => (
                    <option key={idx} value={String(idx)}>
                      {lang === 'ar' ? p.ar : p.en}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                value={patient.referralSource}
                onChange={(e) => updateField('referralSource', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'الموعد القادم', 'Next Appointment')}</label>
              <input
                type="date"
                value={patient.nextAppointmentDate}
                onChange={(e) => updateField('nextAppointmentDate', e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {(isMinor || patient.guardianName) && (
            <div className="pt-4 border-t border-slate-100 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'اسم ولي الأمر', 'Guardian Name')}</label>
                <input
                  type="text"
                  value={patient.guardianName}
                  onChange={(e) => updateField('guardianName', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'جوال ولي الأمر', 'Guardian Phone')}</label>
                <input
                  type="text"
                  value={patient.guardianPhone}
                  onChange={(e) => updateField('guardianPhone', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'صلة القرابة', 'Relation')}</label>
                <input
                  type="text"
                  value={patient.guardianRelation}
                  onChange={(e) => updateField('guardianRelation', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-slate-100 space-y-3">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <label className="block text-xs font-semibold text-slate-700">
                  {tr(lang, 'الشكوى الرئيسية بكلمات المريض', 'Chief Complaint (Patient’s Own Words)')}
                </label>
                <select
                  value=""
                  onChange={(e) => {
                    const idx = e.target.value;
                    if (!idx) return;
                    const preset = CHIEF_COMPLAINT_PRESETS[Number(idx)];
                    if (preset) updateField('chiefComplaintPatientWords', lang === 'ar' ? preset.ar : preset.en);
                  }}
                  className="px-2.5 py-1 text-[11px] bg-slate-50 border border-slate-300 rounded-md text-slate-700"
                >
                  <option value="">{tr(lang, '— اختر شكوى شائعة —', '— Quick Complaint —')}</option>
                  {CHIEF_COMPLAINT_PRESETS.map((p, idx) => (
                    <option key={idx} value={String(idx)}>
                      {lang === 'ar' ? p.ar : p.en}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                rows={2}
                value={patient.chiefComplaintPatientWords}
                onChange={(e) => updateField('chiefComplaintPatientWords', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <label className="block text-xs font-semibold text-slate-700">
                  {tr(lang, 'توقعات المريض من العلاج', 'Patient Treatment Expectations')}
                </label>
                <select
                  value=""
                  onChange={(e) => {
                    const idx = e.target.value;
                    if (!idx) return;
                    const preset = EXPECTATIONS_PRESETS[Number(idx)];
                    if (preset) updateField('patientExpectations', lang === 'ar' ? preset.ar : preset.en);
                  }}
                  className="px-2.5 py-1 text-[11px] bg-slate-50 border border-slate-300 rounded-md text-slate-700"
                >
                  <option value="">{tr(lang, '— اختر توقعاً شائعاً —', '— Quick Expectation —')}</option>
                  {EXPECTATIONS_PRESETS.map((p, idx) => (
                    <option key={idx} value={String(idx)}>
                      {lang === 'ar' ? p.ar : p.en}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                rows={2}
                value={patient.patientExpectations}
                onChange={(e) => updateField('patientExpectations', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>
        </div>

        {/* Consents & Governance */}
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <FileSignature className="w-4 h-4 text-teal-700" />
              <span>{tr(lang, 'الموافقات والخصوصية', 'Consents & Privacy')}</span>
            </div>
            {[
              { k: 'treatmentConsent', ar: 'الموافقة المستنيرة على العلاج', en: 'Informed Treatment Consent' },
              { k: 'photoClinicalConsent', ar: 'استخدام الصور والأشعة للتشخيص والمتابعة', en: 'Clinical Photography & Radiographs' },
              { k: 'photoEducationalConsent', ar: 'استخدام الصور مجهولة الهوية للتعليم/العرض', en: 'Anonymized Educational Case Use' },
              { k: 'shareConsent', ar: 'مشاركة الملف مع أطباء محال إليهم', en: 'External Specialist Sharing' },
              { k: 'externalAiConsent', ar: 'موافقة المعالجة بالمساعد الذكي (ببيانات مجهولة)', en: 'External AI Draft Assistance (Anonymized)' },
            ].map((item) => {
              const key = item.k as keyof typeof patient.consents;
              const checked = Boolean(patient.consents[key]);
              return (
                <label key={item.k} className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!canEditConsents}
                    checked={checked}
                    onChange={(e) =>
                      onChange({
                        ...patient,
                        consents: {
                          ...patient.consents,
                          [key]: e.target.checked,
                          signedAt: new Date().toISOString(),
                        },
                      })
                    }
                    className="mt-0.5 accent-teal-700"
                  />
                  <span>{lang === 'ar' ? item.ar : item.en}</span>
                </label>
              );
            })}
            {patient.consents.signedAt && (
              <div className="pt-2 border-t border-slate-100 flex items-center gap-1.5 text-[11px] text-teal-800">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono tabular-nums">
                  {tr(lang, 'آخر توثيق موافقة:', 'Signed:')} {patient.consents.signedAt.slice(0, 10)}
                </span>
              </div>
            )}
          </div>

          {/* Unified Chronological Timeline */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Clock className="w-4 h-4 text-slate-600" />
              <span>{tr(lang, 'الخط الزمني للزيارات والتغييرات', 'Unified Case Timeline')}</span>
            </div>
            <div className="space-y-3 max-h-80 overflow-y-auto pe-1">
              {patient.timeline.map((ev) => (
                <div key={ev.id} className="pb-2.5 border-b border-slate-100 last:border-0 text-xs">
                  <p className="font-medium text-slate-900">{lang === 'ar' ? ev.summaryAr : ev.summaryEn}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                    {ev.actor} · {ev.timestamp.slice(0, 16).replace('T', ' ')}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
