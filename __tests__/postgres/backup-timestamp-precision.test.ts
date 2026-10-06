import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { sqlValueForColumn } from "../../lib/backup";
import { backupSqlLines } from "../../lib/db";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { parseTarBytes } from "../../lib/restore/archive";
import { validateBackupArchive } from "../../lib/restore/validate";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";

// Deliberately small synthetic clinical/audit shapes. No app migration or
// periodontal candidate is registered, applied or needed for this regression.
const SCHEMA = `
  CREATE TABLE clinical_records (
    id SERIAL PRIMARY KEY,
    recorded_at TIMESTAMPTZ,
    local_at TIMESTAMP WITHOUT TIME ZONE,
    nullable_at TIMESTAMPTZ,
    depth_mm NUMERIC,
    details JSONB NOT NULL,
    tags TEXT[] NOT NULL
  );
  CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    clinical_id INTEGER NOT NULL REFERENCES clinical_records(id),
    created_at TIMESTAMPTZ,
    actor TEXT NOT NULL
  );
  CREATE TABLE patient_documents (
    id SERIAL PRIMARY KEY, storage_key TEXT, sha256 TEXT, size_bytes BIGINT
  );
`;
const CLINICAL_TIME = "2001-02-03T04:05:06.123456Z";
const AUDIT_TIME = "2001-02-03T04:05:06.987654Z";
const LOCAL_TIME = "2001-02-03T04:05:06.654321";
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>> | undefined;
let sourceState: Awaited<ReturnType<typeof state>>;
let sql: string;
let archiveSql: string;
let negative: { clinical: Date; audit: Date; exact: boolean[]; milliseconds: boolean[] };

async function state(pool: Pool) {
  // SQL numeric epoch text is an independent full-precision oracle. Do not
  // compare JS Date values, or source and restored loss can cancel each other.
  return {
    clinical: (await pool.query(`SELECT id,depth_mm,details,tags,
      EXTRACT(EPOCH FROM recorded_at)::text AS recorded_at,
      EXTRACT(EPOCH FROM local_at)::text AS local_at,
      EXTRACT(EPOCH FROM nullable_at)::text AS nullable_at
      FROM clinical_records ORDER BY id`)).rows,
    audit: (await pool.query(`SELECT id,clinical_id,actor,EXTRACT(EPOCH FROM created_at)::text AS created_at
      FROM audit_log ORDER BY id`)).rows,
  };
}

async function sourceSettings(pool: Pool) {
  return (await pool.query(`SELECT current_setting('TimeZone') AS zone,
    current_setting('DateStyle') AS style`)).rows[0];
}

beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  const { source, sqlTarget, archiveTarget } = fixture;
  for (const pool of [source, sqlTarget, archiveTarget]) await pool.query(SCHEMA);
  await source.query("SET TIME ZONE 'UTC'");
  await source.query("SET datestyle TO 'ISO, MDY'");
  const values: (string | null)[][] = [
    [CLINICAL_TIME, LOCAL_TIME, AUDIT_TIME],
    ["2001-02-03T09:50:06.000001+05:45", "2001-02-03T04:05:06.000001", "2001-02-03T00:35:06.999999-03:30"],
    [null, null, null], ["infinity", "infinity", "infinity"], ["-infinity", "-infinity", "-infinity"],
  ];
  for (const [recorded, local, audited] of values) {
    const { rows: [row] } = await source.query<{ id: number }>(`INSERT INTO clinical_records
      (recorded_at,local_at,nullable_at,depth_mm,details,tags)
      VALUES ($1::timestamptz,$2::timestamp,NULL,99999999999999.9,$3::jsonb,$4::text[]) RETURNING id`,
    [recorded, local, JSON.stringify({ note: "Synthetic timestamp fixture", active: false, count: 2 }),
      ["synthetic", "comma,tag", 'quote"tag', null]]);
    await source.query(`INSERT INTO audit_log (clinical_id,created_at,actor)
      VALUES ($1,$2::timestamptz,'synthetic-backup-actor')`, [row.id, audited]);
  }

  // Deliberately reproduce the old SELECT * -> pg Date -> SQL literal route.
  // ISO/UTC isolates precision loss, independently of the hostile-style test.
  const clinical = (await source.query<{ recorded_at: Date }>("SELECT * FROM clinical_records WHERE id=1")).rows[0].recorded_at;
  const audit = (await source.query<{ created_at: Date }>("SELECT * FROM audit_log WHERE id=1")).rows[0].created_at;
  const loss = await source.query<{ clinical_exact: boolean; audit_exact: boolean; clinical_ms: boolean; audit_ms: boolean }>(
    `SELECT recorded_at = ${sqlValueForColumn(clinical, "timestamp with time zone")}::timestamptz AS clinical_exact,
      created_at = ${sqlValueForColumn(audit, "timestamp with time zone")}::timestamptz AS audit_exact,
      date_trunc('milliseconds',recorded_at) = ${sqlValueForColumn(clinical, "timestamp with time zone")}::timestamptz AS clinical_ms,
      date_trunc('milliseconds',created_at) = ${sqlValueForColumn(audit, "timestamp with time zone")}::timestamptz AS audit_ms
      FROM clinical_records r JOIN audit_log a ON a.clinical_id=r.id WHERE r.id=1`);
  negative = { clinical, audit, exact: [loss.rows[0].clinical_exact, loss.rows[0].audit_exact],
    milliseconds: [loss.rows[0].clinical_ms, loss.rows[0].audit_ms] };
  sourceState = await state(source);

  await source.query("SET TIME ZONE 'Asia/Kathmandu'");
  await source.query("SET datestyle TO 'SQL, DMY'");
  const expectedSettings = { zone: "Asia/Kathmandu", style: "SQL, DMY" };
  const client = await source.connect();
  try {
    sql = "";
    for await (const line of backupSqlLines(client)) sql += line;
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client,
      readDocument: async () => { throw new Error("Synthetic fixture has no documents."); },
    })) blocks.push(block);
    const archive = parseTarBytes(Buffer.concat(blocks));
    const validated = validateBackupArchive(archive);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.errors.join("; "));
    archiveSql = Buffer.from(validated.sql).toString("utf8");
  } finally { client.release(); }
  expect(await sourceSettings(source)).toEqual(expectedSettings);
  for (const [target, dump] of [[sqlTarget, sql], [archiveTarget, archiveSql]] as const) {
    await target.query("SET TIME ZONE 'America/St_Johns'");
    await target.query("SET datestyle TO 'German, DMY'");
    // Replay only synthetic data into a different fresh, identity-checked DB.
    // No staged restore, cutover, real backup, or existing database reset.
    await target.query(dump);
  }
  expect(await state(source)).toEqual(sourceState);
}, 90_000);

