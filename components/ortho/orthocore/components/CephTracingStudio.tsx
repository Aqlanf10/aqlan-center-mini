"use client";
import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Contrast,
  Crosshair,
  Eye,
  EyeOff,
  Layers,
  Move,
  RotateCcw,
  Ruler,
  Save,
  ScanSearch,
  Sun,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Language, MeasurementAnalysis, PatientCase, RecordStage, UserRole } from '../types/ortho';
import { tr } from '../i18n/translations';
import {
  CEPH_LANDMARKS_CATALOG,
  CEPH_NORM_BANDS,
  CephSystemId,
  Point2D,
  computeCephalometricMetrics,
} from '../utils/orthoMath';
import { validateOrthoCephApprovalGate } from '@/lib/ortho-scientific-analyses';

interface CephTracingStudioProps {
  patient: PatientCase;
  stage: RecordStage;
  lang: Language;
  role: UserRole;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

const SYSTEMS: Array<{ id: CephSystemId; ar: string; en: string }> = [
  { id: 'all', ar: 'التحليل الشامل', en: 'Comprehensive' },
  { id: 'steiner', ar: 'شتاينر (Steiner)', en: 'Steiner' },
  { id: 'tweed', ar: 'تويد (Tweed)', en: 'Tweed' },
  { id: 'ricketts', ar: 'ريكيتس (Ricketts)', en: 'Ricketts' },
  { id: 'mcnamara', ar: 'ماكنمارا (McNamara)', en: 'McNamara' },
  { id: 'jarabak', ar: 'جاراباك (Jarabak)', en: 'Jarabak' },
];

const GROUP_LABELS: Record<'cranial' | 'skeletal' | 'dental' | 'soft', { ar: string; en: string }> = {
  cranial: { ar: 'قاعدة الجمجمة', en: 'Cranial Base' },
  skeletal: { ar: 'الهيكل الفكي', en: 'Skeletal Jaws' },
  dental: { ar: 'الأسنان والإطباق', en: 'Dentition' },
  soft: { ar: 'الأنسجة الرخوة', en: 'Soft Tissue' },
};

function computeToothPolygon(apex: Point2D, tip: Point2D, widthNorm = 0.018): string {
  const ax = apex.x * 1000;
  const ay = apex.y * 1000;
  const tx = tip.x * 1000;
  const ty = tip.y * 1000;
  const dx = tx - ax;
  const dy = ty - ay;
  const len = Math.hypot(dx, dy);
  if (len < 5) return '';
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const w = widthNorm * 1000;
  // Crown base at 62% from apex to tip
  const cx = ax + dx * 0.56;
  const cy = ay + dy * 0.56;
  const p1 = `${ax},${ay}`;
  const p2 = `${(cx + nx * w * 0.95).toFixed(1)},${(cy + ny * w * 0.95).toFixed(1)}`;
  const p3 = `${(tx + nx * w * 0.55).toFixed(1)},${(ty + ny * w * 0.55).toFixed(1)}`;
  const p4 = `${tx.toFixed(1)},${ty.toFixed(1)}`;
  const p5 = `${(tx - nx * w * 0.55).toFixed(1)},${(ty - ny * w * 0.55).toFixed(1)}`;
  const p6 = `${(cx - nx * w * 0.95).toFixed(1)},${(cy - ny * w * 0.95).toFixed(1)}`;
  return `${p1} ${p2} ${p3} ${p4} ${p5} ${p6}`;
}

export const CephTracingStudio: React.FC<CephTracingStudioProps> = ({
  patient,
  stage,
  lang,
  role,
  actorName,
  onChange,
}) => {
  const cephMediaOptions = patient.media.filter((m) => m.mediaKind === 'radiograph' || m.mediaKind === 'photo');
  const defaultCephMedia =
    cephMediaOptions.find((m) => m.viewType === 'lateral_ceph' && m.stage === stage) ||
    cephMediaOptions.find((m) => m.viewType === 'lateral_ceph') ||
    cephMediaOptions[0] ||
    null;

  const [selectedMediaId, setSelectedMediaId] = useState<string>(defaultCephMedia?.id || '');
  const selectedMedia = patient.media.find((m) => m.id === selectedMediaId) || defaultCephMedia;

  const cephHistory = useMemo(
    () => patient.analyses.filter((a) => a.analysisType === 'cephalometric'),
    [patient.analyses],
  );
  const existingCeph = cephHistory.find((a) => a.stage === stage) || cephHistory[0] || null;

  const [landmarks, setLandmarks] = useState<Record<string, Point2D>>(existingCeph?.landmarks || {});
  const [activeLandmark, setActiveLandmark] = useState<string>('S');
  const [system, setSystem] = useState<CephSystemId>('all');

  // Viewport & Radiography Filters
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const [brightness, setBrightness] = useState(105);
  const [contrast, setContrast] = useState(112);
  const [invertGray, setInvertGray] = useState(false);
  const [showTracing, setShowTracing] = useState(true);
  const [showSuperimpose, setShowSuperimpose] = useState(false);

  // Floating Magnifier Loupe (tracks cursor over radiograph)
  const [loupeEnabled, setLoupeEnabled] = useState(true);
  const [loupePower, setLoupePower] = useState<2 | 3 | 4>(3);
  const [loupeSize, setLoupeSize] = useState<120 | 176 | 240 | 300>(176);
  const [cursorLoupe, setCursorLoupe] = useState<{
    vx: number;
    vy: number;
    nx: number;
    ny: number;
    stageW: number;
    stageH: number;
  } | null>(null);

  // Calibration
  const [calibrating, setCalibrating] = useState(false);
  const [calPts, setCalPts] = useState<Point2D[]>([]);
  const [knownMm, setKnownMm] = useState<number>(30);

  // Dragging state for landmarks or panning
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const panStartRef = useRef<{ clientX: number; clientY: number; origX: number; origY: number } | null>(null);

  const pixelsPerMm = selectedMedia?.calibration.isCalibrated ? selectedMedia.calibration.pixelsPerMm : null;

  const liveMetrics = computeCephalometricMetrics(landmarks, 1000, 1000, pixelsPerMm, system);

  const allComputedMetrics = computeCephalometricMetrics(landmarks, 1000, 1000, pixelsPerMm, 'all');

  const superImposeRef = useMemo(() => {
    if (!showSuperimpose || cephHistory.length === 0) return null;
    return cephHistory.find((a) => a.stage === 'T0') || cephHistory[cephHistory.length - 1];
  }, [showSuperimpose, cephHistory]);

  // Compute S-N registered superimposed landmarks for comparison
  const alignedSuperLandmarks = useMemo(() => {
    if (!superImposeRef) return null;
    const refL = superImposeRef.landmarks;
    if (!refL.S || !refL.N || !landmarks.S || !landmarks.N) return refL;
    const dx = landmarks.S.x - refL.S.x;
    const dy = landmarks.S.y - refL.S.y;
    const a1 = Math.atan2(landmarks.N.y - landmarks.S.y, landmarks.N.x - landmarks.S.x);
    const a0 = Math.atan2(refL.N.y - refL.S.y, refL.N.x - refL.S.x);
    const rot = a1 - a0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const out: Record<string, Point2D> = {};
    for (const [k, pt] of Object.entries(refL)) {
      const rx = pt.x - refL.S.x;
      const ry = pt.y - refL.S.y;
      out[k] = {
        x: refL.S.x + dx + rx * cos - ry * sin,
        y: refL.S.y + dy + rx * sin + ry * cos,
      };
    }
    return out;
  }, [superImposeRef, landmarks.S, landmarks.N]);

  const toNormalizedCoords = (clientX: number, clientY: number): Point2D | null => {
    if (!stageRef.current) return null;
    const rect = stageRef.current.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, Number(((clientX - rect.left) / rect.width).toFixed(4))));
    const ny = Math.max(0, Math.min(1, Number(((clientY - rect.top) / rect.height).toFixed(4))));
    return { x: nx, y: ny };
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (panMode || e.button === 1) {
      panStartRef.current = { clientX: e.clientX, clientY: e.clientY, origX: pan.x, origY: pan.y };
      setCursorLoupe(null);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (draggingKey) return;

    const pt = toNormalizedCoords(e.clientX, e.clientY);
    if (!pt) return;

    if (calibrating) {
      const next = [...calPts, pt];
      if (next.length === 2) {
        const distPxOn1000 = Math.hypot((next[1].x - next[0].x) * 1000, (next[1].y - next[0].y) * 1000);
        const pxPerMm = knownMm > 0 ? Number((distPxOn1000 / knownMm).toFixed(3)) : 0;
        if (selectedMedia && pxPerMm > 0) {
          const updatedMedia = patient.media.map((m) =>
            m.id === selectedMedia.id
              ? {
                  ...m,
                  calibration: {
                    isCalibrated: true,
                    pixelsPerMm: pxPerMm,
                    source: `معايرة نقطتين (${knownMm} مم)`,
                    unit: 'mm' as const,
                    knownMm,
                    p1: next[0],
                    p2: next[1],
                  },
                }
              : m,
          );
          onChange({ ...patient, media: updatedMedia });
        }
        setCalPts([]);
        setCalibrating(false);
      } else {
        setCalPts(next);
      }
      return;
    }

    // Place active landmark and advance to next unplaced
    setLandmarks((prev) => {
      const nextMap = { ...prev, [activeLandmark]: pt };
      const idx = CEPH_LANDMARKS_CATALOG.findIndex((l) => l.key === activeLandmark);
      const nextUnplaced =
        CEPH_LANDMARKS_CATALOG.slice(idx + 1).find((l) => !nextMap[l.key]) ||
        CEPH_LANDMARKS_CATALOG.find((l) => !nextMap[l.key]);
      if (nextUnplaced) setActiveLandmark(nextUnplaced.key);
      return nextMap;
    });
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (viewportRef.current && stageRef.current) {
      const vpRect = viewportRef.current.getBoundingClientRect();
      const stRect = stageRef.current.getBoundingClientRect();
      if (stRect.width > 0 && stRect.height > 0) {
        setCursorLoupe({
          vx: e.clientX - vpRect.left,
          vy: e.clientY - vpRect.top,
          nx: Math.max(0, Math.min(1, (e.clientX - stRect.left) / stRect.width)),
          ny: Math.max(0, Math.min(1, (e.clientY - stRect.top) / stRect.height)),
          stageW: stRect.width,
          stageH: stRect.height,
        });
      }
    }
    if (panStartRef.current) {
      setCursorLoupe(null);
      const dx = e.clientX - panStartRef.current.clientX;
      const dy = e.clientY - panStartRef.current.clientY;
      setPan({ x: panStartRef.current.origX + dx, y: panStartRef.current.origY + dy });
      return;
    }
    if (draggingKey) {
      const pt = toNormalizedCoords(e.clientX, e.clientY);
      if (pt) {
        setLandmarks((prev) => ({ ...prev, [draggingKey]: pt }));
      }
    }
  };

