"use client";

import React, { useState } from "react";
import type { OrthoProblemItem, OrthoWorkspaceRecord } from "@/lib/ortho-workspace-types";

export function OrthoDiagnosisTab({
  record,
  actorName,
  canEdit,
  canApproveDiagnosis,
  canReopen,
  onChange,
}: {
  record: OrthoWorkspaceRecord;
  actorName: string;
  canEdit: boolean;
  canApproveDiagnosis: boolean;
  canReopen: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState<OrthoProblemItem["category"]>("dental");
  const [newSeverity, setNewSeverity] = useState<OrthoProblemItem["severity"]>("moderate");

  const locked = Boolean(record.diagnosisSummary.approvedAt) && !canReopen;
  const editable = canEdit && !locked;

  const addProblem = () => {
    const trimmed = newTitle.trim();
    if (!trimmed || !editable) return;
    const item: OrthoProblemItem = {
      id: `prob-${Date.now()}`,
      category: newCategory,
      severity: newSeverity,
      titleAr: trimmed,
      detailsAr: "",
      source: "manual",
      approved: canApproveDiagnosis,
    };
    onChange({ ...record, problems: [item, ...record.problems] });
    setNewTitle("");
  };

  const syncFromApprovedAnalyses = () => {
    if (!editable) return;
    const existingRefs = new Set(record.problems.map((p) => p.sourceRefId).filter(Boolean));
    const additions: OrthoProblemItem[] = [];
    for (const analysis of record.approvedAnalyses) {
      if (existingRefs.has(analysis.id)) continue;
      additions.push({
        id: `prob-auto-${analysis.id}`,
        category: analysis.type === "ceph" ? "skeletal" : analysis.type === "facial_photo" ? "soft_tissue" : "space",
        severity: "moderate",
        titleAr: `${analysis.titleAr}: ${analysis.summaryAr}`,
        detailsAr: `مشتق من تحليل معتمد بواسطة ${analysis.approvedBy} (${analysis.referenceCitation})`,
        source: analysis.type === "ceph" ? "approved_ceph" : "approved_analysis",
        sourceRefId: analysis.id,
        approved: false,
      });
    }
    if (additions.length > 0) {
      onChange({ ...record, problems: [...additions, ...record.problems] });
    }
  };

  const approveDiagnosis = () => {
    if (!canApproveDiagnosis) return;
    onChange({
      ...record,
      diagnosisSummary: {
        ...record.diagnosisSummary,
        approvedBy: actorName,
        approvedAt: new Date().toISOString(),
      },
    });
  };

  const reopenDiagnosis = () => {
    if (!canReopen) return;
    onChange({
      ...record,
      diagnosisSummary: {
        ...record.diagnosisSummary,
        approvedBy: null,
        approvedAt: null,
      },
    });
  };

  return (
    <div className="space-y-4 text-xs">
      {/* Problem List */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-extrabold text-navy-900">قائمة المشكلات المجمّعة (Problem List)</h3>
            <p className="text-[11px] text-slate-500">
              تُجمع فقط من النتائج المعتمدة (التحليلات المعتمدة والسيفالومتري المعتمد والفحص السريري).
            </p>
          </div>
          {editable ? (
            <button
              type="button"
              onClick={syncFromApprovedAnalyses}
              className="rounded-lg border border-navy-300 bg-navy-50 px-3 py-1.5 text-xs font-extrabold text-navy-900 hover:bg-navy-100"
            >
              تجميع من التحليلات المعتمدة ({record.approvedAnalyses.length})
            </button>
          ) : null}
        </div>

        {editable ? (
          <div className="flex flex-wrap gap-2">
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as OrthoProblemItem["category"])}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
            >
              <option value="skeletal">هيكلي (Skeletal)</option>
              <option value="dental">سني (Dental)</option>
              <option value="space">مسافة / ازدحام (Space)</option>
              <option value="soft_tissue">أنسجة رخوة (Soft Tissue)</option>
              <option value="functional">وظيفي / TMJ</option>
              <option value="periodontal">لثوي (Periodontal)</option>
            </select>
            <select
              value={newSeverity}
              onChange={(e) => setNewSeverity(e.target.value as OrthoProblemItem["severity"])}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5"
            >
              <option value="mild">خفيف</option>
              <option value="moderate">متوسط</option>
              <option value="severe">شديد</option>
            </select>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="أضف مشكلة سريرية محددة..."
              className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5"
            />
            <button
              type="button"
              onClick={addProblem}
              className="rounded-lg bg-navy-800 px-3 py-1.5 font-extrabold text-white"
            >
              + إضافة
            </button>
          </div>
        ) : null}

        {record.problems.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-slate-500">
            لا توجد مشكلات مدرجة بعد. اعتمد التحليلات أولًا ثم اضغط «تجميع من التحليلات المعتمدة» أو أضف يدويًا.
          </p>
        ) : (
          <ul className="space-y-2">
            {record.problems.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <div>
                  <p className="font-bold text-slate-900">
                    {p.titleAr}{" "}
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">
                      {p.severity === "severe" ? "شديد" : p.severity === "moderate" ? "متوسط" : "خفيف"}
                    </span>
                  </p>
                  {p.detailsAr ? <p className="text-[11px] text-slate-500">{p.detailsAr}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!canApproveDiagnosis || locked}
                    onClick={() =>
                      onChange({
                        ...record,
                        problems: record.problems.map((item) =>
                          item.id === p.id ? { ...item, approved: !item.approved } : item,
                        ),
                      })
                    }
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ${
                      p.approved
                        ? "bg-emerald-100 text-emerald-800"
                        : "border border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    {p.approved ? "معتمدة ✓" : "اعتماد"}
                  </button>
                  {editable ? (
                    <button
                      type="button"
                      onClick={() =>
                        onChange({
                          ...record,
                          problems: record.problems.filter((item) => item.id !== p.id),
                        })
                      }
                      className="text-red-600 hover:underline"
                    >
                      حذف
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Final Diagnosis Summary & Approval */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-navy-900">ملخص التشخيص التقويمي النهائي</h3>
          {record.diagnosisSummary.approvedAt ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
                معتمد بواسطة {record.diagnosisSummary.approvedBy} · {record.diagnosisSummary.approvedAt.slice(0, 10)}
              </span>
              {canReopen ? (
                <button
                  type="button"
                  onClick={reopenDiagnosis}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-900"
                >
                  إعادة فتح التشخيص
                </button>
              ) : null}
            </div>
          ) : canApproveDiagnosis ? (
            <button
              type="button"
              onClick={approveDiagnosis}
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-emerald-800"
            >
              اعتماد التشخيص النهائي ✓
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            disabled={!editable}
            value={record.diagnosisSummary.skeletalClass}
            onChange={(e) =>
              onChange({
                ...record,
                diagnosisSummary: { ...record.diagnosisSummary, skeletalClass: e.target.value },
              })
            }
            placeholder="التصنيف الهيكلي (مثال: Skeletal Class II due to retrognathic mandible)"
            className="rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
          />
          <input
            type="text"
            disabled={!editable}
            value={record.diagnosisSummary.dentalClass}
            onChange={(e) =>
              onChange({
                ...record,
                diagnosisSummary: { ...record.diagnosisSummary, dentalClass: e.target.value },
              })
            }
            placeholder="التصنيف السني (Angle Class / Crowding / Overjet / Overbite)"
            className="rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
          />
          <input
            type="text"
            disabled={!editable}
            value={record.diagnosisSummary.verticalPattern}
            onChange={(e) =>
              onChange({
                ...record,
                diagnosisSummary: { ...record.diagnosisSummary, verticalPattern: e.target.value },
              })
            }
            placeholder="النمط العمودي (Normodivergent / Hyperdivergent / Hypodivergent)"
            className="rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
          />
          <input
            type="text"
            disabled={!editable}
            value={record.diagnosisSummary.transversePattern}
            onChange={(e) =>
              onChange({
                ...record,
                diagnosisSummary: { ...record.diagnosisSummary, transversePattern: e.target.value },
              })
            }
            placeholder="النمط العرضي (تضيق فك علوي / عضة معكوسة...)"
            className="rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
          />
        </div>
        <textarea
          rows={3}
          disabled={!editable}
          value={record.diagnosisSummary.finalDiagnosisAr}
          onChange={(e) =>
            onChange({
              ...record,
              diagnosisSummary: { ...record.diagnosisSummary, finalDiagnosisAr: e.target.value },
            })
          }
          placeholder="الصياغة النهائية المعتمدة للتشخيص السريري..."
          className="w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
        />
      </div>
    </div>
  );
}

export function OrthoPlanTab({
  record,
  actorName,
  canEdit,
  canApprovePlan,
  canReopen,
  onChange,
}: {
  record: OrthoWorkspaceRecord;
  actorName: string;
  canEdit: boolean;
  canApprovePlan: boolean;
  canReopen: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
}) {
  const [goalInput, setGoalInput] = useState("");
  const [phaseTitle, setPhaseTitle] = useState("");
  const [phaseObjective, setPhaseObjective] = useState("");
  const [phaseWires, setPhaseWires] = useState("");

  const plan = record.treatmentPlan;
  const locked = Boolean(plan.approvedAt) && !canReopen;
  const editable = canEdit && !locked;

  const updatePlan = (patch: Partial<typeof plan>) =>
    onChange({ ...record, treatmentPlan: { ...plan, ...patch } });

  const addGoal = () => {
    const trimmed = goalInput.trim();
    if (!trimmed || !editable) return;
    updatePlan({ primaryGoals: [...plan.primaryGoals, trimmed] });
    setGoalInput("");
  };

  const addPhase = () => {
    if (!phaseTitle.trim() || !editable) return;
    updatePlan({
      phaseBreakdown: [
        ...plan.phaseBreakdown,
        {
          phase: phaseTitle.trim(),
          objective: phaseObjective.trim(),
          wiresOrAppliance: phaseWires.trim(),
          estimatedMonths: 4,
        },
      ],
    });
    setPhaseTitle("");
    setPhaseObjective("");
    setPhaseWires("");
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-extrabold text-navy-900">أهداف وخطة العلاج والأجهزة والميكانيكا</h3>
            <p className="text-[11px] text-slate-500">
              يُحفظ كخطة سريرية متسلسلة ومعتمدة وتظهر في Case Presentation عند الاعتماد.
            </p>
          </div>
          {plan.approvedAt ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
                خطة معتمدة بواسطة {plan.approvedBy} · {plan.approvedAt.slice(0, 10)}
              </span>
              {canReopen ? (
                <button
                  type="button"
                  onClick={() => updatePlan({ approvedBy: null, approvedAt: null })}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-900"
                >
                  إعادة فتح الخطة
                </button>
              ) : null}
            </div>
          ) : canApprovePlan ? (
            <button
              type="button"
              onClick={() => updatePlan({ approvedBy: actorName, approvedAt: new Date().toISOString() })}
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-emerald-800"
            >
              اعتماد خطة العلاج ✓
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1">
            <span className="font-bold text-slate-700">نوع الجهاز العلاجي</span>
            <select
              disabled={!editable}
              value={plan.treatmentModality}
              onChange={(e) => updatePlan({ treatmentModality: e.target.value as typeof plan.treatmentModality })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2 disabled:bg-slate-50"
            >
              <option value="">— اختر —</option>
              <option value="fixed_metallic">تقويم ثابت معدني (MBT/Roth)</option>
              <option value="fixed_ceramic">تقويم ثابت خزفي (Ceramic)</option>
              <option value="self_ligating">ذاتي الربط (Self-Ligating)</option>
              <option value="clear_aligners">تقويم شفاف (Clear Aligners)</option>
              <option value="functional_growth">أجهزة وظيفية / تعديل نمو</option>
              <option value="interceptive">تقويم وقائي / اعتراضي</option>
              <option value="surgical_ortho">تقويم جراحي مشترك</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="font-bold text-slate-700">قرار القلع</span>
            <select
              disabled={!editable}
              value={plan.extractionPlan}
              onChange={(e) => updatePlan({ extractionPlan: e.target.value as typeof plan.extractionPlan })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2 disabled:bg-slate-50"
            >
              <option value="">—</option>
              <option value="non_extraction">بدون قلع (Non-Extraction)</option>
              <option value="extraction">مع قلع (Extraction)</option>
              <option value="borderline_reassess">حدّي — إعادة تقييم بعد الترصيف</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="font-bold text-slate-700">نظام الدعم (Anchorage)</span>
            <select
              disabled={!editable}
              value={plan.anchoragePlan}
              onChange={(e) => updatePlan({ anchoragePlan: e.target.value as typeof plan.anchoragePlan })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2 disabled:bg-slate-50"
            >
              <option value="">—</option>
              <option value="minimum">أدنى (Minimum)</option>
              <option value="moderate">متوسط (Moderate / Reciprocal)</option>
              <option value="maximum">أقصى (Maximum / TPA / Nance)</option>
              <option value="tad_skeletal">دعم هيكلي (TADs / Miniscrews)</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="font-bold text-slate-700">المدة التقديرية (أشهر)</span>
            <input
              type="number"
              min="1"
              max="60"
              disabled={!editable}
              value={plan.estimatedDurationMonths ?? ""}
              onChange={(e) =>
                updatePlan({ estimatedDurationMonths: e.target.value ? Number(e.target.value) : null })
              }
              placeholder="18"
              className="w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
            />
          </label>
        </div>

        {/* Treatment Goals */}
        <div className="space-y-2">
          <span className="font-bold text-slate-700">الأهداف العلاجية:</span>
          {editable ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
                placeholder="مثال: تصحيح الازدحام وتحقيق علاقة نابية Class I ومطابقة الخطوط الوسطى..."
                className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5"
              />
              <button
                type="button"
                onClick={addGoal}
                className="rounded-lg bg-navy-800 px-3 py-1.5 font-extrabold text-white"
              >
                + هدف
              </button>
            </div>
          ) : null}
          <ul className="space-y-1">
            {plan.primaryGoals.map((g, idx) => (
              <li key={idx} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
                <span>{idx + 1}. {g}</span>
                {editable ? (
                  <button
                    type="button"
                    onClick={() => updatePlan({ primaryGoals: plan.primaryGoals.filter((_, i) => i !== idx) })}
                    className="text-red-600 hover:underline"
                  >
                    حذف
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="font-bold text-slate-700">ملخص الميكانيكا والأسلاك والأجهزة المساعدة</span>
            <textarea
              rows={3}
              disabled={!editable}
              value={plan.mechanicsSummary}
              onChange={(e) => updatePlan({ mechanicsSummary: e.target.value })}
              placeholder="تتابع الأسلاك، إغلاق المسافات، المطاطات، TADs..."
              className="w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-700">المخاطر وموافقة المريض</span>
            <textarea
              rows={3}
              disabled={!editable}
              value={plan.risksDiscussed}
              onChange={(e) => updatePlan({ risksDiscussed: e.target.value })}
              placeholder="امتصاص الجذور، إزالة التمعدن، الالتزام بالمطاطات والمثبّتات..."
              className="w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-50"
            />
          </label>
        </div>

        {/* Phase breakdown */}
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <p className="font-extrabold text-navy-900">مراحل التنفيذ (Treatment Phases)</p>
          {editable ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <input
                type="text"
                value={phaseTitle}
                onChange={(e) => setPhaseTitle(e.target.value)}
                placeholder="المرحلة (مثال: الرصف والتسوية)"
                className="rounded-lg border border-slate-300 p-2"
              />
              <input
                type="text"
                value={phaseObjective}
                onChange={(e) => setPhaseObjective(e.target.value)}
                placeholder="الهدف السريري"
                className="rounded-lg border border-slate-300 p-2"
              />
              <input
                type="text"
                value={phaseWires}
                onChange={(e) => setPhaseWires(e.target.value)}
                placeholder="الأسلاك / الأجهزة (0.014→0.018 NiTi)"
                className="rounded-lg border border-slate-300 p-2"
              />
              <button
                type="button"
                onClick={addPhase}
                className="rounded-lg bg-navy-800 px-3 py-2 font-extrabold text-white"
              >
                + إضافة مرحلة
              </button>
            </div>
          ) : null}
          {plan.phaseBreakdown.length > 0 ? (
            <div className="space-y-1.5">
              {plan.phaseBreakdown.map((ph, idx) => (
                <div key={idx} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-slate-900">{ph.phase}</p>
                    <p className="text-[11px] text-slate-600">{ph.objective} · <span dir="ltr">{ph.wiresOrAppliance}</span></p>
                  </div>
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => updatePlan({ phaseBreakdown: plan.phaseBreakdown.filter((_, i) => i !== idx) })}
                      className="text-red-600 hover:underline"
                    >
                      حذف
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function OrthoRetentionTab({
  record,
  actorName,
  canEdit,
  onChange,
}: {
  record: OrthoWorkspaceRecord;
  actorName: string;
  canEdit: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
}) {
  const ret = record.retention;
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [intervalLabel, setIntervalLabel] = useState("شهر واحد");
  const [compliance, setCompliance] = useState<"excellent" | "good" | "fair" | "poor">("good");
  const [integrity, setIntegrity] = useState<"intact" | "debonded" | "cracked" | "lost" | "replaced">("intact");
  const [relapse, setRelapse] = useState(false);
  const [notes, setNotes] = useState("");

  const updateRet = (patch: Partial<typeof ret>) =>
    onChange({ ...record, retention: { ...ret, ...patch } });

  const addFollowup = () => {
    if (!canEdit) return;
    updateRet({
      followups: [
        {
          id: `ret-${Date.now()}`,
          date,
          intervalLabel,
          compliance,
          retainerIntegrity: integrity,
          relapseObserved: relapse,
          notes: notes.trim(),
          clinician: actorName,
        },
        ...ret.followups,
      ],
    });
    setNotes("");
    setRelapse(false);
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h3 className="text-sm font-extrabold text-navy-900">بروتوكول التثبيت (Retention Protocol)</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="font-bold text-slate-700">تاريخ فك التقويم (Debond Date)</span>
            <input
              type="date"
              disabled={!canEdit}
              value={ret.debondDate ?? ""}
              onChange={(e) => updateRet({ debondDate: e.target.value || null })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-700">المثبّت العلوي</span>
            <select
              disabled={!canEdit}
              value={ret.upperRetainerType}
              onChange={(e) => updateRet({ upperRetainerType: e.target.value as typeof ret.upperRetainerType })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value="">—</option>
              <option value="essix">شفاف (Essix / VFR)</option>
              <option value="hawley">هاولي (Hawley)</option>
              <option value="fixed_bonded">مثبّت ثابت لساني (Bonded)</option>
              <option value="dual_bonded_essix">مزدوج (ثابت + شفاف)</option>
              <option value="none">بدون</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-700">المثبّت السفلي</span>
            <select
              disabled={!canEdit}
              value={ret.lowerRetainerType}
              onChange={(e) => updateRet({ lowerRetainerType: e.target.value as typeof ret.lowerRetainerType })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value="">—</option>
              <option value="fixed_bonded">مثبّت ثابت لساني (Bonded 3-3)</option>
              <option value="essix">شفاف (Essix / VFR)</option>
              <option value="hawley">هاولي (Hawley)</option>
              <option value="dual_bonded_essix">مزدوج (ثابت + شفاف)</option>
              <option value="none">بدون</option>
            </select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="font-bold text-slate-700">تعليمات الارتداء والمتابعة</span>
          <textarea
            rows={2}
            disabled={!canEdit}
            value={ret.wearProtocol}
            onChange={(e) => updateRet({ wearProtocol: e.target.value })}
            placeholder="مثال: 22 ساعة يوميًا أول 6 أشهر ثم ليليًا بانتظام..."
            className="w-full rounded-lg border border-slate-300 p-2"
          />
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h4 className="text-sm font-extrabold text-navy-900">سجل زيارات متابعة التثبيت</h4>
        {canEdit ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-6 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-slate-300 bg-white p-1.5" />
            <input type="text" value={intervalLabel} onChange={(e) => setIntervalLabel(e.target.value)} placeholder="الفترة (3 أشهر...)" className="rounded-lg border border-slate-300 bg-white p-1.5" />
            <select value={compliance} onChange={(e) => setCompliance(e.target.value as typeof compliance)} className="rounded-lg border border-slate-300 bg-white p-1.5">
              <option value="excellent">التزام ممتاز</option>
              <option value="good">التزام جيد</option>
              <option value="fair">التزام متوسط</option>
              <option value="poor">التزام ضعيف</option>
            </select>
            <select value={integrity} onChange={(e) => setIntegrity(e.target.value as typeof integrity)} className="rounded-lg border border-slate-300 bg-white p-1.5">
              <option value="intact">المثبّت سليم</option>
              <option value="debonded">انفكاك سلك</option>
              <option value="cracked">تشقق</option>
              <option value="lost">مفقود</option>
              <option value="replaced">تم استبداله</option>
            </select>
            <label className="inline-flex items-center gap-1.5 px-2 font-bold text-slate-700">
              <input type="checkbox" checked={relapse} onChange={(e) => setRelapse(e.target.checked)} />
              نكس ملحوظ
            </label>
            <button type="button" onClick={addFollowup} className="rounded-lg bg-navy-800 px-3 py-1.5 font-extrabold text-white">
              + تسجيل متابعة
            </button>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="ملاحظات الزيارة..."
              className="sm:col-span-6 rounded-lg border border-slate-300 bg-white p-1.5"
            />
          </div>
        ) : null}

        {ret.followups.length === 0 ? (
          <p className="text-center text-slate-500 py-3">لا توجد زيارات تثبيت مسجّلة بعد.</p>
        ) : (
          <ul className="space-y-2">
            {ret.followups.map((f) => (
              <li key={f.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 flex flex-wrap justify-between gap-2">
                <div>
                  <p className="font-bold text-slate-900">
                    {f.date} · {f.intervalLabel} · الطبيب: {f.clinician}
                  </p>
                  <p className="text-[11px] text-slate-600">
                    الالتزام: {f.compliance} · حالة المثبّت: {f.retainerIntegrity}
                    {f.relapseObserved ? " · ⚠️ نكس ملحوظ" : ""}
                  </p>
                  {f.notes ? <p className="mt-0.5 text-[11px] text-slate-700">{f.notes}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
