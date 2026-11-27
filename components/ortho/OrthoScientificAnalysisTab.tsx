"use client";

import React from "react";
import { CheckCircle2, AlertTriangle, BookOpen, ShieldCheck } from "lucide-react";
import type { ApprovedAnalysisSnapshot, OrthoWorkspaceRecord } from "@/lib/ortho-workspace-types";
import {
  MIN_CEPH_CONFIRMED_LANDMARKS,
  computeAshleyHowe,
  computeBoltonAnalysis,
  computeMoyersAnalysis,
  computeNanceAnalysis,
  computePermanentArchSpace,
  computePontIndex,
  computeTanakaJohnston,
} from "@/lib/ortho-scientific-analyses";

function parseNullableNum(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function OrthoScientificAnalysisTab({
  record,
  actorName,
  canEdit,
  canPerform,
  canApprove,
  onChange,
  onOpenCephTab,
}: {
  record: OrthoWorkspaceRecord;
  actorName: string;
  canEdit: boolean;
  canPerform: boolean;
  canApprove: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
  onOpenCephTab?: () => void;
}) {
  const teeth = record.clinicalExam.teeth;
  const dentitionStage = record.clinicalExam.dentitionStage;
  const upperAvail = record.clinicalExam.intraoral.upperAvailableSpaceMm;
  const lowerAvail = record.clinicalExam.intraoral.lowerAvailableSpaceMm;
  const cast = record.castInputs;

  const boltonAnt = computeBoltonAnalysis(teeth, "anterior");
  const boltonAll = computeBoltonAnalysis(teeth, "overall");
  const spaceUpper = computePermanentArchSpace({ teeth, arch: "upper", availableSpaceMm: upperAvail });
  const spaceLower = computePermanentArchSpace({ teeth, arch: "lower", availableSpaceMm: lowerAvail });
  const moyers = computeMoyersAnalysis({
    teeth,
    dentitionStage,
    percentile: cast.moyersPercentile,
    upperAvailableSpaceMm: upperAvail,
    lowerAvailableSpaceMm: lowerAvail,
  });
  const tanaka = computeTanakaJohnston({
    teeth,
    dentitionStage,
    upperAvailableSpaceMm: upperAvail,
    lowerAvailableSpaceMm: lowerAvail,
  });
  const nance = computeNanceAnalysis({
    teeth,
    dentitionStage,
    upperAvailableSpaceMm: upperAvail,
    lowerAvailableSpaceMm: lowerAvail,
    nanceUpperPredictedMm: cast.nanceUpperPredictedMm,
    nanceLowerPredictedMm: cast.nanceLowerPredictedMm,
  });
  const pont = computePontIndex({
    teeth,
    measuredPremolarWidthMm: cast.upperPremolarWidthMm,
    measuredMolarWidthMm: cast.upperMolarWidthMm,
  });
  const howe = computeAshleyHowe({
    teeth,
    premolarBasalArchWidthMm: cast.premolarBasalArchWidthMm,
  });

  const updateCast = (patch: Partial<typeof cast>) =>
    onChange({ ...record, castInputs: { ...cast, ...patch } });

  const approveSnapshot = (snap: Omit<ApprovedAnalysisSnapshot, "id" | "approvedBy" | "approvedAt">) => {
    if (!canApprove) return;
    const approvedAtIso = new Date().toISOString();
    const item: ApprovedAnalysisSnapshot = {
      ...snap,
      id: `an-${snap.type}-${record.approvedAnalyses.length + 1}-${approvedAtIso}`,
      approvedBy: actorName,
      approvedAt: approvedAtIso,
    };
    const filtered = record.approvedAnalyses.filter((a) => a.type !== snap.type || a.titleAr !== snap.titleAr);
    onChange({ ...record, approvedAnalyses: [item, ...filtered] });
  };

  if (!canPerform && record.approvedAnalyses.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold text-amber-900">
        صلاحية إجراء القياسات والتحليلات غير مفعّلة لحسابك.
      </div>
    );
  }

  return (
    <div className="space-y-4 text-xs">
      {/* Cephalometric Standard Gate Banner */}
      <div className="rounded-xl border border-navy-200 bg-navy-50/50 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-extrabold text-navy-900">
            <ShieldCheck className="h-4 w-4 text-navy-800" />
            <span>ضابط التحليل السيفالومتري (Contemporary Orthodontics 7th Ed)</span>
          </div>
          <p className="text-[11px] text-slate-600">
            يُشترط قبل اعتماد أي تحليل سيفالومتري: معايرة مليمترية موثّقة (`mm/px`) + تأكيد الطبيب لحد أدنى{" "}
            <strong>{MIN_CEPH_CONFIRMED_LANDMARKS} معلمًا تشريحيًا</strong> + اكتمال المعالم الأساسية.
          </p>
        </div>
        {onOpenCephTab ? (
          <button
            type="button"
            onClick={onOpenCephTab}
            className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-extrabold text-white hover:bg-navy-900"
          >
            فتح استوديو السيفالومتري (WebCeph / CephTracer)
          </button>
        ) : null}
      </div>

      {/* Additional Cast Measurements Inputs (Pont, Ashley Howe, Nance, Moyers %) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h3 className="text-sm font-extrabold text-navy-900">مدخلات تحليلات النماذج والإطباق المختلط</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <label className="space-y-1">
            <span className="font-bold text-slate-600">نسبة مويرز (Moyers %)</span>
            <select
              disabled={!canEdit || !canPerform}
              value={cast.moyersPercentile}
              onChange={(e) => updateCast({ moyersPercentile: Number(e.target.value) as 50 | 75 | 85 | 95 })}
              className="w-full rounded-lg border border-slate-300 bg-white p-2"
            >
              <option value={50}>50%</option>
              <option value={75}>75% (المعتمد سريريًا)</option>
              <option value={85}>85%</option>
              <option value={95}>95%</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">عرض الضواحك 14–24 (mm)</span>
            <input
              type="number"
              step="0.1"
              disabled={!canEdit || !canPerform}
              value={cast.upperPremolarWidthMm ?? ""}
              onChange={(e) => updateCast({ upperPremolarWidthMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">عرض الأرحاء 16–26 (mm)</span>
            <input
              type="number"
              step="0.1"
              disabled={!canEdit || !canPerform}
              value={cast.upperMolarWidthMm ?? ""}
              onChange={(e) => updateCast({ upperMolarWidthMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">القاعدة العظمية PMBAW (mm)</span>
            <input
              type="number"
              step="0.1"
              disabled={!canEdit || !canPerform}
              value={cast.premolarBasalArchWidthMm ?? ""}
              onChange={(e) => updateCast({ premolarBasalArchWidthMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">تنبؤ نانس علوي/ربع (mm)</span>
            <input
              type="number"
              step="0.1"
              disabled={!canEdit || !canPerform}
              value={cast.nanceUpperPredictedMm ?? ""}
              onChange={(e) => updateCast({ nanceUpperPredictedMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
          <label className="space-y-1">
            <span className="font-bold text-slate-600">تنبؤ نانس سفلي/ربع (mm)</span>
            <input
              type="number"
              step="0.1"
              disabled={!canEdit || !canPerform}
              value={cast.nanceLowerPredictedMm ?? ""}
              onChange={(e) => updateCast({ nanceLowerPredictedMm: parseNullableNum(e.target.value) })}
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </label>
        </div>
      </div>

      {/* Analysis Cards Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 1. Bolton Analysis */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-extrabold text-navy-900">1. تحليل بولتون (Bolton Analysis)</h4>
            <span className="text-[10px] font-bold text-slate-500">Anterior 77.2% · Overall 91.3%</span>
          </div>

          {[
            { label: "الأمامي (6–6)", res: boltonAnt },
            { label: "الكلي (12–12)", res: boltonAll },
          ].map(({ label, res }) => (
            <div key={label} className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-800">{label}</span>
                {res.status === "calculated" && canApprove ? (
                  <button
                    type="button"
                    onClick={() =>
                      approveSnapshot({
                        type: "bolton",
                        titleAr: `تحليل بولتون ${label}`,
                        summaryAr: res.interpretationAr,
                        values: {
                          upperSumMm: res.upperSumMm,
                          lowerSumMm: res.lowerSumMm,
                          ratioPercent: res.ratioPercent,
                          excessMm: res.excessMm,
                        },
                        referenceCitation: res.reference,
                      })
                    }
                    className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white"
                  >
                    اعتماد ✓
                  </button>
                ) : null}
              </div>
              {res.status === "incomplete" ? (
                <p className="text-[11px] text-amber-800">
                  غير مكتمل — قياسات FDI الناقصة: {res.missingFdi.join("، ")}
                </p>
              ) : (
                <>
                  <p className="font-mono text-[11px] text-navy-900">
                    النسبة: <strong>{res.ratioPercent}%</strong> (علوي {res.upperSumMm} مم / سفلي {res.lowerSumMm} مم)
                  </p>
                  <p className="text-[11px] text-slate-700">{res.interpretationAr}</p>
                </>
              )}
            </div>
          ))}
        </div>

        {/* 2. Permanent Arch Space Discrepancy */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h4 className="text-sm font-extrabold text-navy-900">2. تحليل المساحة للقوس الدائم (Space Analysis)</h4>
          {[spaceUpper, spaceLower].map((sp) => (
            <div key={sp.arch} className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-1">
              <p className="font-bold text-slate-800">{sp.arch === "upper" ? "القوس العلوي (15–25)" : "القوس السفلي (45–35)"}</p>
              {sp.status === "incomplete" ? (
                <p className="text-[11px] text-amber-800">ناقص: {sp.missingFieldsAr.join(" · ")}</p>
              ) : (
                <p className="text-[11px] text-slate-700">{sp.interpretationAr}</p>
              )}
            </div>
          ))}
        </div>

        {/* 3. Moyers Mixed Dentition */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-extrabold text-navy-900">3. تحليل مويرز (Moyers Mixed Dentition)</h4>
            {moyers.status === "calculated" && canApprove ? (
              <button
                type="button"
                onClick={() =>
                  approveSnapshot({
                    type: "moyers",
                    titleAr: `تحليل مويرز (${moyers.percentile}%)`,
                    summaryAr: moyers.interpretationAr,
                    values: {
                      lowerIncisorsSumMm: moyers.lowerIncisorsSumMm,
                      predictedMaxillaryQuadrantMm: moyers.predictedMaxillaryQuadrantMm,
                      predictedMandibularQuadrantMm: moyers.predictedMandibularQuadrantMm,
                    },
                    referenceCitation: moyers.reference,
                  })
                }
                className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white"
              >
                اعتماد ✓
              </button>
            ) : null}
          </div>
          {moyers.status === "incomplete" ? (
            <p className="text-[11px] text-amber-800">ناقص قياسات القواطع السفلية FDI: {moyers.missingFdi.join("، ")}</p>
          ) : moyers.status === "out_of_range" ? (
            <p className="text-[11px] text-red-700">
              مجموع القواطع السفلية ({moyers.lowerIncisorsSumMm} مم) خارج نطاق جداول مويرز ({moyers.allowedRange}).
            </p>
          ) : (
            <div className="space-y-1 text-[11px]">
              {moyers.dentitionWarningAr ? (
                <p className="rounded bg-amber-50 px-2 py-1 font-bold text-amber-900">{moyers.dentitionWarningAr}</p>
              ) : null}
              <p className="text-slate-700">{moyers.interpretationAr}</p>
              <p className="text-slate-500">
                فارق المساحة السفلي: <strong>{moyers.lowerDiscrepancyMm ?? "—"} مم</strong> · العلوي:{" "}
                <strong>{moyers.upperDiscrepancyMm ?? "—"} مم</strong>
              </p>
            </div>
          )}
        </div>

        {/* 4. Tanaka & Johnston */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-extrabold text-navy-900">4. تحليل تاناكا وجونستون (Tanaka &amp; Johnston)</h4>
            {tanaka.status === "calculated" && canApprove ? (
              <button
                type="button"
                onClick={() =>
                  approveSnapshot({
                    type: "tanaka_johnston",
                    titleAr: "تحليل تاناكا وجونستون",
                    summaryAr: tanaka.interpretationAr,
                    values: {
                      lowerIncisorsSumMm: tanaka.lowerIncisorsSumMm,
                      predictedMaxillaryQuadrantMm: tanaka.predictedMaxillaryQuadrantMm,
                      predictedMandibularQuadrantMm: tanaka.predictedMandibularQuadrantMm,
                    },
                    referenceCitation: tanaka.reference,
                  })
                }
                className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white"
              >
                اعتماد ✓
              </button>
            ) : null}
          </div>
          {tanaka.status === "incomplete" ? (
            <p className="text-[11px] text-amber-800">ناقص قياسات القواطع السفلية FDI: {tanaka.missingFdi.join("، ")}</p>
          ) : (
            <div className="space-y-1 text-[11px]">
              {tanaka.dentitionWarningAr ? (
                <p className="rounded bg-amber-50 px-2 py-1 font-bold text-amber-900">{tanaka.dentitionWarningAr}</p>
              ) : null}
              <p className="text-slate-700">{tanaka.interpretationAr}</p>
              <p className="text-slate-500">
                فارق المساحة السفلي: <strong>{tanaka.lowerDiscrepancyMm ?? "—"} مم</strong> · العلوي:{" "}
                <strong>{tanaka.upperDiscrepancyMm ?? "—"} مم</strong>
              </p>
            </div>
          )}
        </div>

        {/* 5. Nance & Leeway Space */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-extrabold text-navy-900">5. تحليل نانس ومسافة Leeway (Nance Analysis)</h4>
            {nance.status === "calculated" && canApprove ? (
              <button
                type="button"
                onClick={() =>
                  approveSnapshot({
                    type: "nance",
                    titleAr: "تحليل نانس (Nance)",
                    summaryAr: nance.interpretationAr,
                    values: {
                      upperDiscrepancyMm: nance.upperDiscrepancyMm,
                      lowerDiscrepancyMm: nance.lowerDiscrepancyMm,
                    },
                    referenceCitation: nance.reference,
                  })
                }
                className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white"
              >
                اعتماد ✓
              </button>
            ) : null}
          </div>
          {nance.status === "incomplete" ? (
            <p className="text-[11px] text-amber-800">ناقص: {nance.missingFieldsAr.join(" · ")}</p>
          ) : (
            <p className="text-[11px] text-slate-700">{nance.interpretationAr}</p>
          )}
        </div>

        {/* 6. Pont's Index & Ashley Howe */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h4 className="text-sm font-extrabold text-navy-900">6. مؤشر بونت (Pont) وتحليل آشلي هاو (Ashley Howe)</h4>

          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-800">مؤشر بونت (Pont&apos;s Index)</span>
              {pont.status === "calculated" && canApprove ? (
                <button
                  type="button"
                  onClick={() =>
                    approveSnapshot({
                      type: "pont",
                      titleAr: "مؤشر بونت (استرشادي)",
                      summaryAr: pont.interpretationAr,
                      values: {
                        idealPremolarWidthMm: pont.idealPremolarWidthMm,
                        idealMolarWidthMm: pont.idealMolarWidthMm,
                        premolarDiffMm: pont.premolarDiffMm,
                        molarDiffMm: pont.molarDiffMm,
                      },
                      referenceCitation: pont.reference,
                    })
                  }
                  className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white"
                >
                  اعتماد ✓
                </button>
              ) : null}
            </div>
            {pont.status === "incomplete" ? (
              <p className="text-[11px] text-amber-800">ناقص: {pont.missingFieldsAr.join(" · ")}</p>
            ) : (
              <>
                <p className="text-[11px] text-slate-700">{pont.interpretationAr}</p>
                <p className="flex items-start gap-1 text-[10px] text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>{pont.scientificCaveatAr}</span>
                </p>
              </>
            )}
          </div>

          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-800">تحليل آشلي هاو (Ashley Howe)</span>
              {howe.status === "calculated" && canApprove ? (
                <button
                  type="button"
                  onClick={() =>
                    approveSnapshot({
                      type: "ashley_howe",
                      titleAr: "تحليل آشلي هاو (Ashley Howe)",
                      summaryAr: howe.interpretationAr,
                      values: {
                        ttmMm: howe.ttmMm,
                        pmbawMm: howe.pmbawMm,
                        ratioPercent: howe.ratioPercent,
                      },
                      referenceCitation: howe.reference,
                    })
                  }
                  className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white"
                >
                  اعتماد ✓
                </button>
              ) : null}
            </div>
            {howe.status === "incomplete" ? (
              <p className="text-[11px] text-amber-800">ناقص: {howe.missingFieldsAr.join(" · ")}</p>
            ) : (
              <p className="text-[11px] text-slate-700">{howe.interpretationAr}</p>
            )}
          </div>
        </div>
      </div>

      {/* Approved Analyses Ledger */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-extrabold text-navy-900">
          <BookOpen className="h-4 w-4" />
          <span>سجل التحليلات المعتمدة لهذه الحالة ({record.approvedAnalyses.length})</span>
        </div>
        {record.approvedAnalyses.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            لم يُعتمد أي تحليل بعد. لا تُدرج التحليلات في قائمة المشكلات أو Case Presentation قبل اعتماد الطبيب.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {record.approvedAnalyses.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2"
              >
                <div>
                  <p className="font-bold text-emerald-950 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    {a.titleAr}
                  </p>
                  <p className="text-[11px] text-slate-700">{a.summaryAr}</p>
                  <p className="text-[10px] text-slate-500">
                    المعتمد: {a.approvedBy} · {a.approvedAt.slice(0, 10)} · المرجع: {a.referenceCitation}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