  const handleStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    panStartRef.current = null;
    setDraggingKey(null);
    if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  const handleSaveCeph = () => {
    const version = cephHistory.length + 1;
    const sysLabel = SYSTEMS.find((s) => s.id === system)?.en || 'Comprehensive';
    const isCalibrated = Boolean(selectedMedia?.calibration.isCalibrated && (selectedMedia.calibration.pixelsPerMm ?? 0) > 0);
    const approvalGate = validateOrthoCephApprovalGate({
      calibrationValid: isCalibrated,
      pixelsPerMm: selectedMedia?.calibration.pixelsPerMm ?? null,
      landmarks,
      actorRole: role,
    });
    const canApproveNow = approvalGate.ok && (role === 'doctor' || role === 'admin');
    const nowIso = new Date().toISOString();
    const newAnalysis: MeasurementAnalysis = {
      id: `ana-ceph-${version}-${nowIso}`,
      version,
      stage,
      analysisType: 'cephalometric',
      analysisSystem: system,
      templateName: `Aqlan Ceph Studio — ${sysLabel}`,
      normSource: 'Steiner / Tweed / Ricketts / McNamara / Jarabak',
      linkedMediaId: selectedMedia?.id,
      calibrationValid: isCalibrated,
      calibrationSource: selectedMedia?.calibration.source || tr(lang, 'غير معاير', 'Uncalibrated'),
      landmarks,
      metrics: allComputedMetrics,
      examiner: actorName,
      createdAt: nowIso,
      approvedBy: canApproveNow ? actorName : undefined,
      approvedAt: canApproveNow ? nowIso : undefined,
    };
    onChange(
      { ...patient, analyses: [newAnalysis, ...patient.analyses] },
      canApproveNow
        ? {
            ar: `اعتماد رسم وتحليل سيفالومتري ${stage} (${approvalGate.confirmedLandmarkCount} معلمًا معايرًا — نسخة ${version})`,
            en: `Approved ${stage} Cephalometric Tracing (${approvalGate.confirmedLandmarkCount} calibrated landmarks — v${version})`,
          }
        : {
            ar: !approvalGate.ok ? approvalGate.messageAr : `حفظ مسودة سيفالومتري ${stage} (نسخة ${version})`,
            en: !approvalGate.ok ? approvalGate.messageEn : `Saved ${stage} Cephalometric Draft (v${version})`,
          },
    );
  };

