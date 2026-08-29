"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  computeAll, interpret, LANDMARK_ORDER, landmarkDef, MEASUREMENTS, round1, summarize,
  type LandmarkCode, type LandmarkMap, type MeasurementResult, type Pt,
} from "@/lib/ceph";

/**
 * مساحة رسم التحليل السيفالومتري.
 *
 * الطبيب يضع المعالم بالنقر على الشععة ويعدّلها بالسحب، والقياسات تجري حيًّا
 * أمامه من دوالّ الوحدة الخالصة نفسها التي تُختم في القاعدة عند الاعتماد — فما
 * يراه هو ما يُعتمد. والاعتماد يقلب الشاشة إلى قراءةٍ فقط: ما خُتم لا يُعدَّل،
 * والتصحيح نسخةٌ جديدة بمعالمها ومعايرتها.
 *
 * ولا خطوطٍ ولا أرقام تُحسب هنا داخل الملفّ: كل الرياضيات في `lib/ceph.ts`،
 * وهذا الملف عرضٌ وتحريكٌ وحفظٌ فقط.
 */

interface AnalysisProp {
  id: number;
  patientId: number;
  documentId: number;
  status: "draft" | "completed" | "discarded";
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
}

interface LandmarkProp {
  code: LandmarkCode;
  x: number;
  y: number;
  source: "manual" | "suggested";
}

interface StampedMeasurement {
  code: string;
  value: number;
}

const GUIDE_LINES: [LandmarkCode, LandmarkCode][] = [
  ["S", "N"], // الخط السهمي الأمامي
  ["Or", "Po"], // مستوى فرانكفورت
  ["Go", "Me"], // مستوى الفك السفلي
  ["N", "A"],
  ["N", "B"],
  ["N", "Pog"],
  ["OcclA", "OcclP"], // مستوى الإطباق
];

const STATUS_COLOR: Record<string, string> = {
  within: "text-emerald-700",
  above: "text-blue-700",
  below: "text-red-700",
};

