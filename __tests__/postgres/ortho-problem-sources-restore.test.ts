import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { appendOrthoProblemSource, getOrthoProblemSources } from "../../lib/ortho-problem-source-store";
import type { ProblemSourceCommand, ProblemSourceReceipt } from "../../lib/ortho-problem-sources";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: (key: string) => key === "aqlan_flow_session" ? { value: request.token } : undefined }) }));
let f: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import("../../lib/db"), directory: string;
let scope: { patientId: number; orthoCaseId: number; clinicalCaseId: number; session: SessionPayload }, original: ProblemSourceCommand, receipt: ProblemSourceReceipt;
const rows = async (pool: Pool) => ({ problems: (await pool.query("SELECT to_jsonb(t)::text value FROM patient_problems t ORDER BY id")).rows, reviews: (await pool.query("SELECT to_jsonb(t)::text value FROM ortho_problem_source_reviews t ORDER BY id")).rows });
beforeAll(async () => {
  f = await openBackupTimestampFixture({ ...process.env }); directory = await mkdtemp(join(tmpdir(), "ortho-problem-restore-"));
  vi.stubEnv("DATABASE_URL", f.source.options.connectionString!); vi.stubEnv("SKIP_SEED", "true"); vi.stubEnv("SESSION_SECRET", "synthetic-orthodontic-source-restore-secret");
  db = await import("../../lib/db"); await db.resetPoolForTesting(); await db.ensureSchema();
  const password = "synthetic-restore-credential", userId = (await f.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-source-restore','Synthetic reviewer',$1,'admin') RETURNING id", [password])).rows[0].id;
  const session: SessionPayload = { userId, username: "synthetic-source-restore", role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion(password) }; request.token = createSessionToken(session);
  const patientId = (await f.source.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-SOURCE-RESTORE','Synthetic source restore') RETURNING id")).rows[0].id;
  const orthoCaseId = (await f.source.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','active') RETURNING id", [patientId])).rows[0].id;
  const clinicalCaseId = (await f.source.query("INSERT INTO clinical_cases(patient_id,ortho_case_id,specialty,title,created_by) VALUES($1,$2,'orthodontics','Synthetic bridge','synthetic') RETURNING id", [patientId, orthoCaseId])).rows[0].id; scope = { patientId, orthoCaseId, clinicalCaseId, session };
  await f.source.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,1,$3::jsonb,'synthetic')", [patientId, orthoCaseId, JSON.stringify({ skeletal: "Synthetic saved diagnosis" })]);
  const first = await getOrthoProblemSources(scope); if (!first.ok) throw Error(first.code);
  original = { schemaVersion: 1, commandId: randomUUID(), source: first.candidates[0].ref, expectedReviewId: null, action: "create", problemId: null, label: "Synthetic reviewed problem", reason: "Synthetic initial review", clinicianReviewed: true };
  const saved = await appendOrthoProblemSource({ ...scope, command: original }); if (!saved.ok) throw Error(saved.code); receipt = saved;
  await f.source.query("INSERT INTO patient_diagnoses(patient_id,ortho_case_id,version,content,created_by) VALUES($1,$2,2,$3::jsonb,'synthetic')", [patientId, orthoCaseId, JSON.stringify({ skeletal: "Synthetic corrected diagnosis" })]);
  const latest = await getOrthoProblemSources(scope); if (!latest.ok) throw Error(latest.code);
  expect(await appendOrthoProblemSource({ ...scope, command: { ...original, commandId: randomUUID(), source: latest.candidates[0].ref, expectedReviewId: saved.reviewId, action: "link", problemId: saved.problemId, label: null, reason: "Synthetic explicit correction review" } })).toMatchObject({ ok: true });
  await f.source.query("CREATE INDEX synthetic_source_reverse ON ortho_problem_source_reviews(id DESC); CLUSTER ortho_problem_source_reviews USING synthetic_source_reverse; DROP INDEX synthetic_source_reverse");
  const client = await f.source.connect();
  try {
    let sql = ""; for await (const line of db.backupSqlLines(client)) sql += line; await writeFile(join(directory, "backup.sql"), sql);
    const blocks: Uint8Array[] = []; for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw Error("No files in this synthetic case"); } })) blocks.push(block);
    await writeFile(join(directory, "backup.tar.gz"), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
});
afterAll(async () => { try { await db?.resetPoolForTesting(); } finally { vi.unstubAllEnvs(); await f?.close(); if (directory) await rm(directory, { recursive: true, force: true }); } });
it.each(["sql", "archive"] as const)("restores populated source lineage and exact original command after newer review using %s", async kind => {
  const target = kind === "sql" ? f.sqlTarget : f.archiveTarget;
  if (kind === "sql") {
    vi.stubEnv("DATABASE_URL", target.options.connectionString!); await db.resetPoolForTesting(); await db.ensureSchema();
    expect((await promisify(execFile)(process.execPath, ["scripts/restore.mjs", join(directory, "backup.sql")], { env: { ...process.env } })).stdout).toContain("تمت الاستعادة");
  } else {
    await db.resetPoolForTesting(); const restored = await stagedRestore({ archivePath: join(directory, "backup.tar.gz"), targetUrl: target.options.connectionString!, stagingDir: join(directory, "documents") }); expect(restored.errors).toEqual([]); expect(restored.ok).toBe(true);
    vi.stubEnv("DATABASE_URL", target.options.connectionString!); await db.resetPoolForTesting();
  }
  expect(await rows(target)).toEqual(await rows(f.source));
  expect(await appendOrthoProblemSource({ ...scope, command: original })).toEqual({ ...receipt, replayed: true });
  expect(await getOrthoProblemSources(scope)).toMatchObject({ ok: true, problems: [{ id: receipt.problemId, label: original.label }], reviews: [{ supersedesReviewId: receipt.reviewId }, { id: receipt.reviewId }] });
  await expect(target.query("UPDATE ortho_problem_source_reviews SET reason='changed'")).rejects.toThrow();
});