  // Derive quick clinical classification from ANB & FMA
  const anbMetric = allComputedMetrics.find((m) => m.key === 'ANB');
  const fmaMetric = allComputedMetrics.find((m) => m.key === 'FMA');
  const impaMetric = allComputedMetrics.find((m) => m.key === 'IMPA');

  const skeletalClassText =
    anbMetric?.value === null || anbMetric?.value === undefined
      ? '—'
      : anbMetric.value > 4
      ? tr(lang, 'صنف II هيكلي', 'Skeletal Class II')
      : anbMetric.value < 0
      ? tr(lang, 'صنف III هيكلي', 'Skeletal Class III')
      : tr(lang, 'صنف I هيكلي', 'Skeletal Class I');

  const growthPatternText =
    fmaMetric?.value === null || fmaMetric?.value === undefined
      ? '—'
      : fmaMetric.value > 28
      ? tr(lang, 'نمو عمودي زائد', 'Hyperdivergent')
      : fmaMetric.value < 22
      ? tr(lang, 'نمو أفقي', 'Hypodivergent')
      : tr(lang, 'متوازن عمودياً', 'Normodivergent');

  const activeLandmarkMeta = CEPH_LANDMARKS_CATALOG.find((l) => l.key === activeLandmark);
  const placedCount = Object.keys(landmarks).length;

  // Dynamic anatomical tooth polygons
  const u1Poly =
    landmarks.U1Apex && landmarks.U1Tip ? computeToothPolygon(landmarks.U1Apex, landmarks.U1Tip, 0.017) : '';
  const l1Poly =
    landmarks.L1Apex && landmarks.L1Tip ? computeToothPolygon(landmarks.L1Apex, landmarks.L1Tip, 0.015) : '';

  // Soft-tissue profile spline path
  const softProfilePoints = ['Pn', 'Col', 'Sn', 'Ls', 'Li', 'PogS']
    .map((k) => landmarks[k])
    .filter(Boolean)
    .map((p) => `${(p.x * 1000).toFixed(1)},${(p.y * 1000).toFixed(1)}`)
    .join(' ');

