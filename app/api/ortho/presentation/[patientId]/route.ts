import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  evaluateOrthoPermission,
  NO_STORE_HEADERS,
  orthoForbiddenResponse,
} from "@/lib/ortho-privacy-server";
import { loadOrthoWorkspaceRecord, filterWorkspaceByPrivacy } from "@/lib/ortho-workspace-store";
import {
  buildCasePresentationDeck,
  generateEditablePptxBytes,
  type PresentationMediaAsset,
  type PresentationSessionInput,
} from "@/lib/ortho-case-presentation";
import {
  CLINIC_TIME_ZONE,
  getDocumentForDownload,
  getPatient,
  getSettingsSafe,
  listPatientDocuments,
  listPatientOrthoCases,
  recordAudit,
} from "@/lib/db";
import { readFileByKey } from "@/lib/files";
import { clinicDateString } from "@/lib/schedule";

export const dynamic = "force-dynamic";

type OverlayKey = "ceph" | "profile" | "smile" | "fifths" | "thirds" | "intraoral";
const ALLOWED_OVERLAY_KEYS = new Set<OverlayKey>([
  "ceph",
  "profile",
  "smile",
  "fifths",
  "thirds",
  "intraoral",
]);
const MAX_OVERLAY_BYTES = 1536 * 1024; // 1.5 MB per traced overlay
const MAX_EMBEDDED_PHOTOS = 24;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4 MB per clinic photo

function detectPngOrJpeg(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.byteLength < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return null;
}

function parseOverlayDataUrl(raw: unknown): { bytes: Uint8Array; ext: "png" | "jpg" } | null {
  if (typeof raw !== "string") return null;
  const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw.trim());
  if (!match) return null;
  const b64 = match[2].replace(/\s+/g, "");
  if (b64.length > MAX_OVERLAY_BYTES * 1.4) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.byteLength < 16 || buf.byteLength > MAX_OVERLAY_BYTES) return null;
    const ext = detectPngOrJpeg(buf);
    if (!ext) return null;
    return { bytes: new Uint8Array(buf), ext };
  } catch {
    return null;
  }
}

function inferViewType(photoView: string | null, title: string, kind: string): string {
  if (photoView && photoView.trim()) return photoView.trim();
  const text = `${title} ${kind}`.toLowerCase();
  if (text.includes("ceph") || text.includes("سيفالو")) return "lateral_ceph";
  if (text.includes("opg") || text.includes("panoramic") || text.includes("بانوراما")) return "opg";
  if (text.includes("profile") || text.includes("جانبي") || text.includes("بروفايل")) return "extraoral_profile";
  if (text.includes("smile") || text.includes("ابتسام")) return "extraoral_frontal_smile";
  if (text.includes("extraoral") || text.includes("وجه")) return "extraoral_frontal_rest";
  if (text.includes("upper") || text.includes("علوي")) return "intraoral_upper";
  if (text.includes("lower") || text.includes("سفلي")) return "intraoral_lower";
  if (text.includes("right") || text.includes("يمين")) return "intraoral_right";
  if (text.includes("left") || text.includes("يسار")) return "intraoral_left";
  if (text.includes("frontal") || text.includes("أمامي")) return "intraoral_frontal";
  if (text.includes("cast") || text.includes("model") || text.includes("نموذج")) return "cast";
  if (kind === "xray") return "opg";
  return "intraoral_frontal";
}

