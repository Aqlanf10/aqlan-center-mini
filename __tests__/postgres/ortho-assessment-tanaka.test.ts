import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import { appendOrthoAssessment, getOrthoAssessment } from "../../lib/ortho-assessment-store";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { getOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { saveConfirmedStudy as saveOrthoCaseStudy } from "../helpers/ortho-study-submit";
import { studyTextPresentation } from "../../lib/ortho-study-text-export";
import { CASE_TEMPLATE_VERSION } from "../../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../../lib/ortho-case-study-template";
import type { StudySaveCommand, StudySourceSelection } from "../../lib/ortho-case-study";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, n = 0;
beforeAll(async () => { vi.stubEnv("SESSION_SECRET", "synthetic-tanaka-review-secret-at-least32characters"); f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); });
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
async function setup() {
  const seq = ++n, password = "Synthetic credential";
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic mixed analysis') RETURNING id", [`SYN-TANAKA-${seq}`])).rows[0].id;
  const userId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic examiner',$2,'admin') RETURNING id", [`synthetic-tanaka-${seq}`, password])).rows[0].id;
  const session: SessionPayload = { userId, username: `synthetic-tanaka-${seq}`, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 600000 };
  request.token = createSessionToken(session);
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic mixed analysis bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId, session };
}
const counts = async (patientId: number) => (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patientId])).rows;
const stored = async (ortho: number) => (await f.pool.query("SELECT to_jsonb(r)::text AS facts FROM ortho_assessment_revisions r WHERE ortho_case_id=$1 ORDER BY version", [ortho])).rows;

describe("mixed analysis stored once and reused in a saved study", () => {
  it("preserves old2.1, saves2.2.1 and snapshots the saved study without changing money", async () => {
    const scope = await setup(), before = await counts(scope.patientId);
    const old = await appendOrthoAssessment({ ...scope, command: { ...assessmentCommandV2(), commandId: randomUUID() } }); if (!old.ok) throw Error(old.code);
    const oldBytes = (await stored(scope.orthoCaseId))[0];
    const command = { ...tanakaCommandV2(), commandId: randomUUID(), expectedRevisionId: old.revision.id };
    const saved = await appendOrthoAssessment({ ...scope, command }); if (!saved.ok) throw Error(saved.code);
    expect(saved.revision).toMatchObject({ version: 2, content: { verifierVersion: "ortho-assessment-payload-2.2.1" } });
    expect(saved.revision.schemaVersion).toBe(2);
    if (saved.revision.schemaVersion !== 2) throw Error("unsupported fixture");
    expect(saved.revision.content.draft.observations.observations).toHaveLength(35);
    expect((await stored(scope.orthoCaseId))[0]).toEqual(oldBytes);
    expect(await appendOrthoAssessment({ ...scope, command })).toMatchObject({ ok: true, replayed: true });
    expect(await getOrthoAssessment({ ...scope, acceptedSchemas: [2] })).toMatchObject({ ok: true, state: "ready" });
    const sources: StudySourceSelection[] = [];
    for (const kind of ["assessment"] as const) {
      const choices = await getOrthoStudySourceChoices({ ...scope, kind }); if (!choices.ok) throw Error(choices.code);
      sources.push(...choices.choices.filter(c => c.state === "available" && (kind !== "assessment" || c.selection?.id === saved.revision.id)).map(c => c.selection!));
    }
    const studyCommand: StudySaveCommand = { schemaVersion: 1, clientRequestId: randomUUID(), expectedHead: null, baseDocumentedRevision: null,
      kind: "draft", documentedFrom: null, reason: "Synthetic versioned analysis capture", content: {
        template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only",
        sources, groups: [], mediaUses: [], comment: "Synthetic stored predictions and manual review",
        panels: [{ instanceId: "mixed", layoutKey: "model-measurements", included: true, state: "available", sourceKeys: sources.filter(s => s.kind === "assessment").map(s => s.key), images: [], comment: "No new calculation on export" }],
      } };
    const study = await saveOrthoCaseStudy({ ...scope, command: studyCommand }); if (!study.ok) throw Error(study.code);
    const text = studyTextPresentation(study.revision, scope).pages.flatMap(page => page.lines).join("\n");
    expect(text).toContain("المسافة المطلوبة المقدّرة"); expect(text).toContain("74 mm"); expect(text).toContain("-2 mm");
    const correction = structuredClone(command); correction.commandId = randomUUID(); correction.expectedRevisionId = saved.revision.id;
    correction.content.observations.observations.find(r => r.id === "width_11")!.value = { state: "measured", value: 9 };
    const corrected = await appendOrthoAssessment({ ...scope, command: correction }); expect(corrected.ok).toBe(true);
    const reopened = await getOrthoCaseStudy({ ...scope, revisionId: study.revision.id }); if (!reopened.ok) throw Error(reopened.code);
    expect(reopened.revision!.content).toEqual(study.revision.content);
    expect((await stored(scope.orthoCaseId))[0]).toEqual(oldBytes);
    expect(await counts(scope.patientId)).toEqual(before);
  });
  it("admits one of two concurrent first saves and replays without duplicate observations or revisions", async () => {
    const scope = await setup();
    const commands = [0, 1].map(i => ({ ...tanakaCommandV2(), commandId: randomUUID(), reason: `Synthetic contender${i}` }));
    const results = await Promise.all(commands.map(command => appendOrthoAssessment({ ...scope, command })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ ok: false, code: "head_changed" });
    const accepted = results.findIndex(r => r.ok);
    expect(await appendOrthoAssessment({ ...scope, command: commands[accepted] })).toMatchObject({ ok: true, replayed: true });
    expect(await stored(scope.orthoCaseId)).toHaveLength(1);
  });
  it("refuses a deactivated author without persisting a new prediction", async () => {
    const scope = await setup(); await f.pool.query("UPDATE users SET is_active=false WHERE id=$1", [scope.session.userId]);
    const saved = await appendOrthoAssessment({ ...scope, command: { ...tanakaCommandV2(), commandId: randomUUID() } });
    expect(saved.ok).toBe(false); expect(await stored(scope.orthoCaseId)).toEqual([]);
  });
});
