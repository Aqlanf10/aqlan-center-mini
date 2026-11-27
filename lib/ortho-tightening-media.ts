import type { PhotoView } from "./ortho-photos";

/**
 * منطق التصوير داخل شاشة الشدّات — خالص وقابل للاختبار.
 *
 * - يحفظ توقيت الالتقاط (قبل / أثناء / بعد إجراء الجلسة) وملاحظة كل صورة بصورة منظمة.
 * - يتحقق من هندسة القص والتدوير وتصحيح الإضاءة بحيث لا يتشوه التشريح أو نسب الأسنان أبدًا
 *   (نسبة العرض للارتفاع المحسوبة من أبعاد المستطيل المقصوص مطابقة تمامًا لنسبة الإخراج).
 * - يدير قائمة إعادة المحاولة عند انقطاع الإنترنت بعد حفظ الشدّة لمنع تكرار الشدّة أو الصور.
 */

export type PhotoTiming = "before" | "during" | "after";

export const PHOTO_TIMING_LABEL: Record<PhotoTiming, string> = {
  before: "قبل الإجراء",
  during: "أثناء الجلسة",
  after: "بعد الإجراء",
};

export interface SafePhotoEdits {
  /** التدوير بزاوية قائمة فقط لحفظ النسب الهندسية بدقة دون تشويه. */
  rotationDeg: 0 | 90 | 180 | 270;
  /** مستطيل القص كنسبة مئوية (0..1) من الصورة بعد التدوير — بدون مطّ غير متماثل. */
  crop: { x: number; y: number; width: number; height: number };
  /** تصحيح الإضاءة (70..140%) — الافتراضي 100. */
  brightness: number;
  /** تصحيح التباين (70..140%) — الافتراضي 100. */
  contrast: number;
}

export const DEFAULT_SAFE_PHOTO_EDITS: SafePhotoEdits = {
  rotationDeg: 0,
  crop: { x: 0, y: 0, width: 1, height: 1 },
  brightness: 100,
  contrast: 100,
};

export function isNonDestructiveEditChanged(edits: SafePhotoEdits): boolean {
  return (
    edits.rotationDeg !== 0 ||
    edits.brightness !== 100 ||
    edits.contrast !== 100 ||
    edits.crop.x > 0.001 ||
    edits.crop.y > 0.001 ||
    edits.crop.width < 0.999 ||
    edits.crop.height < 0.999
  );
}

/**
 * يحسب أبعاد القص الفعلية بالبكسل مع الحفاظ الصارم على نسبة التشريح 1:1
 * (لا يسمح بأي تمديد أفقي أو عمودي مستقل يغيّر أحجام الأسنان).
 */
export function computeAnatomicalSafeCropRect(
  sourceWidth: number,
  sourceHeight: number,
  edits: SafePhotoEdits,
): {
  rotatedWidth: number;
  rotatedHeight: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  brightness: number;
  contrast: number;
} {
  const w = Math.max(1, Math.round(sourceWidth));
  const h = Math.max(1, Math.round(sourceHeight));
  const swapped = edits.rotationDeg === 90 || edits.rotationDeg === 270;
  const rotatedWidth = swapped ? h : w;
  const rotatedHeight = swapped ? w : h;

  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const cx = clamp01(edits.crop.x);
  const cy = clamp01(edits.crop.y);
  const cw = Math.max(0.1, Math.min(1 - cx, clamp01(edits.crop.width)));
  const ch = Math.max(0.1, Math.min(1 - cy, clamp01(edits.crop.height)));

  const sx = Math.round(cx * rotatedWidth);
  const sy = Math.round(cy * rotatedHeight);
  const sw = Math.max(1, Math.min(rotatedWidth - sx, Math.round(cw * rotatedWidth)));
  const sh = Math.max(1, Math.min(rotatedHeight - sy, Math.round(ch * rotatedHeight)));

  const brightness = Math.max(70, Math.min(140, Math.round(edits.brightness || 100)));
  const contrast = Math.max(70, Math.min(140, Math.round(edits.contrast || 100)));

  return { rotatedWidth, rotatedHeight, sx, sy, sw, sh, brightness, contrast };
}

/**
 * يبني ملاحظة الصورة المنظمة (توقيت قبل/بعد + هل هي نسخة مشتقة + ملاحظة الطبيب)
 * ضمن حد الـ 300 حرف المعتمد في `patient_documents.note`.
 */
export function buildTighteningPhotoNote(input: {
  timing: PhotoTiming;
  note?: string;
  isDerived?: boolean;
  derivedFromDocId?: number | null;
}): string {
  const tags: string[] = [`[${PHOTO_TIMING_LABEL[input.timing]}]`];
  if (input.isDerived) {
    tags.push(input.derivedFromDocId ? `[نسخة مشتقة من الأصل #${input.derivedFromDocId}]` : "[نسخة مشتقة معدّلة]");
  }
  const cleanNote = (input.note ?? "").trim();
  const combined = cleanNote ? `${tags.join(" ")} ${cleanNote}` : tags.join(" ");
  return combined.slice(0, 300);
}

export function parseTighteningPhotoMeta(note: string | null | undefined): {
  timing: PhotoTiming | null;
  isDerived: boolean;
  cleanNote: string;
} {
  const raw = (note ?? "").trim();
  if (!raw) return { timing: null, isDerived: false, cleanNote: "" };

  let timing: PhotoTiming | null = null;
  if (raw.includes(`[${PHOTO_TIMING_LABEL.before}]`)) timing = "before";
  else if (raw.includes(`[${PHOTO_TIMING_LABEL.after}]`)) timing = "after";
  else if (raw.includes(`[${PHOTO_TIMING_LABEL.during}]`)) timing = "during";

  const isDerived = /\[نسخة مشتقة/.test(raw);
  const cleanNote = raw
    .replace(/\[(قبل الإجراء|أثناء الجلسة|بعد الإجراء)\]/g, "")
    .replace(/\[نسخة مشتقة[^\]]*\]/g, "")
    .trim();

  return { timing, isDerived, cleanNote };
}

export interface RetryableSessionPhoto {
  localId: string;
  originalFile: File;
  derivedFile?: File | null;
  preview: string;
  view: PhotoView | "";
  timing: PhotoTiming;
  note: string;
  status: "queued" | "uploading" | "uploaded" | "failed";
  error?: string;
  uploadedDocumentId?: number;
}

/**
 * يُبقي الصور التي فشلت فقط في قائمة إعادة المحاولة بحيث لا تُرفع الصور الناجحة مرة ثانية.
 */
export function pendingPhotosForRetry(items: readonly RetryableSessionPhoto[]): RetryableSessionPhoto[] {
  return items.filter((item) => item.status !== "uploaded");
}
