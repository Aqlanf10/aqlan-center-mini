import { CLINIC_TIME_ZONE, insertAuditRow, recordDocumentWith } from "./db";
import { clinicDateString } from "./schedule";
import { canAccessPatient } from "./patient-access";
import { storageKey } from "./storage";
import { PHOTO_STAGE_LABEL, WEBCEPH_RECORD_SLOTS } from "./ortho-photos";
import { authorizeJourneyPatient, assertJourneyCurrent, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { readRecordUploadCommand, type RecordUploadReceipt } from "./ortho-record-upload";

export type PreparedRecordImage = { storageKey: string; sha256: string; sizeBytes: number; mimeType: string; width: number; height: number };
export async function appendOrthoRecordUpload(input: JourneyOwnerInput & { command: unknown; image: PreparedRecordImage }) {
  return journeyTransaction(true, async client => {
    let command;
    try { command = readRecordUploadCommand(input.command); } catch { journeyFail(400, "invalid_record_upload", "راجع الصورة ومرحلتها وتاريخ تصويرها ومصدر المعلومات."); }
    // Reception can upload records under the existing image permission. This
    // does not grant clinical assessment writes or use a stale route session.
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [input.patientId]);
    const actor = await authorizeJourneyPatient(client, input, false);
    if (!actor.canViewImages || !await canAccessPatient(actor.session, input.patientId, "canUploadXrays", client)) journeyFail(403, "record_upload_denied");
    const fingerprint = journeyContentHash(command);
    const previous = (await client.query("SELECT * FROM ortho_record_uploads WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3", [input.patientId, actor.userId, command.clientRequestId])).rows[0];
    if (previous && (previous.ortho_case_id !== input.orthoCaseId || previous.request_fingerprint !== fingerprint || journeyContentHash(previous.command) !== fingerprint)) journeyFail(409, "request_key_conflict");
    const original = previous ? (await client.query("SELECT patient_id,ortho_case_id,removed_at FROM patient_documents WHERE id=$1 FOR SHARE", [previous.document_id])).rows[0] : null;
    const owner = await lockJourneyOwner(client, input, true);
    const receipt = (documentId: number, replayed: boolean): RecordUploadReceipt => ({ ok: true, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId,
      clinicalCaseId: owner.clinicalCaseId, documentId, actorId: actor.userId, commandId: command.clientRequestId, requestFingerprint: fingerprint, replayed });
    if (previous) {
      if (!original || original.patient_id !== input.patientId || original.ortho_case_id !== owner.orthoCaseId || previous.clinical_case_id !== owner.clinicalCaseId || original.removed_at !== null) journeyFail(409, "uploaded_document_unavailable", "الصورة السابقة غير متاحة في هذا السياق؛ لم تُرفع نسخة ثانية ولم يُلغ إخفاؤها.");
      assertJourneyCurrent(actor); return receipt(previous.document_id, true);
    }
    const file = input.image, extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[command.file.mimeType];
    if (file.sha256 !== command.file.sha256 || file.mimeType !== command.file.mimeType || file.sizeBytes !== command.file.sizeBytes
      || file.storageKey !== storageKey(file.sha256, extension) || ![file.width, file.height].every(n => Number.isSafeInteger(n) && n > 0) || file.width * file.height > 40_000_000) journeyFail(400, "record_source_mismatch");
    const takenOn = command.occurrence.takenOn;
    if (takenOn !== null && (takenOn < "1900-01-01" || takenOn > clinicDateString(new Date(), CLINIC_TIME_ZONE))) journeyFail(400, "invalid_record_date");
    const slot = WEBCEPH_RECORD_SLOTS.find(slot => slot.key === command.photoView)!;
    const note = `مصدر الصورة والتاريخ: ${command.occurrence.sourceNote.trim()}\nتاريخ التصوير: ${takenOn ?? "غير معلوم"}\nالمرحلة: ${command.photoStage === null ? "غير معلومة" : PHOTO_STAGE_LABEL[command.photoStage]}`;
    const document = await recordDocumentWith(client, { patientId: input.patientId, visitId: null, adjustmentId: null, orthoCaseId: owner.orthoCaseId,
      kind: slot.category === "xray" ? "xray" : "photo", title: command.title, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256,
      storageKey: file.storageKey, note, takenOn, uploadedBy: actor.session.username, photoStage: command.photoStage, photoView: command.photoView, width: file.width, height: file.height });
    const saved = (await client.query(`INSERT INTO ortho_record_uploads(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,document_id,actor_user_id,created_by,command_id,request_fingerprint,command)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`, [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, document.id, actor.userId, actor.name, command.clientRequestId, fingerprint, JSON.stringify(command)])).rows[0];
    await insertAuditRow(client, { action: "ortho.record_upload", actor: actor.name, actorRole: actor.session.role, entity: "ortho_record_uploads", entityId: saved.id,
      details: { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, documentId: document.id, requestFingerprint: fingerprint } });
    assertJourneyCurrent(actor); return receipt(document.id, false);
  });
}
