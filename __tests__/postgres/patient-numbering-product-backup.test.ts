import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client, Pool } from "pg";
import { expect, it, vi } from "vitest";
import { sqlValue } from "../../lib/backup";
import { upsertBackupHistoryRecord } from "../../lib/backupHistory";
import { backupStateDir, productionBackupFilename, verifyBackupArchiveFile } from "../../lib/backupVolume";
import { backupSqlLines, ensureSchema, resetPoolForTesting } from "../../lib/db";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { parseTarBytes } from "../../lib/restore/archive";
import { readRestoreDrillState, runAdminRestoreDrill } from "../../lib/restore/admin";
import { stagedRestore } from "../../lib/restore/staging";
import { patientNumberSequenceMarker, restorePatientNumberSequence } from "../../lib/restore/patient-number-sequence.mjs";
import { prepareBackupSql } from "../../lib/restore/sql.mjs";
import { validateBackupArchive } from "../../lib/restore/validate";
import { tarEnd, tarHeader, tarPadding } from "../../lib/tar";
import { validateLocalVerificationTarget } from "../../lib/verification-target-policy.mjs";
import { validateGeneratedDatabaseName } from "../../scripts/verify-schema-ownership";
import { validatePostgresTestTarget } from "./_safe-target";
import { NumberingPgFixture } from "./fixtures/patient-numbering-adapter";
import { admitRestoredFixture, captureFixtureCheckpoint } from "./fixtures/patient-numbering-bootstrap";

const target = validatePostgresTestTarget(process.env);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const key = "synthetic-numbering-product-backup.txt";
const bytes = Buffer.from("Synthetic backup witness. No patient or clinical data.\n");
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const columns = {
  config: ["id", "prefix", "revision"],
  history: ["prefix", "historical", "complete"],
  receipts: ["actor", "request", "intent", "result"],
  audit: ["id", "actor", "reason", "before_state", "after_state"],
  issued: ["number"],
} as const;

/** A quiesced fixture extension only; not an archive format or SQL surface. */
async function exportOwnedFixture(fixture: NumberingPgFixture) {
  const { schema, pool } = fixture;
  const records: Record<string, unknown> = {};
  const sql: string[] = [];
  for (const [table, fields] of Object.entries(columns)) {
    const selected = fields.join(", ");
    const { rows } = await pool.query(
      `SELECT ${selected} FROM ${schema}.${table} ORDER BY ${selected}`,
    );
    records[table] = rows;
    for (const row of rows) {
      const identity = table === "audit" ? " OVERRIDING SYSTEM VALUE" : "";
      sql.push(`INSERT INTO ${schema}.${table} (${selected})${identity} VALUES (${fields.map((field) => sqlValue(row[field])).join(", ")});`);
    }
  }
  for (const sequence of [...alphabet].map((p) => `seq_${p.toLowerCase()}`).concat("audit_id_seq")) {
    const qualified = `${schema}.${sequence}`;
    const { rows: [row] } = await pool.query<{last_value: string; is_called: boolean}>(
      `SELECT last_value::text, is_called FROM ${qualified}`,
    );
    if (!/^[1-9][0-9]{0,17}$/.test(row.last_value)) throw new Error("Malformed synthetic counter");
    records[sequence] = row;
    sql.push(`ALTER SEQUENCE ${qualified} RESTART WITH ${row.last_value};`);
    if (row.is_called) sql.push(`SELECT nextval('${qualified}');`);
  }
  return { records, sql: sql.join("\n") };
}

