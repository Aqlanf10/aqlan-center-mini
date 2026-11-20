import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { upsertBackupHistoryRecord } from "../../lib/backupHistory";
import { backupStateDir } from "../../lib/backupVolume";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { HISTORICAL_BOOKING_0090 } from "../../lib/historical-booking-0090";
import { migrate } from "../../lib/migrations";
import { runAdminRestoreDrill } from "../../lib/restore/admin";
import { parseTarBytes } from "../../lib/restore/archive";
import { prepareBackupSql } from "../../lib/restore/sql.mjs";
import { stagedRestore } from "../../lib/restore/staging";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const rx = {
  "0091": {
    name: "prescribing_doctor_identity", column: "prescribing_doctor_party_id",
    ddl: "ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescribing_doctor_party_id INTEGER;\n",
    checksum: "d075fd6222bf8204c2e7de2ea536b66c8f8db71178eaa70de2294f0dba227044",
    specimen: 12345,
  },
  "0092": {
    name: "prescribing_doctor_snapshot", column: "prescribing_doctor_name",
    ddl: "ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescribing_doctor_name TEXT;\n",
    checksum: "587529f146e1bf72fc654cff4fbacb0f233729efaadf26e44fdfde8e802af240",
    specimen: "Synthetic historical prescriber",
  },
} as const;
type RxVersion = keyof typeof rx;
const issuance = {
  version: "0093", name: "prescription_issuance_commands",
  checksum: "7bf8a45c76d1a52b0efa0fae0b0427fb33a079b2be1aced8fc2560e8cf8336dc",
  commandKey: "3a15d253-4538-4d39-91cd-d1a2b3c4d5e6",
} as const;
let issuanceDdl: string;
const booking =
  "-- Additive request metadata only; existing requests retain their original meaning.\n" +
  "ALTER TABLE booking_requests ADD COLUMN request_key TEXT;\n" +
  "ALTER TABLE booking_requests ADD COLUMN request_hash TEXT;\n" +
  "ALTER TABLE booking_requests ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;\n" +
  "CREATE UNIQUE INDEX booking_requests_request_key_idx ON booking_requests (request_key) WHERE request_key IS NOT NULL;\n";
const createdAt = "2026-01-01T00:00:00.000Z";
const backupId = "production-backup-20260101-000000-001-syntheticrx-0123abcd.tar.gz";
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string, backupDir: string, archivePath: string, documentSentinel: string;
let patientId: number;

beforeAll(async () => {
  for (const entry of Object.values(rx)) expect(sha(entry.ddl)).toBe(entry.checksum);
  expect(sha(booking)).toBe(HISTORICAL_BOOKING_0090.sha256);
  issuanceDdl = await readFile(join(process.cwd(), "__tests__/fixtures/historical-prescription-issuance-0093.sql"), "utf8");
  expect(sha(issuanceDdl)).toBe(issuance.checksum);
  fixture = await openBackupTimestampFixture(process.env);
  directory = await mkdtemp(join(tmpdir(), "aqlan-historical-rx-restore-"));
  backupDir = join(directory, "backups");
  archivePath = join(backupDir, backupId);
  const staging = join(backupStateDir(backupDir), "restore-drill-current");
  await mkdir(staging, { recursive: true });
  documentSentinel = join(staging, "synthetic-document");
  await writeFile(documentSentinel, "synthetic previous document");
  await migrate(fixture.source, { apply: true });
  const patient = await fixture.source.query<{ id: number }>(
    "INSERT INTO public.patients(patient_number,full_name) VALUES ('P-SYNTH-RX','Synthetic Archive Patient') RETURNING id",
  );
  patientId = patient.rows[0].id;
  await fixture.archiveTarget.query(
    "CREATE TABLE public.synthetic_previous_drill(label text); INSERT INTO public.synthetic_previous_drill VALUES ('synthetic previous database')",
  );
});

