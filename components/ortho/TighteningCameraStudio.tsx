"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Crop, RefreshCw, RotateCw, Sliders, X } from "lucide-react";
import { PHOTO_VIEW_LABEL, type PhotoView } from "@/lib/ortho-photos";
import {
  computeAnatomicalSafeCropRect,
  DEFAULT_SAFE_PHOTO_EDITS,
  isNonDestructiveEditChanged,
  PHOTO_TIMING_LABEL,
  type PhotoTiming,
  type SafePhotoEdits,
} from "@/lib/ortho-tightening-media";

export interface CapturedTighteningPhotoPayload {
  originalFile: File;
  derivedFile: File | null;
  previewUrl: string;
  view: PhotoView | "";
  timing: PhotoTiming;
  note: string;
}

interface TighteningCameraStudioProps {
  open: boolean;
  canEditPhoto?: boolean;
  defaultTiming?: PhotoTiming;
  onClose: () => void;
  onConfirm: (payload: CapturedTighteningPhotoPayload) => void;
}

const QUICK_VIEWS: Array<{ key: PhotoView | ""; label: string }> = [
  { key: "intraoral_frontal", label: PHOTO_VIEW_LABEL.intraoral_frontal },
  { key: "intraoral_right", label: PHOTO_VIEW_LABEL.intraoral_right },
  { key: "intraoral_left", label: PHOTO_VIEW_LABEL.intraoral_left },
  { key: "upper_occlusal", label: PHOTO_VIEW_LABEL.upper_occlusal },
  { key: "lower_occlusal", label: PHOTO_VIEW_LABEL.lower_occlusal },
  { key: "extraoral_frontal", label: PHOTO_VIEW_LABEL.extraoral_frontal },
  { key: "smile", label: PHOTO_VIEW_LABEL.smile },
  { key: "profile", label: PHOTO_VIEW_LABEL.profile },
  { key: "", label: "صورة إضافية (عام)" },
];

