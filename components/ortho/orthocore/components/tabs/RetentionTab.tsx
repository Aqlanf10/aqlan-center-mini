"use client";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import React, { useState } from 'react';
import { CalendarCheck, Plus, ShieldCheck } from 'lucide-react';
import { Language, PatientCase, RetentionRecord } from '../../types/ortho';
import { tr } from '../../i18n/translations';

interface RetentionTabProps {
  patient: PatientCase;
  lang: Language;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

export const RetentionTab: React.FC<RetentionTabProps> = ({ patient, lang, onChange }) => {
  const ret = patient.retention;
  const [intervalLabel, setIntervalLabel] = useState('متابعة 6 أشهر');
  const [dueDate, setDueDate] = useState(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [repairJaw, setRepairJaw] = useState<'upper' | 'lower' | 'both'>('lower');
  const [repairIssue, setRepairIssue] = useState('');
  const [repairAction, setRepairAction] = useState('');

  const updateRet = (patch: Partial<RetentionRecord>) => {
    onChange({ ...patient, retention: { ...ret, ...patch } });
  };

  const addFollowUp = () => {
    if (!intervalLabel.trim() || !dueDate) return;
    updateRet({
      followUpSchedule: [
        ...ret.followUpSchedule,
        {
          id: `rf-${Date.now()}`,
          intervalLabel: intervalLabel.trim(),
          dueDate,
          status: 'scheduled',
          notes: '',
        },
      ],
    });
  };

  const addRepair = () => {
    if (!repairIssue.trim()) return;
    updateRet({
      repairsAndReplacements: [
        {
          id: `rep-${Date.now()}`,
          date: clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
          jaw: repairJaw,
          issue: repairIssue.trim(),
          actionTaken: repairAction.trim(),
        },
        ...ret.repairsAndReplacements,
      ],
    });
    setRepairIssue('');
    setRepairAction('');
  };

  return (
    <div className="space-y-6">
      {/* Final Evaluation & Debond */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ShieldCheck className="w-4 h-4 text-teal-700" />
          <span>{tr(lang, 'إنهاء العلاج ومقارنة النتائج بالأهداف الأولية', 'Finishing Evaluation & Debonding')}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {tr(lang, 'تاريخ إزالة الأجهزة (Debond)', 'Debond / Appliance Removal Date')}
            </label>
            <input
              type="date"
              value={ret.debondDate}
              onChange={(e) => updateRet({ debondDate: e.target.value })}
              className="w-full px-3 py-2 text-xs font-mono tabular-nums border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {tr(lang, 'تاريخ تسليم المثبتات', 'Retainer Delivery Date')}
            </label>
            <input
              type="date"
              value={ret.deliveryDate}
              onChange={(e) => updateRet({ deliveryDate: e.target.value })}
              className="w-full px-3 py-2 text-xs font-mono tabular-nums border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {tr(lang, 'تقييم تعاون المريض في التثبيت', 'Retention Cooperation')}
            </label>
            <input
              type="text"
              value={ret.cooperation}
              onChange={(e) => updateRet({ cooperation: e.target.value })}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            {tr(lang, 'التقييم النهائي مقارنةً بالأهداف الأولية', 'Final Outcome vs Initial Treatment Goals')}
          </label>
          <textarea
            rows={3}
            value={ret.finalOutcomeVsGoals}
            onChange={(e) => updateRet({ finalOutcomeVsGoals: e.target.value })}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        {/* Goals Outcome Quick Summary */}
        {patient.treatmentPlan.goals.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-700 mb-2">
              {tr(lang, 'حالة تحقيق أهداف الخطة الأولية:', 'Initial Treatment Goals Realization:')}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {patient.treatmentPlan.goals.map((g) => (
                <div key={g.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                  <p className="font-medium text-slate-900">{g.title}</p>
                  <p className="text-[11px] text-teal-800 mt-0.5">{g.outcomeStatus}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Retainer Protocol */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-900">
            {tr(lang, 'وصفة المثبتات وتعليمات الاستخدام', 'Retainer Prescription & Wear Protocol')}
          </h3>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'المثبت العلوي (Upper Arch)', 'Upper Retainer')}</label>
            <input
              type="text"
              value={ret.upperRetainerType}
              onChange={(e) => updateRet({ upperRetainerType: e.target.value })}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'المثبت السفلي (Lower Arch)', 'Lower Retainer')}</label>
            <input
              type="text"
              value={ret.lowerRetainerType}
              onChange={(e) => updateRet({ lowerRetainerType: e.target.value })}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'تعليمات الارتداء والعناية', 'Wear & Hygiene Protocol')}</label>
            <textarea
              rows={2}
              value={ret.wearProtocol}
              onChange={(e) => updateRet({ wearProtocol: e.target.value })}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{tr(lang, 'أي تغيرات أو انتكاس لاحق', 'Post-Treatment Changes / Relapse Notes')}</label>
            <textarea
              rows={2}
              value={ret.postTreatmentChanges}
              onChange={(e) => updateRet({ postTreatmentChanges: e.target.value })}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        {/* Follow-up Schedule & Repairs */}
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CalendarCheck className="w-4 h-4 text-teal-700" />
              <span>{tr(lang, 'جدول متابعات التثبيت', 'Retention Follow-Up Schedule')}</span>
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={intervalLabel}
                onChange={(e) => setIntervalLabel(e.target.value)}
                className="flex-1 min-w-[140px] px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg"
              />
              <button
                type="button"
                onClick={addFollowUp}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-teal-700 text-white text-xs rounded-lg"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{tr(lang, 'إضافة', 'Add')}</span>
              </button>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto">
              {ret.followUpSchedule.map((f) => (
                <div key={f.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between gap-2 text-xs">
                  <div>
                    <span className="font-semibold text-slate-900">{f.intervalLabel}</span>
                    <span className="mx-1.5 text-slate-300">·</span>
                    <span className="font-mono tabular-nums text-slate-600">{f.dueDate}</span>
                    {f.notes && <p className="text-[11px] text-slate-500 mt-0.5">{f.notes}</p>}
                  </div>
                  <select
                    value={f.status}
                    onChange={(e) => {
                      const next = ret.followUpSchedule.map((x) =>
                        x.id === f.id
                          ? {
                              ...x,
                              status: e.target.value as 'scheduled' | 'completed' | 'missed',
                              completedDate: e.target.value === 'completed' ? clinicDateString(new Date(), CLINIC_ZONE_FALLBACK) : x.completedDate,
                            }
                          : x,
                      );
                      updateRet({ followUpSchedule: next });
                    }}
                    className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                  >
                    <option value="scheduled">{tr(lang, 'مجدول', 'Scheduled')}</option>
                    <option value="completed">{tr(lang, 'مكتمل', 'Completed')}</option>
                    <option value="missed">{tr(lang, 'فائت', 'Missed')}</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* Repairs & Replacements */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <h4 className="text-sm font-semibold text-slate-900">
              {tr(lang, 'إصلاحات واستبدالات المثبتات', 'Retainer Repairs & Replacements')}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <select
                value={repairJaw}
                onChange={(e) => setRepairJaw(e.target.value as 'upper' | 'lower' | 'both')}
                className="px-2 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="upper">{tr(lang, 'علوي', 'Upper')}</option>
                <option value="lower">{tr(lang, 'سفلي', 'Lower')}</option>
                <option value="both">{tr(lang, 'كلاهما', 'Both')}</option>
              </select>
              <input
                type="text"
                value={repairIssue}
                onChange={(e) => setRepairIssue(e.target.value)}
                placeholder={tr(lang, 'المشكلة (فك لاصق / كسر)...', 'Issue...')}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={repairAction}
                  onChange={(e) => setRepairAction(e.target.value)}
                  placeholder={tr(lang, 'الإجراء...', 'Action...')}
                  className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
                <button
                  type="button"
                  onClick={addRepair}
                  className="px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg"
                >
                  +
                </button>
              </div>
            </div>
            {ret.repairsAndReplacements.map((r) => (
              <div key={r.id} className="text-xs p-2 bg-slate-50 border border-slate-200 rounded flex justify-between">
                <span>
                  <strong className="font-mono">{r.date}</strong> ({r.jaw}) — {r.issue} → {r.actionTaken}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
