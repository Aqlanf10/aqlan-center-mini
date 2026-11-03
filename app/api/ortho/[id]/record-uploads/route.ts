import { createHash } from "node:crypto";
import sharp from "sharp";
import { admitJourney, journeyResponse, journeyRouteError, journeyRouteOwner, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { orthoQuery, orthoResult, orthoRouteFailure } from "@/lib/ortho-route-handler";
import { canAccessPatient } from "@/lib/patient-access";
import { readBoundedFormData } from "@/lib/http-body";
import { UPLOAD_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { getSettings } from "@/lib/db";
import { putFile, storageStatus } from "@/lib/files";
import { DEFAULT_MAX_BYTES, validateUpload } from "@/lib/storage";
import { contentMatchesMimeType } from "@/lib/magic-bytes";
import { readRecordUploadCommand, RECORD_IMAGE_LIMIT } from "@/lib/ortho-record-upload";
import { appendOrthoRecordUpload } from "@/lib/ortho-record-upload-store";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: JourneyRouteContext) {
  try {
    const admission = await admitJourney(false); if (!admission.ok) return admission.response;
    if (!orthoQuery(request, [])) return journeyRouteError(400, "invalid_query");
    const form = await readBoundedFormData(request, UPLOAD_BODY_LIMIT_BYTES);
    if (Array.from(form.keys()).sort().join(",") !== "command,file,patientId") return journeyRouteError(400, "invalid_record_form");
    const rawPatient = form.get("patientId"), rawCommand = form.get("command"), file = form.get("file");
    if (typeof rawPatient !== "string" || !/^[1-9]\d*$/.test(rawPatient) || typeof rawCommand !== "string" || rawCommand.length > 4000 || !(file instanceof File)) return journeyRouteError(400, "invalid_record_form");
    const owner = await journeyRouteOwner(context, Number(rawPatient), admission.session); if (!owner.ok) return owner.response;
    if (!await canAccessPatient(admission.session, owner.patientId, "canViewXrays") || !await canAccessPatient(admission.session, owner.patientId, "canUploadXrays")) return journeyRouteError(403, "record_upload_denied");
    let command;
    try { command = readRecordUploadCommand(JSON.parse(rawCommand)); } catch { return journeyRouteError(400, "invalid_record_upload"); }
    const settings = await getSettings(), configured = Number(settings["documents.max_megabytes"]);
    const maxBytes = Math.min(RECORD_IMAGE_LIMIT, Number.isFinite(configured) && configured > 0 ? Math.round(configured * 1024 * 1024) : DEFAULT_MAX_BYTES);
    const check = validateUpload({ mimeType: file.type, sizeBytes: file.size, maxBytes });
    if (!check.ok || file.type !== command.file.mimeType || file.size !== command.file.sizeBytes) return journeyRouteError(400, "invalid_record_image", check.ok ? "الصورة لا تطابق الطلب." : check.message);
    const bytes = Buffer.from(await file.arrayBuffer()), sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== command.file.sha256 || !contentMatchesMimeType(bytes, file.type)) return journeyRouteError(400, "record_source_mismatch");
    let dimensions: { width: number; height: number };
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw Error("unsupported");
      // Decode before admitting an unreadable/truncated image as a clinical source.
      await image.clone().resize({ width: 1, height: 1 }).raw().timeout({ seconds: 10 }).toBuffer();
      dimensions = { width: metadata.width, height: metadata.height };
    } catch { return journeyRouteError(400, "unreadable_record_image", "تعذّر فك الصورة أو تجاوزت حدود المعالجة. اختر JPEG أو PNG أو WebP مفردة."); }
    const storage = await storageStatus(); if (!storage.ready) return journeyRouteError(503, "storage_unavailable", storage.message ?? "تعذّر الوصول إلى تخزين الصور.");
    const stored = await putFile(bytes, check.extension);
    const result = await appendOrthoRecordUpload({ ...owner, command, image: { storageKey: stored.key, sha256, sizeBytes: bytes.length, mimeType: file.type, ...dimensions } });
    return result.ok ? journeyResponse(result, result.replayed ? 200 : 201) : orthoResult(result);
  } catch (error) { return orthoRouteFailure(error, true); }
}
