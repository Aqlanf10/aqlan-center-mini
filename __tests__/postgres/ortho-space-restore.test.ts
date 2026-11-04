import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import { appendOrthoAssessment } from "../../lib/ortho-assessment-store";
import { appendOrthoTreatmentStrategy } from "../../lib/ortho-treatment-strategy-store";
import { getOrthoSpaceLedger, appendOrthoSpaceEntry } from "../../lib/ortho-space-store";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let backup: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import("../../lib/db"), directory: string;
let f: { pool: Awaited<ReturnType<typeof openBackupTimestampFixture>>["source"] }, n = 0;
beforeAll(async () => {
  backup = await openBackupTimestampFixture(process.env); directory = await mkdtemp(join(tmpdir(), "ortho-space-restore-"));
  vi.stubEnv("DATABASE_URL", backup.source.options.connectionString!); vi.stubEnv("SKIP_SEED", "true"); vi.stubEnv("SESSION_SECRET", "synthetic-space-backup-secret-at-least32characters");
  db = await import("../../lib/db"); await db.resetPoolForTesting(); await db.ensureSchema(); f = { pool: backup.source };
});
afterAll(async () => { try { await db?.resetPoolForTesting(); } finally { vi.unstubAllEnvs(); await backup?.close(); if (directory) await rm(directory, { recursive: true, force: true }); } });
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
async function prepared() {
  const scope = await setup();
  const a = await appendOrthoAssessment({ ...scope, command: { ...tanakaCommandV2(), commandId: randomUUID() } }); if (!a.ok) throw Error(a.code);
  const problem = (await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,status,noted_by) VALUES($1,$2,'Synthetic space problem','active','synthetic') RETURNING id", [scope.patientId, scope.clinicalCaseId])).rows[0].id;
  const s = await appendOrthoTreatmentStrategy({ ...scope, command: { schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null, reason: "Synthetic planning", rows: [{ problemId: problem, objective: "Synthetic goal", strategy: "Synthetic manual choice", rationale: "Synthetic", planItemIds: [] }] } }); if (!s.ok) throw Error(s.code);
  const r = await getOrthoSpaceLedger(scope); if (!r.ok) throw Error(r.code);
  const baseline = r.choices.baselines.find(b => b.arch === "upper")!.ref;
  const command = { schemaVersion: 1, clientRequestId: randomUUID(), expectedHeadId: null, reason: "Synthetic space plan", content: { kind: "plan", arch: "upper", strategyRevisionId: s.revision.revisionId, baseline,
    gains: [], uses: [], contacts: [{ teeth: [12, 11], plannedUm: 300, budgetGainUm: 300, clinicianLimitUm: 400, note: "Synthetic verified contact" }], rationale: "Synthetic estimate", alternatives: "Synthetic alternatives" } };
  const p = await appendOrthoSpaceEntry({ ...scope, command }); if (!p.ok) throw Error(p.code);
  await f.pool.query("UPDATE ortho_cases SET status='active',phase='aligning',appliance='fixed_metal',arches='both',slot='022',start_date='2026-11-04',planned_months=12 WHERE id=$1", [scope.orthoCaseId]);
  const adjustment = async () => {
    const visit = (await f.pool.query("INSERT INTO visits(patient_id,patient_name,status) VALUES($1,'Synthetic space visit','done') RETURNING id", [scope.patientId])).rows[0].id;
    return (await f.pool.query("INSERT INTO ortho_adjustments(case_id,visit_id,recorded_by) VALUES($1,$2,'Synthetic treating doctor') RETURNING id", [scope.orthoCaseId, visit])).rows[0].id as number;
  };
  return { scope, plan: p, command, adjustment };
}
const perform = (p: Awaited<ReturnType<typeof prepared>>, adjustmentId: number, expectedHeadId: number, performedUm: number | null, extra = {}) => ({ schemaVersion: 1, clientRequestId: randomUUID(), expectedHeadId, reason: "Synthetic actual session documentation", content: { kind: "ipr", arch: "upper", planEntryId: p.plan.revision.id, teeth: [11, 12], adjustmentId, performedUm, measurementNote: "Synthetic direct measurement", supersedesEntryId: null, reviewReason: null, ...extra } });
it("restores checked reference columns, reverse physical event order, correction lineage and exact replay through both SQL and full archive", async () => {
  const p = await prepared(), one = await p.adjustment(), two = await p.adjustment();
  const original = perform(p, one, p.plan.revision.id, 100);
  const first = await appendOrthoSpaceEntry({ ...p.scope, command: original }); if (!first.ok) throw Error(first.code);
  const second = await appendOrthoSpaceEntry({ ...p.scope, command: perform(p, two, first.revision.id, 200) }); if (!second.ok) throw Error(second.code);
  const correction = await appendOrthoSpaceEntry({ ...p.scope, command: perform(p, one, second.revision.id, 50, { supersedesEntryId: first.revision.id }) }); if (!correction.ok) throw Error(correction.code);
  await backup.source.query("CREATE INDEX synthetic_space_reverse ON ortho_space_entries(id DESC)");
  await backup.source.query("CLUSTER ortho_space_entries USING synthetic_space_reverse");
  await backup.source.query("DROP INDEX synthetic_space_reverse");
  const before = (await backup.source.query("SELECT to_jsonb(t)::text value FROM ortho_space_entries t ORDER BY version")).rows;
  const client = await backup.source.connect();
  try {
    let sql = ''; for await (const line of db.backupSqlLines(client)) sql += line;
    await writeFile(join(directory, 'backup.sql'), sql);
    const blocks: Uint8Array[] = []; for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw Error('No files in synthetic space fixture'); } })) blocks.push(block);
    await writeFile(join(directory, 'backup.tar.gz'), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
  for (const kind of ['sql', 'archive'] as const) {
    const target = kind === 'sql' ? backup.sqlTarget : backup.archiveTarget;
    await db.resetPoolForTesting();
    if (kind === 'sql') {
      vi.stubEnv('DATABASE_URL', target.options.connectionString!); await db.ensureSchema();
      expect((await promisify(execFile)(process.execPath, ['scripts/restore.mjs', join(directory, 'backup.sql')], { env: { ...process.env } })).stdout).toContain('تمت الاستعادة');
    } else {
      const restored = await stagedRestore({ archivePath: join(directory, 'backup.tar.gz'), targetUrl: target.options.connectionString!, stagingDir: join(directory, 'documents') }); expect(restored.errors).toEqual([]); expect(restored.ok).toBe(true);
      vi.stubEnv('DATABASE_URL', target.options.connectionString!); await db.resetPoolForTesting();
    }
    expect((await target.query("SELECT to_jsonb(t)::text value FROM ortho_space_entries t ORDER BY version")).rows).toEqual(before);
    expect(await appendOrthoSpaceEntry({ ...p.scope, command: original })).toEqual({ ...first, replayed: true });
    expect(await getOrthoSpaceLedger(p.scope)).toMatchObject({ ok: true, ipr: { totals: [{ performedUm: 250 }] } });
    await expect(target.query("DELETE FROM ortho_space_entries WHERE id=$1", [first.revision.id])).rejects.toThrow('append-only');
  }
});
