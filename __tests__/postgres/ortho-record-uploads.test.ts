import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { openOrthoAssessment } from "../../lib/ortho-assessment-intake-store";
import { appendOrthoRecordUpload } from "../../lib/ortho-record-upload-store";
import { verifyRecordUploadReceipt, type RecordUploadCommand } from "../../lib/ortho-record-upload";
import { ORTHO_RECORD_UPLOADS_SQL } from "../../lib/ortho-record-uploads-schema";
import { storageKey } from "../../lib/storage";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, session: SessionPayload;
beforeAll(async () => { f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); const password = "synthetic-upload-credential", u = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('record-admin','Synthetic records clinician',$1,'admin') RETURNING id", [password])).rows[0]; session = { userId: u.id, username: "record-admin", role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 }; request.token = createSessionToken(session); });
afterAll(async () => { await f?.close(); });
async function scope() {
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic record case') RETURNING id", [randomUUID()])).rows[0].id;
  const opened = await openOrthoAssessment({ patientId, session, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "Synthetic record intake" } }); if (!opened.ok) throw Error(opened.code);
  const command: RecordUploadCommand = { schemaVersion: 1, clientRequestId: randomUUID(), title: "Synthetic face", photoView: "extraoral_frontal", photoStage: null,
    occurrence: { state: "unknown", takenOn: null, sourceNote: "Synthetic transferred image; capture date unknown" }, file: { sha256: "a".repeat(64), mimeType: "image/png", sizeBytes: 900 } };
  return { patientId, orthoCaseId: opened.orthoCaseId, session, command, image: { ...command.file, storageKey: storageKey(command.file.sha256, "png"), width: 30, height: 40 } };
}
const unrelated = async () => (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM appointments) appointments")).rows;
describe("source-bound canonical case document upload", () => {
  it("registers exact migration bytes and one source event without fabricating image facts or finance", async () => {
    expect(readFileSync("migrations/0104_ortho_record_uploads.sql", "utf8")).toBe(ORTHO_RECORD_UPLOADS_SQL);
    expect((await f.pool.query("SELECT checksum,adopted FROM schema_migrations WHERE version='0104'")).rows).toEqual([{ checksum: createHash("sha256").update(ORTHO_RECORD_UPLOADS_SQL).digest("hex"), adopted: false }]);
    const input = await scope(), before = await unrelated(), saved = await appendOrthoRecordUpload(input); expect(saved).toMatchObject({ ok: true, replayed: false }); if (!saved.ok) throw Error(saved.code);
    await expect(verifyRecordUploadReceipt(saved, { ...input, actorId: session.userId! }, 201)).resolves.toEqual(saved);
    expect((await f.pool.query("SELECT patient_id,ortho_case_id,visit_id,adjustment_id,taken_on,photo_stage,photo_view,sha256 FROM patient_documents WHERE id=$1", [saved.documentId])).rows[0]).toEqual({ patient_id: input.patientId, ortho_case_id: input.orthoCaseId, visit_id: null, adjustment_id: null, taken_on: null, photo_stage: null, photo_view: "extraoral_frontal", sha256: input.command.file.sha256 });
    expect((await f.pool.query("SELECT command FROM ortho_record_uploads WHERE document_id=$1", [saved.documentId])).rows[0].command).toEqual(input.command);
    expect(await unrelated()).toEqual(before);
  });
  it("serializes identical concurrent uploads and rejects changed content under the same command", async () => {
    const input = await scope(), results = await Promise.all([appendOrthoRecordUpload(input), appendOrthoRecordUpload(input)]);
    expect(results.every(r => r.ok)).toBe(true); if (!results[0].ok || !results[1].ok) throw Error("unexpected");
    expect(results[0].documentId).toBe(results[1].documentId); expect(results.map(r => r.ok ? r.replayed : null).sort()).toEqual([false, true]);
    expect((await f.pool.query("SELECT count(*)::int n FROM patient_documents WHERE patient_id=$1", [input.patientId])).rows[0].n).toBe(1);
    expect((await f.pool.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.record_upload' AND entity_id=(SELECT id FROM ortho_record_uploads WHERE patient_id=$1)::text", [input.patientId])).rows[0].n).toBe(1);
    expect(await appendOrthoRecordUpload({ ...input, command: { ...input.command, title: "Changed request" } })).toMatchObject({ ok: false, status: 409 });
  });
  it("refuses foreign scope, mismatched source metadata and future capture dates", async () => {
    const input = await scope(), other = await scope();
    expect(await appendOrthoRecordUpload({ ...input, patientId: other.patientId })).toMatchObject({ ok: false, status: 404 });
    expect(await appendOrthoRecordUpload({ ...input, image: { ...input.image, sha256: "b".repeat(64) } })).toMatchObject({ ok: false, code: "record_source_mismatch" });
    expect(await appendOrthoRecordUpload({ ...input, command: { ...input.command, occurrence: { ...input.command.occurrence, state: "known", takenOn: "2999-01-01" } } })).toMatchObject({ ok: false, code: "invalid_record_date" });
    expect((await f.pool.query("SELECT count(*)::int n FROM patient_documents WHERE patient_id=$1", [input.patientId])).rows[0].n).toBe(0);
  });
  it("preserves a known source date, immutable history and document ownership; hidden images stay hidden on retry", async () => {
    const input = await scope(), other = await scope(); input.command = { ...input.command, photoStage: "initial", occurrence: { state: "known", takenOn: "2026-01-02", sourceNote: "Synthetic dated source" } };
    const saved = await appendOrthoRecordUpload(input); if (!saved.ok) throw Error(saved.code);
    expect((await f.pool.query("SELECT taken_on::text,photo_stage FROM patient_documents WHERE id=$1", [saved.documentId])).rows[0]).toEqual({ taken_on: "2026-01-02", photo_stage: "initial" });
    await expect(f.pool.query("UPDATE ortho_record_uploads SET command='{}' WHERE document_id=$1", [saved.documentId])).rejects.toThrow("append-only");
    await expect(f.pool.query("DELETE FROM ortho_record_uploads WHERE document_id=$1", [saved.documentId])).rejects.toThrow("append-only");
    await expect(f.pool.query("UPDATE patient_documents SET ortho_case_id=$1 WHERE id=$2", [other.orthoCaseId, saved.documentId])).rejects.toThrow();
    await expect(f.pool.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2", ["b".repeat(64), saved.documentId])).rejects.toThrow();
    await f.pool.query("UPDATE patient_documents SET removed_at=now() WHERE id=$1", [saved.documentId]);
    expect(await appendOrthoRecordUpload(input)).toMatchObject({ ok: false, code: "uploaded_document_unavailable" });
    expect((await f.pool.query("SELECT count(*)::int n FROM patient_documents WHERE patient_id=$1", [input.patientId])).rows[0].n).toBe(1);
  });
  it("rolls back document, upload command and audit together on audit failure", async () => {
    const input = await scope();
    await f.pool.query("CREATE FUNCTION synthetic_upload_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.record_upload' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_upload_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_upload_audit_fail()");
    try { await expect(appendOrthoRecordUpload(input)).rejects.toThrow("synthetic audit failure"); }
    finally { await f.pool.query("DROP TRIGGER synthetic_upload_audit_fail ON audit_log;DROP FUNCTION synthetic_upload_audit_fail()"); }
    expect((await f.pool.query("SELECT count(*)::int n FROM patient_documents WHERE patient_id=$1", [input.patientId])).rows[0].n).toBe(0);
    expect((await f.pool.query("SELECT count(*)::int n FROM ortho_record_uploads WHERE patient_id=$1", [input.patientId])).rows[0].n).toBe(0);
  });
  it("rechecks upload/view permissions and credentials, while reception retains image upload rights", async () => {
    const input = await scope(), password = "synthetic-upload-doctor";
    const u = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES('upload-doctor','Synthetic doctor',$1,'doctor',$2) RETURNING id", [password, JSON.stringify({ canViewAllPatients: true, canViewXrays: true, canUploadXrays: false })])).rows[0];
    let actor: SessionPayload = { userId: u.id, username: "upload-doctor", role: "doctor", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 };
    try {
      request.token = createSessionToken(actor); expect(await appendOrthoRecordUpload({ ...input, session: actor })).toMatchObject({ ok: false, status: 403 });
      await f.pool.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify({ canViewAllPatients: true, canViewXrays: true, canUploadXrays: true }), u.id]);
      const saved = await appendOrthoRecordUpload({ ...input, session: actor }); expect(saved).toMatchObject({ ok: true });
      await f.pool.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify({ canViewAllPatients: true, canViewXrays: false, canUploadXrays: true }), u.id]);
      expect(await appendOrthoRecordUpload({ ...input, session: actor })).toMatchObject({ ok: false, status: 403 });
      await f.pool.query("UPDATE users SET role='reception' WHERE id=$1", [u.id]); actor = { ...actor, role: "reception" }; request.token = createSessionToken(actor);
      expect(await appendOrthoRecordUpload({ ...input, session: actor, command: { ...input.command, clientRequestId: randomUUID() } })).toMatchObject({ ok: true });
      await f.pool.query("UPDATE users SET is_active=FALSE WHERE id=$1", [u.id]); expect(await appendOrthoRecordUpload({ ...input, session: actor })).toMatchObject({ ok: false, status: 401 });
    } finally { request.token = createSessionToken(session); }
  });
});
