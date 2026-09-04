"use client";

import React, { useMemo, useState } from "react";
import { formatMoney, parseAmount, toInputAmount, type Currency } from "@/lib/money";
import {
  calculateCaseProfitability,
  PROFITABILITY_TIER_META,
  type ProcedureCostInput,
} from "@/lib/profitability";

interface CaseProfitabilityModalProps {
  title?: string;
  patientName?: string;
  patientNumber?: string | null;
  currency?: Currency;
  procedures?: ProcedureCostInput[];
  onClose: () => void;
}

const SAMPLE_PRESETS: { id: string; name: string; patient: string; procedures: ProcedureCostInput[] }[] = [
  {
    id: "zirconia_bridge",
    name: "جسر زركونيا 3 وحدات (Zirconia Bridge)",
    patient: "أحمد منصور (حالة تعويضات سنية)",
    procedures: [
      {
        serviceName: "تاج زركونيا سن داعم #14",
        toothCode: 14,
        revenueMinor: 5000000,
        labCostMinor: 1500000,
        materialCostMinor: 400000,
        doctorCommissionPercent: 30,
      },
      {
        serviceName: "دمية زركونيا مفقود #15",
        toothCode: 15,
        revenueMinor: 4500000,
        labCostMinor: 1500000,
        materialCostMinor: 250000,
        doctorCommissionPercent: 30,
      },
      {
        serviceName: "تاج زركونيا سن داعم #16",
        toothCode: 16,
        revenueMinor: 5000000,
        labCostMinor: 1500000,
        materialCostMinor: 400000,
        doctorCommissionPercent: 30,
      },
    ],
  },
  {
    id: "dental_implant",
    name: "زراعة سن فوري مع تاج إيماكس (Implant + E-Max)",
    patient: "منى الشامي (جراحة وزراعة أسنان)",
    procedures: [
      {
        serviceName: "غرسة سنية تيتانيوم فورية #21",
        toothCode: 21,
        revenueMinor: 14000000,
        labCostMinor: 0,
        materialCostMinor: 3800000,
        doctorCommissionPercent: 25,
      },
      {
        serviceName: "دعامة زركونيا وتاج إيماكس على زرعة",
        toothCode: 21,
        revenueMinor: 8500000,
        labCostMinor: 2800000,
        materialCostMinor: 700000,
        doctorCommissionPercent: 30,
      },
    ],
  },
  {
    id: "molar_endo_crown",
    name: "معالجة لبية لضرس + وتد فايبر وتاج (Endo + Post & Core)",
    patient: "خالد عبد الله (علاج جذور وتأهيل)",
    procedures: [
      {
        serviceName: "علاج عصب ضرس سفلي 4 قنوات #36",
        toothCode: 36,
        revenueMinor: 4500000,
        labCostMinor: 0,
        materialCostMinor: 850000,
        doctorCommissionPercent: 35,
      },
      {
        serviceName: "وتد فايبر وبناء قلب السن بالكمبوزيت",
        toothCode: 36,
        revenueMinor: 2200000,
        labCostMinor: 0,
        materialCostMinor: 450000,
        doctorCommissionPercent: 30,
      },
      {
        serviceName: "تاج بورسلين مدمج بمعدن (PFM)",
        toothCode: 36,
        revenueMinor: 3200000,
        labCostMinor: 1100000,
        materialCostMinor: 300000,
        doctorCommissionPercent: 30,
      },
    ],
  },
  {
    id: "hollywood_smile",
    name: "ابتسامة هوليوود 6 عدسات فينير (Veneers E-Max)",
    patient: "ريم الحميري (تجميل أسنان)",
    procedures: [13, 12, 11, 21, 22, 23].map((tooth) => ({
      serviceName: `عدسة فينير إيماكس جمالية #${tooth}`,
      toothCode: tooth,
      revenueMinor: 4500000,
      labCostMinor: 1400000,
      materialCostMinor: 350000,
      doctorCommissionPercent: 30,
    })),
  },
];