it("demonstrates product backup omission, then proves a pre-provisioned fixture-only extension can round-trip", async () => {
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const directory = await mkdtemp(join(tmpdir(), "synthetic-numbering-product-"));
  const owned: { name: string; identity: unknown; pool: Pool }[] = [];
  const identitySql = "SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1";
  async function newDatabase({ legacyCli = false } = {}) {
    const id = randomUUID().replaceAll("-", "");
    const name = legacyCli ? `backup_dst_${id}` : `aqlan_schema_ownership_num_${id}`;
    if (legacyCli) {
      if (!/^backup_dst_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid owned legacy CLI target");
    } else validateGeneratedDatabaseName(name);
    if (name.length > 63) throw new Error("Synthetic database name exceeds identifier limit");
    const url = new URL(target.testUrl);
    url.pathname = `/${name}`;
    validateLocalVerificationTarget(url.toString(), process.env, { varName: "NUMBERING_FIXTURE", databaseName: name });
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); // no overwrite, no existing DB reset
    const { rows: [identity] } = await admin.query(identitySql, [name]);
    if (!identity) throw new Error("Synthetic database ownership not established");
    const pool = new Pool({ connectionString: url.toString(), ssl: false, max: 1 });
    owned.push({ name, identity, pool });
    expect((await pool.query(identitySql, [name])).rows).toEqual([identity]);
    return { pool, url: url.toString() };
  }

  const failures: unknown[] = [];
  try {
    await admin.connect();
    const source = await newDatabase();
    await migrate(source.pool, { apply: true, files: await loadMigrationFiles() });
    const schema = `numbering_fixture_${randomUUID().replaceAll("-", "")}`;
    const f = new NumberingPgFixture(source.pool, schema, async () => null);
    await f.initialize();
    await source.pool.query(`UPDATE ${schema}.config SET prefix='B', revision=3;
      UPDATE ${schema}.history SET historical=123 WHERE prefix='P';
      SELECT setval('${schema}.seq_p',900000,true);
      SELECT setval('${schema}.seq_b',37,false);
      SELECT setval('public.patient_number_seq',899999,true);
      INSERT INTO ${schema}.issued VALUES('P-900000');
      INSERT INTO ${schema}.receipts VALUES(17,'synthetic_request_00001','synthetic intent','{"next":"37"}');
      INSERT INTO ${schema}.audit(actor,reason,before_state,after_state)
        VALUES(17,'Synthetic owner''s audit','{"prefix":"P"}','{"prefix":"B","next":"37"}');`);
    // Actually allocate and close one synthetic public-file record.
    await source.pool.query("BEGIN");
    try {
      const { rows: [allocation] } = await source.pool.query<{n: string}>(
        "SELECT nextval('public.patient_number_seq')::text AS n",
      );
      expect(allocation.n).toBe("900000");
      await source.pool.query(
        "INSERT INTO patients(patient_number,full_name) VALUES('P-900000','Synthetic retired fixture')",
      );
      await source.pool.query("DELETE FROM patients WHERE patient_number='P-900000'");
      await source.pool.query("COMMIT");
    } catch (error) {
      await source.pool.query("ROLLBACK");
      throw error;
    }
    const { rows: [patient] } = await source.pool.query<{id: number}>(
      "INSERT INTO patients(patient_number,full_name) VALUES('P-00123','Synthetic numbered record') RETURNING id",
    );
    await source.pool.query(
      "INSERT INTO invoices(invoice_number,patient_id,total_minor) VALUES('SYN-NUMBER-PRODUCT',$1,100)", [patient.id],
    );
    await source.pool.query(
      `INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
       VALUES($1,'other','Synthetic numbered document','text/plain',$2,$3,$4,'synthetic-backup-witness')`,
      [patient.id, bytes.length, sha(bytes), key],
    );
    const checkpoint = await captureFixtureCheckpoint(f);
    const witness = await exportOwnedFixture(f);
    const sqlLines: string[] = [];
    const blocks: Buffer[] = [];
    const reader = await source.pool.connect();
    try {
      for await (const line of backupSqlLines(reader)) sqlLines.push(line);
      for await (const block of fullBackupBlocks({
        source: reader, readDocument: async (requested) => {
          if (requested !== key) throw new Error("Non-fixture document read refused");
          return bytes;
        },
      })) blocks.push(Buffer.from(block));
    } finally { reader.release(); }
    const archiveBytes = Buffer.concat(blocks);
    const archive = parseTarBytes(archiveBytes);
    const validated = validateBackupArchive(archive, { documentsDir: directory });
    if (!validated.ok) throw new Error(validated.errors.join("; "));
    for (const sql of [sqlLines.join(""), Buffer.from(validated.sql).toString("utf8")]) {
      expect(sql).toContain("P-00123");
      expect(sql).toContain("SYN-NUMBER-PRODUCT");
      expect(sql).not.toContain(schema);
      expect(prepareBackupSql(sql).patientNumberSequence).toEqual({ lastValue: "900000", isCalled: true });
    }

    const originalSql = Buffer.from(validated.sql).toString("utf8");
    function fixtureArchive(sql: string) {
      const payload = Buffer.from(sql);
      const modified = new Date("2026-01-01T00:00:00Z");
      const entries: Uint8Array[] = [];
      for (const name of archive.order) {
        const data = archive.entries.get(name)!.data;
        const body = name === "database.sql" ? payload : name === "manifest.json"
          ? Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data).toString()), databaseSha256: sha(payload), databaseBytes: payload.length }))
          : data;
        entries.push(tarHeader(name, body.length, modified), body, tarPadding(body.length));
      }
      return gzipSync(Buffer.concat([...entries, tarEnd()]));
    }

    const malformed = await newDatabase();
    const malformedPath = join(directory, "app-malformed-marker.tar.gz");
    await writeFile(malformedPath, fixtureArchive(originalSql.replace(
      `${patientNumberSequenceMarker} 900000 true`, `${patientNumberSequenceMarker} 900000 unsupported`,
    )));
    expect(await stagedRestore({
      archivePath: malformedPath, targetUrl: malformed.url, stagingDir: join(directory, "malformed"),
    })).toMatchObject({ ok: false, readyForCutover: false, migrationsApplied: [], documentsRestored: 0 });
    expect((await malformed.pool.query("SELECT to_regclass('public.patients') AS relation")).rows).toEqual([{ relation: null }]);

    const fixed = await newDatabase();
    const fixedPath = join(directory, "app.tar.gz");
    await writeFile(fixedPath, gzipSync(archiveBytes));
    expect(await stagedRestore({
      archivePath: fixedPath, targetUrl: fixed.url, stagingDir: join(directory, "fixed"),
    })).toMatchObject({ ok: true, readyForCutover: false, documentsVerified: 1, patientNumberSequence: "reconciled", cutoverBlocker: "numbering-freshness-unverified" });
    const legacyCounter = "SELECT last_value::text, is_called FROM public.patient_number_seq";
    expect((await fixed.pool.query(legacyCounter)).rows).toEqual([{ last_value: "900000", is_called: true }]);
    expect(await readFile(join(directory, "fixed", key))).toEqual(bytes);

    const legacyCli = await newDatabase({ legacyCli: true });
    await migrate(legacyCli.pool, { apply: true, files: await loadMigrationFiles() });
    const sqlPath = join(directory, "backup.sql");
    await writeFile(sqlPath, sqlLines.join(""));
    await promisify(execFile)(process.execPath, ["scripts/restore.mjs", sqlPath], {
      env: { ...process.env, DATABASE_URL: legacyCli.url, NODE_ENV: "test" },
    });
    expect((await legacyCli.pool.query(legacyCounter)).rows).toEqual([{ last_value: "900000", is_called: true }]);

    const omitted = await newDatabase();
    const unextendedPath = join(directory, "app-historical-no-marker.tar.gz");
    const historicSql = originalSql.split("\n").filter((line) => !line.startsWith(patientNumberSequenceMarker)).join("\n");
    expect(prepareBackupSql(historicSql).patientNumberSequence).toBeNull();
    await writeFile(unextendedPath, fixtureArchive(historicSql));
    const omittedResult = await stagedRestore({
      archivePath: unextendedPath, targetUrl: omitted.url, stagingDir: join(directory, "omitted"),
    });
    expect(omittedResult).toMatchObject({
      ok: true, readyForCutover: false, documentsVerified: 1, patientNumberSequence: "not-recorded", cutoverBlocker: "numbering-history-not-recorded",
    });
    expect((await omitted.pool.query("SELECT patient_number FROM patients")).rows).toEqual([{ patient_number: "P-00123" }]);
    expect((await source.pool.query(legacyCounter)).rows).toEqual([{ last_value: "900000", is_called: true }]);
    expect((await omitted.pool.query(legacyCounter)).rows).toEqual([{ last_value: "1", is_called: true }]);
    vi.stubEnv("DATABASE_URL", omitted.url);
    vi.stubEnv("SKIP_SEED", "true");
    try {
      await ensureSchema();
      expect((await omitted.pool.query(legacyCounter)).rows).toEqual([{ last_value: "7000", is_called: false }]);
      const { rows: [next] } = await omitted.pool.query<{ n: string }>(
        "SELECT nextval('public.patient_number_seq')::text AS n",
      );
      expect(next.n).toBe("7000");
    } finally {
      await resetPoolForTesting();
      vi.unstubAllEnvs();
    }
    expect((await omitted.pool.query("SELECT to_regnamespace($1) AS namespace", [schema])).rows)
      .toEqual([{ namespace: null }]);
    const omittedFixture = new NumberingPgFixture(omitted.pool, schema, async () => null);
    await expect(admitRestoredFixture(omittedFixture, checkpoint)).rejects.toThrow();

    // Exercise the real admin reset/replay and disk history, only on another
    // database created in this test and with archives generated above.
    const adminTarget = await newDatabase();
    const backupDir = join(directory, "admin-archives");
    await mkdir(backupStateDir(backupDir), { recursive: true });
    const drillEnv = {
      DATABASE_URL: source.url,
      RESTORE_DRILL_DATABASE_URL: adminTarget.url,
      RESTORE_DRILL_DATABASE_ENVIRONMENT: "test",
      RESTORE_DRILL_DEDICATED_TARGET: "true",
    };
    async function register(bytes: Buffer) {
      const now = new Date("2026-01-01T00:00:00Z");
      const backupId = productionBackupFilename(now, "synthetic");
      const path = join(backupDir, backupId);
      await writeFile(path, bytes);
      const integrity = await verifyBackupArchiveFile(path, directory);
      await upsertBackupHistoryRecord(backupDir, {
        backupId, createdAt: now.toISOString(), triggerType: "manual",
        archiveSha256: integrity.sha256, archiveBytes: integrity.bytes,
        databaseSha256: integrity.databaseSha256, documentCount: integrity.documents,
        status: "verified", replicationStatus: "none", destinations: [],
      });
      return backupId;
    }
    async function adminDrill(backupId: string) {
      return runAdminRestoreDrill({ backupDir, backupId, env: drillEnv, actor: "Synthetic owner" });
    }
    const malformedId = await register(await readFile(malformedPath));
    await adminTarget.pool.query("CREATE TABLE public.synthetic_admin_sentinel (id int PRIMARY KEY)");
    expect(await adminDrill(malformedId)).toEqual({ ok: false, reason: "archive-integrity-mismatch" });
    expect((await adminTarget.pool.query("SELECT to_regclass('public.synthetic_admin_sentinel')::text AS table_name")).rows)
      .toEqual([{ table_name: "synthetic_admin_sentinel" }]);
    const historicId = await register(await readFile(unextendedPath));
    const historicHold = {
      readyForCutover: false, patientNumberSequence: "not-recorded", cutoverBlocker: "numbering-history-not-recorded",
    };
    expect(await adminDrill(historicId)).toMatchObject({ ok: true, ...historicHold });
    expect(await readRestoreDrillState(backupDir)).toMatchObject({ backupId: historicId, status: "restored", ...historicHold });
    const freshId = await register(await readFile(fixedPath));
    const freshHold = {
      readyForCutover: false, patientNumberSequence: "reconciled", cutoverBlocker: "numbering-freshness-unverified",
    };
    expect(await adminDrill(freshId)).toMatchObject({ ok: true, ...freshHold });
    expect(await readRestoreDrillState(backupDir)).toMatchObject({ backupId: freshId, status: "restored", ...freshHold });

    // Build a fixture-only extension of the official payload; its stable marker
    // must still precede COMMIT. The new namespace is not a product feature.
    const augmentedSql = originalSql.replace(patientNumberSequenceMarker, () =>
      `${witness.sql}\n${patientNumberSequenceMarker}`);
    expect(augmentedSql).not.toBe(originalSql);
    const extendedPath = join(directory, "fixture-extended.tar.gz");
    await writeFile(extendedPath, fixtureArchive(augmentedSql));
    const absent = await newDatabase();
    expect(await stagedRestore({
      archivePath: extendedPath, targetUrl: absent.url, stagingDir: join(directory, "missing-schema"),
    })).toMatchObject({ ok: false, readyForCutover: false, documentsRestored: 0 });

    // Known schema pre-provisioned only on our fresh target; no migration or runtime change.
    const included = await newDatabase();
    const restored = new NumberingPgFixture(included.pool, schema, async () => null);
    await restored.initialize();
    await included.pool.query(`DELETE FROM ${schema}.config; DELETE FROM ${schema}.history`);
    const includedDir = join(directory, "included");
    expect(await stagedRestore({
      archivePath: extendedPath, targetUrl: included.url, stagingDir: includedDir,
    })).toMatchObject({ ok: true, readyForCutover: false, documentsVerified: 1 });
    expect(await readFile(join(includedDir, key))).toEqual(bytes);
    expect((await exportOwnedFixture(restored)).records).toEqual(witness.records);
    expect((await included.pool.query(legacyCounter)).rows)
      .toEqual([{ last_value: "900000", is_called: true }]);
    await admitRestoredFixture(restored, checkpoint);
    expect(await restored.issue()).toBe("B-00037");
    expect(await f.issue()).toBe("B-00037");
    expect(await f.issue()).toBe("B-00038");
    await expect(admitRestoredFixture(restored, await captureFixtureCheckpoint(f)))
      .rejects.toThrow("Restored state behind trusted checkpoint");

    // The application writer captures a real pending, unconsumed counter too.
    await source.pool.query("SELECT setval('public.patient_number_seq',900111,false)");
    const pendingBlocks: Buffer[] = [];
    const pendingReader = await source.pool.connect();
    try {
      for await (const block of fullBackupBlocks({ source: pendingReader, readDocument: async (requested) => {
        if (requested !== key) throw new Error("Non-fixture document read refused");
        return bytes;
      } })) pendingBlocks.push(Buffer.from(block));
    } finally { pendingReader.release(); }
    const pendingPath = join(directory, "app-pending.tar.gz");
    await writeFile(pendingPath, gzipSync(Buffer.concat(pendingBlocks)));
    const pending = await newDatabase();
    expect(await stagedRestore({
      archivePath: pendingPath, targetUrl: pending.url, stagingDir: join(directory, "pending"),
    })).toMatchObject({ ok: true, patientNumberSequence: "reconciled" });
    expect((await pending.pool.query(legacyCounter)).rows).toEqual([{ last_value: "900111", is_called: false }]);

    // Greater target state stays unchanged; equal called beats equal pending.
    const transaction = await pending.pool.connect();
    try {
      await transaction.query("BEGIN");
      await restorePatientNumberSequence(transaction, { lastValue: "900110", isCalled: true });
      expect((await transaction.query(legacyCounter)).rows).toEqual([{ last_value: "900111", is_called: false }]);
      // Even the no-advance path must hold the allocator lock, before RESTART.
      // Another backend must not allocate while a reconciliation is uncommitted.
      const competitor = new Client({ connectionString: pending.url, ssl: false });
      await competitor.connect();
      try {
        await competitor.query("SET statement_timeout = '150ms'");
        await expect(competitor.query("SELECT nextval('public.patient_number_seq')")).rejects.toMatchObject({ code: "57014" });
      } finally { await competitor.end(); }
      await restorePatientNumberSequence(transaction, { lastValue: "900111", isCalled: true });
      expect((await transaction.query(legacyCounter)).rows).toEqual([{ last_value: "900111", is_called: true }]);
      await restorePatientNumberSequence(transaction, { lastValue: "900115", isCalled: true });
      expect((await transaction.query(legacyCounter)).rows).toEqual([{ last_value: "900115", is_called: true }]);
    } finally {
      await transaction.query("ROLLBACK");
      transaction.release();
    }
    expect((await pending.pool.query(legacyCounter)).rows).toEqual([{ last_value: "900111", is_called: false }]);
    await pending.pool.query("ALTER SEQUENCE public.patient_number_seq CACHE 2");
    const unsupported = await pending.pool.connect();
    try {
      await unsupported.query("BEGIN");
      await expect(restorePatientNumberSequence(unsupported, { lastValue: "900115", isCalled: true }))
        .rejects.toThrow("Unexpected target patient-number sequence definition");
      expect((await unsupported.query(legacyCounter)).rows).toEqual([{ last_value: "900111", is_called: false }]);
    } finally {
      await unsupported.query("ROLLBACK");
      unsupported.release();
    }
  } catch (error) { failures.push(error); }
  finally {
    for (const item of owned.reverse()) {
      try { await item.pool.end(); } catch (error) { failures.push(error); }
      try {
        const current = (await admin.query(identitySql, [item.name])).rows;
        if (current.length !== 1 || JSON.stringify(current[0]) !== JSON.stringify(item.identity)) {
          failures.push(new Error("Synthetic database ownership changed; cleanup refused"));
        } else {
          await admin.query(`DROP DATABASE "${item.name}"`);
        }
      } catch (error) { failures.push(error); }
    }
    try { await admin.end(); } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Synthetic app backup witness or owned cleanup failed");
});
