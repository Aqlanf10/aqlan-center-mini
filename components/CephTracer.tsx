"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CEPH_SCHOOLS, computeAll, enrichWithRefs, generateCephExpertDiagnosis, interpret, LANDMARK_ORDER, landmarkDef, MEASUREMENTS, projectOnLine, REQUIRED_LANDMARKS, round1,
  suggestDiagnosis, suggestLandmarks, summarize,
  type CephSchool, type LandmarkCode, type LandmarkMap, type MeasurementResult, type Pt,
} from "@/lib/ceph";

/**
 * شريط الانحراف البياني الملون القياسي (يوازي نظام WebCeph).
 * يوضح موضع قياس المريض بالنسبة لمتوسط العينة والانحراف المعياري (Z-Score).
 * - الأخضر: النطاق المثالي والطبيعي (±1 SD)
 * - الأصفر: انحراف خفيف (1 إلى 2 SD)
 * - الأحمر: انحراف حاد وملحوظ (>2 SD)
 */
function CephDeviationGauge({
  value,
  mean,
  sd,
  unit,
}: {
  value: number | null;
  mean: number;
  sd: number;
  unit: string;
}) {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(sd) || sd <= 0) {
    return <div className="h-2 w-20 rounded-full bg-slate-100" title="غير متوفر" />;
  }

  const z = (value - mean) / sd;
  // تحويل Z إلى نسبة مئوية (50% عند z=0، المدى ±1 SD يشغل من 35% إلى 65%)
  let pos = 50 + (z * 15);
  pos = Math.max(4, Math.min(96, pos));

  return (
    <div
      className="relative flex h-2.5 w-24 shrink-0 items-center rounded-full bg-slate-100 p-0.5"
      title={`الدرجة المعيارية Z: ${z > 0 ? "+" : ""}${z.toFixed(2)} · القيمة: ${value}${unit} (المعدل: ${mean}±${sd}${unit})`}
    >
      <div className="flex h-full w-full overflow-hidden rounded-full opacity-85">
        <div className="w-[20%] bg-rose-400" title="انحراف حاد أدنى (<-2 SD)" />
        <div className="w-[15%] bg-amber-300" title="انحراف خفيف أدنى (-1 to -2 SD)" />
        <div className="w-[30%] bg-emerald-400" title="داخل المدى الطبيعي (±1 SD)" />
        <div className="w-[15%] bg-amber-300" title="انحراف خفيف أعلى (+1 to +2 SD)" />
        <div className="w-[20%] bg-rose-400" title="انحراف حاد أعلى (>+2 SD)" />
      </div>
      {/* مؤشر الدبوس لموضع المريض */}
      <div
        className="absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 -translate-x-1/2 rounded-full border border-slate-900 bg-white shadow"
        style={{ left: `${pos}%` }}
      />
    </div>
  );
}