afterAll(async () => {
  try { await fixture?.close(); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

async function officialSource(options: {
  versions: RxVersion[];
  populated?: boolean;
  omitRegistry?: boolean;
  wrongChecksum?: boolean;
  withBooking?: boolean;
  withIssuance?: boolean;
}) {
  // These test-only shapes are installed and removed on the owned archive source,
  // never on a restore target. No product migration or Rx route is run.
  await fixture.source.query(`
    DROP TABLE IF EXISTS public.prescription_issuance_commands;
    DROP FUNCTION IF EXISTS public.aqlan_prescription_command_immutable();
    DROP FUNCTION IF EXISTS public.aqlan_prescription_command_complete();
    DROP FUNCTION IF EXISTS public.aqlan_prescription_command_truncate();
    DELETE FROM public.prescriptions;
    DELETE FROM public.schema_migrations WHERE version IN ('0090','0091','0092','0093');
  `);
  for (const entry of Object.values(rx)) {
    await fixture.source.query(`ALTER TABLE public.prescriptions DROP COLUMN IF EXISTS ${entry.column}`);
  }
  await fixture.source.query("DROP INDEX IF EXISTS public.booking_requests_request_key_idx");
  await fixture.source.query("ALTER TABLE public.booking_requests DROP COLUMN IF EXISTS request_key, DROP COLUMN IF EXISTS request_hash, DROP COLUMN IF EXISTS preferences");
  for (const version of options.versions) {
    const entry = rx[version];
    await fixture.source.query(entry.ddl);
    if (!options.omitRegistry) {
      await fixture.source.query(
        "INSERT INTO public.schema_migrations(version,name,checksum,adopted) VALUES ($1,$2,$3,FALSE)",
        [version, entry.name, options.wrongChecksum ? "f".repeat(64) : entry.checksum],
      );
    }
  }
  if (options.withBooking) {
    await fixture.source.query(booking);
    await fixture.source.query(
      "INSERT INTO public.schema_migrations(version,name,checksum,adopted) VALUES ('0090',$1,$2,FALSE)",
      [HISTORICAL_BOOKING_0090.name, HISTORICAL_BOOKING_0090.sha256],
    );
  }
  if (options.withIssuance) {
    await fixture.source.query(issuanceDdl);
    if (!options.omitRegistry) {
      await fixture.source.query(
        "INSERT INTO public.schema_migrations(version,name,checksum,adopted) VALUES ($1,$2,$3,FALSE)",
        [issuance.version, issuance.name, issuance.checksum],
      );
    }
  }
  if (options.populated) {
    const columns = options.versions.map(version => rx[version].column);
    const placeholders = options.versions.map((_, index) => `$${index + 2}`);
    const { rows: [prescription] } = await fixture.source.query<{ id: number }>(
      `INSERT INTO public.prescriptions(patient_id,created_by,items,notes,doctor_party_id${columns.length ? "," + columns.join(",") : ""})
         VALUES ($1,'Synthetic operator','[]'::jsonb,'prescribing_doctor_name, prescribing_doctor_party_id, and prescription_issuance_commands are harmless in an ordinary literal',807${placeholders.length ? "," + placeholders.join(",") : ""}) RETURNING id`,
      [patientId, ...options.versions.map(version => rx[version].specimen)],
    );
    if (options.withIssuance) {
      await fixture.source.query(
        `INSERT INTO public.prescription_issuance_commands
           (command_key,actor_user_id,actor_username,patient_id,payload_sha256,prescription_id)
         VALUES ($1,1,'Synthetic operator',$2,repeat('a',64),$3)`,
        [issuance.commandKey, patientId, prescription.id],
      );
    }
  }

  const source = await fixture.source.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source })) blocks.push(block);
    const bytes = gzipSync(Buffer.concat(blocks));
    const sql = parseTarBytes(gunzipSync(bytes)).entries.get("database.sql")!.data;
    return { bytes, sql, text: Buffer.from(sql).toString("utf8") };
  } finally { source.release(); }
}

const readOnlyPreflight = (body: string) => prepareBackupSql(body, { inspectHistorical0079: true, rejectUnsupportedHistoricalSchema: true });

async function expectNoPreparation(input: Awaited<ReturnType<typeof officialSource>>, reason: RegExp) {
  // In the baseline regression run this assertion fails before any restore adapter
  // or target connection is invoked. No destructive branch is ever tried there.
  expect(() => readOnlyPreflight(input.text)).toThrow(reason);

  await writeFile(archivePath, input.bytes);
  await upsertBackupHistoryRecord(backupDir, {
    backupId, createdAt, triggerType: "manual", status: "verified", replicationStatus: "none", destinations: [],
    archiveSha256: sha(input.bytes), archiveBytes: input.bytes.byteLength, databaseSha256: sha(input.sql), documentCount: 0,
  });
  const direct = await stagedRestore({
    archivePath, targetUrl: fixture.sqlTarget.options.connectionString!, stagingDir: join(directory, "direct-docs"),
  });
  expect(direct).toMatchObject({ ok: false, readyForCutover: false, errors: [expect.stringMatching(reason)], migrationsApplied: [] });
  expect((await fixture.sqlTarget.query("SELECT to_regclass('public.prescriptions') AS target, to_regclass('public.prescription_issuance_commands') AS issuance")).rows).toEqual([{ target: null, issuance: null }]);
  const adminResult = await runAdminRestoreDrill({
    backupDir, backupId, actor: "Synthetic operator", env: {
      DATABASE_URL: fixture.source.options.connectionString!,
      RESTORE_DRILL_DATABASE_URL: fixture.archiveTarget.options.connectionString!,
      RESTORE_DRILL_DATABASE_ENVIRONMENT: "test", RESTORE_DRILL_DEDICATED_TARGET: "true",
    },
  });
  expect(adminResult).toEqual({ ok: false, reason: "archive-integrity-mismatch" });
  expect((await fixture.archiveTarget.query("SELECT label FROM public.synthetic_previous_drill")).rows)
    .toEqual([{ label: "synthetic previous database" }]);
  expect(await readFile(documentSentinel, "utf8")).toBe("synthetic previous document");
}