function isFacialView(viewType: string): boolean {
  const v = viewType.toLowerCase();
  return v.startsWith("extraoral") || v.includes("frontal_rest") || v.includes("smile") || v.includes("profile");
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ patientId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json(
      { message: "انتهت الجلسة. سجّل الدخول من جديد." },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const { patientId: rawId } = await context.params;
  const patientId = Number(rawId);
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  let body: {
    format?: "pptx" | "pdf";
    anonymize?: boolean;
    lang?: "ar" | "en";
    selectedSlideIds?: string[];
    selectedMediaIds?: string[];
    tracedOverlays?: Record<string, string>;
  };
  try {
    body = await readJsonBody(req, 6 * 1024 * 1024);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "بيانات الطلب غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const format = body.format === "pdf" ? "pdf" : "pptx";
  const anonymize = body.anonymize === true;
  const lang = body.lang === "en" ? "en" : "ar";

  const evalCreate = await evaluateOrthoPermission(
    session,
    { permission: "presentation.create", section: "reports" },
    { patientId },
  );
  if (!evalCreate.allowed || !evalCreate.access) {
    return orthoForbiddenResponse("إنشاء Case Presentation يتطلب صلاحية «إنشاء Case Presentation».", {
      reason: evalCreate.reason,
    });
  }

  const actionPerm = format === "pptx" ? "reports.export" : "reports.print";
  if (!evalCreate.access.permissions[actionPerm]) {
    return orthoForbiddenResponse(
      format === "pptx"
        ? "تصدير ملفات PPTX يتطلب صلاحية «تصدير التقارير»."
        : "طباعة العرض كـ PDF تتطلب صلاحية «طباعة التقارير».",
    );
  }

  const patient = await getPatient(patientId).catch(() => null);
  if (!patient) {
    return NextResponse.json({ message: "ملف المريض غير موجود." }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const rawRecord = await loadOrthoWorkspaceRecord(patientId);
  const { filtered } = filterWorkspaceByPrivacy(rawRecord, evalCreate.access);

  // Educational anonymization consent guard
  if (anonymize && !filtered.questionnaire.consentForEducationDeidentified && !evalCreate.subject?.isOwner) {
    return NextResponse.json(
      {
        message:
          "التصدير التعليمي مُخفى الهوية يتطلب توثيق موافقة المريض الخطية في تبويب «الاستبيان» أولًا.",
      },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }

  const settings = await getSettingsSafe().catch(() => null);
  const clinicName = settings?.["clinic.name"]?.trim() || "مركز الدكتور عقلان";
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const cases = await listPatientOrthoCases(patientId, today).catch(() => []);
  const doctorName =
    cases.find((c) => c.responsibleDoctorName)?.responsibleDoctorName ??
    (typeof (filtered.orthoCoreCase as Record<string, unknown> | undefined)?.assignedDoctor === "string"
      ? String((filtered.orthoCoreCase as Record<string, unknown>).assignedDoctor)
      : undefined);

  const rawAdjustments = cases
    .flatMap((c) => c.adjustments ?? [])
    .sort((a, b) => a.doneOn.localeCompare(b.doneOn) || a.id - b.id);

  const sessionSummaries: PresentationSessionInput[] = rawAdjustments.map((a, idx) => ({
    id: a.id,
    visitNumber: idx + 1,
    date: a.doneOn,
    phase: a.phase,
    upperWire: a.upperWire,
    lowerWire: a.lowerWire,
    elastics: a.elastics && a.elastics !== "none" ? (a.elasticNote ? `${a.elastics} (${a.elasticNote})` : a.elastics) : null,
    done: a.done,
    note: a.note,
    clinician: a.recordedBy,
    photoDocIds: (a.photos ?? []).map((p) => p.id),
  }));

  // Load permitted clinical photos from durable disk storage for embedding into PPTX
  const mediaAssets: PresentationMediaAsset[] = [];
  const canEmbedPhotos =
    evalCreate.access.permissions["photos.view"] && evalCreate.access.fields.previousPhotos;

  if (canEmbedPhotos && format === "pptx") {
    const docs = await listPatientDocuments(patientId).catch(() => []);
    const selectedSet =
      Array.isArray(body.selectedMediaIds) && body.selectedMediaIds.length > 0
        ? new Set(body.selectedMediaIds.map((x) => String(x)))
        : null;

    // Also include adjustment-linked photo IDs so session progress slides always get their photos
    const adjustmentDocIds = new Set<number>();
    for (const s of sessionSummaries) {
      for (const did of s.photoDocIds ?? []) adjustmentDocIds.add(did);
    }

    const imageDocs = docs
      .filter((d) => d.isImage && !d.removedAt)
      .filter((d) => {
        if (!selectedSet) return true;
        return (
          selectedSet.has(String(d.id)) ||
          selectedSet.has(`doc-${d.id}`) ||
          adjustmentDocIds.has(d.id)
        );
      })
      .slice(0, MAX_EMBEDDED_PHOTOS);

    const allowFacialWhenAnon = Boolean(filtered.questionnaire.consentForEducationDeidentified);

    for (const doc of imageDocs) {
      const viewType = inferViewType(doc.photoView, doc.title, doc.kind);
      if (anonymize && isFacialView(viewType) && !allowFacialWhenAnon) {
        continue;
      }
      const dl = await getDocumentForDownload(doc.id).catch(() => null);
      if (!dl || dl.document.patientId !== patientId || !dl.storageKey) continue;
      const buf = await readFileByKey(dl.storageKey).catch(() => null);
      if (!buf || buf.byteLength < 16 || buf.byteLength > MAX_PHOTO_BYTES) continue;
      const ext = detectPngOrJpeg(buf);
      if (!ext) continue;

      mediaAssets.push({
        id: `doc-${doc.id}`,
        docId: doc.id,
        title: doc.title || viewType,
        viewType,
        stage: doc.photoStage || "T0",
        adjustmentId: doc.adjustmentId,
        bytes: new Uint8Array(buf),
        ext,
      });
    }
  }

  // Validate optional client-rendered traced canvas overlays (Ceph / Photo Analysis)
  const tracedOverlays: Partial<Record<OverlayKey, { bytes: Uint8Array; ext: "png" | "jpg" }>> = {};
  if (canEmbedPhotos && body.tracedOverlays && typeof body.tracedOverlays === "object") {
    for (const [k, val] of Object.entries(body.tracedOverlays)) {
      if (!ALLOWED_OVERLAY_KEYS.has(k as OverlayKey)) continue;
      const parsed = parseOverlayDataUrl(val);
      if (parsed) {
        tracedOverlays[k as OverlayKey] = parsed;
      }
    }
  }

  const currentYear = new Date().getFullYear();
  const agePart =
    typeof patient.birthYear === "number" && patient.birthYear > 1900 && patient.birthYear <= currentYear
      ? `${currentYear - patient.birthYear}y`
      : "";
  const patientAgeGender = [agePart, patient.gender || ""].filter(Boolean).join(" / ") || undefined;

  const deck = buildCasePresentationDeck({
    clinicName,
    patientName: patient.fullName,
    patientCode: patient.patientNumber,
    patientAgeGender,
    doctorName,
    record: filtered,
    selectedSlideIds: Array.isArray(body.selectedSlideIds) ? body.selectedSlideIds : undefined,
    anonymize,
    lang,
    sessionSummaries,
    photoCount: mediaAssets.length,
    mediaAssets,
    tracedOverlays,
  });

  await recordAudit({
    action: "ortho.presentation_export",
    entity: "patient",
    entityId: String(patientId),
    entityLabel: anonymize ? `عرض تعليمي مخفى الهوية #${patientId}` : patient.fullName,
    details: {
      الصيغة: format.toUpperCase(),
      اللغة: lang.toUpperCase(),
      إخفاء_الهوية: anonymize,
      عدد_الشرائح: deck.slides.length,
      عدد_الصور_المدمجة: mediaAssets.length,
      عدد_الرسوم_التتبعية: Object.keys(tracedOverlays).length,
    },
    actor: session.username,
    actorRole: session.role,
  }).catch(() => {});

  if (format === "pptx") {
    const pptxBytes = generateEditablePptxBytes(deck);
    const filename = anonymize
      ? `AQLAN-Ortho-Case-EDU-${patientId}.pptx`
      : `AQLAN-Ortho-Case-${patient.patientNumber || patientId}.pptx`;
    return new NextResponse(Buffer.from(pptxBytes), {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // Strip raw image bytes for lightweight PDF JSON payload
  const lightDeck = {
    ...deck,
    slides: deck.slides.map((s) => ({
      ...s,
      images: undefined,
    })),
  };

  return NextResponse.json({ ok: true, deck: lightDeck }, { status: 200, headers: NO_STORE_HEADERS });
}