afterAll(async () => { await fixture?.close(); }, 30_000);

describe("canonical backup timestamp precision on owned PostgreSQL fixtures", () => {
  it("proves the old Date path loses clinical and audit microseconds", () => {
    expect(negative.clinical).toBeInstanceOf(Date);
    expect(negative.audit).toBeInstanceOf(Date);
    expect(negative.clinical.toISOString()).toBe("2001-02-03T04:05:06.123Z");
    expect(negative.audit.toISOString()).toBe("2001-02-03T04:05:06.987Z");
    expect(negative.exact).toEqual([false, false]);
    expect(negative.milliseconds).toEqual([true, true]);
  });

  it("exports exact timestamp text despite source DateStyle and non-UTC offset", () => {
    for (const dump of [sql, archiveSql]) {
      expect(dump).toContain("'2001-02-03T09:50:06.123456+05:45'");
      expect(dump).toContain("'2001-02-03T09:50:06.987654+05:45'");
      expect(dump).toContain("'2001-02-03T04:05:06.654321'");
      expect(dump).toContain("'infinity'");
      expect(dump).toContain("'-infinity'");
      expect(dump.match(/^INSERT INTO clinical_records /gm)).toHaveLength(5);
      expect(dump.match(/^INSERT INTO audit_log /gm)).toHaveLength(5);
    }
  });

  it("round-trips exact clinical/audit values, NULLs and other driver types through both exports", async () => {
    for (const pool of [fixture!.sqlTarget, fixture!.archiveTarget]) {
      expect(await state(pool)).toEqual(sourceState);
      expect((await pool.query(`SELECT r.recorded_at=$1::timestamptz AS clinical,
        a.created_at=$2::timestamptz AS audit, r.local_at=$3::timestamp AS local,
        r.nullable_at IS NULL AS nullable FROM clinical_records r
        JOIN audit_log a ON a.clinical_id=r.id WHERE r.id=1`, [CLINICAL_TIME, AUDIT_TIME, LOCAL_TIME])).rows)
        .toEqual([{ clinical: true, audit: true, local: true, nullable: true }]);
      expect((await pool.query("SELECT last_value::int,is_called FROM clinical_records_id_seq")).rows)
        .toEqual([{ last_value: 5, is_called: true }]);
      expect((await pool.query("SELECT last_value::int,is_called FROM audit_log_id_seq")).rows)
        .toEqual([{ last_value: 5, is_called: true }]);
    }
  });

  it("does not change ordinary pg Date decoding or source data", async () => {
    const source = fixture!.source;
    await source.query("SET datestyle TO 'ISO, MDY'");
    const row = (await source.query(`SELECT recorded_at,local_at,nullable_at,id,depth_mm,details,tags
      FROM clinical_records WHERE id=1`)).rows[0];
    expect(row.recorded_at).toBeInstanceOf(Date);
    expect(row.local_at).toBeInstanceOf(Date);
    expect(row.recorded_at.toISOString()).toBe("2001-02-03T04:05:06.123Z");
    expect(row.nullable_at).toBeNull();
    expect(row.id).toBe(1);
    expect(row.depth_mm).toBe("99999999999999.9");
    expect(row.details).toEqual({ note: "Synthetic timestamp fixture", active: false, count: 2 });
    expect(row.tags).toEqual(["synthetic", "comma,tag", 'quote"tag', null]);
    expect(await state(source)).toEqual(sourceState);
  });
});