export function TighteningCameraStudio({
  open,
  canEditPhoto = true,
  defaultTiming = "during",
  onClose,
  onConfirm,
}: TighteningCameraStudioProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [cameraError, setCameraError] = useState<string>("");
  const [startingCamera, setStartingCamera] = useState(false);

  // Captured image state
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [capturedUrl, setCapturedUrl] = useState<string>("");
  const [view, setView] = useState<PhotoView | "">("intraoral_frontal");
  const [timing, setTiming] = useState<PhotoTiming>(defaultTiming);
  const [note, setNote] = useState<string>("");
  const [showEditor, setShowEditor] = useState(false);
  const [edits, setEdits] = useState<SafePhotoEdits>(DEFAULT_SAFE_PHOTO_EDITS);
  const [rendering, setRendering] = useState(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list.filter((d) => d.kind === "videoinput");
      setDevices(cams);
      if (cams.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(cams[0].deviceId);
      }
    } catch {
      // Ignore enumeration failures
    }
  }, [selectedDeviceId]);

  const startCamera = useCallback(
    async (deviceId?: string) => {
      stopStream();
      setCameraError("");
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setCameraError("المتصفح لا يدعم البث المباشر للكاميرا هنا. يمكنك استخدام زر اختيار ملف/كاميرا الجهاز.");
        return;
      }
      setStartingCamera(true);
      try {
        const videoConstraints: MediaTrackConstraints = deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
        const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        await refreshDevices();
      } catch {
        setCameraError("تعذّر فتح الكاميرا. تأكد من منح إذن الكاميرا وتوصيل كاميرا الهاتف أو الكمبيوتر أو USB.");
      } finally {
        setStartingCamera(false);
      }
    },
    [refreshDevices, stopStream],
  );

  useEffect(() => {
    if (!open) {
      stopStream();
      if (capturedUrl) URL.revokeObjectURL(capturedUrl);
      setCapturedFile(null);
      setCapturedUrl("");
      setEdits(DEFAULT_SAFE_PHOTO_EDITS);
      setShowEditor(false);
      setNote("");
      return;
    }
    setTiming(defaultTiming);
    if (!capturedFile) {
      void startCamera(selectedDeviceId || undefined);
    }
    return () => {
      stopStream();
    };
  }, [open, capturedFile, defaultTiming, selectedDeviceId, startCamera, stopStream, capturedUrl]);

  if (!open) return null;

  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = new File([blob], `ortho-capture-${stamp}.jpg`, { type: "image/jpeg" });
        const url = URL.createObjectURL(file);
        stopStream();
        setCapturedFile(file);
        setCapturedUrl(url);
        setEdits(DEFAULT_SAFE_PHOTO_EDITS);
      },
      "image/jpeg",
      0.92,
    );
  };

  const handleRetake = () => {
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    setCapturedFile(null);
    setCapturedUrl("");
    setEdits(DEFAULT_SAFE_PHOTO_EDITS);
    setShowEditor(false);
    void startCamera(selectedDeviceId || undefined);
  };

  const renderDerivedFile = async (sourceFile: File, currentEdits: SafePhotoEdits): Promise<{ file: File; previewUrl: string }> => {
    const imgUrl = URL.createObjectURL(sourceFile);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Image load failed"));
        el.src = imgUrl;
      });

      const geom = computeAnatomicalSafeCropRect(img.naturalWidth, img.naturalHeight, currentEdits);

      // Step 1: rotate onto intermediate canvas with exact 1:1 pixel ratio
      const rotCanvas = document.createElement("canvas");
      rotCanvas.width = geom.rotatedWidth;
      rotCanvas.height = geom.rotatedHeight;
      const rctx = rotCanvas.getContext("2d");
      if (!rctx) throw new Error("Canvas unavailable");

      rctx.filter = `brightness(${geom.brightness}%) contrast(${geom.contrast}%)`;
      rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
      rctx.rotate((currentEdits.rotationDeg * Math.PI) / 180);
      rctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

      // Step 2: aspect-preserving crop (sw x sh -> sw x sh, ZERO stretching!)
      const outCanvas = document.createElement("canvas");
      outCanvas.width = geom.sw;
      outCanvas.height = geom.sh;
      const octx = outCanvas.getContext("2d");
      if (!octx) throw new Error("Canvas unavailable");
      octx.drawImage(rotCanvas, geom.sx, geom.sy, geom.sw, geom.sh, 0, 0, geom.sw, geom.sh);

      const blob = await new Promise<Blob | null>((resolve) => outCanvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Render failed");
      const derivedFile = new File([blob], sourceFile.name.replace(/(\.\w+)?$/, "-edited.jpg"), {
        type: "image/jpeg",
      });
      return { file: derivedFile, previewUrl: URL.createObjectURL(derivedFile) };
    } finally {
      URL.revokeObjectURL(imgUrl);
    }
  };

  const handleConfirm = async () => {
    if (!capturedFile) return;
    setRendering(true);
    try {
      const edited = canEditPhoto && isNonDestructiveEditChanged(edits);
      if (edited) {
        const derived = await renderDerivedFile(capturedFile, edits);
        onConfirm({
          originalFile: capturedFile,
          derivedFile: derived.file,
          previewUrl: derived.previewUrl,
          view,
          timing,
          note: note.trim(),
        });
      } else {
        const previewCopy = URL.createObjectURL(capturedFile);
        onConfirm({
          originalFile: capturedFile,
          derivedFile: null,
          previewUrl: previewCopy,
          view,
          timing,
          note: note.trim(),
        });
      }
      onClose();
    } finally {
      setRendering(false);
    }
  };

  const cropInsetX = Math.round(edits.crop.x * 100);
  const cropInsetY = Math.round(edits.crop.y * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-3 backdrop-blur-xs" dir="rtl">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-brand-orange" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">استوديو التصوير المباشر للشدّة (كاميرا الهاتف / الكمبيوتر / USB)</h3>
              <p className="text-[11px] text-slate-500">
                تُحفظ الصورة الأصلية كما هي، وعند التعديل تُنشأ نسخة مشتقة دون تغيير التشريح أو أحجام الأسنان.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {/* Camera Selector Bar */}
          {!capturedFile && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-1 items-center gap-2 min-w-[220px]">
                <label className="font-semibold text-slate-700 shrink-0">الكاميرا:</label>
                <select
                  value={selectedDeviceId}
                  onChange={(e) => {
                    setSelectedDeviceId(e.target.value);
                    void startCamera(e.target.value);
                  }}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs"
                >
                  {devices.length === 0 ? (
                    <option value="">الكاميرا الافتراضية</option>
                  ) : (
                    devices.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `كاميرا #${i + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <button
                type="button"
                onClick={() => void startCamera(selectedDeviceId || undefined)}
                className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>تحديث الكاميرات</span>
              </button>
            </div>
          )}

          {/* Live Viewfinder OR Captured Preview */}
          <div className="relative overflow-hidden rounded-2xl bg-slate-950 flex items-center justify-center min-h-[280px] max-h-[380px]">
            {!capturedFile ? (
              <>
                <video ref={videoRef} playsInline muted autoPlay className="max-h-[380px] w-full object-contain" />
                {startingCamera && (
                  <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 text-white font-semibold">
                    جاري تشغيل الكاميرا...
                  </div>
                )}
                {cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/85 p-6 text-center text-amber-200">
                    <p className="font-bold">{cameraError}</p>
                    <label className="cursor-pointer rounded-xl bg-brand-orange px-4 py-2 font-bold text-white">
                      فتح كاميرا الجهاز / اختيار صورة
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) {
                            setCapturedFile(f);
                            setCapturedUrl(URL.createObjectURL(f));
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
              </>
            ) : (
              <img
                src={capturedUrl}
                alt="معاينة الصورة الملتقطة"
                style={{
                  transform: `rotate(${edits.rotationDeg}deg)`,
                  filter: `brightness(${edits.brightness}%) contrast(${edits.contrast}%)`,
                }}
                className="max-h-[360px] w-full object-contain transition-transform"
              />
            )}
          </div>

          {/* Capture or Retake Controls */}
          {!capturedFile ? (
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={Boolean(cameraError) || startingCamera}
                onClick={captureFrame}
                className="inline-flex items-center gap-2 rounded-xl bg-brand-orange px-6 py-2.5 text-sm font-bold text-white shadow hover:opacity-95 disabled:opacity-45"
              >
                <Camera className="h-4 w-4" />
                <span>التقاط الصورة الآن</span>
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Quick Non-Destructive Edit Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRetake}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>إعادة الالتقاط</span>
                  </button>
                  {canEditPhoto && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setEdits((prev) => ({
                            ...prev,
                            rotationDeg: ((prev.rotationDeg + 90) % 360) as SafePhotoEdits["rotationDeg"],
                          }))
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        <span>تدوير 90° ({edits.rotationDeg}°)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowEditor((v) => !v)}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-semibold ${
                          showEditor
                            ? "border-brand-blue bg-brand-blue/10 text-brand-blue"
                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        <Sliders className="h-3.5 w-3.5" />
                        <span>قص وإضاءة (غير متلف)</span>
                      </button>
                    </>
                  )}
                </div>
                {isNonDestructiveEditChanged(edits) && (
                  <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-[11px] font-bold text-teal-900">
                    سيُحفظ الأصل + نسخة مشتقة معدّلة
                  </span>
                )}
              </div>

              {/* Non-Destructive Lighting & Crop Controls */}
              {canEditPhoto && showEditor && (
                <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-3.5 sm:grid-cols-2">
                  <div>
                    <label className="flex justify-between font-semibold text-slate-700 mb-1">
                      <span>الإضاءة (Brightness)</span>
                      <span className="font-mono">{edits.brightness}%</span>
                    </label>
                    <input
                      type="range"
                      min={70}
                      max={140}
                      value={edits.brightness}
                      onChange={(e) => setEdits({ ...edits, brightness: Number(e.target.value) })}
                      className="w-full accent-brand-blue"
                    />
                  </div>
                  <div>
                    <label className="flex justify-between font-semibold text-slate-700 mb-1">
                      <span>التباين (Contrast)</span>
                      <span className="font-mono">{edits.contrast}%</span>
                    </label>
                    <input
                      type="range"
                      min={70}
                      max={140}
                      value={edits.contrast}
                      onChange={(e) => setEdits({ ...edits, contrast: Number(e.target.value) })}
                      className="w-full accent-brand-blue"
                    />
                  </div>
                  <div>
                    <label className="flex justify-between font-semibold text-slate-700 mb-1">
                      <span className="inline-flex items-center gap-1"><Crop className="h-3 w-3" /> قص الحواف الأفقية (متماثل)</span>
                      <span className="font-mono">{cropInsetX}%</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={30}
                      value={cropInsetX}
                      onChange={(e) => {
                        const pct = Number(e.target.value) / 100;
                        setEdits({ ...edits, crop: { ...edits.crop, x: pct, width: Math.max(0.2, 1 - pct * 2) } });
                      }}
                      className="w-full accent-brand-blue"
                    />
                  </div>
                  <div>
                    <label className="flex justify-between font-semibold text-slate-700 mb-1">
                      <span className="inline-flex items-center gap-1"><Crop className="h-3 w-3" /> قص الحواف العمودية (متماثل)</span>
                      <span className="font-mono">{cropInsetY}%</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={30}
                      value={cropInsetY}
                      onChange={(e) => {
                        const pct = Number(e.target.value) / 100;
                        setEdits({ ...edits, crop: { ...edits.crop, y: pct, height: Math.max(0.2, 1 - pct * 2) } });
                      }}
                      className="w-full accent-brand-blue"
                    />
                  </div>
                </div>
              )}

              {/* Timing, Classification, and Per-Photo Note */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">توقيت الصورة في الجلسة</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(["before", "during", "after"] as PhotoTiming[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTiming(t)}
                        className={`rounded-lg border py-1.5 font-semibold ${
                          timing === t
                            ? "border-brand-navy bg-brand-navy text-white"
                            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        {PHOTO_TIMING_LABEL[t]}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">تصنيف المنظر السريري</label>
                  <select
                    value={view}
                    onChange={(e) => setView(e.target.value as PhotoView | "")}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-1.5"
                  >
                    {QUICK_VIEWS.map((v) => (
                      <option key={v.key || "extra"} value={v.key}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 block font-semibold text-slate-700">ملاحظة مستقلة لهذه الصورة (اختياري)</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={220}
                  placeholder="مثال: تحسن ارتصاف القواطع العلوية بعد تركيب سلك 0.016×0.022 NiTi..."
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={rendering}
                  onClick={() => void handleConfirm()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-5 py-2 font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  <Check className="h-4 w-4" />
                  <span>{rendering ? "جاري تجهيز النسخة..." : "اعتماد الصورة وإضافتها للشدّة"}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
