import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { getOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { getOrthoStudyEditor } from "../../lib/ortho-case-study-editor-store";
import { readStudyEditorRead } from "../../lib/ortho-case-study-editor-contract";
import { studyTextPresentation } from "../../lib/ortho-study-text-export";
import { withIllustratedStudy } from "../../lib/ortho-study-illustrated-store";
import { saveConfirmedStudy } from "../helpers/ortho-study-submit";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";
import { openPeriodontalFixture } from "./_periodontal-fixture";

const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, session: SessionPayload;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-capture-context-secret-at-least32");
  f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema();
  const username = `synthetic-capture-${randomUUID()}`, password = "synthetic-only-credential";
  const actor = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic capture author',$2,'admin') RETURNING id", [username, password])).rows[0];
  session = { userId: actor.id, username, role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 };
  request.token = createSessionToken(session);
});
afterAll(async () => { try { await f?.close(); } finally { vi.unstubAllEnvs(); } });
const unaffected = async () => (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM appointments) appointments,(SELECT count(*)::int FROM visits) visits")).rows;

it.each(["completed", "discontinued"] as const)("preserves pre-closure capture through %s, later documentation and a new closed-case study", async status => {
  const patientId = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic historical context') RETURNING id", [randomUUID()])).rows[0].id as number;
  // Synthetic existing treatment with an explicitly recorded retainer; closure
  // still uses the real authority and existing completion guard below.
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,retainer,retainer_on,created_by) VALUES($1,'active','leveling','hawley','2026-01-01',$2) RETURNING id", [patientId, session.username])).rows[0].id as number;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic capture bridge',$2,$3) RETURNING id", [patientId, orthoCaseId, session.username])).rows[0].id as number;
  const owner = { patientId, orthoCaseId, clinicalCaseId, session }, before = await unaffected(), command = syntheticStudyCommand();
  const draft = await saveConfirmedStudy({ ...owner, command }); if (!draft.ok) throw Error(draft.code);
  const original = draft.revision, ref = { id: original.id, contentHash: original.contentHash };
  expect(original.content.caseStatusAtCapture).toBe("active");
  expect(await f.db.closeOrthoCase({ id: orthoCaseId, status, actor: "ignored-input-actor", note: "Synthetic explicit closure" }, { patientId, session })).toEqual({ ok: true });
  const caseState = async () => (await f.pool.query("SELECT to_jsonb(c)::text value FROM ortho_cases c WHERE id=$1", [orthoCaseId])).rows;
  const closed = await caseState();
  expect(JSON.parse(closed[0].value)).toMatchObject({ status, closed_by: session.username });

  const assertOriginal = async (revisionId: number) => {
    const read = await getOrthoStudyEditor({ ...owner, revisionId }); if (!read.ok) throw Error(read.code);
    const checked = readStudyEditorRead(read, owner);
    expect(checked.revision).toMatchObject({ capturedAt: original.content.capturedAt, caseStatusAtCapture: "active", contentHash: original.contentHash });
    const saved = await getOrthoCaseStudy({ ...owner, revisionId, exportAccess: true }); if (!saved.ok || !saved.revision) throw Error("Synthetic saved study unavailable");
    expect(saved.revision.content).toEqual(original.content);
    const presentation = studyTextPresentation(saved.revision, owner);
    const capture = presentation.pages.filter(page => page.title === "سياق التقاط الدراسة المحفوظة");
    expect(capture).toHaveLength(1);
    expect(capture[0].lines.join("\n")).toContain("حالة التقويم عند التقاط الدراسة: جارية");
    expect(capture[0].lines.join("\n")).toContain(original.content.capturedAt);
    const illustrated = await withIllustratedStudy({ ...owner, revisionId }, async value => value.pages.filter(page => page.title === "سياق التقاط الدراسة المحفوظة"));
    expect(illustrated).toMatchObject({ ok: true, output: capture });
  };
  await assertOriginal(original.id);
  const documented = await saveConfirmedStudy({ ...owner, command: { ...command, clientRequestId: randomUUID(), kind: "documented", expectedHead: ref, documentedFrom: ref } });
  if (!documented.ok) throw Error(documented.code);
  expect(documented.revision.contentHash).toBe(original.contentHash);
  expect(documented.revision.content).toEqual(original.content);
  await assertOriginal(documented.revision.id);

  const documentedRef = { id: documented.revision.id, contentHash: documented.revision.contentHash };
  const next = await saveConfirmedStudy({ ...owner, command: { ...command, clientRequestId: randomUUID(), expectedHead: documentedRef, baseDocumentedRevision: documentedRef } });
  if (!next.ok) throw Error(next.code);
  expect(next.revision.content.caseStatusAtCapture).toBe(status);
  expect(Date.parse(next.revision.content.capturedAt)).toBeGreaterThan(Date.parse(original.content.capturedAt));
  const latest = await getOrthoStudyEditor(owner); if (!latest.ok) throw Error(latest.code);
  expect(readStudyEditorRead(latest, owner).revision).toMatchObject({ capturedAt: next.revision.content.capturedAt, caseStatusAtCapture: status });
  const page = studyTextPresentation(next.revision, owner).pages.find(row => row.title === "سياق التقاط الدراسة المحفوظة");
  expect(page?.lines.join("\n")).toContain(`حالة التقويم عند التقاط الدراسة: ${status === "completed" ? "مكتملة" : "متوقّفة"}`);
  await assertOriginal(original.id);
  expect(await caseState()).toEqual(closed);
  expect(await unaffected()).toEqual(before);
});
