"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { buildChart, CONDITION_LABEL, isValidTooth, toothName, type ToothRecord } from "@/lib/dental";
import type { ToothScopeMode } from "@/lib/invoice-clinical-linkage";
import { toggleTooth } from "../ToothPicker";
import { Odontogram } from "./Odontogram";
import { SurfaceSelector } from "./SurfaceSelector";
import { MODE_HINT, PER_TOOTH_SPLIT_NOTICE, multiSelect, type ToothSelection } from "./invoice-tooth-selection";

function isChartRecord(value: unknown): value is ToothRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "number" && Number.isSafeInteger(row.id)
    && typeof row.toothCode === "number" && isValidTooth(row.toothCode)
    && typeof row.condition === "string" && Object.hasOwn(CONDITION_LABEL, row.condition)
    && ["existing", "planned", "completed"].includes(String(row.stage))
    && typeof row.recordedAt === "string" && row.recordedAt.length > 0
    && typeof row.recordedBy === "string" && (row.surfaces === null || typeof row.surfaces === "string")
    && (row.note === null || typeof row.note === "string")
    && (row.visitId === null || (typeof row.visitId === "number" && Number.isSafeInteger(row.visitId)));
}

/**
 * (INV-LINK TOOTH) «تحديد الأسنان» لبند الفاتورة — المخطط السريري نفسه (`Odontogram`) لا محدِّدٌ جديد.
 *
 * يعرض حالة أسنان المريض الحقيقية حين تُقرأ (`GET /api/patients/{id}/chart` ثم `buildChart` كما في `DentalChart`)؛
 * وإن تعذّرت القراءة تُعرض هيئة الأسنان بحالة غير معروفة وتبقى قابلةً للاختيار. الاختيار المتعدد بـ`toggleTooth` من `ToothPicker`.
 * نافذةٌ عربية (RTL) وصفوف الأسنان بوضع المواجهة (`dir="ltr"`)؛ على الجوال لوحةٌ سفلية بعرض الشاشة والمخطط
 * يُمرَّر أفقيًا داخلها فقط. Escape أو «إلغاء» يغلق بلا تغيير.
 */
