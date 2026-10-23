import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import * as db from "../../lib/db";
import { sessionCredentialVersion } from "../../lib/auth";
import { saveAppointmentFollowup, retireAppointmentFollowup, readAppointmentFollowupQueue, readAppointmentFollowupSource } from "../../lib/appointment-followup-db";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { readTarGzEntries } from "../../lib/restore/archive";
import { stagedRestore } from "../../lib/restore/staging";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";

// Acceptance regression: deliberately NOT skipped/expected-failure.
// Requires exact-head PG execution; local unit success is not roundtrip evidence.
// Only domain pool routing is injected. Export/replay, authorization SQL, target
// guards, triggers and migration execution remain real.
const cases = ["live", "appointment-null", "both-null", "missing-link", "stale-patient", "stale-timestamp", "old-generation"] as const;
const tables = ["appointment_followups", "appointment_followup_links", "appointment_followup_events", "appointment_followup_receipts", "appointment_followup_retirements"] as const;
async function snapshot(pool: Pool) {
  const result: Record<string, unknown> = {};
  for (const table of [...tables, "patients", "appointments", "audit_log"]) {
    // JSON built by PG retains exact timestamps rather than JS millisecond Dates.
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}

it.each(cases)("real archive/staged restore preserves %s followup identity and guards", async kind => {
  const fixture = await openBackupTimestampFixture({ ...process.env });
  let directory: string | undefined;
  const poolSpy = vi.spyOn(db, "getPool").mockReturnValue(fixture.source as unknown as db.DbPool);
  try {
    directory = await mkdtemp(join(tmpdir(), "followup-restore-"));
    const files = await loadMigrationFiles();
    await migrate(fixture.source, { apply: true, files });
    // Prepare ONLY the owned, empty target through shipped numbered migrations.
    await migrate(fixture.archiveTarget, { apply: true, files });
    for (const table of tables) expect((await fixture.archiveTarget.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    const q = async (sql: string, values: unknown[] = []) => (await fixture.source.query(sql, values)).rows;
    await q("INSERT INTO users(id,username,display_name,password_hash,role) VALUES (900,'synthetic-restore','Synthetic','synthetic-hash','reception')");
    await q("INSERT INTO patients(id,patient_number,full_name) VALUES (901,'SYN-RESTORE-OLD','Synthetic old source')");
    await q(`INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,status,created_at)
      VALUES (902,901,'2000-01-01','10:00','no_show','2000-01-01T00:00:00.123456Z')`);
    const actor = { userId: 900, username: "synthetic-restore", role: "reception",
      credentialVersion: sessionCredentialVersion("synthetic-hash"), expiresAt: Date.now() + 3600000 };
    const identity = await readAppointmentFollowupSource(902, actor);
    await q("SELECT setval(pg_get_serial_sequence('appointment_followups','id'),903,false)");
    const command = { ...identity, expectedActorUserId: actor.userId, requestId: "synthetic-restore-request", expectedRevision: 0,
      assigneeUserId: 900, dueAt: new Date(Date.now() + 86400000).toISOString(), status: "open", outcome: "pending", nextStep: "call" };
    const first = await saveAppointmentFollowup(command, actor);
    expect(first.followupId).toBe(903);
    const expired={...command,requestId:command.requestId+'-retire',expectedRevision:1,dueAt:'2000-01-01T00:00:00.000Z'};
    expect(await retireAppointmentFollowup(expired,actor)).toMatchObject({outcome:'retired'});
    if (kind === "stale-patient") {
      await q("INSERT INTO patients(id,patient_number,full_name) VALUES (904,'SYN-MOVED','Synthetic moved source')");
      await q("UPDATE appointments SET patient_id=904 WHERE id=902");
    }
    if (kind === "stale-timestamp") await q("UPDATE appointments SET created_at='2000-01-01T00:00:00.123457Z' WHERE id=902");
    if (kind === "appointment-null" || kind === "both-null") await q("DELETE FROM appointments WHERE id=902");
    if (kind === "both-null") await q("DELETE FROM patients WHERE id=901");
    if (kind === "missing-link" || kind === "old-generation") await q("DELETE FROM appointment_followup_links WHERE followup_id=903");
    if (kind === "old-generation") {
      await q("DELETE FROM appointments WHERE id=902"); await q("DELETE FROM patients WHERE id=901");
      // Synthetic historical generation fixture; canonical reset is tested separately.
      await q("INSERT INTO audit_log(action,entity,actor,summary,details) VALUES ('system.reset','system','synthetic-restore','Synthetic historical generation','{}')");
      await q("INSERT INTO patients(id,patient_number,full_name) VALUES (901,'SYN-RESTORE-NEW','Synthetic new identity')");
      await q(`INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,status,created_at)
        VALUES (902,901,'2000-01-01','10:00','no_show','2000-01-01T00:00:00.123456Z')`);
    }
    const before = await snapshot(fixture.source);
    const archivePath = join(directory, "followup.tar.gz");
    const client = await fixture.source.connect();
    try {
      const blocks: Uint8Array[] = [];
      for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No fixture documents"); } })) blocks.push(block);
      await writeFile(archivePath, gzipSync(Buffer.concat(blocks)));
    } finally { client.release(); }
    const archive = await readTarGzEntries(archivePath);
    const sql = Buffer.from(archive.entries.get("database.sql")!.data).toString("utf8");
    expect(sql).toContain("INSERT INTO appointment_followups ");
    if (kind !== "missing-link" && kind !== "old-generation") {
      expect(sql.indexOf("INSERT INTO appointment_followup_links ")).toBeGreaterThan(-1);
      expect(sql.indexOf("INSERT INTO appointment_followup_links ")).toBeLessThan(sql.indexOf("INSERT INTO appointment_followup_events "));
    }
    // Invoke the real archive validation, SQL replay and staged verification.
    // allowNonEmptyTarget is scoped to our owned empty candidate schema above.
    const restored = await stagedRestore({ archivePath,
      targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, "documents"), allowNonEmptyTarget: true });
    if (!restored.ok) {
      for (const table of tables) expect((await fixture.archiveTarget.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
    expect(restored.errors, `restore blocker for ${kind}`).toEqual([]);
    expect(restored.ok).toBe(true);
    expect((await fixture.archiveTarget.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid IN ('appointment_followups'::regclass,'appointment_followup_links'::regclass,
        'appointment_followup_events'::regclass,'appointment_followup_receipts'::regclass,'appointment_followup_retirements'::regclass)
      AND tgenabled <> 'O'`)).rows).toEqual([]);
    expect(await snapshot(fixture.archiveTarget)).toEqual(before);
    poolSpy.mockReturnValue(fixture.archiveTarget as unknown as db.DbPool);
    const queue = await readAppointmentFollowupQueue(actor);
    if (kind === "live") {
      expect(queue.items.find(row => row.id === 903)).toMatchObject({ contactBlocked: false, patient_id: 901 });
      expect(await saveAppointmentFollowup(command, actor)).toEqual({ ...first, replayed: true });
      expect(await retireAppointmentFollowup(expired,actor)).toMatchObject({outcome:'retired'});
      await expect(saveAppointmentFollowup(expired,actor)).rejects.toMatchObject({code:'FOLLOWUP_ATTEMPT_RETIRED'});
      expect(await snapshot(fixture.archiveTarget)).toEqual(before);
    } else {
      if (kind === "old-generation") expect(queue.items).toEqual([]);
      else expect(queue.items.find(row => row.id === 903)).toMatchObject({ contactBlocked: true,
        sourceState: "source_unavailable_review_required", sourceIdentity: null, patient_id: null });
      await expect(saveAppointmentFollowup(command, actor)).rejects.toMatchObject({ status: 409,
        code: kind === "old-generation" ? "FOLLOWUP_GENERATION_CHANGED" : "FOLLOWUP_SOURCE_CHANGED" });
      expect(await snapshot(fixture.archiveTarget)).toEqual(before);
    }
    if (kind === "appointment-null" || kind === "both-null") {
      // Refuse rebinding even to a newly valid FK. Never restore contact silently.
      await fixture.archiveTarget.query("INSERT INTO patients(id,patient_number,full_name) VALUES (910,'SYN-NEW','Synthetic replacement')");
      await fixture.archiveTarget.query("INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time) VALUES (911,910,'2000-01-01','10:00')");
      await expect(fixture.archiveTarget.query("UPDATE appointment_followup_links SET appointment_id=911 WHERE followup_id=903")).rejects.toThrow("immutable");
    }
    if (kind === "missing-link" || kind === "old-generation") {
      await expect(fixture.archiveTarget.query("INSERT INTO appointment_followup_links(followup_id,appointment_id,patient_id) VALUES (903,902,901)")).rejects.toThrow("immutable");
    }
    await expect(fixture.archiveTarget.query("UPDATE appointment_followup_events SET outcome='pending' WHERE followup_id=903")).rejects.toThrow("append-only");
    await expect(fixture.archiveTarget.query("DELETE FROM appointment_followup_receipts")).rejects.toThrow("append-only");
    await expect(fixture.archiveTarget.query("DELETE FROM appointment_followup_retirements")).rejects.toThrow("append-only");
  } finally {
    poolSpy.mockRestore();
    try { await fixture.close(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
});
