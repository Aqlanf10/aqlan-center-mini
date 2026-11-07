import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import { appendOrthoAssessment, getOrthoAssessment } from "../../lib/ortho-assessment-store";
import { historicalTanakaPayload } from "../fixtures/ortho-assessment-historical-tanaka";
import { assessmentJsonHash } from "../../lib/ortho-assessment-persisted-v2";
import { checkAnyAssessmentCommand } from "../../lib/ortho-assessment-command-v2";
import { loadMigrationFiles } from "../../lib/migration-files";
import { migrate } from "../../lib/migrations";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, n = 0;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-boundary-review-secret-at-least32characters");
  f = await openPeriodontalFixture(process.env, { pristine: true });
  await migrate(f.pool, { apply: true, files: (await loadMigrationFiles()).filter(file => file.version < "0110") });
});
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function setup() {
  const seq = ++n, password = "Synthetic credential";
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic boundary analysis') RETURNING id", [`SYN-BOUNDARY-${seq}`])).rows[0].id;
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic examiner',$2,'admin') RETURNING id", [`synthetic-boundary-${seq}`, password])).rows[0].id;
  const session: SessionPayload = { userId, username: `synthetic-boundary-${seq}`, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 600000 };
  request.token = createSessionToken(session);
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic boundary bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}
const counts = async (patientId: number) => (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patientId])).rows;
const stored = async (ortho: number) => (await f.pool.query("SELECT to_jsonb(r)::text AS facts FROM ortho_assessment_revisions r WHERE ortho_case_id=$1 ORDER BY version", [ortho])).rows;
function boundaryCommand(widths: number[]) {
  const command = { ...tanakaCommandV2(), commandId: randomUUID() };
  widths.forEach((value, i) => { command.content.observations.observations.find(r => r.id === `width_${[31,32,41,42][i]}`)!.value = { state: "measured", value }; });
  return command;
}

describe("Tanaka boundary persistence and historical command replay", () => {
  it("replays an actual pre-upgrade2.2 command without rewriting its historical outside-domain witness", async () => {
    const scope = await setup(), command = boundaryCommand([4,4.06,5.97,6.47]), beforeCounts = await counts(scope.patientId);
    const parsed = checkAnyAssessmentCommand(command);
    if (!parsed.ok || parsed.value.schemaVersion !== 2) throw Error("invalid fixture");
    const checked = parsed.value, draft = checked.content;
    const content = historicalTanakaPayload(draft);
    expect(content.results.every(r => r.result.state === "outside_supported_predictor_domain")).toBe(true);
    const fingerprint = assessmentJsonHash({ schemaVersion: 2, expectedRevisionId: checked.expectedRevisionId, reason: checked.reason, content: checked.content });
    await f.pool.query(`INSERT INTO ortho_assessment_revisions
      (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content)
      VALUES($1,$1,$2,$3,2,1,NULL,$4,'Synthetic examiner',$5,'current',$6,$7,$8,$9::jsonb)`,
    [scope.patientId,scope.orthoCaseId,scope.clinicalCaseId,scope.session.userId,checked.reason,checked.commandId,fingerprint,assessmentJsonHash(content),JSON.stringify(content)]);
    const before = await stored(scope.orthoCaseId);
    await f.db.ensureSchema();
    const replay = await appendOrthoAssessment({ ...scope, command });
    expect(replay).toMatchObject({ ok: true, replayed: true, revision: { content } });
    expect(await stored(scope.orthoCaseId)).toEqual(before);
    expect(await counts(scope.patientId)).toEqual(beforeCounts);
    const reopened = await getOrthoAssessment({ ...scope, acceptedSchemas: [2] });
    expect(reopened).toMatchObject({ ok: true, state: "ready", revision: { content } });
  });
  it.each([[4,4.06,5.97,6.47], [4.03,7,7.99,7.98]])("saves and reopens exact decimal endpoint %j with a single concurrent command", async (...widths) => {
    await f.db.ensureSchema();
    const scope = await setup(), command = boundaryCommand(widths), before = await counts(scope.patientId);
    const results = await Promise.all([0,1].map(() => appendOrthoAssessment({ ...scope, command })));
    expect(results.every(result => result.ok)).toBe(true);
    expect(results.filter(result => result.ok && result.replayed)).toHaveLength(1);
    const saved = results.find(result => result.ok && !result.replayed)!;
    if (!saved.ok) throw Error(saved.code);
    expect(saved.revision.content.verifierVersion).toBe("ortho-assessment-payload-2.2.1");
    expect(saved.revision.content.results.every(result => result.result.state === "ready")).toBe(true);
    const bytes = await stored(scope.orthoCaseId);
    expect(bytes).toHaveLength(1);
    expect(await getOrthoAssessment({ ...scope, acceptedSchemas: [2] })).toMatchObject({ ok: true, state: "ready", revision: saved.revision });
    expect(await appendOrthoAssessment({ ...scope, command })).toMatchObject({ ok: true, replayed: true, revision: saved.revision });
    expect(await stored(scope.orthoCaseId)).toEqual(bytes);
    expect(await counts(scope.patientId)).toEqual(before);
  });
  it.each([[4,4.06,5.97,6.469], [4.03,7,7.99,7.981]])("persists genuinely outside-domain %j without a calculated witness", async (...widths) => {
    await f.db.ensureSchema();
    const scope = await setup(), before = await counts(scope.patientId);
    const saved = await appendOrthoAssessment({ ...scope, command: boundaryCommand(widths) });
    if (!saved.ok) throw Error(saved.code);
    expect(saved.revision.content.results.every(result => result.result.state === "outside_supported_predictor_domain")).toBe(true);
    expect(await getOrthoAssessment({ ...scope, acceptedSchemas: [2] })).toMatchObject({ ok: true, revision: saved.revision });
    expect(await counts(scope.patientId)).toEqual(before);
  });
});