export function CaseProfitabilityModal({
  title = "تحليل ومحاكاة ربحية الحالات السريرية وهامش المساهمة",
  patientName,
  patientNumber,
  currency = "YER",
  procedures: initialProcedures,
  onClose,
}: CaseProfitabilityModalProps) {
  // الحالة التفاعلية للإجراءات
  const [activeProcedures, setActiveProcedures] = useState<ProcedureCostInput[]>(() => {
    if (initialProcedures && initialProcedures.length > 0) {
      return initialProcedures;
    }
    return SAMPLE_PRESETS[0].procedures;
  });

  const [currentPatient, setCurrentPatient] = useState<string>(() => {
    return patientName || SAMPLE_PRESETS[0].patient;
  });

  const [selectedPresetId, setSelectedPresetId] = useState<string>(() => {
    if (initialProcedures && initialProcedures.length > 0) return "custom";
    return SAMPLE_PRESETS[0].id;
  });

  const handleSelectPreset = (presetId: string) => {
    const preset = SAMPLE_PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setSelectedPresetId(preset.id);
      setCurrentPatient(patientName || preset.patient);
      setActiveProcedures(preset.procedures);
    }
  };

  const handleUpdateProcedure = (
    index: number,
    field: keyof ProcedureCostInput,
    rawVal: string | number,
  ) => {
    setSelectedPresetId("custom");
    setActiveProcedures((prev) => {
      const next = [...prev];
      const item = { ...next[index] };

      if (field === "revenueMinor" || field === "labCostMinor" || field === "materialCostMinor") {
        const parsed = parseAmount(String(rawVal), currency);
        item[field] = parsed ?? 0;
      } else if (field === "doctorCommissionPercent") {
        const num = Number(rawVal);
        item.doctorCommissionPercent = isNaN(num) ? 0 : Math.max(0, Math.min(100, num));
      } else if (field === "serviceName") {
        item.serviceName = String(rawVal);
      } else if (field === "toothCode") {
        const num = Number(rawVal);
        item.toothCode = isNaN(num) ? null : num;
      }

      next[index] = item;
      return next;
    });
  };

  const handleAddProcedure = () => {
    setSelectedPresetId("custom");
    setActiveProcedures((prev) => [
      ...prev,
      {
        serviceName: "إجراء سني جديد",
        revenueMinor: 2500000,
        labCostMinor: 0,
        materialCostMinor: 300000,
        doctorCommissionPercent: 30,
      },
    ]);
  };

  const handleRemoveProcedure = (index: number) => {
    if (activeProcedures.length <= 1) return;
    setSelectedPresetId("custom");
    setActiveProcedures((prev) => prev.filter((_, i) => i !== index));
  };

  const summary = useMemo(
    () => calculateCaseProfitability(activeProcedures),
    [activeProcedures],
  );

  const tierMeta = PROFITABILITY_TIER_META[summary.tier];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/75 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl rounded-3xl bg-white p-5 sm:p-6 shadow-2xl border border-slate-200 my-8">
        {/* الترويسة */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-600 flex items-center justify-center text-white text-xl shadow-xs">
              📊
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-900">{title}</h2>
              <p className="text-xs font-semibold text-slate-500">
                الحالة: <strong className="text-slate-800">{currentPatient}</strong>
                {patientNumber && <span className="font-mono mr-2 text-brand-orange">({patientNumber})</span>}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 font-bold"
          >
            ✕
          </button>
        </div>

        {/* أزرار الحالات النموذجية الجاهزة */}
        <div className="mb-4">
          <span className="text-[11px] font-bold text-slate-500 block mb-1.5">
            نماذج الحالات السريرية الجاهزة للمحاكاة:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {SAMPLE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectPreset(p.id)}
                className={`text-xs px-3 py-1.5 rounded-xl font-bold transition-colors ${
                  selectedPresetId === p.id
                    ? "bg-navy-900 text-white shadow-xs"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {p.name}
              </button>
            ))}
            {selectedPresetId === "custom" && (
              <span className="text-xs px-3 py-1.5 rounded-xl font-bold bg-brand-orange/10 text-brand-orange border border-brand-orange/30">
                حالة مخصصة معدلة ✏️
              </span>
            )}
          </div>
        </div>

        {/* كرت تصنيف الربحية الإجمالي */}
        <div className={`p-4 rounded-2xl border ${tierMeta.bg} flex flex-wrap items-center justify-between gap-3 mb-4`}>
          <div className="flex items-center gap-3">
            <span className="text-3xl">{tierMeta.icon}</span>
            <div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-black ${tierMeta.color}`}>{tierMeta.label}</span>
                <span className="px-2.5 py-0.5 rounded-full bg-white/90 border text-xs font-black text-slate-800 font-mono shadow-xs">
                  هامش المساهمة: {summary.overallMarginPercent}%
                </span>
              </div>
              <p className="text-xs text-slate-600 font-medium mt-0.5">{tierMeta.advice}</p>
            </div>
          </div>
          <div className="text-left">
            <span className="text-[11px] text-slate-500 block font-bold">عائد المركز الصافي</span>
            <span className="text-lg font-black font-mono text-emerald-700">
              {formatMoney(summary.netClinicProfitMinor, currency)}
            </span>
          </div>
        </div>

        {/* تفكيك الأرقام المالية (4 بطاقات رئيسية) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80 text-center">
            <span className="text-[11px] font-bold text-slate-500 block">إجمالي إيراد الحالة</span>
            <span className="text-base font-black font-mono text-slate-900">
              {formatMoney(summary.totalRevenueMinor, currency)}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-amber-50/60 border border-amber-200 text-center">
            <span className="text-[11px] font-bold text-amber-800 block">تكلفة معمل الأسنان</span>
            <span className="text-base font-black font-mono text-amber-700">
              {formatMoney(summary.totalLabCostMinor, currency)}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-indigo-50/60 border border-indigo-200 text-center">
            <span className="text-[11px] font-bold text-indigo-800 block">المواد + عمولة الطبيب</span>
            <span className="text-base font-black font-mono text-indigo-700">
              {formatMoney(
                summary.totalMaterialCostMinor + summary.totalDoctorCommissionMinor,
                currency,
              )}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-center">
            <span className="text-[11px] font-bold text-emerald-800 block">صافي ربح المركز</span>
            <span className="text-base font-black font-mono text-emerald-700">
              {formatMoney(summary.netClinicProfitMinor, currency)}
            </span>
          </div>
        </div>

        {/* جدول الإجراءات التفصيلي مع إمكانية التعديل والمحاكاة */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-black text-slate-800">
              تفكيك التكاليف المباشرة للإجراءات ({activeProcedures.length}):
            </h3>
            <button
              type="button"
              onClick={handleAddProcedure}
              className="text-[11px] font-bold text-brand-orange hover:underline"
            >
              + إضافة إجراء للمحاكاة
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-2xl border border-slate-200">
            <table className="w-full text-right text-xs">
              <thead className="sticky top-0 bg-slate-100 text-slate-600 font-bold border-b border-slate-200">
                <tr>
                  <th className="p-2.5">الإجراء السني</th>
                  <th className="p-2.5 text-left">السعر للمريض</th>
                  <th className="p-2.5 text-left">المعمل</th>
                  <th className="p-2.5 text-left">المواد</th>
                  <th className="p-2.5 text-center">نسبة الطبيب</th>
                  <th className="p-2.5 text-left">صافي المركز</th>
                  <th className="p-2.5 text-center">الهامش %</th>
                  <th className="p-2.5 text-center w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activeProcedures.map((proc, idx) => {
                  const pCalculated = summary.procedures[idx];
                  const pTier = pCalculated ? PROFITABILITY_TIER_META[pCalculated.tier] : PROFITABILITY_TIER_META.healthy;

                  return (
                    <tr key={idx} className="hover:bg-slate-50/70 transition-colors">
                      <td className="p-2">
                        <input
                          type="text"
                          value={proc.serviceName}
                          onChange={(e) => handleUpdateProcedure(idx, "serviceName", e.target.value)}
                          className="w-full text-xs font-bold text-slate-800 bg-transparent border-b border-dashed border-slate-300 focus:border-navy-900 outline-none px-1"
                        />
                      </td>
                      <td className="p-2 text-left">
                        <input
                          type="text"
                          value={toInputAmount(proc.revenueMinor, currency)}
                          onChange={(e) => handleUpdateProcedure(idx, "revenueMinor", e.target.value)}
                          className="w-24 text-xs font-mono font-black text-slate-900 bg-transparent border-b border-dashed border-slate-300 focus:border-navy-900 outline-none px-1 text-left"
                        />
                      </td>
                      <td className="p-2 text-left">
                        <input
                          type="text"
                          value={toInputAmount(proc.labCostMinor ?? 0, currency)}
                          onChange={(e) => handleUpdateProcedure(idx, "labCostMinor", e.target.value)}
                          className="w-20 text-xs font-mono font-bold text-amber-700 bg-transparent border-b border-dashed border-slate-300 focus:border-navy-900 outline-none px-1 text-left"
                        />
                      </td>
                      <td className="p-2 text-left">
                        <input
                          type="text"
                          value={toInputAmount(proc.materialCostMinor ?? 0, currency)}
                          onChange={(e) => handleUpdateProcedure(idx, "materialCostMinor", e.target.value)}
                          className="w-18 text-xs font-mono font-bold text-indigo-700 bg-transparent border-b border-dashed border-slate-300 focus:border-navy-900 outline-none px-1 text-left"
                        />
                      </td>
                      <td className="p-2 text-center">
                        <div className="inline-flex items-center gap-1 font-mono">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={proc.doctorCommissionPercent ?? 0}
                            onChange={(e) => handleUpdateProcedure(idx, "doctorCommissionPercent", e.target.value)}
                            className="w-12 text-xs font-bold text-center bg-transparent border-b border-dashed border-slate-300 focus:border-navy-900 outline-none px-0.5"
                          />
                          <span className="text-[10px] text-slate-400">%</span>
                        </div>
                      </td>
                      <td className="p-2 text-left font-mono font-bold text-emerald-700">
                        {pCalculated ? formatMoney(pCalculated.netContributionMinor, currency) : "—"}
                      </td>
                      <td className="p-2 text-center">
                        {pCalculated ? (
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-black font-mono ${pTier.bg} ${pTier.color}`}>
                            {pCalculated.marginPercent}%
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 text-center">
                        {activeProcedures.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveProcedure(idx)}
                            className="text-slate-400 hover:text-red-600 font-bold text-xs"
                            title="حذف الإجراء من المحاكاة"
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* أزرار الإجراءات السفلية */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100">
          <p className="text-[11px] text-slate-500">
            💡 يمكنك تعديل الأسعار، تكلفة المعمل، المستهلكات ونسبة الطبيب مباشرة في الجدول لتجربة أثرها الفوري على هامش العيادة.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="py-2.5 px-6 rounded-xl bg-navy-900 text-white font-black text-xs hover:bg-navy-800 shadow-xs"
          >
            إغلاق المحلل
          </button>
        </div>
      </div>
    </div>
  );
}
