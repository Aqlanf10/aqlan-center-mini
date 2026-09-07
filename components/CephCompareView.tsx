"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CHANGE_LABEL, type ChangeDirection, type ComparedMeasurement } from "@/lib/cephCompare";

/**
 * عرض مقارنة تحليلين سيفالومتريين مع التراكب.
 * (مقارنة من مستودع الوكيل الآخر؛ التراكب معاد كتابته لإحداثياتنا.)
 *
 * الجدول يقول «SNA نزل ستّ درجات»؛ والرسم يُري **أين تحرّك الوجه**. والاثنان
 * هنا من مصدر واحد (`chronologicalOrder`) فلا يقول أحدهما غير ما يقوله الآخر.
 */

interface CompareResponse {
  before: {
    id: number; phase: string; xrayDate: string | null; createdAt: string;
    documentId: number; status: string;
    measurements: { code: string; name: string; unit: string; value: number; mean: number | null }[];
  };
  after: {
    id: number; phase: string; xrayDate: string | null; createdAt: string;
    documentId: number; status: string;
    measurements: { code: string; name: string; unit: string; value: number; mean: number | null }[];
  };
  comparison: {
    measurements: ComparedMeasurement[];
    onlyBefore: string[]; onlyAfter: string[];
    improved: number; worsened: number; steady: number;
  };
  summary: { ar: string; en: string };
}

interface SuperimposeResponse {
  before: {
    id: number; phase: string; xrayDate: string | null; documentId: number;
    documentWidth: number | null; documentHeight: number | null;
    lines: { from: { x: number; y: number }; to: { x: number; y: number }; label: string }[];
  };
  after: {
    id: number; phase: string; xrayDate: string | null; documentId: number;
    lines: { from: { x: number; y: number }; to: { x: number; y: number }; label: string }[];
  };
  rotationDegrees: number;
  cranialBaseBefore: number;
  cranialBaseAfter: number;
}

const DIRECTION_STYLE: Record<ChangeDirection, string> = {
  improved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  worsened: "bg-rose-50 text-rose-700 border-rose-200",
  steady: "bg-slate-50 text-slate-600 border-slate-200",
  ungraded: "bg-amber-50 text-amber-700 border-amber-200",
};

const PHASE_LABEL: Record<string, string> = {
  pretreatment: "قبل العلاج",
  midtreatment: "أثناء العلاج",
  posttreatment: "بعد العلاج",
  followup: "متابعة",
};

function formatDate(value: string | null): string {
  return value ?? "بلا تاريخ تصوير";
}

