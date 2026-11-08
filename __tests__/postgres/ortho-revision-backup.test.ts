import { saveConfirmedStudy as saveOrthoCaseStudy } from "../helpers/ortho-study-submit";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openOrthoAssessment, startOrthoTreatment } from "../../lib/ortho-assessment-intake-store";
import { appendOrthoAssessment, getOrthoAssessment } from "../../lib/ortho-assessment-store";
import { appendOrthoTreatmentStrategy, getOrthoTreatmentStrategy } from "../../lib/ortho-treatment-strategy-store";
import type { StrategyCommand } from "../../lib/ortho-treatment-strategy";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";

import { getOrthoCaseStudy } from "../../lib/ortho-case-study-store";
import { getOrthoStudySourceChoices } from "../../lib/ortho-case-study-inventory";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";

const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }),
  headers: async () => new Headers(),
}));
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import("../../lib/db"), directory: string, actor: SessionPayload;
let owner: { patientId: number; orthoCaseId: number; clinicalCaseId: number; session: SessionPayload };
let a: ReturnType<typeof assessmentCommandV2>, s: StrategyCommand;
let originalAssessment: Awaited<ReturnType<typeof appendOrthoAssessment>>;
let studyCommand: ReturnType<typeof syntheticStudyCommand>;
let originalStudy: Awaited<ReturnType<typeof saveOrthoCaseStudy>>;
let documentedStudy: Awaited<ReturnType<typeof saveOrthoCaseStudy>>;
let originalStrategy: Awaited<ReturnType<typeof appendOrthoTreatmentStrategy>>;
const intakeCommand = { schemaVersion: 1, clientRequestId: "synthetic_backup_intake_0001", reason: "Synthetic diagnostic identity" };
let intakePatientId: number;
let originalIntake: Awaited<ReturnType<typeof openOrthoAssessment>>;
let adjustmentCommand: Parameters<typeof import("../../lib/db").recordAdjustment>[0];
let originalAdjustmentId: number;
let visitAdjustmentCommand: Parameters<typeof import("../../lib/db").recordAdjustment>[0];
let originalVisitAdjustmentId: number;
const originalUrl = process.env.DATABASE_URL, originalSeed = process.env.SKIP_SEED;
async function rows(pool: Pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) result[tablename] = (await pool.query(`SELECT to_jsonb(t)::text AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "ortho-backup-synthetic-secret-at-least-32-characters");
  fixture = await openBackupTimestampFixture(process.env);
  directory = await mkdtemp(join(tmpdir(), "ortho-revision-backup-"));
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = "true";
  db = await import("../../lib/db"); await db.resetPoolForTesting(); await db.ensureSchema();
  const patient = (await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-ORTHO-BACKUP','Synthetic Ortho backup') RETURNING id")).rows[0].id;
  const user = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-ortho-backup','Synthetic backup recorder','synthetic-hash','admin') RETURNING id")).rows[0].id;
  actor = { userId: user, username: "synthetic-ortho-backup", role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-hash") };
  request.token = createSessionToken(actor);
  const activeCase = (await fixture.source.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','active') RETURNING id", [patient])).rows[0].id;
  adjustmentCommand = { caseId: activeCase, visitId: null, doneOn: "2026-10-02", phase: null,
    upperWire: "016 NiTi", lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic backed-up adjustment",
    nextWeeks: 4, note: null, recordedBy: actor.username, actorRole: actor.role,
    request: { key: "synthetic-ortho-backup-adjustment-001", patientId: patient, session: actor } };
  const adjustment = await db.recordAdjustment(adjustmentCommand);
  if (!adjustment.ok) throw new Error(adjustment.message);
  originalAdjustmentId = adjustment.id;
  const visit = (await fixture.source.query("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic backed-up visit') RETURNING id", [patient])).rows[0].id;
  visitAdjustmentCommand = { ...adjustmentCommand, visitId: visit,
    request: { key: "synthetic-ortho-backup-visit-adjustment-001", patientId: patient, session: actor } };
  const visitAdjustment = await db.recordAdjustment(visitAdjustmentCommand);
  if (!visitAdjustment.ok) throw new Error(visitAdjustment.message);
  originalVisitAdjustmentId = visitAdjustment.id;
  const otherPatient = (await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-ORTHO-BACKUP-OTHER','Synthetic other patient') RETURNING id")).rows[0].id;
  expect(await db.linkVisitToPatient(visit, otherPatient)).toMatchObject({ ok: false });
  expect(await db.linkVisitToPatient(visit, patient)).toMatchObject({ ok: true });
  const ortho = (await fixture.source.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [patient])).rows[0].id;
  const clinical = (await fixture.source.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic explicit bridge',$2,'synthetic') RETURNING id", [patient, ortho])).rows[0].id;
  const problem = (await fixture.source.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'Synthetic problem','synthetic') RETURNING id", [patient, clinical])).rows[0].id;
  owner = { patientId: patient, orthoCaseId: ortho, clinicalCaseId: clinical, session: actor };
  a = assessmentCommandV2(); a.commandId = "synthetic_backup_assessment_0001";
  s = { schemaVersion: 1, commandId: "synthetic_backup_strategy_0001", expectedRevisionId: null, reason: "Synthetic reviewed plan", rows: [{ problemId: problem, objective: "Synthetic objective", strategy: "Doctor-authored strategy", rationale: null, planItemIds: [] }] };
  originalAssessment = await appendOrthoAssessment({ ...owner, command: a });
  originalStrategy = await appendOrthoTreatmentStrategy({ ...owner, command: s });
  if (!originalAssessment.ok || !originalStrategy.ok) throw new Error("Synthetic original revision was refused");
  const a2 = assessmentCommandV2(); a2.commandId = "synthetic_backup_assessment_0002"; a2.expectedRevisionId = originalAssessment.revision.id;
  expect(await appendOrthoAssessment({ ...owner, command: a2 })).toMatchObject({ ok: true, revision: { version: 2 } });
  expect(await appendOrthoTreatmentStrategy({ ...owner, command: { ...s, commandId: "synthetic_backup_strategy_0002", expectedRevisionId: originalStrategy.revision.revisionId } })).toMatchObject({ ok: true, revision: { version: 2 } });
  studyCommand = syntheticStudyCommand();
  for (const kind of ["assessment", "strategy"] as const) {
    const inventory = await getOrthoStudySourceChoices({ ...owner, kind });
    if (!inventory.ok || inventory.state !== "available") throw Error("Synthetic study sources unavailable");
    const selection = inventory.choices.find(row => row.version === 1)?.selection;
    if (!selection) throw Error("Synthetic historical source missing");
    studyCommand.content.sources.push(selection);
  }
  studyCommand.content.panels[0] = { ...studyCommand.content.panels[0], state: "available",
    sourceKeys: studyCommand.content.sources.map(source => source.key) };
  originalStudy = await saveOrthoCaseStudy({ ...owner, command: studyCommand });
  if (!originalStudy.ok) throw Error(originalStudy.code);
  const studyRef = { id: originalStudy.revision.id, contentHash: originalStudy.revision.contentHash };
  documentedStudy = await saveOrthoCaseStudy({ ...owner, command: { ...studyCommand,
    clientRequestId: "synthetic_backup_study_documented_0001", expectedHead: studyRef, documentedFrom: studyRef, kind: "documented" } });
  if (!documentedStudy.ok) throw Error(documentedStudy.code);
  expect(documentedStudy.revision.content).toEqual(originalStudy.revision.content);
  // Deferred self-FKs and history checks must restore correctly even in reverse heap order.
  await fixture.source.query("CREATE INDEX synthetic_study_reverse ON ortho_case_study_revisions(ortho_case_id,version DESC); CLUSTER ortho_case_study_revisions USING synthetic_study_reverse; DROP INDEX synthetic_study_reverse");
  expect((await fixture.source.query("SELECT version FROM ortho_case_study_revisions")).rows.map(row => row.version)).toEqual([2, 1]);
  for (const stem of ["assessment", "strategy"]) {
    // Reverse physical order without disabling constraints or revision guards.
    await fixture.source.query(`CREATE INDEX synthetic_${stem}_reverse ON ortho_${stem}_revisions(ortho_case_id,version DESC); CLUSTER ortho_${stem}_revisions USING synthetic_${stem}_reverse; DROP INDEX synthetic_${stem}_reverse`);
    expect((await fixture.source.query(`SELECT version FROM ortho_${stem}_revisions`)).rows.map(row => row.version)).toEqual([2, 1]);
  }
  intakePatientId = (await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-ORTHO-BACKUP-INTAKE','Synthetic intake backup') RETURNING id")).rows[0].id;
  originalIntake = await openOrthoAssessment({ patientId: intakePatientId, session: actor, command: intakeCommand });
  if (!originalIntake.ok) throw Error(originalIntake.code);
  expect(await startOrthoTreatment({ patientId: intakePatientId, session: actor, orthoCaseId: originalIntake.orthoCaseId,
    command: { schemaVersion: 1, clientRequestId: "synthetic_backup_start_0001", reason: "Synthetic explicit treatment start", confirmed: true,
      appliance: "aligners", arches: "upper", slot: null, startDate: "2026-10-01", plannedMonths: 12, bracketSystem: "" } })).toMatchObject({ ok: true });
  const client = await fixture.source.connect();
  try {
    let sql = ""; for await (const line of db.backupSqlLines(client)) sql += line;
    await writeFile(join(directory, "synthetic-backup.sql"), sql);
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic documents expected"); } })) blocks.push(block);
    await writeFile(join(directory, "synthetic-full-backup.tar.gz"), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
});
afterAll(async () => {
  try { await db?.resetPoolForTesting(); } finally {
    process.env.DATABASE_URL = originalUrl; process.env.SKIP_SEED = originalSeed;
    await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

async function verifyRestored(pool: Pool) {
  if (!originalStudy.ok || !documentedStudy.ok) throw Error("Missing synthetic study fixture");
  expect(await getOrthoCaseStudy(owner)).toMatchObject({ ok: true, revision: documentedStudy.revision,
    history: [{ version: 1 }, { version: 2 }] });
  expect(await getOrthoCaseStudy({ ...owner, revisionId: originalStudy.revision.id })).toMatchObject({ ok: true, revision: originalStudy.revision });
  expect(await saveOrthoCaseStudy({ ...owner, command: studyCommand })).toEqual({ ...originalStudy, replayed: true });
  expect(await openOrthoAssessment({ patientId: intakePatientId, session: actor, command: intakeCommand })).toEqual({ ...originalIntake, mode: "replayed" });
  expect(await rows(pool)).toEqual(await rows(fixture.source));
  // All durable source witnesses, immutable recorder/patient provenance and the
  // original (now non-head) command must remain valid after physical reordering.
  expect(await appendOrthoAssessment({ ...owner, command: a })).toEqual({ ...originalAssessment, replayed: true });
  expect(await appendOrthoTreatmentStrategy({ ...owner, command: s })).toEqual({ ...originalStrategy, replayed: true });
  expect(await db.recordAdjustment(adjustmentCommand)).toMatchObject({ ok: true, id: originalAdjustmentId,
    created: false, replayed: true, visitId: null });
  expect(await db.recordAdjustment(visitAdjustmentCommand)).toMatchObject({ ok: true, id: originalVisitAdjustmentId,
    created: false, replayed: true, visitId: visitAdjustmentCommand.visitId });
  expect(await getOrthoAssessment({ ...owner, acceptedSchemas: [2] })).toMatchObject({ ok: true, history: [{ version: 2 }, { version: 1 }] });
  expect(await getOrthoTreatmentStrategy(owner)).toMatchObject({ ok: true, history: [{ version: 2 }, { version: 1 }] });
  expect(await rows(pool)).toEqual(await rows(fixture.source));
}
it("supported SQL restore preserves reverse-physical revision chains and exact old-command replay", async () => {
  process.env.DATABASE_URL = fixture.sqlTarget.options.connectionString!;
  await db.resetPoolForTesting(); await db.ensureSchema();
  const restored = await promisify(execFile)(process.execPath, ["scripts/restore.mjs", join(directory, "synthetic-backup.sql")], { env: { ...process.env } });
  expect(restored.stdout).toContain("تمت الاستعادة");
  await verifyRestored(fixture.sqlTarget);
});
it("actual full archive restore preserves the same chains and command/content fingerprints", async () => {
  const result = await stagedRestore({ archivePath: join(directory, "synthetic-full-backup.tar.gz"), targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, "restored-documents") });
  expect(result).toMatchObject({ ok: true, errors: [], validationErrors: [] });
  process.env.DATABASE_URL = fixture.archiveTarget.options.connectionString!;
  await db.resetPoolForTesting();
  await verifyRestored(fixture.archiveTarget);
});
