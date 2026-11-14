import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import type { DbClient, DbPool } from "../../lib/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ProtectedOrthoStudyHistoryError, ProtectedPatientNumberHistoryError } from "../../lib/clinic-reset";
import { ORTHO_STUDY_SUBMISSION_SQL } from "../../lib/ortho-study-submission-schema";
import { openPeriodontalFixture } from "./_periodontal-fixture";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let actorId: number;
const fingerprint = "a".repeat(64);
const command = { kind: "draft", content: { comment: "Synthetic recovery payload" } };
type Scope = { patientId: number; orthoCaseId: number; clinicalCaseId: number };
type Executor = DbPool | DbClient;
beforeAll(async () => {
  f = await openPeriodontalFixture(process.env, { pristine: true });
  await f.db.ensureSchema();
  actorId = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic recorder','synthetic-not-a-secret','admin') RETURNING id", [randomUUID()])).rows[0].id;
});
afterAll(async () => { await f?.close(); });
async function patient() {
  return (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic submission patient') RETURNING id", [randomUUID()])).rows[0].id as number;
}
async function scope(): Promise<Scope> {
  const patientId = await patient();
  const orthoCaseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id;
  return { patientId, orthoCaseId, clinicalCaseId };
}
async function submit(owner: Scope, options: {
  state?: "pending" | "committed" | "cancelled"; commandId?: string; revisionId?: number; tombstone?: boolean; ack?: boolean;
} = {}, client: Executor = f.pool) {
  const state = options.state ?? "pending", commandId = options.commandId ?? randomUUID();
  const row = (await client.query(`INSERT INTO ortho_study_submissions
    (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,
      command,previous_version,state,revision_id,settled_at,acknowledged_at)
    VALUES($1,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,
      CASE WHEN $9='pending' THEN NULL ELSE clock_timestamp() END,
      CASE WHEN $11 THEN clock_timestamp() ELSE NULL END) RETURNING *`,
  [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, actorId, commandId, fingerprint,
    options.tombstone || options.ack ? null : JSON.stringify(command), options.tombstone ? null : 0,
    state, options.revisionId ?? null, options.ack ?? false])).rows[0];
  return row as { id: number; command_id: string; request_fingerprint: string; recorded_patient_id: number };
}
async function revision(owner: Scope, commandId: string, options: { id?: number; hash?: string; actor?: number; recordedPatient?: number } = {}, client: Executor = f.pool) {
  return (await client.query(`INSERT INTO ortho_case_study_revisions
    (id,patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,kind,version,actor_user_id,reason,
      command_id,request_fingerprint,content_sha256,content)
    VALUES(COALESCE($1,nextval('ortho_case_study_revisions_id_seq')),$2,$3,$4,$5,'draft',1,$6,'Synthetic draft',$7,$8,$8,'{}') RETURNING id`,
  [options.id ?? null, owner.patientId, options.recordedPatient ?? owner.patientId, owner.orthoCaseId,
    owner.clinicalCaseId, options.actor ?? actorId, commandId, options.hash ?? fingerprint])).rows[0].id as number;
}
async function transaction(run: (client: DbClient) => Promise<void>) {
  const client = await f.pool.connect();
  try { await client.query("BEGIN"); await run(client); await client.query("COMMIT"); }
  finally { await client.query("ROLLBACK"); client.release(); }
}
async function ack(id: number) {
  await f.pool.query("UPDATE ortho_study_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1", [id]);
}
async function expectResetBlocked() {
  let backed = false;
  await expect(f.db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, async () => {
    backed = true; return { ok: false, failure: "must not reach backup" };
  })).rejects.toBeInstanceOf(ProtectedOrthoStudyHistoryError);
  expect(backed).toBe(false);
}