interface AnalysisProp {
  id: number;
  patientId: number;
  documentId: number;
  status: "draft" | "completed" | "discarded";
  orthoCaseId: number | null;
  phase: "pretreatment" | "during" | "posttreatment" | "followup";
  xrayDate: string | null;
  device: string | null;
  refSet: string;
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  findings: { anb: number | null; fma: number | null; wits: number | null } | null;
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

interface DiagnosisProp {
  skeletal: string | null;
  dental: string | null;
  softTissue: string | null;
  note: string | null;
  finalDx: string;
  createdBy: string;
  updatedAt: string;
}

const GUIDE_LINES: [LandmarkCode, LandmarkCode][] = [
  ["S", "N"], // الخط السهمي الأمامي
  ["Or", "Po"], // مستوى فرانكفورت
  ["Go", "Me"], // مستوى الفك السفلي
  ["N", "A"],
  ["N", "B"],
  ["N", "Pog"],
  ["A", "Pog"], // الخط الشفوي العظمي APog
  ["ANS", "PNS"], // مستوى الحنك
  ["OcclA", "OcclP"], // مستوى الإطباق
];

const PHASE_LABEL: Record<string, string> = {
  pretreatment: "قبل العلاج",
  during: "أثناء العلاج",
  posttreatment: "بعد العلاج",
  followup: "متابعة",
};

const SEVERITY_COLOR: Record<string, string> = {
  within: "text-emerald-700",
  mild: "text-amber-700",
  marked: "text-rose-700",
};

const STATUS_COLOR: Record<string, string> = {
  within: "text-emerald-700",
  above: "text-blue-700",
  below: "text-red-700",
};

interface DxState {
  skeletal: string;
  dental: string;
  softTissue: string;
  note: string;
  finalDx: string;
}

export function CephTracer({
  patientName,
  patientBirthYear,
  analysis,
  initialLandmarks,
  stamped,
  refValues,
  refSetName,
  diagnosis,
}: {
  patientName: string;
  patientBirthYear: number | null;
  analysis: AnalysisProp;
  initialLandmarks: LandmarkProp[];
  stamped: StampedMeasurement[] | null;
  refValues: Record<string, { mean: number; sd: number }> | null;
  refSetName: string | null;
  diagnosis: DiagnosisProp | null;
}) {
  const completed = analysis.status === "completed";
  const [points, setPoints] = useState<LandmarkMap>(() => {
    const map: LandmarkMap = {};
    for (const lm of initialLandmarks) map[lm.code] = { x: lm.x, y: lm.y };
    return map;
  });
  const [sources, setSources] = useState<Record<string, "manual" | "suggested">>(() => {
    const map: Record<string, "manual" | "suggested"> = {};
    for (const lm of initialLandmarks) map[lm.code] = lm.source;
    return map;
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDxLoading, setAiDxLoading] = useState(false);
  const [scale, setScale] = useState<number | null>(analysis.mmPerPixel);
  const [calibration, setCalibration] = useState<AnalysisProp["calibration"]>(analysis.calibration);
  const [active, setActive] = useState<LandmarkCode | null>(null);
  const [selected, setSelected] = useState<LandmarkCode | null>(null);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [calMode, setCalMode] = useState<{ p1: Pt | null; p2: Pt | null } | null>(null);
  const [calMm, setCalMm] = useState("10");
  const [showGuides, setShowGuides] = useState(true);
  const [showFullTracing, setShowFullTracing] = useState(true);
  const [showLoupe, setShowLoupe] = useState(true);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [invert, setInvert] = useState(false);
  const [grayscale, setGrayscale] = useState(false);
  const [anonymize, setAnonymize] = useState(false);
  const [tracerStep, setTracerStep] = useState<"digitization" | "analysis" | "report">(
    completed ? "analysis" : "digitization"
  );
  const [analysisViewMode, setAnalysisViewMode] = useState<"table" | "chart">("table");
  const [hoveredPoint, setHoveredPoint] = useState<LandmarkCode | null>(null);
  const [selectedSchool, setSelectedSchool] = useState<CephSchool>("all");
  const [cursorSurfacePt, setCursorSurfacePt] = useState<Pt | null>(null);
  const [cursorClientPos, setCursorClientPos] = useState<{ x: number; y: number } | null>(null);
  const [history, setHistory] = useState<LandmarkMap[]>([]);
  const [future, setFuture] = useState<LandmarkMap[]>([]);

  const imageFilterStyle = useMemo(() => {
    const f: string[] = [];
    if (brightness !== 100) f.push(`brightness(${brightness}%)`);
    if (contrast !== 100) f.push(`contrast(${contrast}%)`);
    if (invert) f.push("invert(100%)");
    if (grayscale) f.push("grayscale(100%)");
    return f.length > 0 ? f.join(" ") : "none";
  }, [brightness, contrast, invert, grayscale]);
  const [results, setResults] = useState<MeasurementResult[]>(() => {
    const map: LandmarkMap = {};
    for (const lm of initialLandmarks) map[lm.code] = { x: lm.x, y: lm.y };
    // صفوف الجدول (الأسماء والمجموعات والمدايات) من سجل التعريفات دائمًا؛ أما
    // **القيم المعروضة** للمعتمد فتأتي من اللقطة حصراً في الأسفل — الحساب الحي
    // لا يجدد رقمًا معتمدًا.
    return computeAll(map, analysis.mmPerPixel ?? NaN);
  });
  const dragging = useRef<LandmarkCode | null>(null);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dx, setDx] = useState<DxState>(() => ({
    skeletal: diagnosis?.skeletal ?? "",
    dental: diagnosis?.dental ?? "",
    softTissue: diagnosis?.softTissue ?? "",
    note: diagnosis?.note ?? "",
    finalDx: diagnosis?.finalDx ?? "",
  }));
  const [dxDirty, setDxDirty] = useState(false);

  /** حفظ نقطة واحدة — كتابةٌ فوقية برمزها، والخادم يرفض إن كان المعتمد. */
  const savePoint = useCallback(async (code: LandmarkCode, pt: Pt) => {
    setSaving(true);
    setSources((s) => ({ ...s, [code]: "manual" }));
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

  const pushHistory = useCallback((snap: LandmarkMap) => {
    setHistory((h) => [...h.slice(-39), snap]);
    setFuture([]);
  }, []);

  const placePoint = useCallback((code: LandmarkCode, pt: Pt) => {
    const snapped = { x: round1(pt.x), y: round1(pt.y) };
    pushHistory(points);
    const next = { ...points, [code]: snapped };
    setPoints(next);
    setSelected(code);
    if (!completed) setResults(computeAll(next, scale ?? NaN));
    if (!completed) void savePoint(code, snapped);
  }, [completed, points, pushHistory, savePoint, scale]);

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
    if (!code) { setMessage("كل المعالم الإلزامية موضوعة — الإضافية تُختار من قائمتها."); return; }
    placePoint(code, pt);
    const remaining = LANDMARK_ORDER.filter((c) => c !== code && points[c] == null);
    setActive(remaining[0] ?? null);
  };

  const onPointerDown = (code: LandmarkCode) => (e: React.PointerEvent) => {
    if (completed || calMode) return;
    pushHistory(points);
    dragging.current = code;
    setSelected(code);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (points[code]) {
      setCursorSurfacePt(points[code]!);
      setCursorClientPos({ x: e.clientX, y: e.clientY });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const code = dragging.current;
    if (!natural) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const pt = {
      x: ((e.clientX - rect.left) / rect.width) * natural.w,
      y: ((e.clientY - rect.top) / rect.height) * natural.h,
    };
    if (code) {
      const next = { ...points, [code]: pt };
      setPoints(next);
      if (!completed) setResults(computeAll(next, scale ?? NaN));
      setCursorSurfacePt(pt);
      setCursorClientPos({ x: e.clientX, y: e.clientY });
    } else {
      // فحص اقتراب المؤشر من أي معلم موضوع لتشغيل عدسة التكبير الفائقة كمنصة WebCeph
      const threshold = Math.max(22, 32 / zoom);
      let nearest: LandmarkCode | null = null;
      let minD = Infinity;
      for (const [k, p] of Object.entries(points) as [LandmarkCode, Pt | undefined][]) {
        if (!p) continue;
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < threshold && d < minD) {
          minD = d;
          nearest = k;
        }
      }
      if (nearest && points[nearest]) {
        setHoveredPoint(nearest);
        setCursorSurfacePt(points[nearest]!);
        setCursorClientPos({ x: e.clientX, y: e.clientY });
      } else if (hoveredPoint) {
        setHoveredPoint(null);
        setCursorSurfacePt(null);
        setCursorClientPos(null);
      }
    }
  };

  const onSurfacePointerLeave = () => {
    if (!dragging.current) {
      setHoveredPoint(null);
      setCursorSurfacePt(null);
      setCursorClientPos(null);
    }
  };

  const onPointerUp = () => {
    const code = dragging.current;
    dragging.current = null;
    setCursorSurfacePt(null);
    setCursorClientPos(null);
    setHoveredPoint(null);
    const pt = code ? points[code] : null;
    if (code && pt) void savePoint(code, pt);
  };

  /** تحريك دقيق بالأسهم — خطوة بكسل، ومع Shift عشرة أضعافها، وحفظٌ مؤجَّل. */
  const nudge = useCallback((code: LandmarkCode, dxPx: number, dyPx: number) => {
    const current = points[code];
    if (!current) return;
    pushHistory(points);
    const next = { ...points, [code]: { x: current.x + dxPx, y: current.y + dyPx } };
    setPoints(next);
    if (!completed) setResults(computeAll(next, scale ?? NaN));
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => {
      const pt = next[code];
      if (pt) void savePoint(code, pt);
    }, 500);
  }, [completed, points, pushHistory, savePoint, scale]);

  /** التراجع والإعادة — ويكتب الفرقُ في القاعدة كي لا يختلّ ما رآه الخادم. */
  const persistDiff = useCallback((before: LandmarkMap, after: LandmarkMap) => {
    const codes = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<LandmarkCode>;
    for (const code of codes) {
      const b = before[code];
      const a = after[code];
      if (b?.x !== a?.x || b?.y !== a?.y) {
        if (a) void savePoint(code, a);
      }
    }
  }, [savePoint]);

  const undo = useCallback(() => {
    if (completed || history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [points, ...f].slice(0, 40));
    setPoints(prev);
    setResults(computeAll(prev, scale ?? NaN));
    persistDiff(points, prev);
  }, [completed, history, persistDiff, points, scale]);

  const redo = useCallback(() => {
    if (completed || future.length === 0) return;
    const nextMap = future[0];
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h.slice(-39), points]);
    setPoints(nextMap);
    setResults(computeAll(nextMap, scale ?? NaN));
    persistDiff(points, nextMap);
  }, [completed, future, persistDiff, points, scale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (completed) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (!selected || points[selected] == null) return;
      const step = e.shiftKey ? 10 : 1;
      const dxy: Record<string, [number, number]> = {
        ArrowUp: [0, -step], ArrowDown: [0, step],
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      };
      const d = dxy[e.key];
      if (!d) return;
      e.preventDefault();
      nudge(selected, d[0], d[1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [completed, nudge, points, redo, selected, undo]);

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

  const requiredMissing = REQUIRED_LANDMARKS.filter((c) => points[c] == null);
  const missing = LANDMARK_ORDER.filter((c) => points[c] == null);
  const canComplete = !completed && scale != null && requiredMissing.length === 0;
  const completionPct = Math.round(((REQUIRED_LANDMARKS.length - requiredMissing.length) / REQUIRED_LANDMARKS.length) * 100);
  const optionalMissing = LANDMARK_ORDER.filter((c) => points[c] == null && !REQUIRED_LANDMARKS.includes(c));

  const complete = async () => {
    if (!window.confirm("اعتماد التحليل يقفل التعديل ويختم القياسات والتشخيص. هل تريد الاعتماد؟")) return;
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

  const enriched = useMemo(() => enrichWithRefs(table, refValues), [table, refValues]);

  const summary = useMemo(() => (table ? summarize(table) : null), [table]);

  const saveDiagnosis = async () => {
    if (!dx.finalDx.trim()) { setMessage("الاستنتاج السيفالومتري لا يُترك فارغًا — حرّره ثم احفظ."); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/ceph/${analysis.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diagnosis: dx }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setDxDirty(false);
        setMessage("التشخيص محفوظ — سيمرّ مع الاعتماد كما كتبته.");
      } else {
        setMessage(data.message ?? "تعذّر حفظ التشخيص.");
      }
    } catch {
      setMessage("تعذّر الاتصال.");
    } finally {
      setSaving(false);
    }
  };

  const fillSuggestion = () => {
    if (!table) return;
    const s = suggestDiagnosis(table);
    setDx((prev) => ({
      skeletal: s.skeletal,
      dental: s.dental,
      softTissue: s.softTissue,
      note: prev.note,
      finalDx: prev.finalDx || `${s.skeletal}`,
    }));
    setDxDirty(true);
  };

  const autoLocateAi = async () => {
    if (completed) return;
    setAiLoading(true);
    setMessage("جاري استقراء واقتراح المعالم بالذكاء الاصطناعي وفق المعايير السيفالومترية…");
    try {
      const w = natural?.w || 1600;
      const h = natural?.h || 1600;
      const res = await fetch(`/api/ceph/${analysis.id}/ai-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suggest-landmarks", imageWidth: w, imageHeight: h, save: true }),
      });
      if (res.ok) {
        const data = await res.json();
        const nextPoints: LandmarkMap = { ...points };
        const nextSources: Record<string, "manual" | "suggested"> = { ...sources };
        for (const lm of data.landmarks) {
          nextPoints[lm.code as LandmarkCode] = { x: lm.x, y: lm.y };
          nextSources[lm.code] = "suggested";
        }
        pushHistory(points);
        setPoints(nextPoints);
        setSources(nextSources);
        setResults(computeAll(nextPoints, scale ?? NaN));
        setMessage("🔮 تم اقتراح المعالم بنجاح (ZONE_B: المعالم مقترحة بلون بنفسجي للمراجعة والاعتماد).");
      } else {
        const suggested = suggestLandmarks(w, h, points);
        const nextPoints = { ...suggested };
        const nextSources: Record<string, "manual" | "suggested"> = { ...sources };
        for (const code of Object.keys(suggested) as LandmarkCode[]) {
          if (!sources[code]) nextSources[code] = "suggested";
        }
        pushHistory(points);
        setPoints(nextPoints);
        setSources(nextSources);
        setResults(computeAll(nextPoints, scale ?? NaN));
        setMessage("🔮 تم استقراء المعالم وفق النسب التشريحية القياسية للشععة.");
      }
    } catch {
      const w = natural?.w || 1600;
      const h = natural?.h || 1600;
      const suggested = suggestLandmarks(w, h, points);
      pushHistory(points);
      setPoints(suggested);
      setResults(computeAll(suggested, scale ?? NaN));
      setMessage("🔮 تم وضع المعالم المقترحة (الذكاء الاصطناعي يقترح ولا يعتمد).");
    } finally {
      setAiLoading(false);
    }
  };

  const generateIntelligentDiagnosis = async () => {
    setAiDxLoading(true);
    setMessage("جاري توليد التشخيص التقويمي السردي وخطة العلاج الموجهة…");
    try {
      const res = await fetch(`/api/ceph/${analysis.id}/ai-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate-diagnosis", useAiChat: true }),
      });
      if (res.ok) {
        const data = await res.json();
        setDx({
          skeletal: data.suggestion.skeletal,
          dental: data.suggestion.dental,
          softTissue: data.suggestion.softTissue,
          finalDx: data.suggestion.finalDx,
          note: data.suggestion.recommendationsText,
        });
        setDxDirty(true);
        setMessage("🧠 تم توليد التشخيص التقويمي الذكي وخطة العلاج السردية — يرجى مراجعة الحقول والضغط على 'حفظ التشخيص'.");
      } else {
        const expert = generateCephExpertDiagnosis(table ?? results);
        setDx({
          skeletal: expert.formatted.skeletal,
          dental: expert.formatted.dental,
          softTissue: expert.formatted.softTissue,
          finalDx: expert.formatted.finalDx,
          note: expert.formatted.recommendationsText,
        });
        setDxDirty(true);
        setMessage("🧠 تم استنتاج التشخيص وخطة العلاج من محرك الخبير السيفالومتري المدمج.");
      }
    } catch {
      const expert = generateCephExpertDiagnosis(table ?? results);
      setDx({
        skeletal: expert.formatted.skeletal,
        dental: expert.formatted.dental,
        softTissue: expert.formatted.softTissue,
        finalDx: expert.formatted.finalDx,
        note: expert.formatted.recommendationsText,
      });
      setDxDirty(true);
      setMessage("🧠 تم توليد التشخيص من محرك التحليل المدمج.");
    } finally {
      setAiDxLoading(false);
    }
  };

  const nextToPlace = completed ? null : (active ?? missing[0] ?? null);
  const ageAtXray = analysis.xrayDate && patientBirthYear
    ? new Date(analysis.xrayDate).getUTCFullYear() - patientBirthYear
    : null;

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
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
          {PHASE_LABEL[analysis.phase] ?? analysis.phase}
        </span>
        {analysis.xrayDate && (
          <span className="text-xs text-slate-500">
            الشععة: {analysis.xrayDate}{ageAtXray != null ? ` — العمر وقتها ≈ ${ageAtXray} سنة` : ""}
          </span>
        )}
        {refSetName && (
          <span className="text-xs text-slate-500" title="مجموعة القيم المرجعية المعروضة في الجدول">
            المرجع: {refSetName}
          </span>
        )}
        <span className="text-xs text-slate-500">
          المقياس: {scale != null ? `${(1 / scale).toFixed(1)} بكسل/مم` : "غير معايَر — القياسات الطولية معطّلة"}
        </span>
        <div className="grow" />
        {!completed && (
          <>
            <button
              type="button"
              onClick={() => void autoLocateAi()}
              disabled={aiLoading || saving}
              className="rounded-lg border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-40 inline-flex items-center gap-1"
              title="يقترح مواقع المعالم الـ 25 بالذكاء الاصطناعي مع وسمها بـ 'suggested' (ZONE_B: اقتراح يتطلب تدقيق الطبيب)"
            >
              <span>🔮</span>
              <span>{aiLoading ? "جاري الاقتراح…" : "اقتراح المعالم الذكي (AI Auto-Locate)"}</span>
            </button>
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
              title={scale == null ? "المعايرة أولًا" : requiredMissing.length > 0 ? `ناقص: ${requiredMissing.join("، ")}` : ""}
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
        <Link
          href={`/print/ceph/${analysis.id}`}
          target="_blank"
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1 shadow-sm"
          title="طباعة التقرير السيفالومتري الرسمي A4 ثنائي اللغة"
        >
          <span>🖨️</span>
          <span>طباعة التقرير الرسمي</span>
        </Link>
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

      {/* شريط مسار العمل السيفالومتري كمنصة WebCeph (WebCeph 3-Stage Stepper) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-2.5 shadow-xs">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {/* الخطوة 1: الرسم والتحديد */}
          <button
            type="button"
            onClick={() => setTracerStep("digitization")}
            className={`flex items-center justify-between rounded-xl p-2.5 text-right transition-all border ${
              tracerStep === "digitization"
                ? "border-purple-600 bg-purple-50/90 text-purple-950 ring-2 ring-purple-500/20 shadow-xs"
                : "border-slate-200 bg-slate-50/60 text-slate-600 hover:bg-slate-100"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${
                tracerStep === "digitization" ? "bg-purple-700 text-white shadow-xs" : "bg-white text-slate-700 border border-slate-200"
              }`}>
                1
              </span>
              <div>
                <p className="text-xs font-black">1. تحديد المعالم والرسم</p>
                <p className="text-[10px] text-slate-500 font-mono">Digitization & Tracing</p>
              </div>
            </div>
            <span className="text-[11px] font-bold text-purple-700 bg-purple-100/80 px-2 py-0.5 rounded-full">
              {completionPct}%
            </span>
          </button>

          {/* الخطوة 2: التحليل والمدارس */}
          <button
            type="button"
            onClick={() => setTracerStep("analysis")}
            className={`flex items-center justify-between rounded-xl p-2.5 text-right transition-all border ${
              tracerStep === "analysis"
                ? "border-blue-600 bg-blue-50/90 text-blue-950 ring-2 ring-blue-500/20 shadow-xs"
                : "border-slate-200 bg-slate-50/60 text-slate-600 hover:bg-slate-100"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${
                tracerStep === "analysis" ? "bg-blue-700 text-white shadow-xs" : "bg-white text-slate-700 border border-slate-200"
              }`}>
                2
              </span>
              <div>
                <p className="text-xs font-black">2. التحليل والمدارس السبع</p>
                <p className="text-[10px] text-slate-500 font-mono">Ceph Analysis & Diagnosis</p>
              </div>
            </div>
            <span className="text-[11px] font-bold text-blue-700 bg-blue-100/80 px-2 py-0.5 rounded-full">
              49 قياساً
            </span>
          </button>

          {/* الخطوة 3: التقرير والمطابقة */}
          <button
            type="button"
            onClick={() => setTracerStep("report")}
            className={`flex items-center justify-between rounded-xl p-2.5 text-right transition-all border ${
              tracerStep === "report"
                ? "border-emerald-600 bg-emerald-50/90 text-emerald-950 ring-2 ring-emerald-500/20 shadow-xs"
                : "border-slate-200 bg-slate-50/60 text-slate-600 hover:bg-slate-100"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${
                tracerStep === "report" ? "bg-emerald-700 text-white shadow-xs" : "bg-white text-slate-700 border border-slate-200"
              }`}>
                3
              </span>
              <div>
                <p className="text-xs font-black">3. التقرير الرسمي والمطابقة</p>
                <p className="text-[10px] text-slate-500 font-mono">Superimposition & Report</p>
              </div>
            </div>
            <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded-full">
              A4 جاهز
            </span>
          </button>
        </div>
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

      {tracerStep === "report" ? (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          {/* رأس التقرير والمطابقة */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-700 text-base text-white shadow-xs">
                  📑
                </span>
                <div>
                  <h3 className="text-sm font-black text-navy-900">
                    التقرير السيفالومتري الرسمي والمطابقة (Ceph Report & Superimposition)
                  </h3>
                  <p className="text-xs text-slate-500">
                    تقرير تشخيصي معتمد ثنائي اللغة يطابق المعايير الأكاديمية والسريرية العالمية
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/print/ceph/${analysis.id}`}
                target="_blank"
                className="inline-flex items-center gap-1.5 rounded-xl bg-navy-800 px-4 py-2 text-xs font-black text-white shadow hover:bg-navy-900 transition-colors"
              >
                <span>🖨️</span>
                <span>فتح وطباعة التقرير الرسمي A4</span>
              </Link>
              {!completed && (
                <button
                  type="button"
                  onClick={() => void complete()}
                  disabled={!canComplete || saving}
                  className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-black text-white shadow hover:bg-emerald-800 disabled:opacity-40 transition-colors"
                >
                  ✓ اعتماد التحليل النهائي
                </button>
              )}
            </div>
          </div>

          {/* بطاقات المؤشرات التشخيصية الرئيسية */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">العلاقة الفكية ANB</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "ANB")?.value != null ? `${enriched.find((r) => r.code === "ANB")?.value}°` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "ANB")?.interpretationAr ?? ""}
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">زاوية المستوى الفكي FMA</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "FMA")?.value != null ? `${enriched.find((r) => r.code === "FMA")?.value}°` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "FMA")?.interpretationAr ?? ""}
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">تقييم ويتس Wits</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "WITS")?.value != null ? `${enriched.find((r) => r.code === "WITS")?.value} مم` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "WITS")?.interpretationAr ?? ""}
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">بروفايل ريكتس (E-Line UL)</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "E_LINE_UL")?.value != null ? `${enriched.find((r) => r.code === "E_LINE_UL")?.value} مم` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "E_LINE_UL")?.interpretationAr ?? ""}
              </span>
            </div>
          </div>

          {/* ملخص التشخيص المنظم وخطة العلاج */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
            <h4 className="text-xs font-black text-navy-900">التشخيص السريري وخطة العلاج المعتمدة</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100">
                <span className="text-[10px] text-slate-500 font-bold block">التشخيص الهيكلي:</span>
                <p className="text-slate-800 font-medium">{dx.skeletal || summary?.skeletal || "—"}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100">
                <span className="text-[10px] text-slate-500 font-bold block">التشخيص السني:</span>
                <p className="text-slate-800 font-medium">{dx.dental || "—"}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100">
                <span className="text-[10px] text-slate-500 font-bold block">الأنسجة الرخوة والبروفايل:</span>
                <p className="text-slate-800 font-medium">{dx.softTissue || "—"}</p>
              </div>
            </div>
            {dx.finalDx && (
              <div className="rounded-lg bg-blue-50/70 p-2.5 border border-blue-200 text-xs">
                <span className="text-[10px] text-blue-900 font-bold block">الاستنتاج السيفالومتري النهائي:</span>
                <p className="text-blue-950 font-bold">{dx.finalDx}</p>
              </div>
            )}
            {dx.note && (
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100 text-xs">
                <span className="text-[10px] text-slate-500 font-bold block">توصيات خطة العلاج:</span>
                <p className="text-slate-700 whitespace-pre-line">{dx.note}</p>
              </div>
            )}
          </div>

          {/* المطابقة السيفالومترية والمقارنة التطورية (Superimposition) */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-lg">📐</span>
              <h4 className="text-xs font-black text-indigo-950">
                المطابقة السيفالومترية التطورية (Cephalometric Superimposition)
              </h4>
            </div>
            <p className="text-xs text-indigo-900 leading-relaxed">
              المطابقة السيفالومترية في طب التقويم تجري وفق المرجعية العالمية على مستوى قاعدة الجمجمة <b>(S-N Plane)</b> متمركزة على نقطة السرج التركي <b>(Sella S)</b> لمقارنة التغيرات الهيكلية ونمو الفكين ومحاور الأسنان بين مرحلة ما قبل العلاج (T1) وأثناء العلاج (T2) وما بعد العلاج (T3).
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link
                href={`/patients/${analysis.patientId}?tab=ceph`}
                className="rounded-lg bg-indigo-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-800 transition-colors"
              >
                استعراض مقارنة مراحل المريض الأخرى ←
              </Link>
              <button
                type="button"
                onClick={() => setTracerStep("analysis")}
                className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50"
              >
                ← العودة إلى التحليل والمدارس
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 lg:flex-row">
        {/* لوحة الرسم */}
        <div className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
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
            <label className="flex items-center gap-1 text-slate-600" title="عرض شبكة التخطيط الشعاعي والمستويات الهيكلية الكاملة كمنصة WebCeph">
              <input type="checkbox" checked={showFullTracing} onChange={(e) => setShowFullTracing(e.target.checked)} />
              شبكة التخطيط الكاملة
            </label>
            <label className="flex items-center gap-1 text-purple-700 font-medium" title="عدسة تكبير دائرية فائقة تظهر عند تحريك أو وضع المعالم">
              <input type="checkbox" checked={showLoupe} onChange={(e) => setShowLoupe(e.target.checked)} />
              🔍 عدسة التكبير (Loupe)
            </label>
            {!completed && (
              <>
                <button
                  type="button"
                  onClick={undo}
                  disabled={history.length === 0}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600 disabled:opacity-40"
                  title="تراجع (Ctrl+Z)"
                >
                  تراجع
                </button>
                <button
                  type="button"
                  onClick={redo}
                  disabled={future.length === 0}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600 disabled:opacity-40"
                  title="إعادة (Ctrl+Shift+Z)"
                >
                  إعادة
                </button>
              </>
            )}
            {saving && <span className="ms-2 text-slate-400">يحفظ…</span>}
          </div>

          {/* شريط أدوات معالجة الصورة وتحسين التباين والخصوصية (WebCeph Image Filters & Privacy) */}
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200/80 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
            <span className="font-semibold text-slate-600 inline-flex items-center gap-1">
              <span>🎨</span>
              <span>فلاتر الرؤية:</span>
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-500">سطوع:</span>
              <input
                type="range"
                min="50"
                max="180"
                step="5"
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                className="h-1.5 w-16 cursor-pointer appearance-none rounded-lg bg-slate-300"
                title={`السطوع: ${brightness}%`}
              />
              <span className="w-7 font-mono text-[10px] text-slate-500">{brightness}%</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-500">تباين:</span>
              <input
                type="range"
                min="50"
                max="200"
                step="5"
                value={contrast}
                onChange={(e) => setContrast(Number(e.target.value))}
                className="h-1.5 w-16 cursor-pointer appearance-none rounded-lg bg-slate-300"
                title={`التباين: ${contrast}%`}
              />
              <span className="w-7 font-mono text-[10px] text-slate-500">{contrast}%</span>
            </div>
            <button
              type="button"
              onClick={() => setInvert((v) => !v)}
              className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
                invert ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
              title="عكس الألوان السلبي لإبراز حواف العظم والشوكية الأنفية"
            >
              🌓 سلبي (Negative)
            </button>
            <button
              type="button"
              onClick={() => setGrayscale((v) => !v)}
              className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
                grayscale ? "border-slate-700 bg-slate-700 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
              title="تحويل إلى تدرج رمادي نقي لتقليل التشويش"
            >
              ⬛ رمادي
            </button>
            <button
              type="button"
              onClick={() => setAnonymize((v) => !v)}
              className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
                anonymize ? "border-purple-700 bg-purple-700 text-white shadow-sm" : "border-purple-300 bg-white text-purple-700 hover:bg-purple-50"
              }`}
              title="وضع شريط خصوصية لحجب هوية المريض وعينيه لعرض الحالة أو التدريس (WebCeph Privacy Mode)"
            >
              🕶️ حجب العينين (Privacy)
            </button>
            {(brightness !== 100 || contrast !== 100 || invert || grayscale) && (
              <button
                type="button"
                onClick={() => {
                  setBrightness(100);
                  setContrast(100);
                  setInvert(false);
                  setGrayscale(false);
                }}
                className="rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700 hover:bg-rose-100"
                title="إعادة ضبط الصورة للافتراضي"
              >
                إعادة ضبط
              </button>
            )}
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-100">
            <div
              onClick={onSurfaceClick}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onSurfacePointerLeave}
              className="relative cursor-crosshair"
              style={{ width: natural ? natural.w * zoom : 640, height: natural ? natural.h * zoom : 480 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/documents/${analysis.documentId}`}
                alt="الشععة السيفالومترية"
                className="absolute inset-0 h-full w-full select-none transition-[filter] duration-100"
                style={{ filter: imageFilterStyle }}
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
                  {/* الخطوط الاستدلالية الأساسية */}
                  {showGuides && GUIDE_LINES.map(([a, b]) => {
                    const pa = points[a];
                    const pb = points[b];
                    if (!pa || !pb) return null;
                    return (
                      <line
                        key={`guide-${a}${b}`}
                        x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                        stroke="rgba(37,99,235,0.45)" strokeWidth={Math.max(1, 1.2 / zoom)}
                        strokeDasharray={`${6 / zoom} ${4 / zoom}`}
                      />
                    );
                  })}

                  {/* شبكة التخطيط الشعاعي والهيكل المتجهي الكامل (WebCeph Vector Tracing) */}
                  {showFullTracing && (
                    <g key="full-tracing-skeleton">
                      {/* مستويات الجمجمة الأساسية */}
                      {points.S && points.N && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.N.x} y2={points.N.y} stroke="#2563eb" strokeWidth={Math.max(1.8, 2.5 / zoom)} />
                      )}
                      {points.Po && points.Or && (
                        <line x1={points.Po.x} y1={points.Po.y} x2={points.Or.x} y2={points.Or.y} stroke="#d97706" strokeWidth={Math.max(1.6, 2.2 / zoom)} />
                      )}
                      {points.Go && points.Me && (
                        <line x1={points.Go.x} y1={points.Go.y} x2={points.Me.x} y2={points.Me.y} stroke="#059669" strokeWidth={Math.max(1.8, 2.5 / zoom)} />
                      )}
                      {points.PNS && points.ANS && (
                        <line x1={points.PNS.x} y1={points.PNS.y} x2={points.ANS.x} y2={points.ANS.y} stroke="#0891b2" strokeWidth={Math.max(1.4, 1.8 / zoom)} />
                      )}
                      {points.OcclP && points.OcclA && (
                        <line x1={points.OcclP.x} y1={points.OcclP.y} x2={points.OcclA.x} y2={points.OcclA.y} stroke="#7c3aed" strokeWidth={Math.max(1.5, 2 / zoom)} />
                      )}

                      {/* الخطوط الهيكلية السهمية والمثلثات */}
                      {points.N && points.Pog && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.Pog.x} y2={points.Pog.y} stroke="#64748b" strokeWidth={Math.max(1, 1.4 / zoom)} strokeDasharray={`${4 / zoom} ${3 / zoom}`} />
                      )}
                      {points.S && points.Gn && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.Gn.x} y2={points.Gn.y} stroke="#8b5cf6" strokeWidth={Math.max(1, 1.4 / zoom)} strokeDasharray={`${5 / zoom} ${3 / zoom}`} />
                      )}
                      {points.N && points.A && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.A.x} y2={points.A.y} stroke="#94a3b8" strokeWidth={Math.max(1, 1.2 / zoom)} strokeDasharray={`${3 / zoom} ${2 / zoom}`} />
                      )}
                      {points.N && points.B && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.B.x} y2={points.B.y} stroke="#94a3b8" strokeWidth={Math.max(1, 1.2 / zoom)} strokeDasharray={`${3 / zoom} ${2 / zoom}`} />
                      )}
                      {points.A && points.Pog && (
                        <line x1={points.A.x} y1={points.A.y} x2={points.Pog.x} y2={points.Pog.y} stroke="#f59e0b" strokeWidth={Math.max(1, 1.4 / zoom)} strokeDasharray={`${4 / zoom} ${2 / zoom}`} />
                      )}

                      {/* مضلع بيورك وجاراك (Bjork-Jarabak Polygon: S-Ar and Ar-Go) */}
                      {points.S && points.Ar && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.Ar.x} y2={points.Ar.y} stroke="#0284c7" strokeWidth={Math.max(1.5, 2 / zoom)} />
                      )}
                      {points.Ar && points.Go && (
                        <line x1={points.Ar.x} y1={points.Ar.y} x2={points.Go.x} y2={points.Go.y} stroke="#0d9488" strokeWidth={Math.max(1.5, 2 / zoom)} />
                      )}

                      {/* خطوط قاعدة الجمجمة مع Basion */}
                      {points.N && points.Ba && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.Ba.x} y2={points.Ba.y} stroke="#0ea5e9" strokeWidth={Math.max(1.4, 1.8 / zoom)} strokeDasharray={`${4 / zoom} ${2 / zoom}`} />
                      )}
                      {points.S && points.Ba && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.Ba.x} y2={points.Ba.y} stroke="#0284c7" strokeWidth={Math.max(1.4, 1.8 / zoom)} />
                      )}

                      {/* محاور القواطع العلوية والسفلية */}
                      {points.U1A && points.U1 && (
                        <line x1={points.U1A.x} y1={points.U1A.y} x2={points.U1.x} y2={points.U1.y} stroke="#a855f7" strokeWidth={Math.max(1.5, 2 / zoom)} />
                      )}
                      {points.L1A && points.L1 && (
                        <line x1={points.L1A.x} y1={points.L1A.y} x2={points.L1.x} y2={points.L1.y} stroke="#c026d3" strokeWidth={Math.max(1.5, 2 / zoom)} />
                      )}

                      {/* مساقط ويتس العمودية على خط الإطباق (Wits Perpendiculars) */}
                      {points.A && points.OcclA && points.OcclP && (() => {
                        const fa = projectOnLine(points.A, points.OcclA, points.OcclP);
                        return (
                          <line x1={points.A.x} y1={points.A.y} x2={fa.x} y2={fa.y} stroke="#ec4899" strokeWidth={Math.max(1, 1.5 / zoom)} strokeDasharray={`${3 / zoom} ${2 / zoom}`} />
                        );
                      })()}
                      {points.B && points.OcclA && points.OcclP && (() => {
                        const fb = projectOnLine(points.B, points.OcclA, points.OcclP);
                        return (
                          <line x1={points.B.x} y1={points.B.y} x2={fb.x} y2={fb.y} stroke="#ec4899" strokeWidth={Math.max(1, 1.5 / zoom)} strokeDasharray={`${3 / zoom} ${2 / zoom}`} />
                        );
                      })()}
                    </g>
                  )}

                  {/* خط ريكتس الجمالي E-Line من Prn إلى PogS */}
                  {points.Prn && points.PogS && (
                    <g key="eline-ricketts">
                      <line
                        x1={points.Prn.x} y1={points.Prn.y}
                        x2={points.PogS.x} y2={points.PogS.y}
                        stroke="#db2777" strokeWidth={Math.max(1.8, 2.4 / zoom)}
                        strokeDasharray={`${6 / zoom} ${3 / zoom}`}
                      />
                      <text
                        x={(points.Prn.x + points.PogS.x) / 2 + 8 / zoom}
                        y={(points.Prn.y + points.PogS.y) / 2}
                        fontSize={Math.max(9, 12 / zoom)}
                        fill="#db2777"
                        fontWeight="bold"
                        className="pointer-events-none select-none"
                      >
                        E-Line (Ricketts)
                      </text>
                    </g>
                  )}

                  {/* شريط حجب هوية العينين للخصوصية الطبية (WebCeph Anonymization Mask) */}
                  {anonymize && (
                    <g key="anonymization-privacy-bar">
                      <rect
                        x={points.Or ? points.Or.x - 25 : (natural.w * 0.52)}
                        y={points.Or ? points.Or.y - 45 : (natural.h * 0.36)}
                        width={Math.max(100, 120 / zoom)}
                        height={Math.max(34, 40 / zoom)}
                        rx={Math.max(4, 6 / zoom)}
                        fill="#09090b"
                        opacity="0.96"
                      />
                      <text
                        x={points.Or ? points.Or.x + 35 : (natural.w * 0.61)}
                        y={points.Or ? points.Or.y - 23 : (natural.h * 0.39)}
                        fill="#f8fafc"
                        fontSize={Math.max(8, 10 / zoom)}
                        fontWeight="bold"
                        textAnchor="middle"
                        className="pointer-events-none select-none font-mono"
                      >
                        CONFIDENTIAL · سري
                      </text>
                    </g>
                  )}

                  {calMode?.p1 && calMode?.p2 && (
                    <line
                      x1={calMode.p1.x} y1={calMode.p1.y} x2={calMode.p2.x} y2={calMode.p2.y}
                      stroke="#b45309" strokeWidth={Math.max(1.5, 2 / zoom)}
                    />
                  )}
                  {calMode?.p1 && !calMode.p2 && (
                    <circle cx={calMode.p1.x} cy={calMode.p1.y} r={Math.max(3, 5 / zoom)} fill="#b45309" />
                  )}

                  {/* رسم المعالم التشريحية الـ 27 */}
                  {(Object.keys(points) as LandmarkCode[]).map((code) => {
                    const pt = points[code];
                    if (!pt) return null;
                    const isDragging = dragging.current === code;
                    const isSuggested = sources[code] === "suggested";
                    const isHovered = hoveredPoint === code;
                    const pointFill = isDragging || isHovered
                      ? "#dc2626"
                      : isSuggested
                      ? "#9333ea"
                      : "#1e3a5f";
                    return (
                      <g
                        key={code}
                        onPointerEnter={(e) => {
                          if (!dragging.current && pt) {
                            setHoveredPoint(code);
                            setCursorSurfacePt(pt);
                            setCursorClientPos({ x: e.clientX, y: e.clientY });
                          }
                        }}
                      >
                        {isSuggested && (
                          <circle
                            cx={pt.x} cy={pt.y}
                            r={Math.max(7, 12 / zoom)}
                            fill="none"
                            stroke="#c084fc"
                            strokeWidth={Math.max(1.2, 1.8 / zoom)}
                            strokeDasharray={`${3 / zoom} ${2 / zoom}`}
                          />
                        )}
                        <circle
                          cx={pt.x} cy={pt.y}
                          r={Math.max(isHovered ? 6 : 4, (isHovered ? 10 : 7) / zoom)}
                          fill={pointFill}
                          stroke="#ffffff"
                          strokeWidth={Math.max(1, 1.5 / zoom)}
                          className={completed ? "" : "cursor-grab"}
                          onPointerDown={onPointerDown(code)}
                        />
                        <text
                          x={pt.x + 10 / zoom} y={pt.y - 10 / zoom}
                          fontSize={Math.max(10, 14 / zoom)}
                          fill={isSuggested ? "#7e22ce" : "#1e3a5f"}
                          fontWeight={isSuggested || isHovered ? "bold" : "normal"}
                          className="pointer-events-none select-none"
                        >
                          {code}{isSuggested ? " ✦" : ""}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              )}
            </div>
          </div>

          {/* عدسة التكبير الرقمية الفائقة 2.5x (Precision Zoom Loupe كمنصة WebCeph) */}
          {showLoupe && cursorSurfacePt && cursorClientPos && natural && (
            <div
              className="pointer-events-none fixed z-50 flex flex-col items-center"
              style={{
                left: `${Math.max(16, Math.min(window.innerWidth - 170, cursorClientPos.x - 75))}px`,
                top: `${Math.max(16, cursorClientPos.y - 175)}px`,
              }}
            >
              <div className="relative h-36 w-36 overflow-hidden rounded-full border-2 border-slate-900 bg-slate-950 shadow-2xl ring-4 ring-purple-500/30">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/documents/${analysis.documentId}`}
                  alt="Magnified Ceph Loupe"
                  className="absolute select-none transition-[filter] duration-100"
                  style={{
                    width: natural.w * 2.5,
                    height: natural.h * 2.5,
                    maxWidth: "none",
                    transform: `translate(${72 - cursorSurfacePt.x * 2.5}px, ${72 - cursorSurfacePt.y * 2.5}px)`,
                    filter: imageFilterStyle,
                  }}
                />
                {/* شعيرات التقاطع الحمراء الحادة */}
                <div className="absolute inset-x-0 top-1/2 h-[1px] -translate-y-1/2 bg-rose-500/80" />
                <div className="absolute inset-y-0 left-1/2 w-[1px] -translate-x-1/2 bg-rose-500/80" />
                <div className="absolute top-1/2 left-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-rose-500/90" />
                {/* شارة المعلم والإحداثيات اللحظية */}
                <div className="absolute bottom-1.5 inset-x-0 mx-auto w-max rounded bg-slate-900/90 px-2 py-0.5 text-center font-mono text-[10px] text-white shadow">
                  {dragging.current
                    ? `${dragging.current} ✦ سحب `
                    : hoveredPoint
                    ? `${hoveredPoint} · ${landmarkDef(hoveredPoint).ar} `
                    : ""}
                  X: {Math.round(cursorSurfacePt.x)} · Y: {Math.round(cursorSurfacePt.y)}
                </div>
              </div>
            </div>
          )}
          {!completed && (
            <div className="mt-2 space-y-1">
              <p className="text-sm">
                <span className="text-slate-500">المعلم التالي: </span>
                {nextToPlace ? (
                  <>
                    <b>{landmarkDef(nextToPlace).ar}</b>
                    <span className="text-slate-500"> ({nextToPlace}) — {landmarkDef(nextToPlace).hint}</span>
                  </>
                ) : (
                  <span className="text-slate-500">كل الإلزامي موضوع — بقيت المعالم الاختيارية إن أردتها.</span>
                )}
              </p>
              <p className="text-xs text-slate-500">
                اكتمال الإلزامي: {completionPct}٪ ({REQUIRED_LANDMARKS.length - requiredMissing.length}/{REQUIRED_LANDMARKS.length})
                {selected && points[selected] && " — الأسهم تحرّك النقطة المحددة (مع Shift أسرع)، Ctrl+Z تراجع."}
              </p>
            </div>
          )}
          {!completed && (
            <div className="mt-2 flex flex-wrap gap-1">
              {LANDMARK_ORDER.map((code) => {
                const isSuggested = sources[code] === "suggested";
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setActive(code);
                      setSelected(code);
                    }}
                    title={`${landmarkDef(code).hint}${landmarkDef(code).required ? "" : " (اختياري)"}${isSuggested ? " [مقترح AI]" : ""}`}
                    className={`rounded-md border px-2 py-0.5 text-xs ${
                      points[code]
                        ? isSuggested
                          ? "border-purple-300 bg-purple-50 text-purple-800 font-medium"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                        : "border-dashed border-amber-300 bg-amber-50 text-amber-700"
                    } ${active === code || selected === code ? "ring-2 ring-navy-800" : ""}`}
                  >
                    {code}{points[code] ? (isSuggested ? " ✦" : " ✓") : ""}
                  </button>
                );
              })}
            </div>
          )}
          {optionalMissing.length > 0 && !completed && (
            <p className="mt-1 text-xs text-slate-400">
              اختيارية لم توضع بعد: {optionalMissing.join("، ")} — تخدم تحاليل موسّعة (SND، McNamara، الحنكي).
            </p>
          )}

