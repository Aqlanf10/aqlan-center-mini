"use client";
import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Crop,
  EyeOff,
  LayoutGrid,
  Minus,
  RotateCw,
  Save,
  Type as TypeIcon,
  Undo2,
  X,
  CircleDot,
} from 'lucide-react';
import { AnnotationItem, Language, MediaEditorState, MediaRecord } from '../types/ortho';
import { tr } from '../i18n/translations';
import { api } from '../services/api';

interface PhotoEditorModalProps {
  open: boolean;
  patientId: string | number;
  media: MediaRecord | null;
  allMedia: MediaRecord[];
  lang: Language;
  onClose: () => void;
  onSaveDerived: (derivedMedia: MediaRecord, updatedOriginalEditorState?: MediaEditorState) => void;
}

type ToolType = 'select' | 'arrow' | 'line' | 'point' | 'text';

export const PhotoEditorModal: React.FC<PhotoEditorModalProps> = ({
  open,
  patientId,
  media,
  allMedia,
  lang,
  onClose,
  onSaveDerived,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [state, setState] = useState<MediaEditorState>({
    rotationDeg: 0,
    tiltDeg: 0,
    brightness: 100,
    contrast: 100,
    anonymizeBar: { enabled: false, yPct: 24, hPct: 10 },
    annotations: [],
  });
  const [history, setHistory] = useState<MediaEditorState[]>([]);
  const [zoom, setZoom] = useState(1);
  const [cropRatio, setCropRatio] = useState<'none' | '1:1' | '4:3' | '16:9'>('none');
  const [tool, setTool] = useState<ToolType>('select');
  const [draftStart, setDraftStart] = useState<{ x: number; y: number } | null>(null);
  const [textInput, setTextInput] = useState('');
  const [saving, setSaving] = useState(false);

  // Collage board mode
  const [collageMode, setCollageMode] = useState(false);
  const [collageIds, setCollageIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !media) return;
    setState(JSON.parse(JSON.stringify(media.editorState)));
    setHistory([]);
    setZoom(1);
    setCropRatio('none');
    setCollageMode(false);
    setCollageIds(
      allMedia
        .filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph')
        .slice(0, 4)
        .map((m) => m.id),
    );
  }, [open, media, allMedia]);

  const pushState = (next: MediaEditorState) => {
    setHistory((h) => [...h.slice(-15), state]);
    setState(next);
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setState(prev);
  };

  const drawCanvas = (img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let targetW = img.naturalWidth || 800;
    let targetH = img.naturalHeight || 600;
    const scaleDown = Math.min(1, 1100 / Math.max(targetW, targetH));
    targetW = Math.round(targetW * scaleDown);
    targetH = Math.round(targetH * scaleDown);

    if (cropRatio === '1:1') {
      const side = Math.min(targetW, targetH);
      targetW = side;
      targetH = side;
    } else if (cropRatio === '4:3') {
      targetH = Math.round((targetW * 3) / 4);
    } else if (cropRatio === '16:9') {
      targetH = Math.round((targetW * 9) / 16);
    }

    canvas.width = targetW;
    canvas.height = targetH;
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, targetW, targetH);

    ctx.save();
    ctx.translate(targetW / 2, targetH / 2);
    ctx.rotate(((state.rotationDeg + state.tiltDeg) * Math.PI) / 180);
    ctx.scale(zoom, zoom);
    ctx.filter = `brightness(${state.brightness}%) contrast(${state.contrast}%)`;
    const drawW = (img.naturalWidth || 800) * scaleDown;
    const drawH = (img.naturalHeight || 600) * scaleDown;
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    // Anonymization bar
    if (state.anonymizeBar.enabled) {
      const barY = (state.anonymizeBar.yPct / 100) * targetH;
      const barH = (state.anonymizeBar.hPct / 100) * targetH;
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, barY, targetW, barH);
    }

    // Layered annotations (kept separate from pixel adjustments)
    for (const ann of state.annotations) {
      ctx.save();
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = 3;
      const x1 = ann.x1 * targetW;
      const y1 = ann.y1 * targetH;
      const x2 = (ann.x2 ?? ann.x1) * targetW;
      const y2 = (ann.y2 ?? ann.y1) * targetH;

      if (ann.type === 'point') {
        ctx.beginPath();
        ctx.arc(x1, y1, 6, 0, Math.PI * 2);
        ctx.fill();
      } else if (ann.type === 'line' || ann.type === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (ann.type === 'arrow') {
          const angle = Math.atan2(y2 - y1, x2 - x1);
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - 14 * Math.cos(angle - Math.PI / 6), y2 - 14 * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(x2 - 14 * Math.cos(angle + Math.PI / 6), y2 - 14 * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fill();
        }
      } else if (ann.type === 'text' && ann.text) {
        ctx.font = 'bold 18px "IBM Plex Sans Arabic", sans-serif';
        const metrics = ctx.measureText(ann.text);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.fillRect(x1 - 6, y1 - 20, metrics.width + 12, 28);
        ctx.fillStyle = ann.color;
        ctx.fillText(ann.text, x1, y1);
      }
      ctx.restore();
    }
  };

  // Render preview canvas
  useEffect(() => {
    if (!open || !media || collageMode) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = media.originalUrl;
    img.onload = () => {
      imgRef.current = img;
      drawCanvas(img);
    };
  }, [open, media, state, zoom, cropRatio, collageMode]);

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === 'select' || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    if (tool === 'point') {
      const item: AnnotationItem = { id: `ann-${Date.now()}`, type: 'point', x1: nx, y1: ny, color: '#2dd4bf' };
      pushState({ ...state, annotations: [...state.annotations, item] });
    } else if (tool === 'text') {
      const label = textInput.trim() || 'Note';
      const item: AnnotationItem = { id: `ann-${Date.now()}`, type: 'text', x1: nx, y1: ny, text: label, color: '#fbbf24' };
      pushState({ ...state, annotations: [...state.annotations, item] });
    } else if (tool === 'arrow' || tool === 'line') {
      setDraftStart({ x: nx, y: ny });
    }
  };

  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draftStart || !canvasRef.current || (tool !== 'arrow' && tool !== 'line')) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const item: AnnotationItem = {
      id: `ann-${Date.now()}`,
      type: tool,
      x1: draftStart.x,
      y1: draftStart.y,
      x2: nx,
      y2: ny,
      color: tool === 'arrow' ? '#f43f5e' : '#38bdf8',
    };
    setDraftStart(null);
    pushState({ ...state, annotations: [...state.annotations, item] });
  };

  const handleSaveDerivedCopy = async () => {
    if (!media || !canvasRef.current) return;
    setSaving(true);
    try {
      const dataUrl = canvasRef.current.toDataURL('image/jpeg', 0.92);
      const parentDocMatch = /\/api\/documents\/(\d+)/.exec(media.originalUrl);
      const parentDocumentId = parentDocMatch ? Number(parentDocMatch[1]) : null;
      const res = await api.saveDerivedImage(patientId, dataUrl, media.title, { parentDocumentId });
      const derivedRecord: MediaRecord = {
        ...media,
        id: `med-derived-${Date.now()}`,
        title: `${media.title} (${state.anonymizeBar.enabled ? tr(lang, 'نسخة مجهولة الهوية', 'Anonymized') : tr(lang, 'نسخة معدلة', 'Edited')})`,
        originalUrl: res.url,
        uploadDate: new Date().toISOString().slice(0, 10),
        isDerivedCopy: true,
        parentMediaId: media.id,
        editorState: { ...state, updatedAt: new Date().toISOString() },
      };
      onSaveDerived(derivedRecord, state);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleExportCollage = async () => {
    const selected = allMedia.filter((m) => collageIds.includes(m.id)).slice(0, 4);
    if (selected.length === 0 || !media) return;
    setSaving(true);
    try {
      const board = document.createElement('canvas');
      board.width = 1200;
      board.height = 900;
      const ctx = board.getContext('2d')!;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 1200, 900);

      const slots = [
        { x: 24, y: 24, w: 564, h: 414 },
        { x: 612, y: 24, w: 564, h: 414 },
        { x: 24, y: 462, w: 564, h: 414 },
        { x: 612, y: 462, w: 564, h: 414 },
      ];

      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        const slot = slots[i];
        const im = new Image();
        im.crossOrigin = 'anonymous';
        await new Promise<void>((resolve) => {
          im.onload = () => resolve();
          im.onerror = () => resolve();
          im.src = item.originalUrl;
        });
        const ratio = Math.min(slot.w / (im.naturalWidth || 1), slot.h / (im.naturalHeight || 1));
        const dw = (im.naturalWidth || 400) * ratio;
        const dh = (im.naturalHeight || 300) * ratio;
        ctx.drawImage(im, slot.x + (slot.w - dw) / 2, slot.y + (slot.h - dh) / 2, dw, dh);
        ctx.fillStyle = 'rgba(15,23,42,0.75)';
        ctx.fillRect(slot.x, slot.y + slot.h - 28, slot.w, 28);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '14px "IBM Plex Sans Arabic", sans-serif';
        ctx.fillText(`${item.title} · ${item.stage} · ${item.captureDate}`, slot.x + 10, slot.y + slot.h - 9);
      }

      const dataUrl = board.toDataURL('image/jpeg', 0.92);
      const parentDocMatch = /\/api\/documents\/(\d+)/.exec(media.originalUrl);
      const parentDocumentId = parentDocMatch ? Number(parentDocMatch[1]) : null;
      const res = await api.saveDerivedImage(patientId, dataUrl, 'clinical_board', { parentDocumentId });
      onSaveDerived({
        ...media,
        id: `med-board-${Date.now()}`,
        title: tr(lang, 'لوحة سريرية مجمعة (2×2)', 'Clinical Composite Board (2×2)'),
        originalUrl: res.url,
        uploadDate: new Date().toISOString().slice(0, 10),
        isDerivedCopy: true,
        parentMediaId: media.id,
        editorState: { rotationDeg: 0, tiltDeg: 0, brightness: 100, contrast: 100, anonymizeBar: { enabled: false, yPct: 24, hPct: 10 }, annotations: [] },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!open || !media) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 flex items-center justify-center p-4">
      <div className="bg-slate-900 text-slate-100 border border-slate-700 rounded-xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-semibold">
              {tr(lang, 'محرر الصور والأشعة السريري (يحفظ الأصل بدون تعديل)', 'Non-Destructive Clinical Photo & Radiograph Editor')}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{media.title} · {media.stage}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCollageMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border ${
                collageMode ? 'bg-teal-700 border-teal-600 text-white' : 'bg-slate-800 border-slate-700 text-slate-200'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>{tr(lang, 'لوحة سريرية مجمعة', 'Clinical Board')}</span>
            </button>
            <button
              type="button"
              onClick={handleUndo}
              disabled={history.length === 0}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>{tr(lang, 'تراجع', 'Undo')}</span>
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {collageMode ? (
          <div className="p-6 space-y-4 overflow-y-auto flex-1">
            <p className="text-sm text-slate-200">
              {tr(lang, 'اختر حتى 4 صور سريرية لترتيبها في لوحة متناسقة الأبعاد وحفظها كنسخة مستقلة:', 'Select up to 4 clinical images to compose an aspect-normalized clinical board:')}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {allMedia
                .filter((m) => m.mediaKind === 'photo' || m.mediaKind === 'radiograph')
                .map((m) => {
                  const active = collageIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        setCollageIds((prev) =>
                          prev.includes(m.id) ? prev.filter((x) => x !== m.id) : prev.length < 4 ? [...prev, m.id] : prev,
                        )
                      }
                      className={`p-2 rounded-lg border text-start transition-colors ${
                        active ? 'border-teal-500 bg-teal-950/50' : 'border-slate-700 bg-slate-800'
                      }`}
                    >
                      <img src={m.originalUrl} alt={m.title} className="w-full h-28 object-cover rounded mb-2" />
                      <p className="text-xs font-medium truncate">{m.title}</p>
                      <p className="text-[11px] text-slate-400 font-mono tabular-nums">{m.stage} · {m.captureDate}</p>
                    </button>
                  );
                })}
            </div>
            <button
              type="button"
              disabled={saving || collageIds.length === 0}
              onClick={handleExportCollage}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-700 hover:bg-teal-600 text-white text-xs font-medium rounded-lg"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? tr(lang, 'جاري الحفظ...', 'Saving...') : tr(lang, 'إنشاء وحفظ اللوحة السريرية', 'Generate & Save Composite Board')}</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 flex-1 overflow-hidden">
            <div className="lg:col-span-3 bg-slate-950 flex items-center justify-center p-4 overflow-auto">
              <canvas
                ref={canvasRef}
                onMouseDown={handleCanvasMouseDown}
                onMouseUp={handleCanvasMouseUp}
                className="max-w-full max-h-[70vh] border border-slate-800 cursor-crosshair"
              />
            </div>

            <div className="p-4 border-s border-slate-800 space-y-4 overflow-y-auto text-xs">
              <div>
                <p className="font-semibold text-slate-200 mb-2">{tr(lang, 'أدوات التعليق والطبقات', 'Layered Annotations')}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { k: 'arrow', ar: 'سهم', en: 'Arrow', icon: ArrowUpRight },
                    { k: 'line', ar: 'خط', en: 'Line', icon: Minus },
                    { k: 'point', ar: 'نقطة', en: 'Point', icon: CircleDot },
                    { k: 'text', ar: 'نص', en: 'Text', icon: TypeIcon },
                  ].map((t) => {
                    const Icon = t.icon;
                    return (
                      <button
                        key={t.k}
                        type="button"
                        onClick={() => setTool(t.k as ToolType)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${
                          tool === t.k ? 'bg-teal-700 border-teal-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        <span>{lang === 'ar' ? t.ar : t.en}</span>
                      </button>
                    );
                  })}
                </div>
                {tool === 'text' && (
                  <input
                    type="text"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder={tr(lang, 'نص التعليق...', 'Annotation label...')}
                    className="mt-2 w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs"
                  />
                )}
                {state.annotations.length > 0 && (
                  <button
                    type="button"
                    onClick={() => pushState({ ...state, annotations: [] })}
                    className="mt-2 text-[11px] text-amber-400 hover:underline"
                  >
                    {tr(lang, `مسح جميع التعليقات (${state.annotations.length})`, `Clear Annotations (${state.annotations.length})`)}
                  </button>
                )}
              </div>

              <div className="pt-3 border-t border-slate-800 space-y-2.5">
                <p className="font-semibold text-slate-200">{tr(lang, 'القص والتوجيه والضوء', 'Crop, Rotate & Exposure')}</p>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => pushState({ ...state, rotationDeg: (state.rotationDeg + 90) % 360 })}
                    className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    <span>90°</span>
                  </button>
                  {(['none', '1:1', '4:3'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setCropRatio(r)}
                      className={`px-2 py-1.5 rounded-lg border ${
                        cropRatio === r ? 'bg-teal-700 border-teal-500' : 'bg-slate-800 border-slate-700'
                      }`}
                    >
                      <Crop className="w-3 h-3 inline me-1" />
                      {r === 'none' ? tr(lang, 'حر', 'Free') : r}
                    </button>
                  ))}
                </div>

                <div>
                  <div className="flex justify-between mb-1 font-mono tabular-nums">
                    <span>{tr(lang, 'تصحيح الميل', 'Tilt Straighten')}</span>
                    <span>{state.tiltDeg}°</span>
                  </div>
                  <input
                    type="range"
                    min={-15}
                    max={15}
                    step={0.5}
                    value={state.tiltDeg}
                    onChange={(e) => setState({ ...state, tiltDeg: Number(e.target.value) })}
                    className="w-full accent-teal-500"
                  />
                </div>

                <div>
                  <div className="flex justify-between mb-1 font-mono tabular-nums">
                    <span>{tr(lang, 'الإضاءة', 'Brightness')}</span>
                    <span>{state.brightness}%</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={150}
                    value={state.brightness}
                    onChange={(e) => setState({ ...state, brightness: Number(e.target.value) })}
                    className="w-full accent-teal-500"
                  />
                </div>

                <div>
                  <div className="flex justify-between mb-1 font-mono tabular-nums">
                    <span>{tr(lang, 'التباين', 'Contrast')}</span>
                    <span>{state.contrast}%</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={180}
                    value={state.contrast}
                    onChange={(e) => setState({ ...state, contrast: Number(e.target.value) })}
                    className="w-full accent-teal-500"
                  />
                </div>

                <div>
                  <div className="flex justify-between mb-1 font-mono tabular-nums">
                    <span>{tr(lang, 'التكبير', 'Zoom')}</span>
                    <span>{zoom.toFixed(1)}×</span>
                  </div>
                  <input
                    type="range"
                    min={0.7}
                    max={2.5}
                    step={0.1}
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                    className="w-full accent-teal-500"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800 space-y-2">
                <button
                  type="button"
                  onClick={() =>
                    pushState({
                      ...state,
                      anonymizeBar: { ...state.anonymizeBar, enabled: !state.anonymizeBar.enabled },
                    })
                  }
                  className={`w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border font-medium ${
                    state.anonymizeBar.enabled
                      ? 'bg-amber-600 border-amber-500 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                >
                  <EyeOff className="w-3.5 h-3.5" />
                  <span>{tr(lang, 'شريط إخفاء الهوية للعرض التعليمي', 'Anonymize Eye-Bar Mask')}</span>
                </button>

                {state.anonymizeBar.enabled && (
                  <div>
                    <div className="flex justify-between mb-1 font-mono tabular-nums text-slate-400">
                      <span>{tr(lang, 'موضع الشريط %', 'Mask Y %')}</span>
                      <span>{state.anonymizeBar.yPct}%</span>
                    </div>
                    <input
                      type="range"
                      min={5}
                      max={75}
                      value={state.anonymizeBar.yPct}
                      onChange={(e) =>
                        setState({
                          ...state,
                          anonymizeBar: { ...state.anonymizeBar, yPct: Number(e.target.value) },
                        })
                      }
                      className="w-full accent-amber-500"
                    />
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-slate-800 space-y-2">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  {tr(
                    lang,
                    'ملاحظة سريرية: الصورة الأصلية تبقى محفوظة دون أي تعديل، ويتم حفظ التغييرات كنسخة مشتقة منفصلة.',
                    'Clinical integrity: Original image remains untouched; edits are saved as a separate derived copy.',
                  )}
                </p>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSaveDerivedCopy}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-3 bg-teal-700 hover:bg-teal-600 text-white font-medium rounded-lg"
                >
                  <Save className="w-4 h-4" />
                  <span>{saving ? tr(lang, 'جاري الحفظ...', 'Saving...') : tr(lang, 'حفظ كنسخة مشتقة', 'Save Derived Copy')}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
