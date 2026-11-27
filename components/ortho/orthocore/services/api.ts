"use client";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * AQLAN Center Mini — Secure OrthoCore API Adapter (TD-07 Hardened)
 *
 * - Eliminates module-mutable `let activeNumericPatientId` completely so opening multiple
 *   patient tabs concurrently can NEVER cross-route uploads to another patient!
 * - Every upload and derived-image save requires an explicit `patientId` (plus optional
 *   `orthoCaseId` and `parentDocumentId` for non-destructive derived lineage).
 * - Enforces the Structural Zero-PHI guard against sending patient clinical images/records externally.
 */

export interface AiMediaReview {
  viewMatchStatus: "matches" | "possible_mismatch" | "uncertain";
  viewMatchNotes: string;
  imageQualityRating: "good" | "acceptable" | "needs_retake";
  imageQualityNotes: string;
  visualObservations: string[];
  suggestedClinicalChecks: string[];
  draftNote: string;
}

export interface AiPatientAudioResult {
  script: string;
  audioBase64?: string;
  mimeType?: string;
  voice: string;
}

export function extractNumericPatientId(rawId: string | number): number {
  const n = typeof rawId === "number" ? rawId : Number(String(rawId).replace(/\D/g, ""));
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error("معرّف ملف المريض غير صالح لرفع المستند.");
  }
  return n;
}

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

export const api = {
  async uploadFile(
    patientIdOrCaseId: string | number,
    file: File,
    opts?: {
      title?: string;
      kind?: string;
      photoStage?: string;
      photoView?: string;
      note?: string;
      orthoCaseId?: number | null;
      adjustmentId?: number | null;
      parentDocumentId?: number | null;
    },
  ): Promise<{ url: string; fileName: string; mimeType: string; sizeBytes: number; docId?: number }> {
    const patientId = extractNumericPatientId(patientIdOrCaseId);
    const form = new FormData();
    form.set("file", file);
    const lower = file.name.toLowerCase();
    const inferredKind =
      opts?.kind ??
      (lower.endsWith(".dcm") || lower.includes("ceph") || lower.includes("opg")
        ? "xray"
        : "photo");
    form.set("kind", inferredKind);
    form.set("title", opts?.title || file.name);
    form.set("takenOn", clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
    if (opts?.photoStage) form.set("photoStage", opts.photoStage);
    if (opts?.photoView) form.set("photoView", opts.photoView);
    if (opts?.note) form.set("note", opts.note);
    if (opts?.orthoCaseId && opts.orthoCaseId > 0) form.set("orthoCaseId", String(opts.orthoCaseId));
    if (opts?.adjustmentId && opts.adjustmentId > 0) form.set("adjustmentId", String(opts.adjustmentId));
    if (opts?.parentDocumentId && opts.parentDocumentId > 0) form.set("parentDocumentId", String(opts.parentDocumentId));

    const res = await fetch(`/api/patients/${patientId}/documents`, {
      method: "POST",
      body: form,
    });
    const payload = (await res.json().catch(() => null)) as { id?: number; message?: string } | null;
    if (!res.ok || !payload?.id) {
      throw new Error(payload?.message || "تعذّر رفع الملف عبر خادم المركز المصادَق عليه.");
    }
    return {
      url: `/api/documents/${payload.id}`,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      docId: payload.id,
    };
  },

  async saveDerivedImage(
    patientIdOrCaseId: string | number,
    dataUrl: string,
    baseName: string,
    opts?: { orthoCaseId?: number | null; parentDocumentId?: number | null },
  ): Promise<{ url: string; fileName: string; mimeType: string; sizeBytes: number; docId?: number }> {
    const safeName = `${baseName.replace(/[^\w\u0600-\u06FF-]+/g, "_")}_derived.jpg`;
    const file = await dataUrlToFile(dataUrl, safeName);
    return this.uploadFile(patientIdOrCaseId, file, {
      title: `${baseName} (نسخة مشتقة)`,
      kind: "photo",
      orthoCaseId: opts?.orthoCaseId ?? null,
      parentDocumentId: opts?.parentDocumentId ?? null,
      note: opts?.parentDocumentId
        ? `[نسخة مشتقة من #${opts.parentDocumentId}] تم الحفظ دون تعديل الأصل التشريحي.`
        : "[نسخة مشتقة] تم الحفظ دون تعديل الأصل التشريحي.",
    });
  },

  async aiMediaReview(_payload: {
    patientId: string;
    mediaId: string;
    language?: string;
    lang?: string;
  }): Promise<{ review: AiMediaReview }> {
    throw new Error(
      "سياسة خصوصية المركز تمنع إرسال صور أو أشعة المرضى إلى خدمات الذكاء الاصطناعي الخارجية (Structural Zero-PHI). استخدم «عقلان — المساعد الذكي» بالوضع المحلي لتدقيق اكتمال السجل.",
    );
  },

  async aiPatientAudio(_payload: {
    patientId: string;
    topic?: string;
    language?: string;
    lang?: string;
    voice?: string;
    customText?: string;
    [key: string]: unknown;
  }): Promise<AiPatientAudioResult> {
    throw new Error(
      "توليد الصوت الخارجي لبيانات المرضى معطّل لحماية خصوصية المرضى (Structural Zero-PHI).",
    );
  },
};