export function CephTracer({
  patientName,
  analysis,
  initialLandmarks,
  stamped,
}: {
  patientName: string;
  analysis: AnalysisProp;
  initialLandmarks: LandmarkProp[];
  stamped: StampedMeasurement[] | null;
}) {
  const completed = analysis.status === "completed";
  const [points, setPoints] = useState<LandmarkMap>(() => {
    const map: LandmarkMap = {};
    for (const lm of initialLandmarks) map[lm.code] = { x: lm.x, y: lm.y };
    return map;
  });
  const [scale, setScale] = useState<number | null>(analysis.mmPerPixel);
  const [calibration, setCalibration] = useState<AnalysisProp["calibration"]>(analysis.calibration);
  const [active, setActive] = useState<LandmarkCode | null>(null);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [calMode, setCalMode] = useState<{ p1: Pt | null; p2: Pt | null } | null>(null);
  const [calMm, setCalMm] = useState("10");
  const [showGuides, setShowGuides] = useState(true);
  const [results, setResults] = useState(() => {
    const map: LandmarkMap = {};
    for (const lm of initialLandmarks) map[lm.code] = { x: lm.x, y: lm.y };
    // صفوف الجدول (الأسماء والمجموعات والمدايات) من سجل التعريفات دائمًا؛ أما
    // **القيم المعروضة** للمعتمد فتأتي من اللقطة حصراً في الأسفل — الحساب الحي
    // لا يجدد رقمًا معتمدًا.
    return computeAll(map, analysis.mmPerPixel ?? NaN);
  });
  const dragging = useRef<LandmarkCode | null>(null);

  /** حفظ نقطة واحدة — كتابةٌ فوقية برمزها، والخادم يرفض إن كان المعتمد. */
  const savePoint = useCallback(async (code: LandmarkCode, pt: Pt) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/ceph/${analysis.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ landmarks: [{ code, x: pt.x, y: pt.y, source: "manual" }] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage(data.message ?? "تعذّر الحفظ.");
      }
    } catch {
      setMessage("تعذّر الاتصال — النقطة على الشاشة فقط ولم تُحفَظ.");
    } finally {
      setSaving(false);
    }
  }, [analysis.id]);

  const placePoint = useCallback((code: LandmarkCode, pt: Pt) => {
    const snapped = { x: round1(pt.x), y: round1(pt.y) };
    const next = { ...points, [code]: snapped };
    setPoints(next);
    if (!completed) setResults(computeAll(next, scale ?? NaN));
    if (!completed) void savePoint(code, snapped);
  }, [completed, points, savePoint, scale]);

  /** تحويل إحداثيات النقر إلى إحداثيات الصورة الطبيعية. */
  const imagePoint = (e: React.MouseEvent): Pt | null => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (!natural) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * natural.w,
      y: ((e.clientY - rect.top) / rect.height) * natural.h,
    };
  };

  const onSurfaceClick = (e: React.MouseEvent) => {
    if (completed || !natural) return;
    const pt = imagePoint(e);
    if (!pt) return;
    // وضع المعايرة يسبق وضع المعالم — حتى تُعرض الأطوال بالمليمتر منذ أول نقطة.
    if (calMode) {
      if (!calMode.p1) { setCalMode({ p1: pt, p2: null }); return; }
      setCalMode({ p1: calMode.p1, p2: pt });
      return;
    }
    const code = active ?? LANDMARK_ORDER.find((c) => points[c] == null) ?? null;
    if (!code) { setMessage("كل المعالم موضوعة."); return; }
    placePoint(code, pt);
    const remaining = LANDMARK_ORDER.filter((c) => c !== code && points[c] == null);
    setActive(remaining[0] ?? null);
  };

  const onPointerDown = (code: LandmarkCode) => (e: React.PointerEvent) => {
    if (completed || calMode) return;
    dragging.current = code;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const code = dragging.current;
    if (!code || !natural) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const pt = {
      x: ((e.clientX - rect.left) / rect.width) * natural.w,
      y: ((e.clientY - rect.top) / rect.height) * natural.h,
    };
    const next = { ...points, [code]: pt };
    setPoints(next);
    if (!completed) setResults(computeAll(next, scale ?? NaN));
  };

  const onPointerUp = () => {
    const code = dragging.current;
    dragging.current = null;
    const pt = code ? points[code] : null;
    if (code && pt) void savePoint(code, pt);
  };

  const saveCalibration = async () => {
    if (!calMode?.p1 || !calMode?.p2) return;
    const mm = Number(calMm);
    if (!Number.isFinite(mm) || mm <= 0) { setMessage("أدخل المسافة الحقيقية بالمليمتر."); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/ceph/${analysis.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calibration: {
            x1: round1(calMode.p1.x), y1: round1(calMode.p1.y),
            x2: round1(calMode.p2.x), y2: round1(calMode.p2.y),
            mm,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCalibration({ x1: round1(calMode.p1.x), y1: round1(calMode.p1.y), x2: round1(calMode.p2.x), y2: round1(calMode.p2.y), mm });
        // المقياس يعود من الخادم نفسه — لا يُحسب في المتصفّح.
        const study = await fetch(`/api/ceph/${analysis.id}`);
        if (study.ok) {
          const s = await study.json();
          setScale(s.analysis?.mmPerPixel ?? null);
          setResults(computeAll(points, s.analysis?.mmPerPixel ?? NaN));
        }
        setCalMode(null);
        setMessage("المعايرة محفوظة.");
      } else {
        setMessage(data.message ?? "تعذّر حفظ المعايرة.");
      }
    } catch {
      setMessage("تعذّر الاتصال.");
    } finally {
      setSaving(false);
    }
  };

  const missing = LANDMARK_ORDER.filter((c) => points[c] == null);
  const canComplete = !completed && scale != null && missing.length === 0;

  const complete = async () => {
    if (!window.confirm("اعتماد التحليل يقفل التعديل ويختم القياسات. هل تريد الاعتماد؟")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/ceph/${analysis.id}/complete`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        window.location.href = `/ceph/${analysis.id}`;
      } else {
        setMessage(data.message ?? "تعذّر الاعتماد.");
      }
    } catch {
      setMessage("تعذّر الاتصال.");
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    if (!window.confirm("فتح نسخة تصحيح عن هذا التحليل المعتمد؟")) return;
    try {
      const res = await fetch(`/api/ceph/${analysis.id}/duplicate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) window.location.href = `/ceph/${data.id}`;
      else setMessage(data.message ?? "تعذّر فتح النسخة.");
    } catch {
      setMessage("تعذّر الاتصال.");
    }
  };

  const discard = async () => {
    const note = window.prompt("سبب رفض المسودة (يُوثَّق باسمك):");
    if (note === null) return;
    try {
      const res = await fetch(`/api/ceph/${analysis.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note || "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) window.location.href = `/patients/${analysis.patientId}?tab=ceph`;
      else setMessage(data.message ?? "تعذّر الرفض.");
    } catch {
      setMessage("تعذّر الاتصال.");
    }
  };

  // جدول المسودة يجري حيًّا؛ وجدول المعتمد يقرأ اللقطة: القيم من ceph_measurements
  // وحدها مع تفسيرها على سجل التعريفات نفسه — لا رقم معتمد يُعاد حسابه.
  const table = useMemo((): MeasurementResult[] => {
    if (!(completed && stamped)) return results;
    const snap = new Map(stamped.map((s) => [s.code, s.value]));
    return results.map((r) => {
      const v = snap.get(r.code);
      if (v == null || !Number.isFinite(v)) {
        return { ...r, value: null, display: "—", status: null };
      }
      const def = MEASUREMENTS.find((d) => d.code === r.code);
      return { ...r, value: v, display: String(v), status: def ? interpret(v, def) : r.status };
    });
  }, [completed, stamped, results]);

  const summary = useMemo(() => {
    // الخلاصة تقرأ من صفوف الجدول نفسها: حيّة للمسودة، ومن اللقطة للمعتمد.
    return table ? summarize(table) : null;
  }, [table]);

  const nextToPlace = completed ? null : (active ?? missing[0] ?? null);

  return (
    <div className="space-y-3">
      {/* الشريط العلوي */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <Link href={`/patients/${analysis.patientId}?tab=ceph`} className="text-sm text-blue-700 hover:underline">
          ← ملف {patientName}
        </Link>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${completed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {completed ? `معتمد — ${analysis.completedBy ?? ""}` : "مسودة"}
        </span>
        <span className="text-xs text-slate-500">
          المقياس: {scale != null ? `${(1 / scale).toFixed(1)} بكسل/مم` : "غير معايَر — القياسات الطولية معطّلة"}
        </span>
        <div className="grow" />
        {!completed && (
          <>
            <button
              type="button"
              onClick={() => setCalMode(calMode ? null : { p1: null, p2: null })}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${calMode ? "border-amber-300 bg-amber-50 text-amber-700" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}
            >
              {calMode ? "إلغاء المعايرة" : calibration ? "تصحيح المعايرة" : "معايرة الشععة"}
            </button>
            <button
              type="button"
              onClick={() => void complete()}
              disabled={!canComplete || saving}
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              title={scale == null ? "المعايرة أولًا" : missing.length > 0 ? `ناقص: ${missing.join("، ")}` : ""}
            >
              اعتماد التحليل
            </button>
            <button
              type="button"
              onClick={() => void discard()}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              رفض المسودة
            </button>
          </>
        )}
        {completed && (
          <button
            type="button"
            onClick={() => void duplicate()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            نسخة تصحيح جديدة
          </button>
        )}
      </div>

      {/* وضع المعايرة */}
      {calMode && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">
            المعايرة: انقر النقطة الأولى {calMode.p1 ? "ثم الثانية" : "على عنصرٍ معلوم طوله"}
            {calMode.p2 ? " — ثم أدخل المسافة الحقيقية" : ""}
          </p>
          <p className="mt-1 text-xs">
            كرة معايرة أو مسطرة مدمجة في الشععة. كل القياسات الطولية تُضرب في المقياس
            الناتج، والزوايا لا تحتاج المعايرة. <b>الاعتماد لا يمرّ بلا معايرة.</b>
          </p>
          {calMode.p1 && calMode.p2 && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={calMm}
                onChange={(e) => setCalMm(e.target.value)}
                className="w-28 rounded-lg border border-amber-300 px-2 py-1 text-sm"
              />
              <span className="text-xs">مم بين النقطتين</span>
              <button
                type="button"
                onClick={() => void saveCalibration()}
                disabled={saving}
                className="rounded-lg bg-amber-700 px-3 py-1 text-xs font-medium text-white"
              >
                حفظ المعايرة
              </button>
            </div>
          )}
        </div>
      )}

      {message && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">{message}</p>
      )}

      <div className="flex flex-col gap-3 lg:flex-row">
        {/* لوحة الرسم */}
        <div className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="text-slate-500">تكبير:</span>
            {[1, 2, 3, 4].map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoom(z)}
                className={`rounded-md border px-2 py-0.5 ${zoom === z ? "border-navy-800 bg-navy-800 text-white" : "border-slate-300 text-slate-600"}`}
              >
                {z}×
              </button>
            ))}
            <label className="ms-3 flex items-center gap-1 text-slate-600">
              <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
              الخطوط الاستدلالية
            </label>
            {saving && <span className="ms-2 text-slate-400">يحفظ…</span>}
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-100">
            <div
              onClick={onSurfaceClick}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="relative cursor-crosshair"
              style={{ width: natural ? natural.w * zoom : 640, height: natural ? natural.h * zoom : 480 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/documents/${analysis.documentId}`}
                alt="الشععة السيفالومترية"
                className="absolute inset-0 h-full w-full select-none"
                draggable={false}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setNatural({ w: el.naturalWidth, h: el.naturalHeight });
                }}
              />
              {natural && (
                <svg
                  className="absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${natural.w} ${natural.h}`}
                  preserveAspectRatio="none"
                >
                  {showGuides && GUIDE_LINES.map(([a, b]) => {
                    const pa = points[a];
                    const pb = points[b];
                    if (!pa || !pb) return null;
                    return (
                      <line
                        key={`${a}${b}`}
                        x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                        stroke="rgba(37,99,235,0.45)" strokeWidth={Math.max(1, 1.2 / zoom)}
                        strokeDasharray={`${6 / zoom} ${4 / zoom}`}
                      />
                    );
                  })}
                  {calMode?.p1 && calMode?.p2 && (
                    <line
                      x1={calMode.p1.x} y1={calMode.p1.y} x2={calMode.p2.x} y2={calMode.p2.y}
                      stroke="#b45309" strokeWidth={Math.max(1.5, 2 / zoom)}
                    />
                  )}
                  {calMode?.p1 && !calMode.p2 && (
                    <circle cx={calMode.p1.x} cy={calMode.p1.y} r={Math.max(3, 5 / zoom)} fill="#b45309" />
                  )}
                  {(Object.keys(points) as LandmarkCode[]).map((code) => {
                    const pt = points[code];
                    if (!pt) return null;
                    const isDragging = dragging.current === code;
                    return (
                      <g key={code}>
                        <circle
                          cx={pt.x} cy={pt.y}
                          r={Math.max(4, 7 / zoom)}
                          fill={isDragging ? "#dc2626" : "#1e3a5f"}
                          stroke="#ffffff"
                          strokeWidth={Math.max(1, 1.5 / zoom)}
                          className={completed ? "" : "cursor-grab"}
                          onPointerDown={onPointerDown(code)}
                        />
                        <text
                          x={pt.x + 10 / zoom} y={pt.y - 10 / zoom}
                          fontSize={Math.max(10, 14 / zoom)}
                          fill="#1e3a5f"
                          className="pointer-events-none select-none"
                        >
                          {code}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              )}
            </div>
          </div>
          {!completed && nextToPlace && (
            <p className="mt-2 text-sm">
              <span className="text-slate-500">المعلم التالي: </span>
              <b>{landmarkDef(nextToPlace).ar}</b>
              <span className="text-slate-500"> ({nextToPlace}) — {landmarkDef(nextToPlace).hint}</span>
            </p>
          )}
          {!completed && (
            <div className="mt-2 flex flex-wrap gap-1">
              {LANDMARK_ORDER.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setActive(code)}
                  title={landmarkDef(code).hint}
                  className={`rounded-md border px-2 py-0.5 text-xs ${points[code] ? "border-slate-200 bg-slate-50 text-slate-600" : "border-dashed border-amber-300 bg-amber-50 text-amber-700"} ${active === code ? "ring-2 ring-navy-800" : ""}`}
                >
                  {code}{points[code] ? " ✓" : ""}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* جدول القياسات */}
        <div className="w-full shrink-0 lg:w-96">
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">
              {completed ? "القياسات المعتمدة — لقطة الاعتماد" : "القياسات — حيّة مع كل نقطة"}
            </div>
            <div className="max-h-[70vh] overflow-auto p-2">
              {table == null ? (
                <p className="p-2 text-sm text-slate-500">—</p>
              ) : (
                (["sagittal", "vertical", "dental"] as const).map((group) => (
                  <div key={group} className="mb-3">
                    <p className="px-2 py-1 text-xs font-medium text-slate-400">
                      {group === "sagittal" ? "الهيكلي — أفقي" : group === "vertical" ? "الهيكلي — عمودي" : "الأسنان"}
                    </p>
                    <table className="w-full text-sm">
                      <tbody>
                        {table.filter((r) => r.group === group).map((r) => (
                          <tr key={r.code} className="border-b border-slate-100 last:border-0">
                            <td className="px-2 py-1.5 text-slate-700">{r.ar}</td>
                            <td className={`px-2 py-1.5 text-left font-mono font-medium ${r.status ? STATUS_COLOR[r.status] : "text-slate-400"}`}>
                              {completed && stamped
                                ? stamped.find((s) => s.code === r.code)?.value ?? "—"
                                : r.display}
                              <span className="ms-0.5 text-xs font-normal text-slate-400">{r.value != null || completed ? r.unit : ""}</span>
                            </td>
                            <td className="px-2 py-1.5 text-left text-xs text-slate-400" title={`مرجع ${r.source}`}>
                              {r.mean}{r.unit === "%" ? "%" : r.unit === "mm" ? "" : "°"} ±{r.tol}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))
              )}
            </div>
            {summary && (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
                <p>{summary.skeletal}</p>
                <p>{summary.vertical}</p>
                <p className="mt-1 text-slate-400">
                  المعدلات مراجع أدبيات (وسائل عيّنات) تُقرأ مع الظاهر السريري — البرنامج
                  يقيس ولا يُشخّص.
                </p>
              </div>
            )}
            {completed && (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
                اعتمدها {analysis.completedBy} في {new Date(analysis.completedAt ?? "").toLocaleDateString("ar")}
                {analysis.note ? ` — ${analysis.note}` : ""}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
