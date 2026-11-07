import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { putFile } from "../../lib/files";
import { getStudyImageBasis } from "../../lib/ortho-study-image-store";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { appendOrthoAssessment, getOrthoAssessment } from "../../lib/ortho-assessment-store";
import { newAssessmentEditorV2, assessmentEditorCommandV2 } from "../../lib/ortho-assessment-editor-v2";
import { addPanoramicFinding, panoramicFindingId } from "../../lib/ortho-panoramic-findings";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let directory = "";
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>, sequence = 0;
beforeAll(async () => { vi.stubEnv("SESSION_SECRET", "synthetic-panoramic-secret-at-least-32-characters"); fixture = await openPeriodontalFixture(process.env, { pristine: true }); await fixture.db.ensureSchema(); directory = await mkdtemp(join(tmpdir(), "panoramic-synthetic-")); vi.stubEnv("DOCUMENTS_DIR", directory); });
afterAll(async () => { try { await fixture?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); } });
async function setup() {
  const n = ++sequence, password = "Synthetic password hash";
  const patientId = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic panoramic patient') RETURNING id", [`SYN-PANO-${n}`])).rows[0].id;
  const userId = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic reader',$2,'admin') RETURNING id", [`synthetic-pano-${n}`, password])).rows[0].id;
  const session: SessionPayload = { userId, username: `synthetic-pano-${n}`, role: "admin", expiresAt: Date.now() + 120000, credentialVersion: sessionCredentialVersion(password) }; request.token = createSessionToken(session);
  const orthoCaseId = (await fixture.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await fixture.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: n % 256, g: 80, b: 160 } } }).png().toBuffer();
  const stored = await putFile(bytes, "png");
  const documentId = (await fixture.pool.query(`INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view)
    VALUES($1,$2,'imaging','Synthetic panoramic record','image/png',$4,$3,$5,'synthetic','panoramic') RETURNING id`, [patientId, orthoCaseId, stored.sha256, bytes.length, stored.key])).rows[0].id;
  const scope = { patientId, orthoCaseId, clinicalCaseId, session };
  const read = await getOrthoAssessment({ ...scope, acceptedSchemas: [2] }); if (!read.ok || read.state !== "ready") throw Error("fixture read");
  const source = read.sources.items.find(s => s.kind === "document" && s.id === documentId)!;
  const editor = newAssessmentEditorV2(randomUUID(), null)!; editor.reason = "Synthetic doctor review";
  editor.measurements = addPanoramicFinding(editor.measurements, { kind: source.kind, id: source.id, version: source.version }, 13)!;
  const id = panoramicFindingId(documentId, 13);
  editor.measurements.values[id] = { ...editor.measurements.values[id], state: "recorded", text: "Synthetic observation, not a patient diagnosis", dateState: "known", date: "2026-10-01", method: "direct_examination", methodDescription: "Manual examination of synthetic image", performer: "documented", performerAttribution: "Synthetic specialist" };
  const command = assessmentEditorCommandV2(editor)!; if (!command) throw Error("fixture command");
  return { scope, command, documentId, userId, observationId: id, stored, bytes };
}
const sideEffects = async () => (await fixture.pool.query(`SELECT (SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM plan_items) plan_items`)).rows;
describe("source-bound panoramic comments in the real PostgreSQL assessment writer", () => {
  it("saves, restores, corrects and exactly replays one observation without extra visits or money", async () => {
    const f = await setup(), before = await sideEffects(), first = await appendOrthoAssessment({ ...f.scope, command: f.command });
    expect(first).toMatchObject({ ok: true, replayed: false, revision: { version: 1 } }); if (!first.ok) throw Error(first.code);
    const corrected = structuredClone(f.command); corrected.commandId = randomUUID(); corrected.expectedRevisionId = first.revision.id;
    corrected.content.observations.observations.find(o => o.id === f.observationId)!.value = { state: "recorded", text: "Corrected synthetic interpretation" };
    expect(await appendOrthoAssessment({ ...f.scope, command: corrected })).toMatchObject({ ok: true, revision: { version: 2 } });
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: true, replayed: true, revision: first.revision });
    const old = await getOrthoAssessment({ ...f.scope, acceptedSchemas: [2], revisionId: first.revision.id });
    expect(old).toMatchObject({ ok: true, revision: first.revision }); expect(await sideEffects()).toEqual(before);
  });
  it("refuses a false tooth/source identity and a non-panoramic or unassigned source", async () => {
    const f = await setup(), forged = structuredClone(f.command), row = forged.content.observations.observations.find(o => o.id === f.observationId)!;
    row.target = { kind: "tooth", tooth: 23 };
    expect(await appendOrthoAssessment({ ...f.scope, command: forged })).toMatchObject({ ok: false, code: "invalid_panoramic_target" });
    row.target = { kind: "tooth", tooth: 13 }; row.provenance!.sources = [];
    expect(await appendOrthoAssessment({ ...f.scope, command: forged })).toMatchObject({ ok: false, code: "missing_panoramic_source" });
    await fixture.pool.query("UPDATE patient_documents SET photo_view='profile' WHERE id=$1", [f.documentId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "panoramic_source_unavailable" });
    await fixture.pool.query("UPDATE patient_documents SET photo_view='panoramic',ortho_case_id=NULL WHERE id=$1", [f.documentId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "panoramic_source_unavailable" });
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [f.scope.orthoCaseId])).rows[0].n).toBe(0);
  });
  it("serializes concurrent revisions and revalidates current source bytes and authority", async () => {
    const f = await setup(), second = { ...f.command, commandId: randomUUID() };
    const results = await Promise.all([appendOrthoAssessment({ ...f.scope, command: f.command }), appendOrthoAssessment({ ...f.scope, command: second })]);
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.filter(r => !r.ok)).toMatchObject([{ ok: false, code: "head_changed" }]);
    const winner = results.find(r => r.ok)!; if (!winner.ok) throw Error("fixture winner");
    await fixture.pool.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2", ["b".repeat(64), f.documentId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: { ...f.command, commandId: randomUUID(), expectedRevisionId: winner.revision.id } })).toMatchObject({ ok: false, code: "source_unavailable" });
    await fixture.pool.query("UPDATE users SET role='reception' WHERE id=$1", [f.userId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false });
  });
  it.each([
    ["changed hash", "sha256='" + "b".repeat(64) + "'", "source_unavailable"],
    ["removed source", "removed_at=NOW()", "source_unavailable"],
    ["archived source", "photo_stage='archived'", "panoramic_source_unavailable"],
    ["non-image MIME", "mime_type='application/pdf'", "panoramic_source_unavailable"],
  ])("rejects a new revision using %s but preserves the confirmed immutable replay", async (_label, mutation, code) => {
    const f = await setup();
    const saved = await appendOrthoAssessment({ ...f.scope, command: f.command });
    expect(saved.ok).toBe(true); if (!saved.ok) throw Error(saved.code);
    await fixture.pool.query(`UPDATE patient_documents SET ${mutation} WHERE id=$1`, [f.documentId]);
    const next = { ...f.command, commandId: randomUUID(), expectedRevisionId: saved.revision.id };
    expect(await appendOrthoAssessment({ ...f.scope, command: next })).toMatchObject({ ok: false, code });
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: true, replayed: true, revision: saved.revision });
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_assessment_revisions WHERE ortho_case_id=$1", [f.scope.orthoCaseId])).rows[0].n).toBe(1);
  });
  it("denies both new writes and replay after document ownership moves to another case", async () => {
    const f = await setup();
    const saved = await appendOrthoAssessment({ ...f.scope, command: f.command });
    if (!saved.ok) throw Error(saved.code);
    const other = (await fixture.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','synthetic') RETURNING id", [f.scope.patientId])).rows[0].id;
    await fixture.pool.query("UPDATE patient_documents SET ortho_case_id=$1 WHERE id=$2", [other, f.documentId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: { ...f.command, commandId: randomUUID(), expectedRevisionId: saved.revision.id } })).toMatchObject({ ok: false, code: "source_unavailable" });
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "source_access_changed" });
  });
  it("denies cross-patient document ownership for new writes and replay", async () => {
    const f = await setup();
    const saved = await appendOrthoAssessment({ ...f.scope, command: f.command });
    if (!saved.ok) throw Error(saved.code);
    const other = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic other patient') RETURNING id", [`SYN-PANO-OTHER-${++sequence}`])).rows[0].id;
    await fixture.pool.query("UPDATE patient_documents SET patient_id=$1,ortho_case_id=NULL WHERE id=$2", [other, f.documentId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: { ...f.command, commandId: randomUUID(), expectedRevisionId: saved.revision.id } })).toMatchObject({ ok: false, code: "source_unavailable" });
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "source_access_changed" });
  });

  it("requires current imaging permission even to replay a confirmed panoramic command", async () => {
    const f = await setup();
    await fixture.pool.query("UPDATE users SET role='doctor',permissions=$2 WHERE id=$1", [f.userId, JSON.stringify({ canViewAllPatients: true, canViewXrays: true })]);
    f.scope.session.role = "doctor"; request.token = createSessionToken(f.scope.session);
    const saved = await appendOrthoAssessment({ ...f.scope, command: f.command });
    if (!saved.ok) throw Error(saved.code);
    await fixture.pool.query("UPDATE users SET permissions=$2 WHERE id=$1", [f.userId, JSON.stringify({ canViewAllPatients: true, canViewXrays: false })]);
    expect(await appendOrthoAssessment({ ...f.scope, command: { ...f.command, commandId: randomUUID(), expectedRevisionId: saved.revision.id } })).toMatchObject({ ok: false, code: "imaging_restricted" });
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "imaging_restricted" });
    expect(await getOrthoAssessment({ ...f.scope, acceptedSchemas: [2] })).toMatchObject({ ok: false, code: "imaging_restricted" });
  });

  it.each(["missing", "changed", "truncated"] as const)("rejects %s backing bytes after successful preview and preserves confirmed replay", async mutation => {
    const f = await setup();
    expect(await getStudyImageBasis({ ...f.scope, documentId: f.documentId, sha256: f.stored.sha256 })).toMatchObject({ ok: true });
    const saved = await appendOrthoAssessment({ ...f.scope, command: f.command });
    if (!saved.ok) throw Error(saved.code);
    const path = join(directory, f.stored.key);
    if (mutation === "missing") await rm(path);
    else if (mutation === "truncated") await writeFile(path, f.bytes.subarray(0, 12));
    else { const changed = Buffer.from(f.bytes); changed[changed.length - 1] ^= 1; await writeFile(path, changed); }
    expect(await appendOrthoAssessment({ ...f.scope, command: { ...f.command, commandId: randomUUID(), expectedRevisionId: saved.revision.id } })).toMatchObject({ ok: false, code: "panoramic_source_unavailable" });
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: true, replayed: true, revision: saved.revision });
  });

  it("rejects invalid image bytes even when metadata and command hashes agree", async () => {
    const f = await setup(), invalid = await putFile(Buffer.from("Synthetic invalid image"), "png");
    await fixture.pool.query("UPDATE patient_documents SET sha256=$1,storage_key=$2,size_bytes=$3 WHERE id=$4", [invalid.sha256, invalid.key, invalid.sizeBytes, f.documentId]);
    f.command.content.observations.observations.find(o => o.id === f.observationId)!.provenance!.sources[0].version = `sha256:${invalid.sha256}`;
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "panoramic_source_unavailable" });
  });
  it("rejects encoded MIME mismatch and oversized declared sources", async () => {
    const f = await setup();
    await fixture.pool.query("UPDATE patient_documents SET mime_type='image/jpeg' WHERE id=$1", [f.documentId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "panoramic_source_unavailable" });
    await fixture.pool.query("UPDATE patient_documents SET mime_type='image/png',size_bytes=26214401 WHERE id=$1", [f.documentId]);
    expect(await appendOrthoAssessment({ ...f.scope, command: f.command })).toMatchObject({ ok: false, code: "panoramic_source_size_limit" });
  });

});
