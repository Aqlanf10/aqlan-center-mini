"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  computeAll, enrichWithRefs, generateCephExpertDiagnosis, interpret, LANDMARK_ORDER, landmarkDef, MEASUREMENTS, REQUIRED_LANDMARKS, round1,
  suggestDiagnosis, suggestLandmarks, summarize,
  type LandmarkCode, type LandmarkMap, type MeasurementResult, type Pt,
} from "@/lib/ceph";

/**
 * مساحة رسم التحليل السيفالومتري.
 *
 * الطبيب يضع المعالم بالنقر على الشععة ويعدّلها بالسحب أو بأسهم لوحة المفاتيح،
 * والقياسات تجري حيًّا أمامه من دوالّ الوحدة الخالصة نفسها التي تُختم في القاعدة
 * عند الاعتماد — فما يراه هو ما يُعتمد. والقيم المرجعية تأتي من مجموعة الدراسة
 * في القاعدة (بمتوسطها وانحرافها المعياري ودرجتها Z) لا من رقمٍ صلب، والتصنيف
 * يُعرض بنصٍّ صريح لا باللون وحده.
 *
 * والتشخيص المنظم اقتراحٌ من النظام يقفز في الحقول ويحرّره الطبيب ويوقّعه —
 * قاعدة ZONE_B كما هي: الحاسوب يقترح ولا يعتمد.
 *
 * ولا خطوطٍ ولا أرقام تُحسب هنا داخل الملفّ: كل الرياضيات في `lib/ceph.ts`،
 * وهذا الملف عرضٌ وتحريكٌ وحفظٌ فقط.
 */

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
  const [history, setHistory] = useState<LandmarkMap[]>([]);
  const [future, setFuture] = useState<LandmarkMap[]>([]);
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
                  {/* خط ريكتس الجمالي E-Line من Prn إلى PogS */}
                  {showGuides && points.Prn && points.PogS && (
                    <g key="eline-ricketts">
                      <line
                        x1={points.Prn.x} y1={points.Prn.y}
                        x2={points.PogS.x} y2={points.PogS.y}
                        stroke="#db2777" strokeWidth={Math.max(1.5, 2 / zoom)}
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
                    const isSuggested = sources[code] === "suggested";
                    const pointFill = isDragging
                      ? "#dc2626"
                      : isSuggested
                      ? "#9333ea"
                      : "#1e3a5f";
                    return (
                      <g key={code}>
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
                          r={Math.max(4, 7 / zoom)}
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
                          fontWeight={isSuggested ? "bold" : "normal"}
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
        </div>

        {/* جدول القياسات */}
        <div className="w-full shrink-0 lg:w-96">
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">
              {completed ? "القياسات المعتمدة — لقطة الاعتماد" : "القياسات — حيّة مع كل نقطة"}
            </div>
            <div className="max-h-[46vh] overflow-auto p-2">
              {(["sagittal", "vertical", "dental", "softTissue"] as const).map((group) => (
                <div key={group} className="mb-3">
                  <p className="px-2 py-1 text-xs font-medium text-slate-400">
                    {group === "sagittal"
                      ? "الهيكلي — أفقي"
                      : group === "vertical"
                      ? "الهيكلي — عمودي"
                      : group === "dental"
                      ? "الأسنان"
                      : "الأنسجة الرخوة والبروفايل"}
                  </p>
                  <table className="w-full text-sm">
                    <tbody>
                      {enriched.filter((r) => r.group === group).map((r) => {
                        const sev = r.refSeverity;
                        const colorClass = sev
                          ? SEVERITY_COLOR[sev]
                          : r.status ? STATUS_COLOR[r.status] : "text-slate-400";
                        const refText = r.refMean != null && r.refSd != null
                          ? `${Math.round(r.refMean * 10) / 10}±${Math.round(r.refSd * 10) / 10}`
                          : `${r.mean}±${r.tol}`;
                        const label = r.refLabel
                          ?? (r.status ? { above: "أعلى من المدى", below: "أدنى من المدى", within: "داخل المدى" }[r.status] : null);
                        const detail = r.diff != null
                          ? `(${r.diff > 0 ? "+" : ""}${r.diff}${r.z != null ? ` · Z ${r.z}` : ""})`
                          : null;
                        return (
                          <tr key={r.code} className="border-b border-slate-100 last:border-0">
                            <td className="px-2 py-1.5 text-slate-700" title={r.ar}>
                              {r.code}
                              <span className="ms-1 text-xs text-slate-400">{r.ar.split("—")[0].trim()}</span>
                            </td>
                            <td className={`px-2 py-1.5 text-left font-mono font-medium ${colorClass}`}>
                              {completed && stamped
                                ? stamped.find((s) => s.code === r.code)?.value ?? "—"
                                : r.display}
                              <span className="ms-0.5 text-xs font-normal text-slate-400">{r.value != null || completed ? r.unit : ""}</span>
                            </td>
                            <td className="px-2 py-1.5 text-left text-xs text-slate-400" title={`مرجع ${r.source}${r.note ? ` — ${r.note}` : ""}`}>
                              {refText}
                              {r.unit === "%" ? "%" : r.unit === "mm" ? "" : "°"}
                            </td>
                            <td className={`px-2 py-1.5 text-left text-xs ${colorClass}`} title={label ?? ""}>
                              {label ?? "—"}
                              {label && detail && (
                                <span className="block font-mono text-[10px] text-slate-400">{detail}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
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
          </div>
        </div>
      </div>
    </div>
  );
}
