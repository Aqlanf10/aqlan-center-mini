"use client";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Crosshair,
  Eye,
  EyeOff,
  RotateCcw,
  Ruler,
  Save,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Language, MeasurementAnalysis, PatientCase, RecordStage, UserRole } from '../types/ortho';
import { tr } from '../i18n/translations';
import {
  PHOTO_LANDMARKS_CATALOG,
  PhotoModeId,
  Point2D,
  computePhotoMetrics,
} from '../utils/orthoMath';

interface PhotoAnalysisStudioProps {
  patient: PatientCase;
  stage: RecordStage;
  lang: Language;
  role: UserRole;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

interface PhotoModeMeta {
  id: PhotoModeId;
  group: 'extraoral' | 'intraoral';
  ar: string;
  en: string;
  shortAr: string;
  shortEn: string;
  defaultKnownMm: number;
  calHintAr: string;
  calHintEn: string;
}

const PHOTO_MODES: PhotoModeMeta[] = [
  {
    id: 'frontal',
    group: 'extraoral',
    ar: 'تحليل الوجه الأمامي (الأثلاث والتماثل)',
    en: 'Frontal Facial Proportions',
    shortAr: 'الوجه الأمامي',
    shortEn: 'Frontal',
    defaultKnownMm: 62,
    calHintAr: 'المسافة بين الحدقتين ~62 مم',
    calHintEn: 'Interpupillary distance ~62 mm',
  },
  {
    id: 'profile',
    group: 'extraoral',
    ar: 'تحليل البروفايل الجانبي والزوايا الرخوة',
    en: 'Profile Soft-Tissue Angles',
    shortAr: 'البروفايل الجانبي',
    shortEn: 'Profile',
    defaultKnownMm: 10,
    calHintAr: 'معايرة مرجعية (مثلاً 10 مم)',
    calHintEn: 'Reference ruler (e.g. 10 mm)',
  },
  {
    id: 'smile',
    group: 'extraoral',
    ar: 'تحليل الابتسامة والممر الشدقي',
    en: 'Smile Arc & Buccal Corridor',
    shortAr: 'الابتسامة',
    shortEn: 'Smile',
    defaultKnownMm: 8.5,
    calHintAr: 'عرض الثنية العلوية #11 ~8.5 مم',
    calHintEn: 'Upper central #11 width ~8.5 mm',
  },
  {
    id: 'intraoral_frontal',
    group: 'intraoral',
    ar: 'داخل الفم أمامي (الخط المتوسط والتغطية)',
    en: 'Intraoral Frontal Occlusion',
    shortAr: 'داخل الفم أمامي',
    shortEn: 'IO Frontal',
    defaultKnownMm: 8.5,
    calHintAr: 'عرض الثنية العلوية #11 ~8.5 مم',
    calHintEn: 'Upper central #11 width ~8.5 mm',
  },
  {
    id: 'intraoral_right',
    group: 'intraoral',
    ar: 'داخل الفم جانبي يمين (الأرحاء والأنياب وOverjet)',
    en: 'Intraoral Right Buccal',
    shortAr: 'جانبي يمين',
    shortEn: 'IO Right',
    defaultKnownMm: 10.0,
    calHintAr: 'العرض الأنسي الوحشي للضرس #16 ~10 مم أو الناب #13 ~7.8 مم',
    calHintEn: 'Upper molar #16 ~10 mm or canine #13 ~7.8 mm',
  },
  {
    id: 'intraoral_left',
    group: 'intraoral',
    ar: 'داخل الفم جانبي يسار (الأرحاء والأنياب وOverjet)',
    en: 'Intraoral Left Buccal',
    shortAr: 'جانبي يسار',
    shortEn: 'IO Left',
    defaultKnownMm: 10.0,
    calHintAr: 'العرض الأنسي الوحشي للضرس #26 ~10 مم أو الناب #23 ~7.8 مم',
    calHintEn: 'Upper molar #26 ~10 mm or canine #23 ~7.8 mm',
  },
  {
    id: 'intraoral_upper',
    group: 'intraoral',
    ar: 'إطباقي علوي (عرض القوس والتناظر)',
    en: 'Upper Occlusal Arch',
    shortAr: 'إطباقي علوي',
    shortEn: 'Upper Occ.',
    defaultKnownMm: 8.5,
    calHintAr: 'عرض الثنية #11 ~8.5 مم أو الضرس #16 ~10 مم',
    calHintEn: 'Central #11 ~8.5 mm or molar #16 ~10 mm',
  },
  {
    id: 'intraoral_lower',
    group: 'intraoral',
    ar: 'إطباقي سفلي (عرض القوس والتناظر)',
    en: 'Lower Occlusal Arch',
    shortAr: 'إطباقي سفلي',
    shortEn: 'Lower Occ.',
    defaultKnownMm: 5.5,
    calHintAr: 'عرض الثنية السفلية #41 ~5.5 مم أو الضرس #46 ~11 مم',
    calHintEn: 'Lower central #41 ~5.5 mm or molar #46 ~11 mm',
  },
];

const EMPTY_LANDMARKS_BY_MODE = (): Record<PhotoModeId, Record<string, Point2D>> => ({
  frontal: {},
  profile: {},
  smile: {},
  intraoral_frontal: {},
  intraoral_right: {},
  intraoral_left: {},
  intraoral_upper: {},
  intraoral_lower: {},
});

const loadLandmarksFromAnalyses = (
  analyses: MeasurementAnalysis[],
): Record<PhotoModeId, Record<string, Point2D>> => {
  const res = EMPTY_LANDMARKS_BY_MODE();
  (Object.keys(res) as PhotoModeId[]).forEach((mId) => {
    const found = analyses.find((a) => a.analysisType === 'photo_analysis' && a.photoViewMode === mId);
    if (found?.landmarks) res[mId] = found.landmarks;
  });
  return res;
};

export const PhotoAnalysisStudio: React.FC<PhotoAnalysisStudioProps> = ({
  patient,
  stage,
  lang,
  role,
  actorName,
  onChange,
}) => {
  const [mode, setMode] = useState<PhotoModeId>('smile');
  const photoOptions = useMemo(
    () => patient.media.filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph'),
    [patient.media],
  );

  const pickBestPhoto = (mId: PhotoModeId) => {
    const viewMap: Record<PhotoModeId, string[]> = {
      frontal: ['extraoral_frontal'],
      profile: ['extraoral_profile'],
      smile: ['extraoral_smile', 'intraoral_frontal'],
      intraoral_frontal: ['intraoral_frontal', 'extraoral_smile'],
      intraoral_right: ['intraoral_right'],
      intraoral_left: ['intraoral_left'],
      intraoral_upper: ['intraoral_upper'],
      intraoral_lower: ['intraoral_lower'],
    };
    for (const vt of viewMap[mId]) {
      const match = photoOptions.find((m) => m.viewType === vt);
      if (match) return match;
    }
    return photoOptions[0] || null;
  };

  const [selectedMediaId, setSelectedMediaId] = useState<string>(() => pickBestPhoto('smile')?.id || '');
  const selectedMedia = patient.media.find((m) => m.id === selectedMediaId) || pickBestPhoto(mode);

  const savedForMode = useMemo(
    () => patient.analyses.find((a) => a.analysisType === 'photo_analysis' && a.photoViewMode === mode) || null,
    [patient.analyses, mode],
  );

  const [landmarksByMode, setLandmarksByMode] = useState<Record<PhotoModeId, Record<string, Point2D>>>(() =>
    loadLandmarksFromAnalyses(patient.analyses),
  );

  useEffect(() => {
    setLandmarksByMode(loadLandmarksFromAnalyses(patient.analyses));
  }, [patient.id]);

  const landmarks = landmarksByMode[mode] || {};
  const catalog = PHOTO_LANDMARKS_CATALOG[mode];
  const [activeKey, setActiveKey] = useState<string>(catalog[0].key);
  const [showGuides, setShowGuides] = useState(true);
  const [zoom, setZoom] = useState(1);

  const [calibrating, setCalibrating] = useState(false);
  const [calPts, setCalPts] = useState<Point2D[]>([]);
  const [knownMm, setKnownMm] = useState<number>(8.5);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const modeInfo = PHOTO_MODES.find((pm) => pm.id === mode);
    if (modeInfo) setKnownMm(modeInfo.defaultKnownMm);
    const best = pickBestPhoto(mode);
    if (best) setSelectedMediaId(best.id);
    setActiveKey(PHOTO_LANDMARKS_CATALOG[mode][0].key);
    setCalibrating(false);
    setCalPts([]);
  }, [mode, patient.id]);

  const pixelsPerMm = selectedMedia?.calibration.isCalibrated ? selectedMedia.calibration.pixelsPerMm : null;

  const liveMetrics = useMemo(
    () => computePhotoMetrics(mode, landmarks, 1000, 1000, pixelsPerMm),
    [mode, landmarks, pixelsPerMm],
  );

  const toNorm = (clientX: number, clientY: number): Point2D | null => {
    if (!stageRef.current) return null;
    const rect = stageRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, Number(((clientX - rect.left) / rect.width).toFixed(4)))),
      y: Math.max(0, Math.min(1, Number(((clientY - rect.top) / rect.height).toFixed(4)))),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingKey) return;
    const pt = toNorm(e.clientX, e.clientY);
    if (!pt) return;

    if (calibrating) {
      const next = [...calPts, pt];
      if (next.length === 2) {
        const distPx = Math.hypot((next[1].x - next[0].x) * 1000, (next[1].y - next[0].y) * 1000);
        const pxPerMm = knownMm > 0 ? Number((distPx / knownMm).toFixed(3)) : 0;
        if (selectedMedia && pxPerMm > 0) {
          const updatedMedia = patient.media.map((m) =>
            m.id === selectedMedia.id
              ? {
                  ...m,
                  calibration: {
                    isCalibrated: true,
                    pixelsPerMm: pxPerMm,
                    source: `معايرة صورة (${knownMm} مم)`,
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

    setLandmarksByMode((prev) => {
      const cur = { ...prev[mode], [activeKey]: pt };
      const idx = catalog.findIndex((c) => c.key === activeKey);
      const nextUnplaced =
        catalog.slice(idx + 1).find((c) => !cur[c.key]) || catalog.find((c) => !cur[c.key]);
      if (nextUnplaced) setActiveKey(nextUnplaced.key);
      return { ...prev, [mode]: cur };
    });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingKey) return;
    const pt = toNorm(e.clientX, e.clientY);
    if (!pt) return;
    setLandmarksByMode((prev) => ({
      ...prev,
      [mode]: { ...prev[mode], [draggingKey]: pt },
    }));
  };

  const handleSavePhotoAnalysis = () => {
    const count = patient.analyses.filter((a) => a.analysisType === 'photo_analysis').length + 1;
    const modeLabel = PHOTO_MODES.find((m) => m.id === mode);
    const isIntraoral = modeLabel?.group === 'intraoral';
    const newAnalysis: MeasurementAnalysis = {
      id: `ana-photo-${Date.now()}`,
      version: count,
      stage,
      analysisType: 'photo_analysis',
      photoViewMode: mode,
      templateName: lang === 'ar' ? modeLabel?.ar || 'تحليل الصور' : modeLabel?.en || 'Photo Analysis',
      normSource: isIntraoral
        ? 'Intraoral Occlusal, Sagittal & Arch Form Photogrammetry'
        : 'Arnett / Sarver / Ricketts Facial & Smile Aesthetics',
      linkedMediaId: selectedMedia?.id,
      calibrationValid: Boolean(selectedMedia?.calibration.isCalibrated),
      calibrationSource: selectedMedia?.calibration.source || tr(lang, 'غير معاير', 'Uncalibrated'),
      landmarks,
      metrics: liveMetrics,
      examiner: actorName,
      createdAt: new Date().toISOString(),
      approvedBy: role === 'doctor' ? actorName : undefined,
      approvedAt: role === 'doctor' ? new Date().toISOString() : undefined,
    };

    onChange(
      { ...patient, analyses: [newAnalysis, ...patient.analyses] },
      {
        ar: `حفظ ${modeLabel?.ar || 'تحليل الصور'} (${stage})`,
        en: `Saved ${modeLabel?.en || 'Photo Analysis'} (${stage})`,
      },
    );
  };

  const activeDef = catalog.find((c) => c.key === activeKey);
  const currentModeInfo = PHOTO_MODES.find((pm) => pm.id === mode)!;
  const extraoralModes = PHOTO_MODES.filter((pm) => pm.group === 'extraoral');
  const intraoralModes = PHOTO_MODES.filter((pm) => pm.group === 'intraoral');

  return (
    <div className="space-y-4">
      {/* Studio Top Strip */}
      <div className="bg-navy-900 text-white rounded-xl border border-navy-800 p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Extraoral Modes */}
            <div className="flex flex-wrap items-center gap-1 bg-navy-950/70 p-1 rounded-lg border border-navy-800">
              <span className="px-2 text-[10px] font-bold uppercase tracking-wide text-navy-300">
                {tr(lang, 'خارج الفم:', 'Extraoral:')}
              </span>
              {extraoralModes.map((pm) => (
                <button
                  key={pm.id}
                  type="button"
                  onClick={() => setMode(pm.id)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    mode === pm.id
                      ? 'bg-brand-orange text-navy-950 font-semibold'
                      : 'text-navy-200 hover:text-white hover:bg-navy-800'
                  }`}
                >
                  {lang === 'ar' ? pm.shortAr : pm.shortEn}
                </button>
              ))}
            </div>

            {/* Intraoral Modes */}
            <div className="flex flex-wrap items-center gap-1 bg-navy-950/70 p-1 rounded-lg border border-navy-800">
              <span className="px-2 text-[10px] font-bold uppercase tracking-wide text-emerald-300">
                {tr(lang, 'داخل الفم:', 'Intraoral:')}
              </span>
              {intraoralModes.map((pm) => {
                const hasSaved = patient.analyses.some((a) => a.analysisType === 'photo_analysis' && a.photoViewMode === pm.id);
                return (
                  <button
                    key={pm.id}
                    type="button"
                    onClick={() => setMode(pm.id)}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1 ${
                      mode === pm.id
                        ? 'bg-emerald-500 text-navy-950 font-semibold'
                        : 'text-navy-200 hover:text-white hover:bg-navy-800'
                    }`}
                  >
                    <span>{lang === 'ar' ? pm.shortAr : pm.shortEn}</span>
                    {hasSaved && mode !== pm.id && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                  </button>
                );
              })}
            </div>
          </div>

          <select
            value={selectedMedia?.id || ''}
            onChange={(e) => setSelectedMediaId(e.target.value)}
            className="px-3 py-1.5 text-xs bg-navy-800 border border-navy-700 text-white rounded-lg focus:outline-none focus:border-brand-orange"
          >
            {photoOptions.length === 0 ? (
              <option value="">{tr(lang, 'لا توجد صور مرفوعة', 'No photos uploaded')}</option>
            ) : (
              photoOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} ({m.stage})
                </option>
              ))
            )}
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-navy-800">
          <p className="text-xs text-navy-200 font-medium">
            {lang === 'ar' ? currentModeInfo.ar : currentModeInfo.en}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 bg-navy-950/60 border border-navy-800 rounded-lg px-2 py-1 text-xs">
              <input
                type="number"
                step="0.5"
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
                }}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold ${
                  calibrating ? 'bg-brand-orange text-navy-950' : 'bg-navy-800 text-navy-100 hover:bg-navy-700'
                }`}
              >
                <Ruler className="w-3.5 h-3.5" />
                <span>
                  {calibrating
                    ? tr(lang, `نقطتان (${calPts.length}/2)`, `2 pts (${calPts.length}/2)`)
                    : tr(lang, 'معايرة عرض سن/مسافة', 'Calibrate Photo')}
                </span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowGuides((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border ${
                showGuides ? 'bg-navy-700 border-navy-600 text-white' : 'bg-navy-800 border-navy-700 text-navy-300'
              }`}
            >
              {showGuides ? <Eye className="w-3.5 h-3.5 text-brand-orange" /> : <EyeOff className="w-3.5 h-3.5" />}
              <span>{tr(lang, 'الشبكة الهندسية', 'Guides')}</span>
            </button>

            <div className="flex items-center gap-1 bg-navy-800 border border-navy-700 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setZoom((z) => Number(Math.min(3.5, z + 0.25).toFixed(2)))}
                className="p-1 hover:bg-navy-700 rounded text-navy-200"
                title={tr(lang, 'تكبير', 'Zoom In')}
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Number(Math.max(0.8, z - 0.25).toFixed(2)))}
                className="p-1 hover:bg-navy-700 rounded text-navy-200"
                title={tr(lang, 'تصغير', 'Zoom Out')}
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="p-1 hover:bg-navy-700 rounded text-navy-200"
                title={tr(lang, 'إعادة ضبط التكبير', 'Reset Zoom')}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Calibration notice */}
      {selectedMedia && !selectedMedia.calibration.isCalibrated ? (
        <div className="px-4 py-2 bg-accent-50 border border-accent-200 rounded-xl flex items-center gap-2 text-xs text-accent-900">
          <AlertTriangle className="w-4 h-4 text-brand-orange shrink-0" />
          <span>
            {tr(
              lang,
              `للحصول على قياسات مليمترية: اضغط "معايرة عرض سن/مسافة" وانقر نقطتين معلومتين — (${currentModeInfo.calHintAr}). النسب والزوايا تحسب تلقائياً بدون معايرة.`,
              `For millimeter readouts: click "Calibrate Photo" across a known tooth/distance (${currentModeInfo.calHintEn}). Ratios & angles calculate automatically without calibration.`,
            )}
          </span>
        </div>
      ) : selectedMedia ? (
        <div className="px-4 py-2 bg-navy-50 border border-navy-200 rounded-xl flex items-center justify-between text-xs text-navy-800">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="w-4 h-4 text-brand-blue" />
            <span>{selectedMedia.calibration.source}</span>
          </span>
          <span className="font-mono tabular-nums font-semibold">
            {selectedMedia.calibration.pixelsPerMm} px/mm
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Landmarks Selector */}
        <div className="xl:col-span-3 bg-white border border-navy-200 rounded-xl p-3.5 space-y-3">
          <div className="flex items-center justify-between border-b border-navy-100 pb-2">
            <div>
              <h4 className="text-xs font-bold text-navy-900">
                {tr(lang, 'نقاط تحليل الصورة', 'Photographic Landmarks')}
              </h4>
              <p className="text-[11px] text-navy-500 mt-0.5">{activeDef?.hintAr}</p>
            </div>
            {Object.keys(landmarks).length > 0 && (
              <button
                type="button"
                onClick={() => setLandmarksByMode((prev) => ({ ...prev, [mode]: {} }))}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50 rounded-md"
              >
                <Trash2 className="w-3 h-3" />
                <span>{tr(lang, 'مسح', 'Clear')}</span>
              </button>
            )}
          </div>

          <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
            {catalog.map((lm) => {
              const placed = Boolean(landmarks[lm.key]);
              const isActive = activeKey === lm.key;
              return (
                <button
                  key={lm.key}
                  type="button"
                  onClick={() => {
                    setActiveKey(lm.key);
                    setCalibrating(false);
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-xs rounded-lg border transition-colors text-start ${
                    isActive
                      ? 'bg-navy-900 border-navy-900 text-white font-semibold'
                      : placed
                      ? 'bg-accent-50 border-accent-200 text-navy-900'
                      : 'bg-white border-navy-200 text-navy-600 hover:bg-navy-50'
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5 truncate">
                    <Crosshair
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isActive || placed ? 'text-brand-orange' : 'text-navy-300'
                      }`}
                    />
                    <span className="truncate">{lang === 'ar' ? lm.ar : lm.en}</span>
                  </span>
                  {placed && <span className="text-[10px] font-bold text-brand-orange">✓</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Center Photo Canvas */}
        <div className="xl:col-span-5 bg-navy-950 border border-navy-800 rounded-xl p-3 space-y-3">
          {selectedMedia ? (
            <>
              <div
                className="relative w-full aspect-[4/3] max-h-[540px] bg-black rounded-lg overflow-hidden select-none border border-navy-800"
                onWheel={(e) => {
                  e.preventDefault();
                  const d = e.deltaY < 0 ? 0.15 : -0.15;
                  setZoom((z) => Number(Math.max(0.8, Math.min(3.5, z + d)).toFixed(2)));
                }}
              >
                <div
                  ref={stageRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={() => setDraggingKey(null)}
                  style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                  className="relative w-full h-full cursor-crosshair"
                >
                  <img
                    src={selectedMedia.originalUrl}
                    alt={selectedMedia.title}
                    draggable={false}
                    className="w-full h-full object-contain pointer-events-none"
                  />

                  <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
                    {showGuides && mode === 'frontal' && (
                      <g pointerEvents="none">
                        {/* Horizontal Facial Third Lines */}
                        {['Tr', 'G', 'Sn', 'MeS'].map((k) => {
                          const pt = landmarks[k];
                          if (!pt) return null;
                          return (
                            <line
                              key={`h-${k}`}
                              x1="120"
                              y1={pt.y * 1000}
                              x2="880"
                              y2={pt.y * 1000}
                              stroke="#38bdf8"
                              strokeWidth="1.6"
                              strokeDasharray="6 4"
                            />
                          );
                        })}
                        {/* Interpupillary & Commissure lines */}
                        {landmarks.PuR && landmarks.PuL && (
                          <>
                            <line
                              x1={landmarks.PuR.x * 1000}
                              y1={landmarks.PuR.y * 1000}
                              x2={landmarks.PuL.x * 1000}
                              y2={landmarks.PuL.y * 1000}
                              stroke="#22c55e"
                              strokeWidth="2"
                            />
                            {/* Vertical Facial Midline */}
                            <line
                              x1={((landmarks.PuR.x + landmarks.PuL.x) / 2) * 1000}
                              y1="80"
                              x2={((landmarks.PuR.x + landmarks.PuL.x) / 2) * 1000}
                              y2="920"
                              stroke="#f5922e"
                              strokeWidth="1.8"
                              strokeDasharray="5 4"
                            />
                          </>
                        )}
                        {landmarks.ChR && landmarks.ChL && (
                          <line
                            x1={landmarks.ChR.x * 1000}
                            y1={landmarks.ChR.y * 1000}
                            x2={landmarks.ChL.x * 1000}
                            y2={landmarks.ChL.y * 1000}
                            stroke="#f472b6"
                            strokeWidth="2"
                          />
                        )}
                      </g>
                    )}

                    {showGuides && mode === 'profile' && (
                      <g pointerEvents="none">
                        {landmarks.G && landmarks.Sn && landmarks.PogS && (
                          <polyline
                            points={`${landmarks.G.x * 1000},${landmarks.G.y * 1000} ${landmarks.Sn.x * 1000},${landmarks.Sn.y * 1000} ${landmarks.PogS.x * 1000},${landmarks.PogS.y * 1000}`}
                            fill="none"
                            stroke="#38bdf8"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.Col && landmarks.Sn && landmarks.Ls && (
                          <polyline
                            points={`${landmarks.Col.x * 1000},${landmarks.Col.y * 1000} ${landmarks.Sn.x * 1000},${landmarks.Sn.y * 1000} ${landmarks.Ls.x * 1000},${landmarks.Ls.y * 1000}`}
                            fill="none"
                            stroke="#f5922e"
                            strokeWidth="2.2"
                          />
                        )}
                        {landmarks.Li && landmarks.BS && landmarks.PogS && (
                          <polyline
                            points={`${landmarks.Li.x * 1000},${landmarks.Li.y * 1000} ${landmarks.BS.x * 1000},${landmarks.BS.y * 1000} ${landmarks.PogS.x * 1000},${landmarks.PogS.y * 1000}`}
                            fill="none"
                            stroke="#f472b6"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.Pn && landmarks.PogS && (
                          <line
                            x1={landmarks.Pn.x * 1000}
                            y1={landmarks.Pn.y * 1000}
                            x2={landmarks.PogS.x * 1000}
                            y2={landmarks.PogS.y * 1000}
                            stroke="#22c55e"
                            strokeWidth="1.8"
                            strokeDasharray="5 4"
                          />
                        )}
                      </g>
                    )}

                    {showGuides && mode === 'smile' && (
                      <g pointerEvents="none">
                        {landmarks.ChR && landmarks.ChL && (
                          <line
                            x1={landmarks.ChR.x * 1000}
                            y1={landmarks.ChR.y * 1000}
                            x2={landmarks.ChL.x * 1000}
                            y2={landmarks.ChL.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="1.8"
                            strokeDasharray="6 4"
                          />
                        )}
                        {landmarks.DentR && landmarks.DentL && (
                          <line
                            x1={landmarks.DentR.x * 1000}
                            y1={landmarks.DentR.y * 1000}
                            x2={landmarks.DentL.x * 1000}
                            y2={landmarks.DentL.y * 1000}
                            stroke="#22c55e"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.FaceMid && (
                          <line
                            x1={landmarks.FaceMid.x * 1000}
                            y1="150"
                            x2={landmarks.FaceMid.x * 1000}
                            y2="850"
                            stroke="#f5922e"
                            strokeWidth="1.8"
                            strokeDasharray="5 4"
                          />
                        )}
                        {landmarks.ChR && landmarks.U1Edge && landmarks.CanineL && landmarks.ChL && (
                          <path
                            d={`M ${landmarks.ChR.x * 1000} ${landmarks.ChR.y * 1000} Q ${landmarks.U1Edge.x * 1000} ${landmarks.U1Edge.y * 1000 + 30} ${landmarks.ChL.x * 1000} ${landmarks.ChL.y * 1000}`}
                            fill="none"
                            stroke="#facc15"
                            strokeWidth="2"
                          />
                        )}
                      </g>
                    )}

                    {showGuides && mode === 'intraoral_frontal' && (
                      <g pointerEvents="none">
                        {landmarks.UMid && (
                          <line
                            x1={landmarks.UMid.x * 1000}
                            y1="140"
                            x2={landmarks.UMid.x * 1000}
                            y2="860"
                            stroke="#f5922e"
                            strokeWidth="1.8"
                            strokeDasharray="5 4"
                          />
                        )}
                        {landmarks.LMid && (
                          <line
                            x1={landmarks.LMid.x * 1000}
                            y1="450"
                            x2={landmarks.LMid.x * 1000}
                            y2="860"
                            stroke="#22c55e"
                            strokeWidth="1.8"
                            strokeDasharray="4 4"
                          />
                        )}
                        {landmarks.UCanR && landmarks.UCanL && (
                          <line
                            x1={landmarks.UCanR.x * 1000}
                            y1={landmarks.UCanR.y * 1000}
                            x2={landmarks.UCanL.x * 1000}
                            y2={landmarks.UCanL.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.Zen11 && landmarks.Zen21 && (
                          <line
                            x1={landmarks.Zen11.x * 1000}
                            y1={landmarks.Zen11.y * 1000}
                            x2={landmarks.Zen21.x * 1000}
                            y2={landmarks.Zen21.y * 1000}
                            stroke="#22c55e"
                            strokeWidth="1.8"
                          />
                        )}
                        {landmarks.W11R && landmarks.W11L && (
                          <line
                            x1={landmarks.W11R.x * 1000}
                            y1={landmarks.W11R.y * 1000}
                            x2={landmarks.W11L.x * 1000}
                            y2={landmarks.W11L.y * 1000}
                            stroke="#facc15"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.W12R && landmarks.W12L && (
                          <line
                            x1={landmarks.W12R.x * 1000}
                            y1={landmarks.W12R.y * 1000}
                            x2={landmarks.W12L.x * 1000}
                            y2={landmarks.W12L.y * 1000}
                            stroke="#facc15"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.U1Edge && landmarks.L1Edge && (
                          <line
                            x1={landmarks.U1Edge.x * 1000}
                            y1={landmarks.U1Edge.y * 1000}
                            x2={landmarks.L1Edge.x * 1000}
                            y2={landmarks.L1Edge.y * 1000}
                            stroke="#f472b6"
                            strokeWidth="2.2"
                          />
                        )}
                      </g>
                    )}

                    {showGuides && (mode === 'intraoral_right' || mode === 'intraoral_left') && (
                      <g pointerEvents="none">
                        {landmarks.U6MB && (landmarks.U3Tip || landmarks.U1Lab) && (
                          <line
                            x1={landmarks.U6MB.x * 1000}
                            y1={landmarks.U6MB.y * 1000}
                            x2={(landmarks.U3Tip || landmarks.U1Lab).x * 1000}
                            y2={(landmarks.U3Tip || landmarks.U1Lab).y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="2"
                            strokeDasharray="6 4"
                          />
                        )}
                        {landmarks.U1Axis && landmarks.U1Lab && (
                          <line
                            x1={landmarks.U1Axis.x * 1000}
                            y1={landmarks.U1Axis.y * 1000}
                            x2={landmarks.U1Lab.x * 1000}
                            y2={landmarks.U1Lab.y * 1000}
                            stroke="#f5922e"
                            strokeWidth="2.2"
                          />
                        )}
                        {landmarks.U6MB && landmarks.L6Groove && (
                          <line
                            x1={landmarks.U6MB.x * 1000}
                            y1={landmarks.U6MB.y * 1000}
                            x2={landmarks.L6Groove.x * 1000}
                            y2={landmarks.L6Groove.y * 1000}
                            stroke="#22c55e"
                            strokeWidth="2.2"
                          />
                        )}
                        {landmarks.U3Tip && landmarks.L34Embr && (
                          <line
                            x1={landmarks.U3Tip.x * 1000}
                            y1={landmarks.U3Tip.y * 1000}
                            x2={landmarks.L34Embr.x * 1000}
                            y2={landmarks.L34Embr.y * 1000}
                            stroke="#facc15"
                            strokeWidth="2.2"
                          />
                        )}
                        {landmarks.U1Lab && landmarks.L1Lab && (
                          <line
                            x1={landmarks.U1Lab.x * 1000}
                            y1={landmarks.U1Lab.y * 1000}
                            x2={landmarks.L1Lab.x * 1000}
                            y2={landmarks.L1Lab.y * 1000}
                            stroke="#f472b6"
                            strokeWidth="2.2"
                          />
                        )}
                      </g>
                    )}

                    {showGuides && (mode === 'intraoral_upper' || mode === 'intraoral_lower') && (
                      <g pointerEvents="none">
                        {landmarks.IncMid && landmarks.PalMid && (
                          <line
                            x1={landmarks.IncMid.x * 1000}
                            y1={landmarks.IncMid.y * 1000}
                            x2={landmarks.PalMid.x * 1000}
                            y2={landmarks.PalMid.y * 1000}
                            stroke="#f5922e"
                            strokeWidth="2"
                            strokeDasharray="6 4"
                          />
                        )}
                        {landmarks.C3R && landmarks.C3L && (
                          <line
                            x1={landmarks.C3R.x * 1000}
                            y1={landmarks.C3R.y * 1000}
                            x2={landmarks.C3L.x * 1000}
                            y2={landmarks.C3L.y * 1000}
                            stroke="#38bdf8"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.P4R && landmarks.P4L && (
                          <line
                            x1={landmarks.P4R.x * 1000}
                            y1={landmarks.P4R.y * 1000}
                            x2={landmarks.P4L.x * 1000}
                            y2={landmarks.P4L.y * 1000}
                            stroke="#22c55e"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.M6R && landmarks.M6L && (
                          <line
                            x1={landmarks.M6R.x * 1000}
                            y1={landmarks.M6R.y * 1000}
                            x2={landmarks.M6L.x * 1000}
                            y2={landmarks.M6L.y * 1000}
                            stroke="#f472b6"
                            strokeWidth="2"
                          />
                        )}
                        {landmarks.M6R && landmarks.C3R && landmarks.IncEdge && landmarks.C3L && landmarks.M6L && (
                          <polyline
                            points={[
                              landmarks.M6R,
                              landmarks.P4R,
                              landmarks.C3R,
                              landmarks.IncEdge,
                              landmarks.C3L,
                              landmarks.P4L,
                              landmarks.M6L,
                            ]
                              .filter(Boolean)
                              .map((pt) => `${pt!.x * 1000},${pt!.y * 1000}`)
                              .join(' ')}
                            fill="none"
                            stroke="#facc15"
                            strokeWidth="2"
                            strokeDasharray="4 3"
                          />
                        )}
                      </g>
                    )}

                    {calPts.map((cp, i) => (
                      <circle
                        key={`pcal-${i}`}
                        cx={cp.x * 1000}
                        cy={cp.y * 1000}
                        r="7"
                        fill="#f5922e"
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                    ))}

                    {Object.entries(landmarks).map(([k, pt]) => (
                      <g
                        key={k}
                        transform={`translate(${pt.x * 1000}, ${pt.y * 1000})`}
                        className="cursor-move"
                        onPointerDown={(ev) => {
                          if (calibrating) return;
                          ev.stopPropagation();
                          setActiveKey(k);
                          setDraggingKey(k);
                          (ev.currentTarget as unknown as HTMLElement).setPointerCapture?.(ev.pointerId);
                        }}
                      >
                        <circle
                          r={activeKey === k ? 8 : 5.5}
                          fill={activeKey === k ? '#f5922e' : '#3d7ab5'}
                          stroke="#ffffff"
                          strokeWidth="2"
                        />
                        <text
                          x="10"
                          y="4"
                          fill="#f8fafc"
                          fontSize="16"
                          fontFamily="IBM Plex Mono, monospace"
                          fontWeight="600"
                          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
                        >
                          {k}
                        </text>
                      </g>
                    ))}
                  </svg>
                </div>
              </div>

              <div className="flex items-center justify-between text-[11px] text-navy-200 px-1">
                <span className="inline-flex items-center gap-1.5">
                  <Camera className="w-3.5 h-3.5 text-brand-orange" />
                  <span>{selectedMedia.title}</span>
                </span>
                <span className="font-mono tabular-nums">{zoom.toFixed(1)}×</span>
              </div>
            </>
          ) : (
            <div className="p-10 text-center text-xs text-navy-300 border border-dashed border-navy-700 rounded-lg">
              {tr(lang, 'ارفع صورة وجه أو ابتسامة في تبويب الصور لبدء التحليل.', 'Upload a clinical facial or smile photo first.')}
            </div>
          )}
        </div>

        {/* Right Photo Results */}
        <div className="xl:col-span-4 bg-white border border-navy-200 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-navy-100 pb-3">
            <div>
              <h4 className="text-sm font-bold text-navy-900">
                {currentModeInfo.group === 'intraoral'
                  ? tr(lang, 'قياسات الصور داخل الفم', 'Intraoral Photogrammetry Metrics')
                  : tr(lang, 'قياسات التناسق والابتسامة', 'Photo Proportions & Smile Metrics')}
              </h4>
              <p className="text-[11px] text-navy-500 mt-0.5">
                {savedForMode
                  ? `${tr(lang, 'آخر حفظ:', 'Last saved:')} v${savedForMode.version} (${savedForMode.stage})`
                  : tr(lang, 'حساب مباشر من النقاط المحددة', 'Live geometric calculation')}
              </p>
            </div>
            <button
              type="button"
              onClick={handleSavePhotoAnalysis}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg"
            >
              <Save className="w-3.5 h-3.5 text-brand-orange" />
              <span>{tr(lang, 'حفظ التحليل', 'Save')}</span>
            </button>
          </div>

          <div className="divide-y divide-navy-100">
            {liveMetrics.map((m) => (
              <div key={m.key} title={m.formulaDesc} className="py-2.5 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-navy-900">
                    {lang === 'ar' ? m.labelAr : m.labelEn}
                  </p>
                  <p className="text-[11px] text-navy-500 mt-0.5">{m.interpretation}</p>
                </div>
                <div className="text-end shrink-0">
                  <span className="text-sm font-bold font-mono tabular-nums text-navy-900">
                    {m.value !== null ? `${m.value}${m.unit === 'deg' ? '°' : m.unit === '%' ? '%' : ` ${m.unit}`}` : '—'}
                  </span>
                  <span className="block text-[10px] font-mono tabular-nums text-navy-400">
                    {m.normRange}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
