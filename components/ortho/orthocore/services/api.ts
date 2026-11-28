"use client";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * AQLAN Center Mini — Secure OrthoCore API Adapter
 *
 * Replaces OrthoCore's standalone SQLite / unauthenticated `/uploads` API with
 * AQLAN Center Mini's authenticated PostgreSQL + Documents APIs and enforces
 * the strict Zero-PHI guard against sending any patient images/records to Gemini.
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

let activeNumericPatientId: number | null = null;
let activeNumericOrthoCaseId: number | null = null;

export function setActiveOrthoCorePatientId(patientId: number, orthoCaseId: number | null = null) {
  activeNumericPatientId = patientId;
  activeNumericOrthoCaseId = orthoCaseId;
}

export function getActiveOrthoCoreCaseId(): number | null {
  return activeNumericOrthoCaseId;
}

function getPatientIdOrThrow(): number {
  if (!activeNumericPatientId || activeNumericPatientId <= 0) {
    throw new Error("معرّف ملف المريض غير محدد لرفع المستند.");
  }
  return activeNumericPatientId;
}

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

export const api = {
  async uploadFile(
    file: File,
    opts?: {
      title?: string;
      kind?: string;
      takenOn?: string;
      photoStage?: string;
      photoView?: string;
      orthoCaseId?: number | null;
      note?: string;
    },
  ): Promise<{ url: string; fileName: string; mimeType: string; sizeBytes: number; docId?: number }> {
    const patientId = getPatientIdOrThrow();
    const form = new FormData();
    form.set("file", file);
    const lower = file.name.toLowerCase();
    const inferredKind =
      opts?.kind ??
      (lower.endsWith(".dcm") || lower.includes("ceph") || lower.includes("opg")
        ? "xray"
        : "photo");
    const stageMap: Record<string, string> = {
      T0: "initial",
      T1: "progress",
      T2: "debond",
      T3: "retention",
      initial: "initial",
      progress: "progress",
      debond: "debond",
      retention: "retention",
    };
    const effectiveTakenOn =
      opts?.takenOn && /^\d{4}-\d{2}-\d{2}$/.test(opts.takenOn)
        ? opts.takenOn
        : clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
    form.set("kind", inferredKind);
    form.set("title", opts?.title || file.name);
    form.set("takenOn", effectiveTakenOn);
    const effectiveCaseId = opts?.orthoCaseId !== undefined ? opts.orthoCaseId : activeNumericOrthoCaseId;
    if (effectiveCaseId && effectiveCaseId > 0) form.set("orthoCaseId", String(effectiveCaseId));
    if (opts?.photoStage) form.set("photoStage", stageMap[opts.photoStage] ?? opts.photoStage);
    if (opts?.photoView) form.set("photoView", opts.photoView);
    if (opts?.note) form.set("note", opts.note);

    const res = await fetch(`/api/patients/${patientId}/documents`, {
      method: "POST",
      body: form,
    });
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      id?: number;
      message?: string;
    } | null;
    if (!res.ok) {
      throw new Error(payload?.message || "تعذّر رفع الملف عبر خادم المركز المصادَق عليه.");
    }
    if (!payload?.id) {
      if (payload?.ok === true) {
        return {
          url: "",
          fileName: "",
          mimeType: "",
          sizeBytes: 0,
        };
      }
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
    dataUrl: string,
    baseName: string,
  ): Promise<{ url: string; fileName: string; mimeType: string; sizeBytes: number; docId?: number }> {
    const safeName = `${baseName.replace(/[^\w\u0600-\u06FF-]+/g, "_")}_derived.jpg`;
    const file = await dataUrlToFile(dataUrl, safeName);
    return this.uploadFile(file, {
      title: `${baseName} (نسخة مشتقة)`,
      kind: "photo",
      note: "[نسخة مشتقة] تم الحفظ دون تعديل الأصل التشريحي.",
    });
  },

  async aiMediaReview(_payload: {
    patientId: string;
    mediaId: string;
    language?: string;
    lang?: string;
  }): Promise<{ review: AiMediaReview }> {
    throw new Error(
      "سياسة خصوصية المركز تمنع إرسال صور أو أشعة المرضى إلى خدمات الذكاء الاصطناعي الخارجية (Gemini). استخدم «عقلان — المساعد الذكي» بالوضع المحلي لتدقيق اكتمال السجل.",
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
      "توليد الصوت الخارجي لبيانات المرضى معطّل افتراضيًا لحماية خصوصية المرضى (Zero-PHI Policy).",
    );
  },
};