  return (
    <div className="space-y-4">
      {/* Studio Top Bar — Aqlan Navy Dark Control Strip */}
      <div className="bg-navy-900 text-white rounded-xl border border-navy-800 p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={selectedMedia?.id || ''}
            onChange={(e) => setSelectedMediaId(e.target.value)}
            className="px-3 py-1.5 text-xs bg-navy-800 border border-navy-700 text-white rounded-lg focus:outline-none focus:border-brand-orange"
          >
            {cephMediaOptions.length === 0 ? (
              <option value="">{tr(lang, 'لا توجد صور أشعة مرفوعة', 'No radiographs uploaded')}</option>
            ) : (
              cephMediaOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} ({m.stage})
                </option>
              ))
            )}
          </select>

          <div className="flex items-center gap-1 bg-navy-950/70 p-1 rounded-lg border border-navy-800 overflow-x-auto">
            {SYSTEMS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSystem(s.id)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md whitespace-nowrap transition-colors ${
                  system === s.id
                    ? 'bg-brand-orange text-navy-950 font-semibold'
                    : 'text-navy-200 hover:text-white hover:bg-navy-800'
                }`}
              >
                {lang === 'ar' ? s.ar : s.en}
              </button>
            ))}
          </div>
        </div>

        {/* Calibration & Studio View Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-navy-950/60 border border-navy-800 rounded-lg px-2 py-1 text-xs">
            <input
              type="number"
              value={knownMm}
              onChange={(e) => setKnownMm(Number(e.target.value))}
              className="w-12 bg-transparent text-white font-mono tabular-nums text-xs text-center focus:outline-none"
            />
            <span className="text-navy-300 text-[11px]">mm</span>
            <button
              type="button"
              onClick={() => {
                setCalibrating((v) => !v);
                setCalPts([]);
                setPanMode(false);
              }}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                calibrating
                  ? 'bg-brand-orange text-navy-950'
                  : 'bg-navy-800 text-navy-100 hover:bg-navy-700'
              }`}
            >
              <Ruler className="w-3.5 h-3.5" />
              <span>
                {calibrating
                  ? tr(lang, `نقطتان (${calPts.length}/2)`, `2 pts (${calPts.length}/2)`)
                  : tr(lang, 'معايرة', 'Calibrate')}
              </span>
            </button>
          </div>

          {/* Button-Only Zoom Controls (+ / - / 100%) */}
          <div className="flex items-center bg-navy-950/70 border border-navy-800 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setZoom((z) => Number(Math.max(0.5, z - 0.25).toFixed(2)))}
              disabled={zoom <= 0.5}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-navy-100 hover:bg-navy-800 disabled:opacity-40"
              title={tr(lang, 'تصغير الصورة', 'Zoom Out')}
            >
              <ZoomOut className="w-3.5 h-3.5 text-brand-orange" />
              <span>{tr(lang, 'تصغير', 'Out')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="px-2 py-1.5 text-[11px] font-mono tabular-nums text-white border-x border-navy-800 hover:bg-navy-800"
              title={tr(lang, 'إعادة لحجم 100%', 'Reset 100%')}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Number(Math.min(4, z + 0.25).toFixed(2)))}
              disabled={zoom >= 4}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-navy-100 hover:bg-navy-800 disabled:opacity-40"
              title={tr(lang, 'تكبير الصورة', 'Zoom In')}
            >
              <ZoomIn className="w-3.5 h-3.5 text-brand-orange" />
              <span>{tr(lang, 'تكبير', 'In')}</span>
            </button>
          </div>

          {/* Cursor Magnifier Loupe Toggle + Magnification + Lens Size */}
          <div className="flex flex-wrap items-center bg-navy-950/70 border border-navy-800 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setLoupeEnabled((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors ${
                loupeEnabled
                  ? 'bg-brand-orange text-navy-950 font-semibold'
                  : 'text-navy-200 hover:bg-navy-800'
              }`}
              title={tr(lang, 'عدسة تكبير تتحرك مع المؤشر', 'Cursor Magnifier Loupe')}
            >
              <ScanSearch className="w-3.5 h-3.5" />
              <span>{tr(lang, 'عدسة', 'Loupe')}</span>
            </button>
            {loupeEnabled && (
              <>
                <div className="flex items-center border-s border-navy-800" title={tr(lang, 'قوة التكبير', 'Magnification')}>
                  {([2, 3, 4] as const).map((pwr) => (
                    <button
                      key={pwr}
                      type="button"
                      onClick={() => setLoupePower(pwr)}
                      className={`px-2 py-1.5 text-[11px] font-mono transition-colors ${
                        loupePower === pwr ? 'bg-navy-700 text-brand-orange font-bold' : 'text-navy-300 hover:bg-navy-800'
                      }`}
                    >
                      {pwr}×
                    </button>
                  ))}
                </div>
                <div className="flex items-center border-s border-navy-800" title={tr(lang, 'حجم العدسة', 'Loupe Diameter')}>
                  <span className="px-1.5 text-[10px] text-navy-400">{tr(lang, 'الحجم:', 'Size:')}</span>
                  {(
                    [
                      [120, 'S'],
                      [176, 'M'],
                      [240, 'L'],
                      [300, 'XL'],
                    ] as const
                  ).map(([sz, lbl]) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setLoupeSize(sz)}
                      className={`px-2 py-1.5 text-[11px] font-mono transition-colors ${
                        loupeSize === sz ? 'bg-brand-blue text-white font-bold' : 'text-navy-300 hover:bg-navy-800'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setPanMode((v) => !v);
              setCalibrating(false);
            }}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              panMode
                ? 'bg-brand-orange border-brand-orange text-navy-950 font-semibold'
                : 'bg-navy-800 border-navy-700 text-navy-100 hover:bg-navy-700'
            }`}
          >
            <Move className="w-3.5 h-3.5" />
            <span>{tr(lang, 'تحريك', 'Pan')}</span>
          </button>

          <button
            type="button"
            onClick={() => setInvertGray((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              invertGray
                ? 'bg-brand-blue border-brand-blue text-white'
                : 'bg-navy-800 border-navy-700 text-navy-100 hover:bg-navy-700'
            }`}
          >
            <Contrast className="w-3.5 h-3.5" />
            <span>{tr(lang, 'عكس', 'Invert')}</span>
          </button>

          <button
            type="button"
            onClick={() => setShowTracing((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              showTracing
                ? 'bg-navy-700 border-navy-600 text-white'
                : 'bg-navy-800 border-navy-700 text-navy-300'
            }`}
          >
            {showTracing ? <Eye className="w-3.5 h-3.5 text-brand-orange" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span>{tr(lang, 'خطوط التتبع', 'Tracing')}</span>
          </button>

          {cephHistory.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSuperimpose((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
                showSuperimpose
                  ? 'bg-cyan-600 border-cyan-500 text-white font-semibold'
                  : 'bg-navy-800 border-navy-700 text-navy-100 hover:bg-navy-700'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>{tr(lang, 'تراكب T0', 'Superimpose')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
              setBrightness(105);
              setContrast(112);
              setInvertGray(false);
            }}
            className="p-1.5 bg-navy-800 hover:bg-navy-700 border border-navy-700 rounded-lg text-navy-200"
            title={tr(lang, 'إعادة ضبط العرض', 'Reset View')}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Calibration Banner */}
      {selectedMedia && !selectedMedia.calibration.isCalibrated ? (
        <div className="px-4 py-2.5 bg-accent-50 border border-accent-200 rounded-xl flex items-center gap-2 text-xs text-accent-900">
          <AlertTriangle className="w-4 h-4 text-brand-orange shrink-0" />
          <span>
            {tr(
              lang,
              'الصورة غير معايرة خطياً — الزوايا دقيقة، أما القياسات المليمترية (Wits / E-Line / Co-A) فتتطلب معايرة مسطرة الصورة بالضغط على "معايرة".',
              'Image is uncalibrated — angles are accurate; linear mm metrics require calibrating the ruler.',
            )}
          </span>
        </div>
      ) : selectedMedia ? (
        <div className="px-4 py-2 bg-navy-50 border border-navy-200 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-navy-800">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="w-4 h-4 text-brand-blue" />
            <span>
              {tr(lang, 'المعايرة:', 'Calibration:')} {selectedMedia.calibration.source}
            </span>
          </span>
          <span className="font-mono tabular-nums text-navy-700 font-semibold">
            {selectedMedia.calibration.pixelsPerMm} px/mm · {placedCount}/{CEPH_LANDMARKS_CATALOG.length}{' '}
            {tr(lang, 'معلم محدد', 'landmarks placed')}
          </span>
        </div>
      ) : null}

      {/* Main 3-Column Studio Grid: Landmarks Palette | Tracing Viewport | Live Results */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Column 1: Step-by-Step Anatomical Landmarks (2 cols) */}
        <div className="xl:col-span-3 bg-white border border-navy-200 rounded-xl p-3.5 space-y-3">
          <div className="flex items-center justify-between border-b border-navy-100 pb-2">
            <div>
              <h4 className="text-xs font-bold text-navy-900">
                {tr(lang, 'المعالم التشريحية', 'Anatomical Landmarks')}
              </h4>
              <p className="text-[11px] text-navy-500 mt-0.5">
                {activeLandmarkMeta
                  ? lang === 'ar'
                    ? activeLandmarkMeta.hintAr
                    : activeLandmarkMeta.hintEn
                  : ''}
              </p>
            </div>
            {placedCount > 0 && (
              <button
                type="button"
                onClick={() => setLandmarks({})}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50 rounded-md"
                title={tr(lang, 'مسح المعالم', 'Clear Landmarks')}
              >
                <Trash2 className="w-3 h-3" />
                <span>{tr(lang, 'مسح', 'Clear')}</span>
              </button>
            )}
          </div>

          <div className="space-y-3 max-h-[540px] overflow-y-auto pe-1">
            {(['cranial', 'skeletal', 'dental', 'soft'] as const).map((grp) => {
              const items = CEPH_LANDMARKS_CATALOG.filter((l) => l.group === grp);
              return (
                <div key={grp} className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-navy-600">
                    {lang === 'ar' ? GROUP_LABELS[grp].ar : GROUP_LABELS[grp].en}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {items.map((lm) => {
                      const placed = Boolean(landmarks[lm.key]);
                      const isActive = activeLandmark === lm.key;
                      return (
                        <div key={lm.key} className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveLandmark(lm.key);
                              setPanMode(false);
                              setCalibrating(false);
                            }}
                            className={`flex-1 flex items-center justify-between gap-1 px-2 py-1.5 text-[11px] rounded-lg border transition-colors text-start ${
                              isActive
                                ? 'bg-navy-900 border-navy-900 text-white font-semibold'
                                : placed
                                ? 'bg-accent-50 border-accent-200 text-navy-900'
                                : 'bg-white border-navy-200 text-navy-600 hover:bg-navy-50'
                            }`}
                          >
                            <span className="inline-flex items-center gap-1 truncate">
                              <Crosshair
                                className={`w-3 h-3 shrink-0 ${
                                  isActive ? 'text-brand-orange' : placed ? 'text-brand-orange' : 'text-navy-300'
                                }`}
                              />
                              <span className="font-mono truncate">{lm.key}</span>
                            </span>
                            {placed && (
                              <span className="text-[9px] font-bold text-brand-orange shrink-0">✓</span>
                            )}
                          </button>
                          {placed && (
                            <button
                              type="button"
                              onClick={() =>
                                setLandmarks((prev) => {
                                  const next = { ...prev };
                                  delete next[lm.key];
                                  return next;
                                })
                              }
                              className="p-1 text-navy-400 hover:text-rose-600 rounded"
                              title={tr(lang, 'حذف المعلم', 'Remove')}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 2: Dark Radiology Tracing Stage (5 cols) */}
        <div className="xl:col-span-5 bg-navy-950 border border-navy-800 rounded-xl p-3 space-y-3">
          {selectedMedia ? (
            <>
              <div
                ref={viewportRef}
                dir="ltr"
                onPointerLeave={() => setCursorLoupe(null)}
                className="relative w-full aspect-square max-h-[560px] bg-black rounded-lg overflow-hidden select-none mx-auto border border-navy-800"
              >
                <div
                  ref={stageRef}
                  onPointerDown={handleStagePointerDown}
                  onPointerMove={handleStagePointerMove}
                  onPointerUp={handleStagePointerUp}
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                  }}
                  className={`relative w-full h-full ${
                    panMode
                      ? 'cursor-grab active:cursor-grabbing'
                      : loupeEnabled && cursorLoupe
                      ? 'cursor-none'
                      : 'cursor-crosshair'
                  }`}
                >
                  <img
                    src={selectedMedia.originalUrl}
                    alt={selectedMedia.title}
                    draggable={false}
                    style={{
                      filter: `brightness(${brightness}%) contrast(${contrast}%) ${invertGray ? 'invert(1)' : ''}`,
                    }}
                    className="w-full h-full object-contain pointer-events-none"
                  />

                  <svg viewBox="0 0 1000 1000" className="absolute inset-0 w-full h-full">
                    {/* Optional Superimposition Layer (T0 reference aligned on S-N) */}
                    {showSuperimpose && alignedSuperLandmarks && (
                      <g opacity="0.7" pointerEvents="none">
                        {alignedSuperLandmarks.S && alignedSuperLandmarks.N && (
                          <line
                            x1={alignedSuperLandmarks.S.x * 1000}
                            y1={alignedSuperLandmarks.S.y * 1000}
                            x2={alignedSuperLandmarks.N.x * 1000}
                            y2={alignedSuperLandmarks.N.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="2"
                            strokeDasharray="6 4"
                          />
                        )}
                        {alignedSuperLandmarks.N && alignedSuperLandmarks.A && (
                          <line
                            x1={alignedSuperLandmarks.N.x * 1000}
                            y1={alignedSuperLandmarks.N.y * 1000}
                            x2={alignedSuperLandmarks.A.x * 1000}
                            y2={alignedSuperLandmarks.A.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="1.5"
                            strokeDasharray="5 4"
                          />
                        )}
                        {alignedSuperLandmarks.N && alignedSuperLandmarks.B && (
                          <line
                            x1={alignedSuperLandmarks.N.x * 1000}
                            y1={alignedSuperLandmarks.N.y * 1000}
                            x2={alignedSuperLandmarks.B.x * 1000}
                            y2={alignedSuperLandmarks.B.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="1.5"
                            strokeDasharray="5 4"
                          />
                        )}
                        {alignedSuperLandmarks.Go && alignedSuperLandmarks.Me && (
                          <line
                            x1={alignedSuperLandmarks.Go.x * 1000}
                            y1={alignedSuperLandmarks.Go.y * 1000}
                            x2={alignedSuperLandmarks.Me.x * 1000}
                            y2={alignedSuperLandmarks.Me.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="2"
                            strokeDasharray="5 4"
                          />
                        )}
                      </g>
                    )}

                    {/* Active Anatomical Tracing Overlay */}
                    {showTracing && (
                      <g pointerEvents="none">
                        {/* Cranial Base S-N & Ba-S-N */}
                        {landmarks.S && landmarks.N && (
                          <line
                            x1={landmarks.S.x * 1000}
                            y1={landmarks.S.y * 1000}
                            x2={landmarks.N.x * 1000}
                            y2={landmarks.N.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="2.2"
                          />
                        )}
                        {landmarks.Ba && landmarks.S && (
                          <line
                            x1={landmarks.Ba.x * 1000}
                            y1={landmarks.Ba.y * 1000}
                            x2={landmarks.S.x * 1000}
                            y2={landmarks.S.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="1.6"
                            strokeDasharray="5 3"
                          />
                        )}
                        {/* Frankfort Horizontal Po-Or */}
                        {landmarks.Po && landmarks.Or && (
                          <line
                            x1={landmarks.Po.x * 1000}
                            y1={landmarks.Po.y * 1000}
                            x2={landmarks.Or.x * 1000}
                            y2={landmarks.Or.y * 1000}
                            stroke="#a78bfa"
                            strokeWidth="1.8"
                            strokeDasharray="7 4"
                          />
                        )}
                        {/* Palatal Plane ANS-PNS */}
                        {landmarks.ANS && landmarks.PNS && (
                          <line
                            x1={landmarks.PNS.x * 1000}
                            y1={landmarks.PNS.y * 1000}
                            x2={landmarks.ANS.x * 1000}
                            y2={landmarks.ANS.y * 1000}
                            stroke="#2dd4bf"
                            strokeWidth="1.8"
                          />
                        )}
                        {/* N-A and N-B lines */}
                        {landmarks.N && landmarks.A && (
                          <line
                            x1={landmarks.N.x * 1000}
                            y1={landmarks.N.y * 1000}
                            x2={landmarks.A.x * 1000}
                            y2={landmarks.A.y * 1000}
                            stroke="#34d399"
                            strokeWidth="1.8"
                          />
                        )}
                        {landmarks.N && landmarks.B && (
                          <line
                            x1={landmarks.N.x * 1000}
                            y1={landmarks.N.y * 1000}
                            x2={landmarks.B.x * 1000}
                            y2={landmarks.B.y * 1000}
                            stroke="#f5922e"
                            strokeWidth="1.8"
                          />
                        )}
                        {/* Mandibular Plane & Ramus */}
                        {landmarks.Go && landmarks.Me && (
                          <line
                            x1={landmarks.Go.x * 1000}
                            y1={landmarks.Go.y * 1000}
                            x2={landmarks.Me.x * 1000}
                            y2={landmarks.Me.y * 1000}
                            stroke="#f472b6"
                            strokeWidth="2.2"
                          />
                        )}
                        {landmarks.Ar && landmarks.Go && (
                          <line
                            x1={landmarks.Ar.x * 1000}
                            y1={landmarks.Ar.y * 1000}
                            x2={landmarks.Go.x * 1000}
                            y2={landmarks.Go.y * 1000}
                            stroke="#f472b6"
                            strokeWidth="1.8"
                          />
                        )}
                        {/* Occlusal Plane */}
                        {landmarks.U6 && landmarks.U1Tip && (
                          <line
                            x1={landmarks.U6.x * 1000}
                            y1={landmarks.U6.y * 1000}
                            x2={landmarks.U1Tip.x * 1000}
                            y2={landmarks.U1Tip.y * 1000}
                            stroke="#facc15"
                            strokeWidth="1.5"
                            strokeDasharray="4 4"
                          />
                        )}
                        {/* Ricketts E-Line */}
                        {landmarks.Pn && landmarks.PogS && (
                          <line
                            x1={landmarks.Pn.x * 1000}
                            y1={landmarks.Pn.y * 1000}
                            x2={landmarks.PogS.x * 1000}
                            y2={landmarks.PogS.y * 1000}
                            stroke="#22c55e"
                            strokeWidth="1.6"
                            strokeDasharray="5 4"
                          />
                        )}
                        {/* Soft tissue facial contour polyline */}
                        {softProfilePoints && (
                          <polyline
                            points={softProfilePoints}
                            fill="none"
                            stroke="#fde68a"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity="0.85"
                          />
                        )}
                        {/* Stylized Tooth Silhouettes */}
                        {u1Poly && (
                          <polygon
                            points={u1Poly}
                            fill="rgba(251, 113, 133, 0.28)"
                            stroke="#fb7185"
                            strokeWidth="1.8"
                          />
                        )}
                        {l1Poly && (
                          <polygon
                            points={l1Poly}
                            fill="rgba(96, 165, 250, 0.28)"
                            stroke="#60a5fa"
                            strokeWidth="1.8"
                          />
                        )}
                        {landmarks.U1Apex && landmarks.U1Tip && (
                          <line
                            x1={landmarks.U1Apex.x * 1000}
                            y1={landmarks.U1Apex.y * 1000}
                            x2={landmarks.U1Tip.x * 1000}
                            y2={landmarks.U1Tip.y * 1000}
                            stroke="#fb7185"
                            strokeWidth="1.5"
                            strokeDasharray="3 2"
                          />
                        )}
                        {landmarks.L1Apex && landmarks.L1Tip && (
                          <line
                            x1={landmarks.L1Apex.x * 1000}
                            y1={landmarks.L1Apex.y * 1000}
                            x2={landmarks.L1Tip.x * 1000}
                            y2={landmarks.L1Tip.y * 1000}
                            stroke="#60a5fa"
                            strokeWidth="1.5"
                            strokeDasharray="3 2"
                          />
                        )}
                      </g>
                    )}

                    {/* Calibration ruler dots */}
                    {calPts.map((cp, idx) => (
                      <circle
                        key={`cal-${idx}`}
                        cx={cp.x * 1000}
                        cy={cp.y * 1000}
                        r="7"
                        fill="#f5922e"
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                    ))}

                    {/* Draggable Landmark Pins */}
                    {Object.entries(landmarks).map(([k, pt]) => {
                      const isActive = activeLandmark === k || draggingKey === k;
                      return (
                        <g
                          key={k}
                          transform={`translate(${pt.x * 1000}, ${pt.y * 1000})`}
                          className="cursor-move"
                          onPointerDown={(ev) => {
                            if (panMode || calibrating) return;
                            ev.stopPropagation();
                            setActiveLandmark(k);
                            setDraggingKey(k);
                            (ev.currentTarget as unknown as HTMLElement).setPointerCapture?.(ev.pointerId);
                          }}
                        >
                          <circle
                            r={isActive ? 8 : 5.5}
                            fill={isActive ? '#f5922e' : '#3d7ab5'}
                            stroke="#ffffff"
                            strokeWidth="2"
                          />
                          <text
                            x="11"
                            y="4"
                            fill={isActive ? '#fbd09b' : '#f8fafc'}
                            fontSize="17"
                            fontFamily="IBM Plex Mono, monospace"
                            fontWeight="600"
                            style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
                          >
                            {k}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>

                {/* Floating Cursor Magnifier Loupe (LTR absolute coordinate box for exact X-ray zoom) */}
                {loupeEnabled && cursorLoupe && !panMode && (() => {
                  const loupeHalf = loupeSize / 2;
                  const lensW = cursorLoupe.stageW * loupePower;
                  const lensH = cursorLoupe.stageH * loupePower;
                  return (
                    <div
                      dir="ltr"
                      className="absolute rounded-full overflow-hidden border-2 border-brand-orange shadow-2xl bg-black pointer-events-none z-30"
                      style={{
                        width: `${loupeSize}px`,
                        height: `${loupeSize}px`,
                        left: `${cursorLoupe.vx - loupeHalf}px`,
                        top: `${cursorLoupe.vy - loupeHalf}px`,
                      }}
                    >
                      <div
                        className="absolute"
                        style={{
                          width: `${lensW}px`,
                          height: `${lensH}px`,
                          left: `${loupeHalf - cursorLoupe.nx * lensW}px`,
                          top: `${loupeHalf - cursorLoupe.ny * lensH}px`,
                        }}
                      >
                        <img
                          src={selectedMedia.originalUrl}
                          alt=""
                          draggable={false}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            filter: `brightness(${brightness}%) contrast(${contrast}%) ${invertGray ? 'invert(1)' : ''}`,
                          }}
                        />
                        <svg viewBox="0 0 1000 1000" className="absolute inset-0 w-full h-full">
                          {showTracing && (
                            <g>
                              {landmarks.S && landmarks.N && (
                                <line x1={landmarks.S.x * 1000} y1={landmarks.S.y * 1000} x2={landmarks.N.x * 1000} y2={landmarks.N.y * 1000} stroke="#38bdf8" strokeWidth="1.4" />
                              )}
                              {landmarks.Ba && landmarks.S && (
                                <line x1={landmarks.Ba.x * 1000} y1={landmarks.Ba.y * 1000} x2={landmarks.S.x * 1000} y2={landmarks.S.y * 1000} stroke="#38bdf8" strokeWidth="1.1" strokeDasharray="4 3" />
                              )}
                              {landmarks.Po && landmarks.Or && (
                                <line x1={landmarks.Po.x * 1000} y1={landmarks.Po.y * 1000} x2={landmarks.Or.x * 1000} y2={landmarks.Or.y * 1000} stroke="#a78bfa" strokeWidth="1.2" strokeDasharray="5 3" />
                              )}
                              {landmarks.ANS && landmarks.PNS && (
                                <line x1={landmarks.PNS.x * 1000} y1={landmarks.PNS.y * 1000} x2={landmarks.ANS.x * 1000} y2={landmarks.ANS.y * 1000} stroke="#2dd4bf" strokeWidth="1.2" />
                              )}
                              {landmarks.N && landmarks.A && (
                                <line x1={landmarks.N.x * 1000} y1={landmarks.N.y * 1000} x2={landmarks.A.x * 1000} y2={landmarks.A.y * 1000} stroke="#34d399" strokeWidth="1.2" />
                              )}
                              {landmarks.N && landmarks.B && (
                                <line x1={landmarks.N.x * 1000} y1={landmarks.N.y * 1000} x2={landmarks.B.x * 1000} y2={landmarks.B.y * 1000} stroke="#f5922e" strokeWidth="1.2" />
                              )}
                              {landmarks.Go && landmarks.Me && (
                                <line x1={landmarks.Go.x * 1000} y1={landmarks.Go.y * 1000} x2={landmarks.Me.x * 1000} y2={landmarks.Me.y * 1000} stroke="#f472b6" strokeWidth="1.4" />
                              )}
                              {landmarks.Ar && landmarks.Go && (
                                <line x1={landmarks.Ar.x * 1000} y1={landmarks.Ar.y * 1000} x2={landmarks.Go.x * 1000} y2={landmarks.Go.y * 1000} stroke="#f472b6" strokeWidth="1.2" />
                              )}
                              {landmarks.Pn && landmarks.PogS && (
                                <line x1={landmarks.Pn.x * 1000} y1={landmarks.Pn.y * 1000} x2={landmarks.PogS.x * 1000} y2={landmarks.PogS.y * 1000} stroke="#22c55e" strokeWidth="1.1" strokeDasharray="4 3" />
                              )}
                              {softProfilePoints && (
                                <polyline points={softProfilePoints} fill="none" stroke="#fde68a" strokeWidth="1.3" opacity="0.85" />
                              )}
                              {landmarks.U1Apex && landmarks.U1Tip && (
                                <line x1={landmarks.U1Apex.x * 1000} y1={landmarks.U1Apex.y * 1000} x2={landmarks.U1Tip.x * 1000} y2={landmarks.U1Tip.y * 1000} stroke="#fb7185" strokeWidth="1.2" />
                              )}
                              {landmarks.L1Apex && landmarks.L1Tip && (
                                <line x1={landmarks.L1Apex.x * 1000} y1={landmarks.L1Apex.y * 1000} x2={landmarks.L1Tip.x * 1000} y2={landmarks.L1Tip.y * 1000} stroke="#60a5fa" strokeWidth="1.2" />
                              )}
                            </g>
                          )}
                          {Object.entries(landmarks).map(([k, pt]) => (
                            <g key={`loupe-${k}`} transform={`translate(${pt.x * 1000}, ${pt.y * 1000})`}>
                              <circle r="3.2" fill={activeLandmark === k ? '#f5922e' : '#3d7ab5'} stroke="#fff" strokeWidth="0.9" />
                              <text x="5" y="2" fill="#fbd09b" fontSize="10" fontFamily="IBM Plex Mono, monospace" fontWeight="600">
                                {k}
                              </text>
                            </g>
                          ))}
                        </svg>
                      </div>
                      {/* Precision Reticle Crosshair */}
                      <svg viewBox="0 0 160 160" className="absolute inset-0 w-full h-full">
                        <line x1="80" y1="6" x2="80" y2="70" stroke="#f5922e" strokeWidth="1.1" strokeOpacity="0.85" />
                        <line x1="80" y1="90" x2="80" y2="154" stroke="#f5922e" strokeWidth="1.1" strokeOpacity="0.85" />
                        <line x1="6" y1="80" x2="70" y2="80" stroke="#f5922e" strokeWidth="1.1" strokeOpacity="0.85" />
                        <line x1="90" y1="80" x2="154" y2="80" stroke="#f5922e" strokeWidth="1.1" strokeOpacity="0.85" />
                        <circle cx="80" cy="80" r="3" fill="none" stroke="#f5922e" strokeWidth="1.1" />
                        <circle cx="80" cy="80" r="0.9" fill="#ffffff" />
                      </svg>
                      <div className="absolute bottom-1.5 inset-x-0 flex justify-center">
                        <span className="px-2 py-0.5 rounded-full bg-navy-950/90 border border-navy-700 text-[10px] font-mono text-brand-orange font-bold">
                          {loupePower}× · {calibrating ? 'CAL' : activeLandmark}
                        </span>
                      </div>
                    </div>
                  );
                })()}

                {/* Top corner status readout */}
                <div
                  dir={lang === 'ar' ? 'rtl' : 'ltr'}
                  className="absolute top-2.5 left-2.5 bg-navy-950/85 border border-navy-800 px-2.5 py-1 rounded-md text-[11px] text-navy-100 pointer-events-none"
                >
                  <span>{tr(lang, 'المعلم النشط:', 'Active:')} </span>
                  <span className="font-mono font-bold text-brand-orange">{activeLandmark}</span>
                  <span className="mx-1.5 text-navy-500">·</span>
                  <span className="font-mono tabular-nums">{Math.round(zoom * 100)}%</span>
                </div>

                {/* Quick On-Stage Zoom Buttons (+ / -) */}
                <div
                  onPointerEnter={() => setCursorLoupe(null)}
                  onPointerMove={(e) => {
                    e.stopPropagation();
                    setCursorLoupe(null);
                  }}
                  className="absolute bottom-2.5 end-2.5 flex items-center gap-1 bg-navy-950/90 border border-navy-800 rounded-lg p-1 z-40"
                >
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Number(Math.max(0.5, z - 0.25).toFixed(2)))}
                    disabled={zoom <= 0.5}
                    className="p-1.5 rounded bg-navy-800 hover:bg-navy-700 text-white disabled:opacity-40"
                    title={tr(lang, 'تصغير', 'Zoom Out')}
                  >
                    <ZoomOut className="w-3.5 h-3.5 text-brand-orange" />
                  </button>
                  <span className="px-1.5 text-[11px] font-mono tabular-nums text-navy-100">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Number(Math.min(4, z + 0.25).toFixed(2)))}
                    disabled={zoom >= 4}
                    className="p-1.5 rounded bg-navy-800 hover:bg-navy-700 text-white disabled:opacity-40"
                    title={tr(lang, 'تكبير', 'Zoom In')}
                  >
                    <ZoomIn className="w-3.5 h-3.5 text-brand-orange" />
                  </button>
                </div>
              </div>

              {/* Filter Sliders Footer Bar inside dark stage (Brightness & Contrast only — Zoom is strictly via +/- buttons) */}
              <div className="grid grid-cols-2 gap-4 pt-1 text-[11px] text-navy-200">
                <label className="space-y-1">
                  <span className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1">
                      <Sun className="w-3 h-3 text-brand-orange" />
                      {tr(lang, 'السطوع', 'Brightness')}
                    </span>
                    <span className="font-mono tabular-nums">{brightness}%</span>
                  </span>
                  <input
                    type="range"
                    min={50}
                    max={180}
                    value={brightness}
                    onChange={(e) => setBrightness(Number(e.target.value))}
                    className="w-full accent-brand-orange"
                  />
                </label>

                <label className="space-y-1">
                  <span className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1">
                      <Contrast className="w-3 h-3 text-brand-orange" />
                      {tr(lang, 'التباين', 'Contrast')}
                    </span>
                    <span className="font-mono tabular-nums">{contrast}%</span>
                  </span>
                  <input
                    type="range"
                    min={50}
                    max={200}
                    value={contrast}
                    onChange={(e) => setContrast(Number(e.target.value))}
                    className="w-full accent-brand-orange"
                  />
                </label>
              </div>
            </>
          ) : (
            <div className="p-12 text-center text-xs text-navy-300 border border-dashed border-navy-700 rounded-lg">
              {tr(
                lang,
                'ارفع صورة أشعة سيفالومترية في تبويب الصور والأشعة للبدء بالتتبع والرسم.',
                'Upload a lateral cephalogram in Media tab to start tracing.',
              )}
            </div>
          )}
        </div>

        {/* Column 3: Live Cephalometric Readouts + Deviation Gauges (4 cols) */}
        <div className="xl:col-span-4 bg-white border border-navy-200 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-navy-100 pb-3">
            <div>
              <h4 className="text-sm font-bold text-navy-900">
                {tr(lang, 'نتائج التحليل والانحراف', 'Cephalometric Analysis & Norms')}
              </h4>
              <p className="text-[11px] text-navy-500 mt-0.5">
                {skeletalClassText} · {growthPatternText}
                {impaMetric?.value !== null && impaMetric?.value !== undefined ? ` · IMPA ${impaMetric.value}°` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={handleSaveCeph}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg shrink-0"
            >
              <Save className="w-3.5 h-3.5 text-brand-orange" />
              <span>{tr(lang, 'حفظ النسخة', 'Save')}</span>
            </button>
          </div>

          <div className="max-h-[510px] overflow-y-auto divide-y divide-navy-100 pe-1">
            {liveMetrics.map((m) => {
              const band = CEPH_NORM_BANDS[m.key];
              let statusColor = 'text-navy-500';
              let dotLeftPct = 50;
              let normLeftPct = 30;
              let normWidthPct = 40;
              let outOfRange = false;

              if (band && m.value !== null) {
                const span = band.scaleMax - band.scaleMin;
                normLeftPct = Math.max(0, Math.min(100, ((band.min - band.scaleMin) / span) * 100));
                normWidthPct = Math.max(8, Math.min(100 - normLeftPct, ((band.max - band.min) / span) * 100));
                dotLeftPct = Math.max(2, Math.min(98, ((m.value - band.scaleMin) / span) * 100));
                outOfRange = m.value < band.min || m.value > band.max;
                statusColor = outOfRange ? 'text-accent-700' : 'text-emerald-700';
              }

              return (
                <div key={m.key} title={m.formulaDesc} className="py-2.5 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-navy-900 truncate">
                        {lang === 'ar' ? m.labelAr : m.labelEn}
                      </p>
                      <p className={`text-[11px] ${statusColor}`}>{m.interpretation}</p>
                    </div>
                    <div className="text-end shrink-0">
                      <span className="text-sm font-bold font-mono tabular-nums text-navy-900">
                        {m.value !== null ? `${m.value}${m.unit === 'deg' ? '°' : ` ${m.unit}`}` : '—'}
                      </span>
                      <span className="block text-[10px] font-mono tabular-nums text-navy-400">
                        {m.normRange}
                      </span>
                    </div>
                  </div>

                  {/* Mini visual norm deviation bar */}
                  {band && m.value !== null && (
                    <div className="relative h-2 bg-navy-100 rounded-full overflow-hidden" dir="ltr">
                      <div
                        className="absolute top-0 bottom-0 bg-emerald-200/80 border-x border-emerald-500/40"
                        style={{ left: `${normLeftPct}%`, width: `${normWidthPct}%` }}
                      />
                      <div
                        className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full border border-white shadow ${
                          outOfRange ? 'bg-brand-orange' : 'bg-emerald-600'
                        }`}
                        style={{ left: `${dotLeftPct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