          {/* بطاقة الانتقال للمرحلة التالية (WebCeph Workflow Step 1 -> 2) */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-purple-200 bg-gradient-to-r from-purple-50 to-indigo-50/50 p-3 shadow-xs">
            <div>
              <p className="text-xs font-black text-purple-950">
                الخطوة التالية: التحليل السيفالومتري (WebCeph Analysis)
              </p>
              <p className="text-[11px] text-purple-800">
                بعد ضبط المعالم وتدقيقها بالعدسة المكبرة، انتقل لعرض تحاليل شتاينر، تويد، مكنمارا، ريكتس، كيم، ويتس.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTracerStep("analysis")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-purple-700 px-4 py-2 text-xs font-black text-white shadow hover:bg-purple-800 transition-all"
            >
              <span>تأكيد المعالم والانتقال للتحليل</span>
              <span>←</span>
            </button>
          </div>
        </div>

        {/* جدول القياسات مع تبويبات كبار العلماء وأشرطة الانحراف البيانية (WebCeph Parity) */}
        <div className="w-full shrink-0 lg:w-[570px]">
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 flex items-center justify-between text-sm font-medium text-slate-700">
              <span>{completed ? "القياسات المعتمدة — لقطة الاعتماد" : "القياسات السيفالومترية — حيّة مع كل نقطة"}</span>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setAnalysisViewMode("table")}
                    className={`rounded px-2.5 py-0.5 text-[11px] font-bold transition-all ${
                      analysisViewMode === "table" ? "bg-navy-800 text-white shadow-xs" : "text-slate-600 hover:text-navy-900"
                    }`}
                  >
                    جدول
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnalysisViewMode("chart")}
                    className={`rounded px-2.5 py-0.5 text-[11px] font-bold transition-all ${
                      analysisViewMode === "chart" ? "bg-navy-800 text-white shadow-xs" : "text-slate-600 hover:text-navy-900"
                    }`}
                  >
                    مخطط
                  </button>
                </div>
                <span className="text-xs text-slate-400 font-mono">49 قياساً</span>
              </div>
            </div>

            {/* شريط تبويب كبار العلماء السبعة كمنصة WebCeph */}
            <div className="border-b border-slate-200 bg-slate-50/80 p-2">
              <div className="flex items-center gap-1 overflow-x-auto pb-1 text-xs">
                {CEPH_SCHOOLS.map((school) => {
                  const isSelected = selectedSchool === school.id;
                  const count = school.id === "all"
                    ? enriched.length
                    : enriched.filter((r) => r.schools.includes(school.id)).length;
                  return (
                    <button
                      key={school.id}
                      type="button"
                      onClick={() => setSelectedSchool(school.id)}
                      className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                        isSelected
                          ? "bg-navy-800 text-white shadow-sm"
                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                      }`}
                      title={school.descAr}
                    >
                      {school.nameAr}
                      <span className={`ms-1 rounded-full px-1.5 py-0.2 text-[10px] ${isSelected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
              {selectedSchool !== "all" && (
                <div className="mt-1 rounded-md bg-white border border-slate-200/80 p-1.5 text-[11px] text-slate-600">
                  <span className="font-semibold text-slate-800">{CEPH_SCHOOLS.find((s) => s.id === selectedSchool)?.nameEn}</span>
                  <span className="text-slate-400 ms-1">({CEPH_SCHOOLS.find((s) => s.id === selectedSchool)?.author}): </span>
                  <span>{CEPH_SCHOOLS.find((s) => s.id === selectedSchool)?.descAr}</span>
                </div>
              )}
            </div>

            <div className="max-h-[50vh] overflow-auto p-2">
              {analysisViewMode === "chart" ? (
                /* مخطط بياني شريطي لانحرافات القياسات كمنصة WebCeph */
                <div className="space-y-2 p-1">
                  {enriched
                    .filter((r) => selectedSchool === "all" || r.schools.includes(selectedSchool))
                    .map((r) => {
                      const activeVal = completed && stamped
                        ? stamped.find((s) => s.code === r.code)?.value ?? null
                        : r.value;
                      const mean = r.refMean ?? r.mean;
                      const sd = r.refSd ?? r.tol;
                      const z = activeVal != null && sd > 0 ? (activeVal - mean) / sd : null;
                      const barPercent = z != null ? Math.max(0, Math.min(100, 50 + z * 16.6)) : 50;
                      return (
                        <div key={r.code} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2 text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-bold text-slate-800">{r.code} — {r.ar.split("—")[0]}</span>
                            <div className="flex items-center gap-1 font-mono">
                              <span className="font-black text-navy-900">{activeVal != null ? activeVal : "—"} {r.unit}</span>
                              <span className="text-[10px] text-slate-400">({mean}±{sd})</span>
                              {r.severityStars && (
                                <span className={`text-[10px] font-bold px-1 rounded ${
                                  r.severityStars === "***" ? "bg-rose-100 text-rose-700" :
                                  r.severityStars === "**" ? "bg-amber-100 text-amber-700" : "bg-yellow-100 text-yellow-700"
                                }`}>
                                  {r.severityStars}
                                </span>
                              )}
                            </div>
                          </div>
                          {/* شريط الانحراف المعياري WebCeph SD Bar */}
                          <div className="relative h-3 w-full rounded-full bg-slate-200 overflow-hidden">
                            <div className="absolute inset-y-0 left-1/2 w-0.5 bg-slate-400 z-10" title="المعدل الطبيعي (Mean)" />
                            <div className="absolute inset-y-0 left-[33.3%] w-[33.4%] bg-emerald-100/60 z-0" title="المجال الطبيعي ±1 SD" />
                            {z != null && (
                              <div
                                className={`absolute top-0.5 bottom-0.5 w-2.5 rounded-full transition-all shadow-xs ${
                                  Math.abs(z) <= 1 ? "bg-emerald-600" : Math.abs(z) <= 2 ? "bg-amber-500" : "bg-rose-600"
                                }`}
                                style={{ left: `calc(${barPercent}% - 5px)` }}
                                title={`Z-Score: ${z.toFixed(2)}`}
                              />
                            )}
                          </div>
                          <div className="flex items-center justify-between text-[9px] text-slate-400 mt-0.5">
                            <span>-3 SD</span>
                            <span>طبيعي</span>
                            <span>+3 SD</span>
                          </div>
                          <div className="mt-1 text-[11px] text-slate-600 flex items-center justify-between">
                            <span>{r.interpretationAr}</span>
                            <span className="text-[9px] text-slate-400 font-mono">{r.interpretationEn}</span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : selectedSchool === "all" ? (
                (["sagittal", "vertical", "dental", "softTissue"] as const).map((group) => {
                  const groupRows = enriched.filter((r) => r.group === group);
                  if (groupRows.length === 0) return null;
                  return (
                    <div key={group} className="mb-3">
                      <p className="px-2 py-1 text-xs font-medium text-slate-400 bg-slate-50 rounded mb-1">
                        {group === "sagittal"
                          ? "الهيكلي — أفقي (Sagittal Skeletal)"
                          : group === "vertical"
                          ? "الهيكلي — عمودي (Vertical Skeletal & Bjork)"
                          : group === "dental"
                          ? "الأسنان (Dental Relationships)"
                          : "الأنسجة الرخوة والبروفايل (Soft Tissue & Esthetics)"}
                      </p>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-slate-400 text-[10px] border-b border-slate-100">
                            <th className="px-1.5 py-1 text-right font-normal">القياس</th>
                            <th className="px-1 py-1 text-left font-normal">القيمة</th>
                            <th className="px-1 py-1 text-center font-normal" title="شدة الانحراف كمنصة WebCeph (* / ** / ***)">الشدة</th>
                            <th className="px-1.5 py-1 text-left font-normal">المعدل</th>
                            <th className="px-1 py-1 text-center font-normal">الانحراف</th>
                            <th className="px-1.5 py-1 text-left font-normal">التفسير السريري (Interpretation)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupRows.map((r) => {
                            const sev = r.refSeverity;
                            const colorClass = sev
                              ? SEVERITY_COLOR[sev]
                              : r.status ? STATUS_COLOR[r.status] : "text-slate-400";
                            const refText = r.refMean != null && r.refSd != null
                              ? `${Math.round(r.refMean * 10) / 10}±${Math.round(r.refSd * 10) / 10}`
                              : `${r.mean}±${r.tol}`;
                            const activeVal = completed && stamped
                              ? stamped.find((s) => s.code === r.code)?.value ?? null
                              : r.value;
                            return (
                              <tr key={r.code} className="border-b border-slate-100 hover:bg-slate-50/60 last:border-0">
                                <td className="px-1.5 py-1 text-slate-700" title={r.ar}>
                                  <span className="font-semibold">{r.code}</span>
                                  <span className="ms-1 text-[10px] text-slate-400 block sm:inline">{r.ar.split("—")[0].trim()}</span>
                                </td>
                                <td className={`px-1 py-1 text-left font-mono font-medium ${colorClass}`}>
                                  {activeVal != null ? activeVal : "—"}
                                  <span className="ms-0.5 text-[10px] font-normal text-slate-400">{activeVal != null ? r.unit : ""}</span>
                                </td>
                                <td className="px-1 py-1 text-center font-bold font-mono">
                                  {r.severityStars === "***" ? (
                                    <span className="rounded bg-rose-100 px-1 py-0.2 text-xs text-rose-700 ring-1 ring-rose-300" title="انحراف شديد (>3 SD)">***</span>
                                  ) : r.severityStars === "**" ? (
                                    <span className="rounded bg-amber-100 px-1 py-0.2 text-xs text-amber-800" title="انحراف ملحوظ (2-3 SD)">**</span>
                                  ) : r.severityStars === "*" ? (
                                    <span className="rounded bg-yellow-100 px-1 py-0.2 text-xs text-yellow-800" title="انحراف خفيف (1-2 SD)">*</span>
                                  ) : (
                                    <span className="text-slate-300 text-[10px]">—</span>
                                  )}
                                </td>
                                <td className="px-1.5 py-1 text-left text-[11px] text-slate-400" title={`مرجع ${r.source}${r.note ? ` — ${r.note}` : ""}`}>
                                  {refText}{r.unit === "%" ? "%" : r.unit === "mm" ? "" : "°"}
                                </td>
                                <td className="px-1 py-1 text-center">
                                  <CephDeviationGauge
                                    value={activeVal}
                                    mean={r.refMean ?? r.mean}
                                    sd={r.refSd ?? r.tol}
                                    unit={r.unit}
                                  />
                                </td>
                                <td className={`px-1.5 py-1 text-left text-[11px] ${colorClass}`} title={r.interpretationEn}>
                                  <span className="font-medium block leading-tight">{r.interpretationAr}</span>
                                  <span className="text-[9px] text-slate-400 block font-mono">{r.interpretationEn}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-400 text-[10px] border-b border-slate-100">
                      <th className="px-1.5 py-1 text-right font-normal">القياس</th>
                      <th className="px-1 py-1 text-left font-normal">القيمة</th>
                      <th className="px-1 py-1 text-center font-normal" title="شدة الانحراف كمنصة WebCeph (* / ** / ***)">الشدة</th>
                      <th className="px-1.5 py-1 text-left font-normal">المعدل</th>
                      <th className="px-1 py-1 text-center font-normal">الانحراف</th>
                      <th className="px-1.5 py-1 text-left font-normal">التفسير السريري (Interpretation)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enriched.filter((r) => r.schools.includes(selectedSchool)).map((r) => {
                      const sev = r.refSeverity;
                      const colorClass = sev
                        ? SEVERITY_COLOR[sev]
                        : r.status ? STATUS_COLOR[r.status] : "text-slate-400";
                      const refText = r.refMean != null && r.refSd != null
                        ? `${Math.round(r.refMean * 10) / 10}±${Math.round(r.refSd * 10) / 10}`
                        : `${r.mean}±${r.tol}`;
                      const activeVal = completed && stamped
                        ? stamped.find((s) => s.code === r.code)?.value ?? null
                        : r.value;
                      return (
                        <tr key={r.code} className="border-b border-slate-100 hover:bg-slate-50/60 last:border-0">
                          <td className="px-1.5 py-1 text-slate-700" title={r.ar}>
                            <span className="font-semibold">{r.code}</span>
                            <span className="ms-1 text-[10px] text-slate-400 block sm:inline">{r.ar.split("—")[0].trim()}</span>
                          </td>
                          <td className={`px-1 py-1 text-left font-mono font-medium ${colorClass}`}>
                            {activeVal != null ? activeVal : "—"}
                            <span className="ms-0.5 text-[10px] font-normal text-slate-400">{activeVal != null ? r.unit : ""}</span>
                          </td>
                          <td className="px-1 py-1 text-center font-bold font-mono">
                            {r.severityStars === "***" ? (
                              <span className="rounded bg-rose-100 px-1 py-0.2 text-xs text-rose-700 ring-1 ring-rose-300" title="انحراف شديد (>3 SD)">***</span>
                            ) : r.severityStars === "**" ? (
                              <span className="rounded bg-amber-100 px-1 py-0.2 text-xs text-amber-800" title="انحراف ملحوظ (2-3 SD)">**</span>
                            ) : r.severityStars === "*" ? (
                              <span className="rounded bg-yellow-100 px-1 py-0.2 text-xs text-yellow-800" title="انحراف خفيف (1-2 SD)">*</span>
                            ) : (
                              <span className="text-slate-300 text-[10px]">—</span>
                            )}
                          </td>
                          <td className="px-1.5 py-1 text-left text-[11px] text-slate-400" title={`مرجع ${r.source}${r.note ? ` — ${r.note}` : ""}`}>
                            {refText}{r.unit === "%" ? "%" : r.unit === "mm" ? "" : "°"}
                          </td>
                          <td className="px-1 py-1 text-center">
                            <CephDeviationGauge
                              value={activeVal}
                              mean={r.refMean ?? r.mean}
                              sd={r.refSd ?? r.tol}
                              unit={r.unit}
                            />
                          </td>
                          <td className={`px-1.5 py-1 text-left text-[11px] ${colorClass}`} title={r.interpretationEn}>
                            <span className="font-medium block leading-tight">{r.interpretationAr}</span>
                            <span className="text-[9px] text-slate-400 block font-mono">{r.interpretationEn}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {/* التشخيص المنظم: اقتراحُ النظام يُحرَّر ويوقَّع — المعتمد يُقرأ لا يُكتب. */}
            <div className="border-t border-slate-200 px-4 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-700">التشخيص السيفالومتري المنظم</p>
                {!completed && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void generateIntelligentDiagnosis()}
                      disabled={aiDxLoading}
                      className="rounded-md border border-purple-300 bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-40 inline-flex items-center gap-1"
                      title="يولد تشخيصاً تقويمياً سردياً شاملاً وخطة علاج موجهة بالذكاء الاصطناعي ومحرك الخبير"
                    >
                      <span>🧠</span>
                      <span>{aiDxLoading ? "جاري التوليد…" : "توليد التشخيص الذكي"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={fillSuggestion}
                      className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
                      title="يملأ الحقول من القياسات — اقتراحٌ قابل للتحرير"
                    >
                      تعبئة أساسية
                    </button>
                  </div>
                )}
              </div>
              {completed ? (
                diagnosis ? (
                  <div className="space-y-1 text-xs text-slate-600">
                    {diagnosis.skeletal && <p><b className="text-slate-500">هيكلي: </b>{diagnosis.skeletal}</p>}
                    {diagnosis.dental && <p><b className="text-slate-500">أسنان: </b>{diagnosis.dental}</p>}
                    {diagnosis.softTissue && <p><b className="text-slate-500">أنسجة رخوة: </b>{diagnosis.softTissue}</p>}
                    <p><b className="text-slate-500">الاستنتاج: </b>{diagnosis.finalDx}</p>
                    {diagnosis.note && <p><b className="text-slate-500">ملاحظات: </b>{diagnosis.note}</p>}
                    <p className="text-slate-400">حرّره {diagnosis.createdBy} — آخر تعديل {new Date(diagnosis.updatedAt).toLocaleDateString("ar")}</p>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">لم يُكتب تشخيص منظم قبل الاعتماد.</p>
                )
              ) : (
                <div className="space-y-2">
                  <p className="rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-500">
                    ما يكتبه النظام <b>اقتراحٌ موسوم</b> قابل للتحرير — ولا يُختم إلا باعتمادك التحليل.
                  </p>
                  <textarea
                    value={dx.skeletal}
                    onChange={(e) => { setDx({ ...dx, skeletal: e.target.value }); setDxDirty(true); }}
                    placeholder="هيكلي…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.dental}
                    onChange={(e) => { setDx({ ...dx, dental: e.target.value }); setDxDirty(true); }}
                    placeholder="أسنان…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.softTissue}
                    onChange={(e) => { setDx({ ...dx, softTissue: e.target.value }); setDxDirty(true); }}
                    placeholder="أنسجة رخوة…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.finalDx}
                    onChange={(e) => { setDx({ ...dx, finalDx: e.target.value }); setDxDirty(true); }}
                    placeholder="الاستنتاج السيفالومتري (مطلوب)…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-400 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.note}
                    onChange={(e) => { setDx({ ...dx, note: e.target.value }); setDxDirty(true); }}
                    placeholder="ملاحظات الطبيب (اختياري)…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void saveDiagnosis()}
                    disabled={saving || !dxDirty}
                    className="rounded-lg bg-navy-800 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                  >
                    حفظ التشخيص
                  </button>
                </div>
              )}
            </div>
            {summary && (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
                <p>{summary.skeletal}</p>
                <p>{summary.vertical}</p>
                <p className="mt-1 text-slate-400">
                  المرجع: {refSetName ?? "المدمج (متوسط ± المدى التقريبي)"} — يُقرأ مع الظاهر السريري،
                  والبرنامج يقيس ولا يُشخّص.
                </p>
              </div>
            )}
            {completed && (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
                اعتمدها {analysis.completedBy} في {new Date(analysis.completedAt ?? "").toLocaleDateString("ar")}
                {analysis.note ? ` — ${analysis.note}` : ""}
              </div>
            )}

            {/* أزرار الانتقال المنهجي كمنصة WebCeph */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/90 px-4 py-2.5">
              <button
                type="button"
                onClick={() => setTracerStep("digitization")}
                className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
              >
                ← العودة لتعديل المعالم والرسم
              </button>
              <button
                type="button"
                onClick={() => setTracerStep("report")}
                className="rounded-xl bg-emerald-700 px-4 py-1.5 text-xs font-black text-white shadow hover:bg-emerald-800 transition-colors inline-flex items-center gap-1"
              >
                <span>المتابعة للمطابقة والتقرير</span>
                <span>←</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
