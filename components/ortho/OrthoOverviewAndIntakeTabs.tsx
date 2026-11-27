"use client";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

import React, { useState } from "react";
import {
  DECIDUOUS_FDI_TEETH,
  PERMANENT_FDI_TEETH,
  computeOrthoWorkspaceCompleteness,
  type AngleClass,
  type DentitionStage,
  type FdiToothRecord,
  type OrthoWorkspaceRecord,
  type OrthoWorkspaceTabId,
  type ToothStatus,
} from "@/lib/ortho-workspace-types";

const ANGLE_OPTIONS: Array<{ value: AngleClass; label: string }> = [
  { value: "", label: "— غير محدد —" },
  { value: "Class I", label: "Class I" },
  { value: "Class II div 1", label: "Class II Div 1" },
  { value: "Class II div 2", label: "Class II Div 2" },
  { value: "Class III", label: "Class III" },
];

const TOOTH_STATUS_META: Record<ToothStatus, { labelAr: string; cls: string }> = {
  present: { labelAr: "موجود", cls: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  missing: { labelAr: "مفقود", cls: "border-red-300 bg-red-50 text-red-900" },
  impacted: { labelAr: "مطموُر", cls: "border-amber-300 bg-amber-50 text-amber-900" },
  unerupted: { labelAr: "غير بازغ", cls: "border-sky-300 bg-sky-50 text-sky-900" },
  extracted: { labelAr: "مخلوع", cls: "border-slate-300 bg-slate-200 text-slate-700" },
  deciduous_retained: { labelAr: "لبني باقٍ", cls: "border-purple-300 bg-purple-50 text-purple-900" },
};

function parseNullableNum(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function OrthoOverviewTab({
  record,
  patientName,
  patientCode,
  canEdit,
  canOpenSessions = true,
  onNavigateTab,
}: {
  record: OrthoWorkspaceRecord;
  patientName: string;
  patientCode: string;
  canEdit: boolean;
  canOpenSessions?: boolean;
  onNavigateTab: (tab: OrthoWorkspaceTabId) => void;
}) {
  const completeness = computeOrthoWorkspaceCompleteness(record);
  const measuredTeethCount = Object.values(record.clinicalExam.teeth).filter(
    (t) => typeof t.widthMm === "number" && t.widthMm > 0,
  ).length;
  const approvedProblems = record.problems.filter((p) => p.approved);

  return (
    <div className="space-y-4">
      {/* KPI Summary Strip — OrthoCore Design */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-bold text-slate-500">اكتمال الملف التقويمي</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-extrabold text-navy-900">{completeness.percent}%</span>
            <span className="text-xs text-slate-500">
              {completeness.completedCount}/{completeness.totalCount} أقسام
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-navy-800 transition-all"
              style={{ width: `${completeness.percent}%` }}
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-bold text-slate-500">مرحلة الأسنان والقياسات</p>
          <p className="mt-1 text-base font-extrabold text-slate-900">
            {record.clinicalExam.dentitionStage === "permanent"
              ? "دائمة (Permanent)"
              : record.clinicalExam.dentitionStage === "mixed"
                ? "مختلطة (Mixed)"
                : "لبنية (Deciduous)"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            الأسنان المقاسة (FDI): <strong className="text-navy-800">{measuredTeethCount}</strong>
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-bold text-slate-500">التحليلات والمشكلات المعتمدة</p>
          <p className="mt-1 text-base font-extrabold text-slate-900">
            {record.approvedAnalyses.length} تحليل · {approvedProblems.length} مشكلة
          </p>
          <p className="mt-1 text-xs text-slate-500">
            التشخيص:{" "}
            {record.diagnosisSummary.approvedAt ? (
              <span className="font-bold text-emerald-700">معتمد ✓</span>
            ) : (
              <span className="text-amber-700">بانتظار الاعتماد</span>
            )}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-[11px] font-bold text-slate-500">خطة العلاج والتثبيت</p>
          <p className="mt-1 text-base font-extrabold text-slate-900">
            {record.treatmentPlan.approvedAt ? "خطة معتمدة ✓" : "مسودة خطة"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            جلسات التثبيت المسجّلة: <strong>{record.retention.followups.length}</strong>
          </p>
        </div>
      </div>

      {/* Patient Clinical Snapshot + Quick Navigation */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <div>
              <h3 className="text-sm font-extrabold text-navy-900">ملخص الحالة السريرية</h3>
              <p className="text-[11px] text-slate-500">
                {patientName} {patientCode ? `· ملف رقم ${patientCode}` : ""}
              </p>
            </div>
            {canOpenSessions ? (
              <button
                type="button"
                onClick={() => onNavigateTab("sessions")}
                className="rounded-lg bg-navy-800 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-navy-900"
              >
                الانتقال إلى الشدّات اليومية ←
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <p className="font-bold text-slate-500">الشكوى الرئيسية</p>
              <p className="mt-1 text-slate-900">
                {record.questionnaire.chiefComplaint.trim() || "لم تُسجَّل بعد في تبويب الاستبيان."}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <p className="font-bold text-slate-500">التشخيص النهائي المعتمد</p>
              <p className="mt-1 text-slate-900">
                {record.diagnosisSummary.finalDiagnosisAr.trim() || "لم يُعتمد التشخيص بعد في تبويب المشكلات والتشخيص."}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <p className="font-bold text-slate-500">التنبيهات الطبية والحساسية</p>
              <p className="mt-1 text-slate-900">
                {record.questionnaire.medicalAlertsSummary.trim() || record.questionnaire.allergies.trim() || "لا توجد تنبيهات مدوّنة."}
              </p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <p className="font-bold text-slate-500">ملخص الميكانيكا والخطة</p>
              <p className="mt-1 text-slate-900">
                {record.treatmentPlan.mechanicsSummary.trim() || "لم تُوثَّق الميكانيكا بعد في تبويب خطة العلاج."}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h3 className="text-sm font-extrabold text-navy-900">النواقص السريرية المقترحة</h3>
          {completeness.missingAr.length === 0 ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-800">
              جميع أقسام السجل التقويمي مكتملة وجاهزة للتقارير وعرض الحالة.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {completeness.missingAr.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-1.5 text-amber-900"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
          {!canEdit ? (
            <p className="text-[11px] text-slate-500">وضع العرض فقط وفق صلاحيات الخصوصية الحالية.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function OrthoQuestionnaireTab({
  record,
  canEdit,
  onChange,
}: {
  record: OrthoWorkspaceRecord;
  canEdit: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
}) {
  const q = record.questionnaire;
  const updateQ = (patch: Partial<typeof q>) =>
    onChange({ ...record, questionnaire: { ...q, ...patch } });

  const habitsList: Array<{ key: keyof typeof q.habits; label: string }> = [
    { key: "thumbSucking", label: "مصّ الإبهام / الأصابع" },
    { key: "mouthBreathing", label: "التنفس الفموي" },
    { key: "tongueThrust", label: "دفع اللسان (Tongue Thrust)" },
    { key: "bruxism", label: "صرير الأسنان (Bruxism)" },
    { key: "nailBiting", label: "قضم الأظافر" },
  ];

  const tmjList: Array<{ key: keyof typeof q.tmjSymptoms; label: string }> = [
    { key: "clicking", label: "طقطقة المفصل (Clicking)" },
    { key: "pain", label: "ألم المفصل الفكي الصدغي" },
    { key: "limitedOpening", label: "تحدّد فتح الفم" },
    { key: "deviation", label: "انحراف الفك عند الفتح" },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
        <h3 className="text-sm font-extrabold text-navy-900">الاستبيان والشكوى الرئيسية</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span className="font-bold text-slate-700">الشكوى الرئيسية (Chief Complaint)</span>
            <textarea
              rows={3}
              disabled={!canEdit}
              value={q.chiefComplaint}
              onChange={(e) => updateQ({ chiefComplaint: e.target.value })}
              placeholder="مثال: بروز الأسنان الأمامية العلوية وازدحام في القوس السفلي..."
              className="w-full rounded-lg border border-slate-300 p-2 text-xs disabled:bg-slate-50"
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="font-bold text-slate-700">توقعات المريض / ولي الأمر</span>
            <textarea
              rows={3}
              disabled={!canEdit}
              value={q.patientExpectations}
              onChange={(e) => updateQ({ patientExpectations: e.target.value })}
              placeholder="الأهداف الجمالية والوظيفية التي يطمح إليها المريض..."
              className="w-full rounded-lg border border-slate-300 p-2 text-xs disabled:bg-slate-50"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="block space-y-1 text-xs">
            <span className="font-bold text-slate-700">حالة النمو (Growth Status)</span>
            <select
              disabled={!canEdit}
              value={q.growthStatus}
              onChange={(e) => updateQ({ growthStatus: e.target.value as typeof q.growthStatus })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2 text-xs disabled:bg-slate-50"
            >
              <option value="">— غير محدد —</option>
              <option value="pre_pubertal">قبل البلوغ (Pre-pubertal)</option>
              <option value="peak_growth">ذروة النمو (CS3–CS4 Peak)</option>
              <option value="post_pubertal">بعد ذروة النمو (Post-pubertal)</option>
              <option value="adult">بالغ (Adult / Growth Complete)</option>
            </select>
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-bold text-slate-700">الحساسية (Allergies)</span>
            <input
              type="text"
              disabled={!canEdit}
              value={q.allergies}
              onChange={(e) => updateQ({ allergies: e.target.value })}
              placeholder="مثال: النيكل، اللاتكس، الأدوية..."
              className="w-full rounded-lg border border-slate-300 p-2 text-xs disabled:bg-slate-50"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-bold text-slate-700">الأدوية المزمنة</span>
            <input
              type="text"
              disabled={!canEdit}
              value={q.medications}
              onChange={(e) => updateQ({ medications: e.target.value })}
              placeholder="مضادات الالتهاب، البيسفوسفونات، إلخ..."
              className="w-full rounded-lg border border-slate-300 p-2 text-xs disabled:bg-slate-50"
            />
          </label>
        </div>

        <label className="block space-y-1 text-xs">
          <span className="font-bold text-slate-700">ملخص التاريخ الطبي والتنبيهات</span>
          <textarea
            rows={2}
            disabled={!canEdit}
            value={q.medicalAlertsSummary}
            onChange={(e) => updateQ({ medicalAlertsSummary: e.target.value })}
            className="w-full rounded-lg border border-slate-300 p-2 text-xs disabled:bg-slate-50"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h4 className="text-xs font-extrabold text-navy-900">العادات الفموية (Oral Habits)</h4>
          <div className="flex flex-wrap gap-2">
            {habitsList.map((h) => {
              const checked = Boolean(q.habits[h.key]);
              return (
                <label
                  key={h.key}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                    checked ? "border-amber-400 bg-amber-50 font-bold text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={checked}
                    onChange={(e) =>
                      updateQ({ habits: { ...q.habits, [h.key]: e.target.checked } })
                    }
                  />
                  {h.label}
                </label>
              );
            })}
          </div>
          <input
            type="text"
            disabled={!canEdit}
            value={q.habits.other}
            onChange={(e) => updateQ({ habits: { ...q.habits, other: e.target.value } })}
            placeholder="عادات أخرى..."
            className="w-full rounded-lg border border-slate-300 p-2 text-xs disabled:bg-slate-50"
          />
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h4 className="text-xs font-extrabold text-navy-900">المفصل الفكي الصدغي (TMJ)</h4>
          <div className="flex flex-wrap gap-2">
            {tmjList.map((t) => {
              const checked = Boolean(q.tmjSymptoms[t.key]);
              return (
                <label
                  key={t.key}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                    checked ? "border-red-300 bg-red-50 font-bold text-red-900" : "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={checked}
                    onChange={(e) =>
                      updateQ({ tmjSymptoms: { ...q.tmjSymptoms, [t.key]: e.target.checked } })
                    }
                  />
                  {t.label}
                </label>
              );
            })}
          </div>
          <input
            type="text"
            disabled={!canEdit}
            value={q.tmjSymptoms.notes}
            onChange={(e) => updateQ({ tmjSymptoms: { ...q.tmjSymptoms, notes: e.target.value } })}
            placeholder="ملاحظات المفصل ومدى فتح الفم..."
            className="w-full rounded-lg border border-slate-300 p-2 text-xs disabled:bg-slate-50"
          />
        </div>
      </div>

      {/* Educational de-identified consent */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-800">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={q.consentForEducationDeidentified}
            onChange={(e) =>
              updateQ({
                consentForEducationDeidentified: e.target.checked,
                consentSignedOn: e.target.checked ? clinicDateString(new Date(), CLINIC_ZONE_FALLBACK) : null,
              })
            }
          />
          موافقة المريض الخطية على استخدام السجلات مُخفاة الهوية في العروض التعليمية (Case Presentation)
        </label>
        {q.consentSignedOn ? (
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800">
            تاريخ الموافقة: {q.consentSignedOn}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function OrthoExamTab({
  record,
  canEdit,
  onChange,
}: {
  record: OrthoWorkspaceRecord;
  canEdit: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
}) {
  const exam = record.clinicalExam;
  const [selectedFdi, setSelectedFdi] = useState<number>(11);

  const updateExtra = (patch: Partial<typeof exam.extraoral>) =>
    onChange({ ...record, clinicalExam: { ...exam, extraoral: { ...exam.extraoral, ...patch } } });

  const updateIntra = (patch: Partial<typeof exam.intraoral>) =>
    onChange({ ...record, clinicalExam: { ...exam, intraoral: { ...exam.intraoral, ...patch } } });

  const updateDentition = (dentitionStage: DentitionStage) =>
    onChange({ ...record, clinicalExam: { ...exam, dentitionStage } });

  const updateTooth = (fdi: number, patch: Partial<FdiToothRecord>) => {
    const key = String(fdi);
    const isDeciduous = fdi >= 51;
    const current: FdiToothRecord = exam.teeth[key] ?? {
      fdi,
      dentition: isDeciduous ? "deciduous" : "permanent",
      status: "present",
      widthMm: null,
    };
    onChange({
      ...record,
      clinicalExam: {
        ...exam,
        teeth: { ...exam.teeth, [key]: { ...current, ...patch } },
      },
    });
  };

  const activeTooth: FdiToothRecord = exam.teeth[String(selectedFdi)] ?? {
    fdi: selectedFdi,
    dentition: selectedFdi >= 51 ? "deciduous" : "permanent",
    status: "present",
    widthMm: null,
  };

  const renderToothRow = (teeth: readonly number[], title: string) => (
    <div className="space-y-1.5">
      <p className="text-[11px] font-bold text-slate-500">{title}</p>
      <div className="flex flex-wrap gap-1" dir="ltr">
        {teeth.map((fdi) => {
          const rec = exam.teeth[String(fdi)];
          const st: ToothStatus = rec?.status ?? "present";
          const isSelected = selectedFdi === fdi;
          return (
            <button
              key={fdi}
              type="button"
              onClick={() => setSelectedFdi(fdi)}
              className={`flex min-w-[44px] flex-col items-center rounded-lg border px-1.5 py-1 text-[11px] transition ${
                isSelected
                  ? "border-navy-800 bg-navy-800 text-white shadow-sm"
                  : TOOTH_STATUS_META[st].cls
              }`}
            >
              <span className="font-mono font-extrabold">{fdi}</span>
              <span className="text-[10px] opacity-85">
                {rec?.widthMm != null ? `${rec.widthMm}mm` : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Extraoral Exam */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h3 className="text-sm font-extrabold text-navy-900">الفحص خارج الفم (Extraoral Exam)</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
          <label className="space-y-1">
            <span className="font-bold text-slate-600">نمط الوجه</span>
            <select
              disabled={!canEdit}
              value={exam.extraoral.facialForm}
              onChange={(e) => updateExtra({ facialForm: e.target.value as typeof exam.extraoral.facialForm })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value="">—</option>
              <option value="mesofacial">متوسط (Mesofacial)</option>
              <option value="dolichofacial">طويل (Dolichofacial)</option>
              <option value="brachyfacial">عريض (Brachyfacial)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">الجانب الوجهي (Profile)</span>
            <select
              disabled={!canEdit}
              value={exam.extraoral.profileType}
              onChange={(e) => updateExtra({ profileType: e.target.value as typeof exam.extraoral.profileType })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value="">—</option>
              <option value="straight">مستقيم (Straight)</option>
              <option value="convex">محدّب (Convex)</option>
              <option value="concave">مقعّر (Concave)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">إطباق الشفتين</span>
            <select
              disabled={!canEdit}
              value={exam.extraoral.lipCompetence}
              onChange={(e) => updateExtra({ lipCompetence: e.target.value as typeof exam.extraoral.lipCompetence })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value="">—</option>
              <option value="competent">متطابقتان (Competent)</option>
              <option value="potentially_competent">قابل للتطابق</option>
              <option value="incompetent">غير متطابقتين (Incompetent)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">قوس الابتسامة (Smile Arc)</span>
            <select
              disabled={!canEdit}
              value={exam.extraoral.smileArc}
              onChange={(e) => updateExtra({ smileArc: e.target.value as typeof exam.extraoral.smileArc })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value="">—</option>
              <option value="consonant">متناغم (Consonant)</option>
              <option value="flat">مسطّح (Flat)</option>
              <option value="reverse">معكوس (Reverse)</option>
            </select>
          </label>
        </div>
      </div>

      {/* Intraoral Exam */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-navy-900">الفحص داخل الفم والإطباق (Intraoral Exam)</h3>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-bold text-slate-600">مرحلة الإطباق:</span>
            {(["permanent", "mixed", "deciduous"] as const).map((st) => (
              <button
                key={st}
                type="button"
                disabled={!canEdit}
                onClick={() => updateDentition(st)}
                className={`rounded-lg border px-2.5 py-1 font-bold ${
                  exam.dentitionStage === st
                    ? "border-navy-800 bg-navy-800 text-white"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                {st === "permanent" ? "دائمة" : st === "mixed" ? "مختلطة" : "لبنية"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
          <label className="space-y-1">
            <span className="font-bold text-slate-600">علاقة الأرحاء يمين</span>
            <select
              disabled={!canEdit}
              value={exam.intraoral.molarRight}
              onChange={(e) => updateIntra({ molarRight: e.target.value as AngleClass })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              {ANGLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">علاقة الأرحاء يسار</span>
            <select
              disabled={!canEdit}
              value={exam.intraoral.molarLeft}
              onChange={(e) => updateIntra({ molarLeft: e.target.value as AngleClass })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              {ANGLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">Overjet (mm)</span>
            <input
              type="number"
              step="0.5"
              disabled={!canEdit}
              value={exam.intraoral.overjetMm ?? ""}
              onChange={(e) => updateIntra({ overjetMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">Overbite (mm)</span>
            <input
              type="number"
              step="0.5"
              disabled={!canEdit}
              value={exam.intraoral.overbiteMm ?? ""}
              onChange={(e) => updateIntra({ overbiteMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">المساحة المتاحة علوي (mm)</span>
            <input
              type="number"
              step="0.1"
              disabled={!canEdit}
              value={exam.intraoral.upperAvailableSpaceMm ?? ""}
              onChange={(e) => updateIntra({ upperAvailableSpaceMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">المساحة المتاحة سفلي (mm)</span>
            <input
              type="number"
              step="0.1"
              disabled={!canEdit}
              value={exam.intraoral.lowerAvailableSpaceMm ?? ""}
              onChange={(e) => updateIntra({ lowerAvailableSpaceMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">العضّة المعكوسة الخلفية</span>
            <select
              disabled={!canEdit}
              value={exam.intraoral.crossbitePosterior}
              onChange={(e) =>
                updateIntra({ crossbitePosterior: e.target.value as typeof exam.intraoral.crossbitePosterior })
              }
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value="none">لا يوجد</option>
              <option value="right">يمين</option>
              <option value="left">يسار</option>
              <option value="bilateral">ثنائية الجانب</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">Curve of Spee (mm)</span>
            <input
              type="number"
              step="0.5"
              disabled={!canEdit}
              value={exam.intraoral.curveOfSpeeMm ?? ""}
              onChange={(e) => updateIntra({ curveOfSpeeMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
        </div>
      </div>

      {/* FDI Permanent & Deciduous Tooth Chart & Mesiodistal Measurements */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-extrabold text-navy-900">
              مخطط وقياسات الأسنان وفق نظام FDI (الدائمة واللبنية)
            </h3>
            <p className="text-[11px] text-slate-500">
              اضغط على أي سنّ لتسجيل حالته وعرضه الإنسي-الوحشي (Mesiodistal Width بالمليمتر) لاستخدامه في Bolton وMoyers وTanaka-Johnston.
            </p>
          </div>
          <span className="rounded-lg bg-navy-50 px-2.5 py-1 font-mono text-xs font-extrabold text-navy-900">
            FDI #{selectedFdi}
          </span>
        </div>

        {renderToothRow(PERMANENT_FDI_TEETH.slice(0, 16), "الفك العلوي الدائم (18–28)")}
        {exam.dentitionStage !== "permanent"
          ? renderToothRow(DECIDUOUS_FDI_TEETH.slice(0, 10), "الفك العلوي اللبني (55–65)")
          : null}
        {exam.dentitionStage !== "permanent"
          ? renderToothRow(DECIDUOUS_FDI_TEETH.slice(10), "الفك السفلي اللبني (85–75)")
          : null}
        {renderToothRow(PERMANENT_FDI_TEETH.slice(16), "الفك السفلي الدائم (48–38)")}

        {/* Active Tooth Editor */}
        <div className="rounded-xl border border-navy-200 bg-navy-50/40 p-3 grid grid-cols-1 gap-3 sm:grid-cols-3 text-xs">
          <label className="space-y-1">
            <span className="font-bold text-slate-700">حالة السنّ FDI #{selectedFdi}</span>
            <select
              disabled={!canEdit}
              value={activeTooth.status}
              onChange={(e) => updateTooth(selectedFdi, { status: e.target.value as ToothStatus })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              {(Object.keys(TOOTH_STATUS_META) as ToothStatus[]).map((st) => (
                <option key={st} value={st}>{TOOTH_STATUS_META[st].labelAr}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-700">العرض الإنسي-الوحشي (mm)</span>
            <input
              type="number"
              step="0.1"
              min="2"
              max="16"
              disabled={!canEdit}
              value={activeTooth.widthMm ?? ""}
              onChange={(e) => updateTooth(selectedFdi, { widthMm: parseNullableNum(e.target.value) })}
              placeholder="مثال: 8.5"
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-700">ملاحظة السنّ</span>
            <input
              type="text"
              disabled={!canEdit}
              value={activeTooth.note ?? ""}
              onChange={(e) => updateTooth(selectedFdi, { note: e.target.value })}
              placeholder="دوران، انطمار، تآكل..."
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