export function ToothSelectionDialog({ patientId, mode, serviceName, initial, onConfirm, onCancel }: {
  patientId: number;
  mode: ToothScopeMode;
  serviceName: string;
  initial: ToothSelection;
  onConfirm: (selection: ToothSelection) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const hintId = useId();
  const multi = multiSelect(mode);
  const [teeth, setTeeth] = useState<number[]>(() => [...initial.teeth].sort((a, b) => a - b));
  const [surfaces, setSurfaces] = useState<string[]>(() => initial.surfaces.split("").filter(Boolean));
  const [showPrimary, setShowPrimary] = useState(() => initial.teeth.some((tooth) => tooth >= 51));
  const [chartRead, setChartRead] = useState<{ patientId: number; records: ToothRecord[]; status: "ready" | "unavailable" } | null>(null);
  if (chartRead && chartRead.patientId !== patientId) setChartRead(null);
  const chartState = chartRead?.patientId === patientId ? chartRead.status : "loading";
  const panel = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; }, [onCancel]);

  // حالة الأسنان للعرض فقط — فشلها لا يمنع الاختيار.
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/patients/${patientId}/chart`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { records?: unknown } | null;
        if (controller.signal.aborted) return;
        if (response.ok && Array.isArray(payload?.records) && payload.records.every(isChartRecord)) {
          setChartRead({ patientId, records: payload.records, status: "ready" });
        } else setChartRead({ patientId, records: [], status: "unavailable" });
      })
      .catch(() => { if (!controller.signal.aborted) setChartRead({ patientId, records: [], status: "unavailable" }); });
    return () => controller.abort();
  }, [patientId]);

  const chart = useMemo(() => buildChart(chartRead?.patientId === patientId ? chartRead.records : []), [chartRead, patientId]);

  // Escape يغلق، والتركيز يدخل النافذة ويعود لزرّ الفتح بعد الإغلاق، والصفحة خلفها لا تتمرّر.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRef.current(); return; }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) { event.preventDefault(); panel.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) {
        event.preventDefault(); first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (panel.current && event.target instanceof Node && !panel.current.contains(event.target)) panel.current.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const pick = (code: number) => {
    // A surface selection describes one specific tooth and must never migrate to its replacement.
    if (!multi) setSurfaces([]);
    setTeeth((current) => multi ? toggleTooth(current, code) : current.includes(code) ? [] : [code]);
  };
  const needsTooth = mode !== "region";
  const canConfirm = !needsTooth || teeth.length > 0;
  const confirm = () => {
    if (!canConfirm) return;
    onConfirm({ teeth, surfaces: mode === "tooth_surfaces" ? surfaces.join("") : "", scope: initial.scope });
  };

  const summary = teeth.length === 0 ? "لم يُختر سن بعد — انقر على السن في المخطط."
    : multi ? `المختارة (${teeth.length}): ${teeth.join("، ")}`
    : `${teeth[0]} — ${toothName(teeth[0])}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/40 p-0 sm:items-center sm:p-4"
      onClick={onCancel} data-testid="tooth-dialog-backdrop">
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} tabIndex={-1}
        data-testid="tooth-dialog" data-mode={mode} data-chart-state={chartState}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[92vh] w-full min-w-0 max-w-4xl flex-col rounded-t-3xl bg-white shadow-2xl outline-none sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <h3 id={titleId} className="text-sm font-extrabold text-navy-900">تحديد الأسنان — {serviceName}</h3>
            <p id={hintId} className="mt-0.5 text-[11px] font-semibold text-slate-500">{MODE_HINT[mode]}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="إغلاق"
            className="min-h-[44px] min-w-[44px] shrink-0 rounded-xl bg-slate-100 text-xs font-black text-slate-600 hover:bg-slate-200">✕</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="font-semibold text-slate-500">
              {chartState === "loading" ? "جارٍ تحميل حالة الأسنان…"
                : chartState === "ready" ? "الألوان = حالة السن المسجّلة · النقطة البرتقالية = إجراء مخطط"
                : "تعذّر تحميل حالة الأسنان — تُعرض الأسنان دون حالتها ويبقى الاختيار ممكنًا."}
            </span>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-1.5 font-medium text-slate-600">
              <input type="checkbox" checked={showPrimary} onChange={(event) => setShowPrimary(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-navy-900 focus:ring-navy-900" />
              <span>إظهار الأسنان اللبنية (أطفال)</span>
            </label>
          </div>

          <div dir="ltr" className="overflow-x-auto overscroll-x-contain rounded-2xl border border-slate-200 bg-white p-2 shadow-card"
            data-testid="tooth-dialog-chart">
            <div className="mx-auto w-fit">
              <div className="mb-1 flex justify-between text-[10px] font-bold text-slate-400">
                <span>يمين المريض</span><span>يسار المريض</span>
              </div>
              <Odontogram chart={chart} selected={teeth} onPick={pick} showPrimary={showPrimary} chartKnown={chartState === "ready"} touch />
            </div>
          </div>

          {mode === "tooth_surfaces" && teeth.length > 0 ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <p className="mb-2 text-xs font-bold text-slate-700">أسطح السن {teeth[0]} (اختياري):</p>
              <SurfaceSelector value={surfaces} onChange={setSurfaces} />
            </div>
          ) : null}

          {mode === "per_tooth_episode" && teeth.length > 1 ? (
            <p role="status" data-testid="tooth-dialog-split-notice"
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
              {PER_TOOTH_SPLIT_NOTICE}: {teeth.join("، ")} — لا تُجمع عدة أسنان في حالة واحدة.
            </p>
          ) : null}
          {mode === "multi_tooth_episode" && teeth.length > 1 ? (
            <p role="status" className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-900">
              حلقةٌ واحدة: {teeth.join("، ")} — سطرٌ لكل سن في الفاتورة.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3">
          <p className="min-w-0 flex-1 basis-full text-xs font-bold text-navy-900 sm:basis-auto" data-testid="tooth-dialog-summary">
            {summary}
          </p>
          {teeth.length > 0 ? (
            <button type="button" onClick={() => { setTeeth([]); setSurfaces([]); }}
              className="min-h-[44px] rounded-xl px-3 text-xs font-bold text-red-700 hover:bg-red-50">
              مسح
            </button>
          ) : null}
          <button type="button" onClick={onCancel}
            className="min-h-[44px] flex-1 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 hover:bg-slate-50 sm:flex-none">
            إلغاء
          </button>
          <button type="button" onClick={confirm} disabled={!canConfirm} data-testid="tooth-dialog-confirm"
            className="min-h-[44px] flex-1 rounded-xl bg-navy-800 px-5 text-sm font-extrabold text-white shadow-md shadow-navy-900/20 hover:bg-navy-900 disabled:opacity-40 sm:flex-none">
            تأكيد الاختيار
          </button>
        </div>
      </div>
    </div>
  );
}