export function CephCompareView({ first, second, patientName }: {
  first: number; second: number; patientName: string;
}) {
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [superimpose, setSuperimpose] = useState<SuperimposeResponse | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/ceph/compare?first=${first}&second=${second}`);
        const payload = await response.json();
        if (!response.ok) {
          if (!cancelled) setError(payload?.message ?? "تعذّرت المقارنة.");
          return;
        }
        if (!cancelled) setComparison(payload as CompareResponse);
      } catch {
        if (!cancelled) setError("تعذّر الاتصال بالخادم.");
      }
      try {
        const response = await fetch(`/api/ceph/superimpose?first=${first}&second=${second}`);
        const payload = await response.json();
        if (!response.ok) {
          if (!cancelled) setOverlayError(payload?.message ?? "تعذّر التراكب.");
          return;
        }
        if (!cancelled) setSuperimpose(payload as SuperimposeResponse);
      } catch {
        if (!cancelled) setOverlayError("تعذّر الاتصال بالخادم.");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [first, second]);

  /* أبعاد شععة الأساس: المتصفّح حمّلها فقاسها — والقديم الذي رُفع قبل تخزين
     الأبعاد يظلّ يعمل من قياس المتصفّح نفسه. */
  const viewBox = useMemo(() => {
    if (imageSize) return `0 0 ${imageSize.w} ${imageSize.h}`;
    if (superimpose?.before.documentWidth && superimpose?.before.documentHeight) {
      return `0 0 ${superimpose.before.documentWidth} ${superimpose.before.documentHeight}`;
    }
    return null;
  }, [imageSize, superimpose]);

  if (error) {
    return <p className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700">{error}</p>;
  }
  if (!comparison) {
    return <p className="p-4 text-sm text-slate-400">جارٍ تحميل المقارنة…</p>;
  }

  const { before, after, comparison: table, summary } = comparison;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-800">
            مقارنة التحليلات السيفالومترية — {patientName}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            قبل: #{before.id} ({PHASE_LABEL[before.phase] ?? before.phase} — {formatDate(before.xrayDate)})
            {" ← "}
            بعد: #{after.id} ({PHASE_LABEL[after.phase] ?? after.phase} — {formatDate(after.xrayDate)})
          </p>
        </div>
        <a href={`/print/ceph-compare?first=${first}&second=${second}`} target="_blank" rel="noopener"
          className="rounded-xl bg-brand-navy px-4 py-2 text-xs font-extrabold text-white">
          طباعة تقرير المقارنة
        </a>
      </div>

      <p className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-bold text-sky-900">
        {summary.ar} — والحكم على العلاج للطبيب: الأداة تعدّ القياسات ولا تحكم.
      </p>

      {/* التراكب: الأقدم ثابتة والأحدث منقولة إليها على SN عند S */}
      {showOverlay ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="التراكب">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-extrabold text-navy-900">التراكب على قاعدة الجمجمة (SN عند S)</h2>
            <div className="flex items-center gap-3 text-[11px] font-bold">
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-6 bg-sky-600" /> قبل العلاج (#{before.id})
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-6 bg-rose-500" /> بعد العلاج (#{after.id}) — منقول
              </span>
            </div>
          </div>
          {overlayError ? (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
              {overlayError}
            </p>
          ) : !superimpose ? (
            <p className="mt-3 text-xs text-slate-400">جارٍ حساب التراكب…</p>
          ) : (
            <div className="mt-3">
              <div className="relative mx-auto max-w-[720px] overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imageRef}
                  src={`/api/documents/${superimpose.before.documentId}`}
                  alt="شععة التحليل الأقدم"
                  className="block w-full select-none"
                  draggable={false}
                  onLoad={(event) => {
                    const element = event.currentTarget;
                    setImageSize({ w: element.naturalWidth, h: element.naturalHeight });
                  }}
                />
                {viewBox ? (
                  <svg
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    viewBox={viewBox}
                    preserveAspectRatio="none"
                  >
                    {superimpose.before.lines.map((line, index) => (
                      <line
                        key={`b-${index}`}
                        x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}
                        stroke="#0ea5e9" strokeWidth={Math.max(2, (imageSize?.w ?? 800) / 300)}
                        opacity={0.85}
                      />
                    ))}
                    {superimpose.after.lines.map((line, index) => (
                      <line
                        key={`a-${index}`}
                        x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y}
                        stroke="#f43f5e" strokeWidth={Math.max(2, (imageSize?.w ?? 800) / 300)}
                        strokeDasharray={Math.max(6, (imageSize?.w ?? 800) / 100)}
                        opacity={0.9}
                      />
                    ))}
                  </svg>
                ) : null}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-bold text-slate-600 sm:grid-cols-4">
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  طول SN قبل: {superimpose.cranialBaseBefore.toFixed(1)} ملم
                </p>
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  طول SN بعد: {superimpose.cranialBaseAfter.toFixed(1)} ملم
                </p>
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  فرق النموّ: {(superimpose.cranialBaseAfter - superimpose.cranialBaseBefore).toFixed(1)} ملم
                </p>
                <p className="rounded-lg bg-slate-50 px-2 py-1">
                  زاوية المحاذاة: {superimpose.rotationDegrees.toFixed(1)}°
                </p>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                التحجيم من معايرة الصورتين وحده — لا على طول SN لئلا يُمحى النموّ: قاعدة
                الجمجمة تطول في الطفل، ومساواتها في الرسمين تُلغي بالضبط ما جاء التراكب
                ليُظهره. والمحاذاة على خطّ SN عند النقطة S، فما تحرّك بعدها تحرّك فعلًا.
              </p>
            </div>
          )}
        </section>
      ) : null}

      {/* جدول المقارنة: لا يُقارَن إلا ما قيس في الاثنتين */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="جدول المقارنة">
        <h2 className="text-xs font-extrabold text-navy-900">القياسات المشتركة بين التحليلين</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="p-2 text-right font-bold">القياس</th>
                <th className="p-2 font-bold">قبل</th>
                <th className="p-2 font-bold">بعد</th>
                <th className="p-2 font-bold">الفرق</th>
                <th className="p-2 text-right font-bold">الحكم</th>
              </tr>
            </thead>
            <tbody>
              {table.measurements.map((row) => (
                <tr key={row.key} className="border-b border-slate-100">
                  <td className="p-2 text-right font-bold text-slate-700">
                    {row.name}
                    <span className="mr-1 text-[10px] text-slate-400">{row.unit}</span>
                  </td>
                  <td className="p-2 text-center tabular-nums">{row.before.toFixed(1)}</td>
                  <td className="p-2 text-center tabular-nums font-bold">{row.after.toFixed(1)}</td>
                  <td className={`p-2 text-center tabular-nums font-extrabold ${row.delta > 0 ? "text-emerald-700" : row.delta < 0 ? "text-rose-700" : "text-slate-400"}`}>
                    {row.delta > 0 ? "+" : ""}{row.delta.toFixed(1)}
                  </td>
                  <td className="p-2">
                    <span className={`inline-block rounded-lg border px-2 py-0.5 text-[10px] font-extrabold ${DIRECTION_STYLE[row.direction]}`}>
                      {CHANGE_LABEL[row.direction].ar}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {table.measurements.length === 0 ? (
          <p className="mt-3 text-xs font-bold text-amber-700">
            لا قياسًا مشتركًا بين التحليلين — لا يُقارَنان.
          </p>
        ) : null}
        {table.onlyBefore.length > 0 || table.onlyAfter.length > 0 ? (
          <p className="mt-2 text-[11px] text-slate-500">
            قياساتٌ في أحدهما وحده لا تُقارَن (غياب النقطة ليس «ثباتًا»):
            {table.onlyBefore.length > 0 ? ` في القديم فقط ${table.onlyBefore.length}؛` : ""}
            {table.onlyAfter.length > 0 ? ` في الجديد فقط ${table.onlyAfter.length}.` : ""}
          </p>
        ) : null}
      </section>
    </div>
  );
}
