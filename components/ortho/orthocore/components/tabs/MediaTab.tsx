"use client";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import React, { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Columns2,
  Edit3,
  Eye,
  FileBox,
  Loader2,
  Scan,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { ClinicSettings, Language, MediaKind, MediaRecord, PatientCase, RecordStage, UserRole } from '../../types/ortho';
import { REQUIRED_T0_VIEWS, VIEW_TYPE_LABELS, tr } from '../../i18n/translations';
import { AiMediaReview, api } from '../../services/api';
import { PhotoEditorModal } from '../PhotoEditorModal';
import { DicomViewerModal } from '../DicomViewerModal';
import { Model3DViewer } from '../Model3DViewer';

interface MediaTabProps {
  patient: PatientCase;
  settings?: ClinicSettings;
  lang: Language;
  role: UserRole;
  actorName: string;
  currentOrthoCaseId?: number | null;
  previousCasesMedia?: Array<{ orthoCaseId: number; media: MediaRecord[] }>;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

export const MediaTab: React.FC<MediaTabProps> = ({
  patient,
  settings,
  lang,
  role,
  actorName,
  currentOrthoCaseId,
  previousCasesMedia = [],
  onChange,
}) => {
  const [stageFilter, setStageFilter] = useState<'ALL' | RecordStage>('ALL');
  const [uploadStage, setUploadStage] = useState<RecordStage>('T0');
  const [uploadView, setUploadView] = useState<string>('intraoral_right');
  const [uploadKind, setUploadKind] = useState<MediaKind>('photo');
  const [captureDate, setCaptureDate] = useState(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [sourceNote, setSourceNote] = useState('كاميرا العيادة');
  const [uploading, setUploading] = useState(false);

  const [compareMode, setCompareMode] = useState(false);
  const [compareView, setCompareView] = useState<string>('extraoral_smile');

  const [editorMedia, setEditorMedia] = useState<MediaRecord | null>(null);
  const [dicomOpen, setDicomOpen] = useState<{ open: boolean; url?: string; title?: string; mediaId?: string }>({ open: false });
  const [model3DOpen, setModel3DOpen] = useState<{ open: boolean; url?: string; title?: string }>({ open: false });

  const [aiReviewTarget, setAiReviewTarget] = useState<MediaRecord | null>(null);
  const [aiReviewLoading, setAiReviewLoading] = useState(false);
  const [aiReviewError, setAiReviewError] = useState('');
  const [aiReviewResult, setAiReviewResult] = useState<AiMediaReview | null>(null);
  const [aiReviewSaved, setAiReviewSaved] = useState(false);
  const [blindUploadConfirmed, setBlindUploadConfirmed] = useState(false);

  const canUpload = role === 'doctor' || role === 'assistant' || role === 'admin';
  const uploadDisabledForMissingCase = currentOrthoCaseId === null;
  const canUseAi = role === 'doctor' || role === 'assistant';
  const aiConsentReady = Boolean(settings?.allowExternalAi && patient.consents.externalAiConsent);

  const runAiMediaReview = async (media: MediaRecord) => {
    setAiReviewTarget(media);
    setAiReviewError('');
    setAiReviewResult(null);
    setAiReviewSaved(false);
    if (!aiConsentReady) return;
    setAiReviewLoading(true);
    try {
      const res = await api.aiMediaReview({
        patientId: patient.id,
        mediaId: media.id,
        language: lang,
      });
      setAiReviewResult(res.review);
    } catch (err) {
      setAiReviewError(err instanceof Error ? err.message : 'AI visual review error');
    } finally {
      setAiReviewLoading(false);
    }
  };

  const applyAiNoteToMedia = () => {
    if (!aiReviewTarget || !aiReviewResult?.draftNote) return;
    const prefix = tr(lang, '[مسودة مراجعة بصرية ذكية]:', '[AI Visual Review Draft]:');
    const nextMedia = patient.media.map((item) =>
      item.id === aiReviewTarget.id
        ? {
            ...item,
            notes: item.notes ? `${item.notes}\n${prefix} ${aiReviewResult.draftNote}` : `${prefix} ${aiReviewResult.draftNote}`,
          }
        : item,
    );
    onChange(
      { ...patient, media: nextMedia },
      {
        ar: `إضافة ملاحظة مراجعة بصرية ذكية للصورة: ${aiReviewTarget.title}`,
        en: `Appended AI visual review draft note to ${aiReviewTarget.title}`,
      },
    );
    setAiReviewSaved(true);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !canUpload || uploadDisabledForMissingCase) return;
    setUploading(true);
    setBlindUploadConfirmed(false);
    try {
      const added: MediaRecord[] = [];
      let blindCount = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const lower = f.name.toLowerCase();
        const detectedKind: MediaKind = lower.endsWith('.dcm')
          ? 'dicom'
          : lower.endsWith('.stl') || lower.endsWith('.obj')
          ? 'model3d'
          : lower.endsWith('.pdf')
          ? 'document'
          : uploadKind;

        const labelObj = VIEW_TYPE_LABELS[uploadView];
        const displayTitle = `${labelObj ? (lang === 'ar' ? labelObj.ar : labelObj.en) : f.name} (${uploadStage})`;
        const uploaded = await api.uploadFile(f, {
          title: displayTitle,
          kind: detectedKind === 'radiograph' || detectedKind === 'dicom' ? 'xray' : detectedKind === 'document' ? 'other' : 'photo',
          takenOn: captureDate,
          photoStage: uploadStage,
          photoView: uploadView,
          orthoCaseId: currentOrthoCaseId ?? null,
          note: sourceNote,
        });
        if (!uploaded.docId || !uploaded.url) {
          blindCount++;
          continue;
        }
        added.push({
          id: `doc-${uploaded.docId}`,
          orthoCaseId: currentOrthoCaseId ?? null,
          title: displayTitle,
          mediaKind: detectedKind,
          stage: uploadStage,
          viewType: uploadView,
          captureDate,
          uploadDate: clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
          source: sourceNote,
          notes: '',
          originalUrl: uploaded.url,
          mimeType: uploaded.mimeType,
          calibration: { isCalibrated: false, pixelsPerMm: null, source: tr(lang, 'غير معاير', 'Uncalibrated'), unit: 'mm' },
          editorState: {
            rotationDeg: 0,
            tiltDeg: 0,
            brightness: 100,
            contrast: 100,
            anonymizeBar: { enabled: false, yPct: 24, hPct: 10 },
            annotations: [],
          },
        });
      }
      if (blindCount > 0) {
        setBlindUploadConfirmed(true);
      }
      if (added.length > 0) {
        onChange(
          { ...patient, media: [...added, ...patient.media] },
          {
            ar: `رفع ${added.length} سجل/صور تشخيصية (${uploadStage})`,
            en: `Uploaded ${added.length} diagnostic record(s) (${uploadStage})`,
          },
        );
      }
    } finally {
      setUploading(false);
    }
  };

  const t0ViewsPresent = new Set(patient.media.filter((m) => m.stage === 'T0').map((m) => m.viewType));
  const filteredMedia = patient.media.filter((m) => stageFilter === 'ALL' || m.stage === stageFilter);

  const stageGroups: RecordStage[] = ['T0', 'T1', 'T2', 'T3'];

  return (
    <div className="space-y-6">
      {/* Required Records T0 Checklist */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {tr(lang, 'قائمة السجلات الأساسية المطلوبة (مرحلة قبل العلاج T0)', 'Required Diagnostic Records Checklist (T0)')}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              {tr(
                lang,
                `مكتمل ${t0ViewsPresent.size} من ${REQUIRED_T0_VIEWS.length} سجلات أساسية`,
                `${t0ViewsPresent.size} of ${REQUIRED_T0_VIEWS.length} standard T0 views captured`,
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCompareMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border ${
                compareMode ? 'bg-teal-700 border-teal-700 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Columns2 className="w-3.5 h-3.5" />
              <span>{tr(lang, 'مقارنة T0 / T1 / T2', 'Compare T0 / T1 / T2')}</span>
            </button>
            <button
              type="button"
              onClick={() => setDicomOpen({ open: true, title: tr(lang, 'عارض DICOM (مع اختبار قياس)', 'DICOM Viewer') })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg"
            >
              <Scan className="w-3.5 h-3.5" />
              <span>{tr(lang, 'عارض DICOM', 'DICOM Viewer')}</span>
            </button>
            <button
              type="button"
              onClick={() => setModel3DOpen({ open: true, title: tr(lang, 'عارض النماذج ثلاثية الأبعاد (3D)', '3D Dental Model Viewer') })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg"
            >
              <FileBox className="w-3.5 h-3.5" />
              <span>{tr(lang, 'عارض 3D (STL/OBJ)', '3D Model Viewer')}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          {REQUIRED_T0_VIEWS.map((v) => {
            const exists = t0ViewsPresent.has(v.key);
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => {
                  setUploadStage('T0');
                  setUploadView(v.key);
                }}
                className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-start text-xs transition-colors ${
                  exists ? 'bg-teal-50/70 border-teal-200 text-teal-900' : 'bg-amber-50/60 border-amber-200 text-amber-900'
                }`}
              >
                {exists ? <CheckCircle2 className="w-3.5 h-3.5 text-teal-700 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
                <span className="truncate">{lang === 'ar' ? v.ar : v.en}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Synchronized Multi-Stage Comparison */}
      {compareMode && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-slate-900">
              {tr(lang, 'مقارنة السجلات المتزامنة عبر مراحل العلاج', 'Synchronized Stage Comparison (T0 · T1 · T2 · T3)')}
            </h4>
            <select
              value={compareView}
              onChange={(e) => setCompareView(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              {Object.entries(VIEW_TYPE_LABELS).map(([k, lbl]) => (
                <option key={k} value={k}>
                  {lang === 'ar' ? lbl.ar : lbl.en}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {stageGroups.map((st) => {
              const match = patient.media.find((m) => m.stage === st && m.viewType === compareView);
              return (
                <div key={st} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-800">
                    <span>{st}</span>
                    {match && <span className="font-mono text-[11px] text-slate-500">{match.captureDate}</span>}
                  </div>
                  {match ? (
                    <img src={match.originalUrl} alt={match.title} className="w-full h-44 object-contain bg-slate-900 rounded" />
                  ) : (
                    <div className="w-full h-44 flex items-center justify-center border border-dashed border-slate-300 rounded text-xs text-slate-400">
                      {tr(lang, 'لا يوجد سجل لهذه المرحلة', 'No record')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Drag & Drop + Camera Upload */}
      {canUpload && uploadDisabledForMissingCase && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs font-medium text-amber-900">
          {tr(
            lang,
            'افتح حالة تقويم أولاً من تبويب «الشدّات والجلسات» لربط الصور والأشعة بحالة محددة وعزلها عن أي حالات أخرى.',
            'Open an orthodontic case first in the Sessions tab so diagnostic photos are strictly bound to that case.',
          )}
        </div>
      )}

      {blindUploadConfirmed && (
        <p role="status" className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-xs font-semibold text-emerald-900">
          {tr(lang, 'تم رفع الملف بنجاح.', 'File uploaded successfully.')}
        </p>
      )}

      {canUpload && !uploadDisabledForMissingCase && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
          }}
          className="bg-white border border-dashed border-slate-300 rounded-xl p-5 space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">{tr(lang, 'المرحلة', 'Stage')}</label>
              <select
                value={uploadStage}
                onChange={(e) => setUploadStage(e.target.value as RecordStage)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="T0">T0 ({tr(lang, 'قبل العلاج', 'Pre-Tx')})</option>
                <option value="T1">T1 ({tr(lang, 'أثناء العلاج', 'Progress')})</option>
                <option value="T2">T2 ({tr(lang, 'إنهاء العلاج', 'Finishing')})</option>
                <option value="T3">T3 ({tr(lang, 'التثبيت', 'Retention')})</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">{tr(lang, 'نوع المنظر / السجل', 'View Type')}</label>
              <select
                value={uploadView}
                onChange={(e) => setUploadView(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                {Object.entries(VIEW_TYPE_LABELS).map(([k, lbl]) => (
                  <option key={k} value={k}>
                    {lang === 'ar' ? lbl.ar : lbl.en}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">{tr(lang, 'نوع الملف', 'Media Kind')}</label>
              <select
                value={uploadKind}
                onChange={(e) => setUploadKind(e.target.value as MediaKind)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="photo">{tr(lang, 'صورة سريرية', 'Clinical Photo')}</option>
                <option value="radiograph">{tr(lang, 'أشعة (OPG/Ceph)', 'Radiograph')}</option>
                <option value="dicom">DICOM (.dcm)</option>
                <option value="model3d">3D Model (.stl / .obj)</option>
                <option value="document">{tr(lang, 'مستند موافقة', 'Document')}</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">{tr(lang, 'تاريخ الالتقاط الفعلي', 'Capture Date')}</label>
              <input
                type="date"
                value={captureDate}
                onChange={(e) => setCaptureDate(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">{tr(lang, 'المصدر / الجهاز', 'Source')}</label>
              <input
                type="text"
                value={sourceNote}
                onChange={(e) => setSourceNote(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="text-xs text-slate-500">
              {tr(
                lang,
                'اسحب الصور والأشعة أو ملفات DICOM (.dcm) والنماذج (.stl/.obj) وأفلتها هنا، أو استخدم الأزرار:',
                'Drag & drop photos, radiographs, DICOM (.dcm), or 3D (.stl/.obj) files here, or choose:',
              )}
            </p>
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium rounded-lg cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                <span>{uploading ? tr(lang, 'جاري الرفع...', 'Uploading...') : tr(lang, 'اختيار ملفات', 'Upload Files')}</span>
                <input
                  type="file"
                  multiple
                  accept="image/*,.dcm,.stl,.obj,.pdf"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
              </label>
              <label className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium rounded-lg cursor-pointer">
                <Camera className="w-3.5 h-3.5" />
                <span>{tr(lang, 'التقاط بالكاميرا', 'Camera Capture')}</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Gallery Filters & Cards */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
            {(['ALL', 'T0', 'T1', 'T2', 'T3'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStageFilter(st)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  stageFilter === st ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                {st === 'ALL' ? tr(lang, 'الكل', 'All Stages') : st}
              </button>
            ))}
          </div>
          {typeof currentOrthoCaseId === 'number' && currentOrthoCaseId > 0 ? (
            <span className="px-2.5 py-1 rounded-lg bg-navy-50 border border-navy-200 text-xs font-semibold text-navy-900">
              {tr(lang, `صور الحالة التقويمية #${currentOrthoCaseId} فقط`, `Case #${currentOrthoCaseId} Media Only`)}
            </span>
          ) : null}
        </div>

        {filteredMedia.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
            {tr(lang, 'لا توجد صور أو أشعة مسجلة لهذه المرحلة.', 'No media records found for this stage.')}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredMedia.map((m) => (
              <div key={m.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
                <div className="h-52 bg-slate-900 flex items-center justify-center relative">
                  {m.mediaKind === 'photo' || m.mediaKind === 'radiograph' ? (
                    <img
                      src={m.originalUrl}
                      alt={m.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-contain"
                    />
                  ) : m.mediaKind === 'dicom' ? (
                    <div className="text-center text-slate-300 space-y-2">
                      <Scan className="w-8 h-8 mx-auto text-teal-400" />
                      <p className="text-xs font-mono">DICOM Dataset</p>
                    </div>
                  ) : (
                    <div className="text-center text-slate-300 space-y-2">
                      <FileBox className="w-8 h-8 mx-auto text-teal-400" />
                      <p className="text-xs font-mono">{m.mediaKind.toUpperCase()}</p>
                    </div>
                  )}
                </div>

                <div className="p-4 space-y-2 flex-1 flex flex-col justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 truncate">{m.title}</h4>
                    <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                      {m.stage} · {tr(lang, 'الالتقاط:', 'Captured:')} {m.captureDate} · {tr(lang, 'الرفع:', 'Uploaded:')} {m.uploadDate}
                    </p>
                    <p className="text-xs text-slate-600 mt-1">{m.source}</p>
                    {m.isDerivedCopy && (
                      <p className="text-[11px] text-teal-700 mt-1 font-medium">
                        {tr(lang, 'نسخة مشتقة محفوظة (الأصل محفوظ)', 'Derived Copy (Original Preserved)')}
                      </p>
                    )}
                    {m.notes && <p className="text-xs text-slate-500 mt-1">{m.notes}</p>}
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex flex-wrap gap-2">
                    {(m.mediaKind === 'photo' || m.mediaKind === 'radiograph') && (
                      <>
                        <button
                          type="button"
                          onClick={() => setEditorMedia(m)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>{tr(lang, 'تحرير وتعليق', 'Edit & Annotate')}</span>
                        </button>
                        {canUseAi && (
                          <button
                            type="button"
                            onClick={() => runAiMediaReview(m)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-navy-50 hover:bg-navy-100 text-navy-900 border border-navy-200 rounded-lg"
                          >
                            <Sparkles className="w-3.5 h-3.5 text-brand-orange" />
                            <span>{tr(lang, 'مراجعة بصرية ذكية', 'AI Visual Review')}</span>
                          </button>
                        )}
                      </>
                    )}
                    {m.mediaKind === 'dicom' && (
                      <button
                        type="button"
                        onClick={() => setDicomOpen({ open: true, url: m.originalUrl, title: m.title, mediaId: m.id })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-teal-700 text-white rounded-lg"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{tr(lang, 'فتح عارض DICOM', 'Open DICOM')}</span>
                      </button>
                    )}
                    {m.mediaKind === 'model3d' && (
                      <button
                        type="button"
                        onClick={() => setModel3DOpen({ open: true, url: m.originalUrl, title: m.title })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-teal-700 text-white rounded-lg"
                      >
                        <FileBox className="w-3.5 h-3.5" />
                        <span>{tr(lang, 'فتح النموذج 3D', 'Open 3D Model')}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Isolated Archive of Previous Orthodontic Cases */}
      {role !== 'reception' && previousCasesMedia.length > 0 && (
        <details
          data-testid="ortho-previous-cases-media"
          className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4"
        >
          <summary className="cursor-pointer text-xs font-bold text-slate-800 select-none">
            أرشيف صور الحالات التقويمية السابقة (معزولة عن الحالة الحالية) ({previousCasesMedia.reduce((acc, g) => acc + g.media.length, 0)})
          </summary>
          <div className="pt-3 space-y-4 border-t border-slate-200">
            {previousCasesMedia.map((group) => (
              <div key={group.orthoCaseId} className="space-y-2">
                <h4 className="text-xs font-bold text-navy-900">
                  {`حالة التقويم السابقة #${group.orthoCaseId}`} ({group.media.length})
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {group.media.map((m) => (
                    <div key={m.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col">
                      <div className="h-40 bg-slate-900 flex items-center justify-center">
                        {m.mediaKind === 'photo' || m.mediaKind === 'radiograph' ? (
                          <img
                            src={m.originalUrl}
                            alt={m.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <span className="text-xs font-mono text-slate-300">{m.mediaKind.toUpperCase()}</span>
                        )}
                      </div>
                      <div className="p-3 space-y-1">
                        <p className="text-xs font-semibold text-slate-900 truncate">{m.title}</p>
                        <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                          {m.stage} · {m.captureDate}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Specialized Modals */}
      <PhotoEditorModal
        open={Boolean(editorMedia)}
        media={editorMedia}
        allMedia={patient.media}
        lang={lang}
        onClose={() => setEditorMedia(null)}
        onSaveDerived={(derived, updatedState) => {
          const taggedDerived: MediaRecord = {
            ...derived,
            orthoCaseId: currentOrthoCaseId ?? null,
          };
          const nextMedia = patient.media.map((item) =>
            item.id === taggedDerived.parentMediaId && updatedState ? { ...item, editorState: updatedState } : item,
          );
          onChange(
            { ...patient, media: [taggedDerived, ...nextMedia] },
            { ar: `حفظ نسخة معدلة من ${taggedDerived.title}`, en: `Saved derived image copy: ${taggedDerived.title}` },
          );
        }}
      />

      <DicomViewerModal
        open={dicomOpen.open}
        lang={lang}
        initialUrl={dicomOpen.url}
        title={dicomOpen.title}
        patient={patient}
        role={role}
        actorName={actorName}
        onChange={onChange}
        onClose={() => setDicomOpen({ open: false })}
        onCalibrateFromDicom={(pxPerMm, source) => {
          if (!dicomOpen.mediaId) return;
          const nextMedia = patient.media.map((m) =>
            m.id === dicomOpen.mediaId
              ? { ...m, calibration: { isCalibrated: true, pixelsPerMm: pxPerMm, source, unit: 'mm' as const } }
              : m,
          );
          onChange({ ...patient, media: nextMedia });
          setDicomOpen({ open: false });
        }}
      />

      <Model3DViewer
        open={model3DOpen.open}
        lang={lang}
        initialUrl={model3DOpen.url}
        title={model3DOpen.title}
        onClose={() => setModel3DOpen({ open: false })}
        onSaveMeasurement={(distMm, label) => {
          const newAnalysis = {
            id: `ana-3d-${Date.now()}`,
            version: patient.analyses.length + 1,
            stage: 'T0' as RecordStage,
            analysisType: 'model3d_mesh' as const,
            templateName: '3D Mesh Point-to-Point Caliper',
            normSource: '1:1 Three.js STL/Model Coordinates (mm)',
            calibrationValid: true,
            calibrationSource: '3D Mesh Coordinate System (mm)',
            landmarks: {},
            metrics: [
              {
                key: 'DIST_3D',
                labelAr: label,
                labelEn: label,
                value: distMm,
                unit: 'mm' as const,
                normRange: 'قياس مباشر',
                formulaDesc: 'Euclidean 3D Distance √(Δx²+Δy²+Δz²)',
                interpretation: `${distMm} mm`,
                requiresCalibration: true,
              },
            ],
            examiner: actorName,
            createdAt: new Date().toISOString(),
          };
          onChange(
            { ...patient, analyses: [newAnalysis, ...patient.analyses] },
            { ar: `حفظ قياس 3D (${distMm} مم)`, en: `Saved 3D caliper measurement (${distMm} mm)` },
          );
          setModel3DOpen({ open: false });
        }}
      />

      {/* AI Visual Review Modal */}
      {aiReviewTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-brand-orange" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {tr(lang, 'المراجعة البصرية الذكية (مسودة للمراجعة الطبية)', 'AI Visual Review (Clinician Draft)')}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    {aiReviewTarget.title} · {aiReviewTarget.stage} · {aiReviewTarget.viewType}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAiReviewTarget(null)}
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-5 p-5 overflow-y-auto flex-1 text-xs">
              <div className="md:col-span-5 space-y-3">
                <div className="bg-slate-900 rounded-xl overflow-hidden h-72 flex items-center justify-center">
                  <img
                    src={aiReviewTarget.originalUrl}
                    alt={aiReviewTarget.title}
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1 text-[11px] text-slate-600">
                  <p>
                    <strong className="text-slate-800">{tr(lang, 'المصدر:', 'Source:')}</strong> {aiReviewTarget.source}
                  </p>
                  <p>
                    <strong className="text-slate-800">{tr(lang, 'المعايرة:', 'Calibration:')}</strong>{' '}
                    {aiReviewTarget.calibration.isCalibrated
                      ? tr(lang, 'معايرة متاحة', 'Calibrated')
                      : tr(lang, 'غير معايرة', 'Uncalibrated')}
                  </p>
                  <p className="text-slate-500 pt-1">
                    {tr(
                      lang,
                      'ملاحظة: لا يتم توليد قياسات رقمية (مم أو درجات) من الصور دون التتبع المعاير؛ المخرجات للمراجعة السريرية فقط.',
                      'Note: No numeric mm/degree measurements are fabricated from images; outputs are strictly clinician review drafts.',
                    )}
                  </p>
                </div>
              </div>

              <div className="md:col-span-7 space-y-4">
                {!aiConsentReady && (
                  <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
                    <div className="space-y-1">
                      <p className="font-semibold">
                        {tr(lang, 'حوكمة الخصوصية والموافقة مطلوبة', 'Privacy & Consent Required')}
                      </p>
                      <p>
                        {tr(
                          lang,
                          'فعّل خيار «المعالجة بالذكاء الاصطناعي الخارجي» في إعدادات الإدارة وتأكد من موافقة المريض في تبويب «البيانات» لتشغيل المراجعة البصرية.',
                          'Enable External AI in Clinic Admin Settings and grant Patient AI Consent in the Overview tab to run visual review.',
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {aiReviewLoading && (
                  <div className="p-8 bg-slate-50 border border-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 text-slate-600">
                    <Loader2 className="w-6 h-6 animate-spin text-teal-700" />
                    <p className="font-medium">
                      {tr(lang, 'جاري تحليل الصورة عبر Gemini Interactions API...', 'Analyzing clinical image with Gemini...')}
                    </p>
                  </div>
                )}

                {aiReviewError && (
                  <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-800 space-y-2">
                    <p>{aiReviewError}</p>
                    <button
                      type="button"
                      onClick={() => runAiMediaReview(aiReviewTarget)}
                      className="px-3 py-1.5 bg-red-700 hover:bg-red-800 text-white rounded-lg font-medium"
                    >
                      {tr(lang, 'إعادة المحاولة', 'Retry Review')}
                    </button>
                  </div>
                )}

                {aiReviewResult && (
                  <div className="space-y-4">
                    <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 font-medium">
                      {tr(
                        lang,
                        'مسودة بصرية مقترحة — تتطلب تحقق واعتماد أخصائي التقويم',
                        'VISUAL DRAFT — Requires Orthodontist Verification & Approval',
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-800">
                            {tr(lang, 'مطابقة نوع المنظر', 'View Tag Check')}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                              aiReviewResult.viewMatchStatus === 'matches'
                                ? 'bg-teal-100 text-teal-900'
                                : aiReviewResult.viewMatchStatus === 'possible_mismatch'
                                ? 'bg-amber-100 text-amber-900'
                                : 'bg-slate-200 text-slate-700'
                            }`}
                          >
                            {aiReviewResult.viewMatchStatus === 'matches'
                              ? tr(lang, 'متطابق', 'Matches')
                              : aiReviewResult.viewMatchStatus === 'possible_mismatch'
                              ? tr(lang, 'عدم تطابق محتمل', 'Check Tag')
                              : tr(lang, 'غير مؤكد', 'Uncertain')}
                          </span>
                        </div>
                        <p className="text-slate-600 leading-relaxed">{aiReviewResult.viewMatchNotes}</p>
                      </div>

                      <div className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-800">
                            {tr(lang, 'جودة الصورة التشخيصية', 'Diagnostic Quality')}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                              aiReviewResult.imageQualityRating === 'good'
                                ? 'bg-teal-100 text-teal-900'
                                : aiReviewResult.imageQualityRating === 'acceptable'
                                ? 'bg-sky-100 text-sky-900'
                                : 'bg-red-100 text-red-900'
                            }`}
                          >
                            {aiReviewResult.imageQualityRating === 'good'
                              ? tr(lang, 'جيدة', 'Good')
                              : aiReviewResult.imageQualityRating === 'acceptable'
                              ? tr(lang, 'مقبولة', 'Acceptable')
                              : tr(lang, 'يفضل إعادة الالتقاط', 'Needs Retake')}
                          </span>
                        </div>
                        <p className="text-slate-600 leading-relaxed">{aiReviewResult.imageQualityNotes}</p>
                      </div>
                    </div>

                    {aiReviewResult.visualObservations.length > 0 && (
                      <div className="space-y-1.5">
                        <h4 className="font-semibold text-slate-900">
                          {tr(lang, 'الملاحظات البصرية المرصودة:', 'Visible Clinical Observations:')}
                        </h4>
                        <ul className="list-disc list-inside space-y-1 text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3">
                          {aiReviewResult.visualObservations.map((obs, idx) => (
                            <li key={idx}>{obs}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {aiReviewResult.suggestedClinicalChecks.length > 0 && (
                      <div className="space-y-1.5">
                        <h4 className="font-semibold text-slate-900">
                          {tr(lang, 'نقاط مقترحة للتحقق السريري / التتبع:', 'Suggested Clinician Verification Checks:')}
                        </h4>
                        <ul className="list-disc list-inside space-y-1 text-slate-700 bg-navy-50/60 border border-navy-200 rounded-lg p-3">
                          {aiReviewResult.suggestedClinicalChecks.map((chk, idx) => (
                            <li key={idx}>{chk}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {aiReviewResult.draftNote && (
                      <div className="space-y-2 pt-2 border-t border-slate-200">
                        <h4 className="font-semibold text-slate-900">
                          {tr(lang, 'ملاحظة مسودة جاهزة للحفظ:', 'Suggested Media Note Draft:')}
                        </h4>
                        <p className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 leading-relaxed">
                          {aiReviewResult.draftNote}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={aiReviewSaved}
                            onClick={applyAiNoteToMedia}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-teal-700 hover:bg-teal-800 disabled:bg-teal-600/60 text-white font-medium rounded-lg"
                          >
                            <ClipboardCheck className="w-3.5 h-3.5" />
                            <span>
                              {aiReviewSaved
                                ? tr(lang, 'تم الحفظ في ملاحظات الصورة', 'Saved to Media Notes')
                                : tr(lang, 'إضافة إلى ملاحظات الصورة', 'Append to Media Notes')}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => runAiMediaReview(aiReviewTarget)}
                            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 font-medium rounded-lg"
                          >
                            {tr(lang, 'إعادة التحليل', 'Re-run Review')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