it("registers exact migration provenance and allows an empty fenced reset", async () => {
  expect(readFileSync("migrations/0112_ortho_study_submissions.sql", "utf8")).toBe(ORTHO_STUDY_SUBMISSION_SQL);
  expect((await f.pool.query("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0112'")).rows).toEqual([{
    name: "ortho_study_submissions", checksum: createHash("sha256").update(ORTHO_STUDY_SUBMISSION_SQL).digest("hex"), adopted: false,
  }]);
  let backed = false;
  const reset = await f.db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, async () => {
    backed = true; return { ok: true, backupId: "synthetic-empty-history-reset" };
  });
  expect(reset).toMatchObject({ ok: true, counts: { patients: 0 } }); expect(backed).toBe(true);
  // With a patient file present the patient-number protection refuses before backup.
  await scope(); let reached = false;
  await expect(f.db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, async () => {
    reached = true; return { ok: true, backupId: "must-not-reach" };
  })).rejects.toBeInstanceOf(ProtectedPatientNumberHistoryError);
  expect(reached).toBe(false);
});
it("serializes an empty-history reset behind an in-flight generic patient merge", async () => {
  const owner = await scope(), target = await patient(), blocker = await f.pool.connect();
  let merge: Promise<unknown> | undefined, reset: Promise<unknown> | undefined;
  try {
    await blocker.query("SELECT pg_advisory_lock(744112)");
    await f.pool.query(`CREATE FUNCTION synthetic_study_pause_merge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(744112); RETURN NEW; END $$;
      CREATE TRIGGER synthetic_study_pause_merge BEFORE UPDATE OF patient_id ON clinical_cases
      FOR EACH ROW WHEN (OLD.patient_id=${owner.patientId}) EXECUTE FUNCTION synthetic_study_pause_merge()`);
    merge = f.db.mergeDuplicatePatient(owner.patientId, target, { actor: "synthetic" }).catch(error => error);
    await expect.poll(async () => (await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE clinical_cases SET patient_id%') waiting")).rows[0].waiting, { timeout: 5000 }).toBe(true);
    reset = f.db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, async () => ({ ok: false, failure: "synthetic backup declined" })).catch(error => error);
    await expect.poll(async () => (await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%') waiting")).rows[0].waiting, { timeout: 5000 }).toBe(true);
    await blocker.query("SELECT pg_advisory_unlock(744112)");
    expect(await merge).toMatchObject({ ok: true });
    // The reset waited behind the merge; it then meets the merged patient files and refuses before backup.
    expect(await reset).toBeInstanceOf(ProtectedPatientNumberHistoryError);
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(744112)"); blocker.release();
    await Promise.all([merge, reset]);
    await f.pool.query("DROP TRIGGER IF EXISTS synthetic_study_pause_merge ON clinical_cases; DROP FUNCTION IF EXISTS synthetic_study_pause_merge()");
  }
});
it("protects pending, cancelled and acknowledged submissions from reset before backup even without revisions", async () => {
  const s = await submit(await scope());
  expect((await f.pool.query("SELECT count(*)::int n FROM ortho_case_study_revisions")).rows[0].n).toBe(0);
  await expectResetBlocked();
  await f.pool.query("UPDATE ortho_study_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1", [s.id]);
  await expectResetBlocked(); await ack(s.id); await expectResetBlocked();
});
it("preserves immutable identity, predecessor version and payload and rejects erasure", async () => {
  const owner = await scope(), s = await submit(owner);
  for (const change of ["id=id+100000", "recorded_patient_id=recorded_patient_id+1", "ortho_case_id=ortho_case_id+1",
    "clinical_case_id=clinical_case_id+1", "actor_user_id=actor_user_id+1", "command_id='changed_command_1234'",
    "request_fingerprint=repeat('b',64)", "previous_version=1", "created_at=created_at+interval '1 second'", "command='{}'"]) {
    await expect(f.pool.query(`UPDATE ortho_study_submissions SET ${change} WHERE id=$1`, [s.id])).rejects.toThrow(/immutable/);
  }
  await expect(f.pool.query("DELETE FROM ortho_study_submissions WHERE id=$1", [s.id])).rejects.toThrow(/cannot be erased/);
  await expect(f.pool.query("TRUNCATE ortho_study_submissions")).rejects.toThrow(/cannot be erased/);
  await expect(ack(s.id)).rejects.toThrow(/cannot be acknowledged/);
  await expect(f.pool.query("UPDATE ortho_study_submissions SET patient_id=$2 WHERE id=$1", [s.id, await patient()])).rejects.toThrow(/ownership/);
  await expect(f.pool.query("UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1", [owner.clinicalCaseId])).rejects.toThrow(/ownership/);
});
it("settles a pending command atomically and keeps terminal outcomes blocking until payload-clearing acknowledgement", async () => {
  const owner = await scope(), s = await submit(owner);
  let revisionId = 0;
  await transaction(async client => {
    revisionId = await revision(owner, s.command_id, {}, client);
    await client.query("UPDATE ortho_study_submissions SET state='committed',revision_id=$2,settled_at=clock_timestamp() WHERE id=$1", [s.id, revisionId]);
  });
  await expect(submit(owner)).rejects.toMatchObject({ code: "23505" });
  await expect(f.pool.query("UPDATE ortho_study_submissions SET acknowledged_at=clock_timestamp() WHERE id=$1", [s.id])).rejects.toMatchObject({ code: "23514" });
  for (const change of ["state='pending',revision_id=NULL,settled_at=NULL", "state='cancelled',revision_id=NULL", "revision_id=revision_id+1", "settled_at=settled_at+interval '1 second'"]) {
    await expect(f.pool.query(`UPDATE ortho_study_submissions SET ${change} WHERE id=$1`, [s.id])).rejects.toThrow(/cannot be changed or reopened/);
  }
  await ack(s.id);
  expect((await f.pool.query("SELECT command,request_fingerprint,revision_id FROM ortho_study_submissions WHERE id=$1", [s.id])).rows[0]).toEqual({ command: null, request_fingerprint: fingerprint, revision_id: revisionId });
  await expect(f.pool.query("UPDATE ortho_study_submissions SET acknowledged_at=NULL WHERE id=$1", [s.id])).rejects.toThrow(/acknowledgement is immutable/);
  await expect(f.pool.query("UPDATE ortho_study_submissions SET command='{}' WHERE id=$1", [s.id])).rejects.toThrow(/payload is immutable/);
  await expect(submit(owner, { commandId: s.command_id })).rejects.toMatchObject({ code: "23505" });
  await expect(submit(owner)).resolves.toMatchObject({ request_fingerprint: fingerprint });
});
it("keeps cancellation tombstones permanent and prevents a late revision even after acknowledgement", async () => {
  const owner = await scope(), s = await submit(owner, { state: "cancelled", tombstone: true });
  expect((await f.pool.query("SELECT command,previous_version,revision_id FROM ortho_study_submissions WHERE id=$1", [s.id])).rows[0]).toEqual({ command: null, previous_version: null, revision_id: null });
  await expect(submit(owner)).rejects.toMatchObject({ code: "23505" });
  await expect(revision(owner, s.command_id)).rejects.toThrow(/Uncommitted study submission/);
  await ack(s.id);
  await expect(revision(owner, s.command_id)).rejects.toThrow(/Uncommitted study submission/);
  await expect(f.pool.query("UPDATE ortho_study_submissions SET state='pending',command='{}',previous_version=0,settled_at=NULL,acknowledged_at=NULL WHERE id=$1", [s.id])).rejects.toThrow();
  // Cancelled metadata may retain its recorded bridge without permanently freezing it.
  await f.pool.query("UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1", [owner.clinicalCaseId]);
  await expect(submit(owner, { commandId: s.command_id, state: "cancelled", tombstone: true, ack: true })).rejects.toMatchObject({ code: "23505" });
});
it("validates state shape and bounded command data", async () => {
  const owner = await scope();
  for (const [payload, previous, state] of [[null, 0, "pending"], [command, null, "pending"], [[], 0, "pending"],
    [command, -1, "pending"], [command, 0, "unknown"], [{ data: "x".repeat(2097152) }, 0, "pending"]]) {
    await expect(f.pool.query(`INSERT INTO ortho_study_submissions
      (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,previous_version,state)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, actorId, randomUUID(), fingerprint,
      payload === null ? null : JSON.stringify(payload), previous, state])).rejects.toMatchObject({ code: "23514" });
  }
});
it("allows reverse physical restore but rejects a missing or mismatched committed revision", async () => {
  const owner = await scope(), commandId = randomUUID();
  const revisionId = (await f.pool.query("SELECT nextval('ortho_case_study_revisions_id_seq')::int id")).rows[0].id;
  await transaction(async client => {
    await submit(owner, { state: "committed", commandId, revisionId, ack: true }, client);
    await revision(owner, commandId, { id: revisionId }, client);
  });
  const missing = await scope();
  await expect(submit(missing, { state: "committed", revisionId: 999999 })).rejects.toThrow();
  for (const mismatch of ["fingerprint", "actor", "command", "case", "previous_version"] as const) {
    const target = await scope(), key = randomUUID();
    await expect(transaction(async client => {
      const revOwner = mismatch === "case" ? await scope() : target;
      const id = await revision(revOwner, mismatch === "command" ? randomUUID() : key, {
        hash: mismatch === "fingerprint" ? "b".repeat(64) : undefined,
        actor: mismatch === "actor" ? (await client.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic alternate','x','doctor') RETURNING id", [randomUUID()])).rows[0].id : undefined,
      }, client);
      const row = await submit(target, { state: "committed", commandId: key, revisionId: id }, client);
      if (mismatch === "previous_version") await client.query("UPDATE ortho_study_submissions SET previous_version=1 WHERE id=$1", [row.id]);
    })).rejects.toThrow();
  }
});
it.each(["source", "target"] as const)("refuses merges with any unacknowledged submission on the %s", async side => {
  const owner = await scope(), other = await patient(), s = await submit(owner);
  const ids = side === "source" ? [owner.patientId, other] : [other, owner.patientId];
  for (const state of ["pending", "cancelled"] as const) {
    if (state === "cancelled") await f.pool.query("UPDATE ortho_study_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1", [s.id]);
    expect(await f.db.mergeDuplicatePatient(ids[0], ids[1], { actor: "synthetic" })).toEqual({ ok: false, reason: "source_has_clinical_command_history", counts: { orthoStudySubmissions: 1 } });
    expect((await f.pool.query("SELECT id FROM patients WHERE id=ANY($1::int[])", [ids])).rows).toHaveLength(2);
  }
  await ack(s.id);
  expect(await f.db.mergeDuplicatePatient(ids[0], ids[1], { actor: "synthetic" })).toMatchObject({ ok: true });
  expect((await f.pool.query("SELECT patient_id,recorded_patient_id,command FROM ortho_study_submissions WHERE id=$1", [s.id])).rows[0]).toEqual({ patient_id: ids[1], recorded_patient_id: owner.patientId, command: null });
});
it("moves acknowledged committed metadata and revisions together while preserving recorded identity", async () => {
  const owner = await scope(), target = await patient(), key = randomUUID(); let submissionId = 0;
  await transaction(async client => {
    const id = await revision(owner, key, {}, client);
    submissionId = (await submit(owner, { state: "committed", commandId: key, revisionId: id, ack: true }, client)).id;
  });
  expect(await f.db.mergeDuplicatePatient(owner.patientId, target, { actor: "synthetic" })).toMatchObject({ ok: true,
    moved: { "ortho_case_study_revisions.patient_id": 1, "ortho_study_submissions.patient_id": 1 } });
  expect((await f.pool.query("SELECT patient_id,recorded_patient_id,command FROM ortho_study_submissions WHERE id=$1", [submissionId])).rows[0]).toEqual({ patient_id: target, recorded_patient_id: owner.patientId, command: null });
});
it("holds reset behind the fixed revision-then-submission writer fence and refuses after the submission commits", async () => {
  const owner = await scope(), writer = await f.pool.connect();
  let reset: Promise<unknown> | undefined; let backed = false;
  try {
    await writer.query("BEGIN");
    await writer.query("LOCK TABLE ortho_case_study_revisions, ortho_study_submissions IN ROW EXCLUSIVE MODE");
    await writer.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [owner.patientId]);
    await submit(owner, {}, writer);
    reset = f.db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, async () => {
      backed = true; return { ok: false, failure: "must not back up" };
    }).catch(error => error);
    await expect.poll(async () => (await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE ortho_case_study_revisions%') waiting")).rows[0].waiting, { timeout: 5000 }).toBe(true);
    await writer.query("COMMIT");
    expect(await reset).toBeInstanceOf(ProtectedOrthoStudyHistoryError); expect(backed).toBe(false);
  } finally { await writer.query("ROLLBACK"); writer.release(); await reset; }
});

it.each(["cancel", "revision"] as const)("serializes direct late revision/tombstone commits when %s commits first", async first => {
  const owner = await scope(), key = randomUUID(), leader = await f.pool.connect();
  let follower: Promise<unknown> | undefined;
  try {
    await leader.query("BEGIN");
    if (first === "cancel") await submit(owner, { state: "cancelled", tombstone: true, commandId: key }, leader);
    else await revision(owner, key, {}, leader);
    await leader.query("SET CONSTRAINTS ALL IMMEDIATE");
    follower = transaction(async client => {
      if (first === "cancel") await revision(owner, key, {}, client);
      else await submit(owner, { state: "cancelled", tombstone: true, commandId: key }, client);
    }).then(() => "unexpected success", error => error);
    await expect.poll(async () => (await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory') waiting")).rows[0].waiting, { timeout: 5000 }).toBe(true);
    await leader.query("COMMIT");
    expect(await follower).toMatchObject({ code: "23514" });
    expect((await f.pool.query("SELECT count(*)::int n FROM ortho_study_submissions WHERE ortho_case_id=$1", [owner.orthoCaseId])).rows[0].n).toBe(first === "cancel" ? 1 : 0);
    expect((await f.pool.query("SELECT count(*)::int n FROM ortho_case_study_revisions WHERE ortho_case_id=$1", [owner.orthoCaseId])).rows[0].n).toBe(first === "revision" ? 1 : 0);
  } finally { await leader.query("ROLLBACK"); leader.release(); await follower; }
});

it("journals a legacy replay after canonical merge without changing either recorded identity", async () => {
  const original = await scope(), target = await patient(), key = randomUUID();
  const id = await revision(original, key);
  expect(await f.db.mergeDuplicatePatient(original.patientId, target, { actor: "synthetic" })).toMatchObject({ ok: true });
  const s = await submit({ ...original, patientId: target }, { state: "committed", revisionId: id, commandId: key });
  expect(s.recorded_patient_id).toBe(target);
  expect((await f.pool.query("SELECT patient_id,recorded_patient_id FROM ortho_case_study_revisions WHERE id=$1", [id])).rows[0]).toEqual({ patient_id: target, recorded_patient_id: original.patientId });
  await ack(s.id);
});

it("round-trips all submission states and precise metadata through a real full backup and fresh local restore", async () => {
  const state = async () => ({
    submissions: (await f.pool.query("SELECT to_jsonb(s)::text snapshot FROM ortho_study_submissions s ORDER BY id")).rows,
    revisions: (await f.pool.query("SELECT to_jsonb(r)::text snapshot FROM ortho_case_study_revisions r ORDER BY id")).rows,
  });
  const expected = await state();
  expect(expected.submissions.length).toBeGreaterThan(10);
  const directory = await mkdtemp(path.join(tmpdir(), "aqlan-study-submission-restore-"));
  try {
    const archivePath = path.join(directory, "synthetic-full.tar.gz"), source = await f.pool.connect();
    try {
      await pipeline(Readable.from(fullBackupBlocks({ source, readDocument: async () => {
        throw new Error("This synthetic study fixture has no external documents");
      } })), createGzip(), createWriteStream(archivePath));
    } finally { source.release(); }
    await f.close();
    f = await openPeriodontalFixture(process.env, { pristine: true });
    const restored = await stagedRestore({ archivePath, targetUrl: f.url, stagingDir: path.join(directory, "synthetic-documents") });
    expect(restored.errors).toEqual([]);
    expect(restored.ok).toBe(true);
    expect(restored.migrationsApplied).toContain("0112");
    expect(await state()).toEqual(expected);
    const tombstone = (await f.pool.query("SELECT * FROM ortho_study_submissions WHERE state='cancelled' AND acknowledged_at IS NOT NULL AND previous_version IS NULL LIMIT 1")).rows[0];
    await expect(revision({ patientId: tombstone.patient_id, orthoCaseId: tombstone.ortho_case_id, clinicalCaseId: tombstone.clinical_case_id }, tombstone.command_id)).rejects.toThrow();
    expect(await state()).toEqual(expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