it.each(["0091", "0092"] as const)("preserves existing target when the official archive contains only the historical Rx %s registry", async version => {
  const input = await officialSource({ versions: [version] });
  expect(input.text).toContain(`VALUES ('${version}', '${rx[version].name}', '${rx[version].checksum}'`);
  expect(input.text).not.toMatch(/^INSERT INTO prescriptions /m);
  await expectNoPreparation(input, new RegExp(`Historical prescription ${version} requires`));
});

it("preserves existing target when both exact Rx migrations have a populated prescription", async () => {
  const input = await officialSource({ versions: ["0091", "0092"], populated: true });
  expect(input.text).toContain("Synthetic historical prescriber");
  await expectNoPreparation(input, /Historical prescription 009[12]/);
});

it.each(["0091", "0092"] as const)("holds a populated historical Rx %s column even when the registry row is absent", async version => {
  const input = await officialSource({ versions: [version], populated: true, omitRegistry: true });
  expect(input.text).not.toContain(`VALUES ('${version}', '${rx[version].name}'`);
  expect(input.text).toMatch(new RegExp(`^INSERT INTO prescriptions \\(.*"${rx[version].column}".*`, "m"));
  await expectNoPreparation(input, new RegExp(`Historical prescription ${version} columns`));
});

it("does not treat changed Rx ledger bytes as verified lineage", async () => {
  await expectNoPreparation(await officialSource({ versions: ["0092"], wrongChecksum: true }), /Invalid historical prescription 0092 registry/);
});

it("holds the supported historical detection paths when booking and Rx evidence coexist", async () => {
  await expectNoPreparation(
    await officialSource({ versions: ["0091", "0092"], populated: true, withBooking: true }),
    /Historical (?:booking 0090|prescription 009[12])/,
  );
});

it("refuses registry-only 0093 from an official archive with an empty issuance table", async () => {
  const input = await officialSource({ versions: [], withIssuance: true });
  expect(input.text).toContain(`VALUES ('0093', '${issuance.name}', '${issuance.checksum}'`);
  expect(input.text).not.toMatch(/^INSERT INTO prescription_issuance_commands /m);
  await expectNoPreparation(input, /Historical prescription 0093 requires/);
});

it("refuses a populated issuance command in an official archive with no 0093 registry", async () => {
  const input = await officialSource({ versions: [], withIssuance: true, populated: true, omitRegistry: true });
  expect(input.text).not.toContain(`VALUES ('0093', '${issuance.name}'`);
  expect(input.text).toMatch(/^INSERT INTO prescription_issuance_commands /m);
  expect(input.text).toContain(issuance.commandKey);
  await expectNoPreparation(input, /Historical prescription 0093 issuance table/);
});

it("holds mixed official booking, prescribing identity, and issuance history before resetting", async () => {
  const input = await officialSource({ versions: ["0091", "0092"], populated: true, withBooking: true, withIssuance: true });
  expect(input.text).toContain(`VALUES ('0090', '${HISTORICAL_BOOKING_0090.name}'`);
  expect(input.text).toContain(`VALUES ('0091', '${rx["0091"].name}'`);
  expect(input.text).toContain(`VALUES ('0092', '${rx["0092"].name}'`);
  expect(input.text).toMatch(/^INSERT INTO prescription_issuance_commands /m);
  await expectNoPreparation(input, /Historical (?:booking 0090|prescription 009[123])/);
});

it("preserves ordinary prescription INSERT bytes and ignores historical names in literal notes", async () => {
  const input = await officialSource({ versions: [], populated: true });
  const statement = input.text.match(/^INSERT INTO prescriptions .*$/m)?.[0];
  expect(statement).toBeTruthy();
  expect(statement).toContain('"doctor_party_id"');
  expect(readOnlyPreflight(input.text).dataSql).toContain(statement);
});

it.each(["0092", "0093"] as const)("raw SQL CLI refuses exact %s history before constructing a database client", async version => {
  const input = version === "0092"
    ? await officialSource({ versions: [version] })
    : await officialSource({ versions: [], withIssuance: true });
  const filename = join(directory, "synthetic-rx.sql");
  await writeFile(filename, input.sql);
  const run = spawnSync(process.execPath, [
    "--import", "./scripts/security/pg-probe-preload.mjs", "scripts/restore.mjs", filename,
  ], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", DATABASE_ENVIRONMENT: "test",
      DATABASE_URL: fixture.sqlTarget.options.connectionString! },
    encoding: "utf8", timeout: 10000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(new RegExp(`Historical prescription ${version} requires`));
  expect(run.stderr).not.toMatch(/PG_CLIENT_CONSTRUCTOR_CALLED/);
});
