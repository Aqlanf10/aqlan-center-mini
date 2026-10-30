import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { backupSqlLines } from "../../lib/db";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { documentEntryName, parseTarBytes } from "../../lib/restore/archive";
import { validateBackupArchive } from "../../lib/restore/validate";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";

// Synthetic representative HR/financial date shapes only, not financial rules.
// The date-only table also guards the projection's no-timestamp fast path.
const SCHEMA = `
  -- Full backup also snapshots optional branding-photo settings. Keep this
  -- empty fixture table: no photo, no application migrations or live settings.
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE staff_dates (
    id SERIAL PRIMARY KEY, hire_date DATE, salary_effective_on DATE, end_date DATE
  );
  CREATE TABLE financial_dates (
    id SERIAL PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff_dates(id),
    due_date DATE, accounting_date DATE, amount_minor BIGINT NOT NULL, currency TEXT NOT NULL,
    recorded_at TIMESTAMPTZ, local_at TIMESTAMP WITHOUT TIME ZONE
  );
  CREATE TABLE patient_documents (
    id SERIAL PRIMARY KEY, storage_key TEXT, sha256 TEXT, size_bytes BIGINT
  );
`;
const DAYS = ["2020-01-01", "2028-02-29", "2026-03-29", "2026-10-25", "0099-12-31", null, "infinity", "-infinity"];
const DOCUMENT = Buffer.from("Synthetic backup date regression document.\n", "utf8");
const STORAGE_KEY = "synthetic/date-fixture.txt";
const DOCUMENT_HASH = createHash("sha256").update(DOCUMENT).digest("hex");

async function state(pool: Pool) {
  // Database JSON, not JS Date, is the independent calendar/precision oracle.
  const result: Record<string, unknown> = {};
  for (const table of ["staff_dates", "financial_dates", "patient_documents"]) {
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY id`)).rows;
  }
  return result;
}

describe.each([
  { zone: "UTC", januaryOffset: 0, julyOffset: 0 },
  { zone: "Asia/Aden", januaryOffset: -180, julyOffset: -180 },
  { zone: "America/Phoenix", januaryOffset: 420, julyOffset: 420 },
  { zone: "Europe/Berlin", januaryOffset: -60, julyOffset: -120 },
])("DATE SQL/archive roundtrip with Node TZ=$zone", ({ zone, januaryOffset, julyOffset }) => {
  it.each(["ISO, MDY", "SQL, DMY", "German, DMY"])("preserves exact dates with source DateStyle=%s", async (style) => {
    const originalZone = process.env.TZ;
    let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>> | undefined;
    try {
      process.env.TZ = zone;
      // Do not silently claim timezone coverage if the test runner ignores TZ.
      expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(januaryOffset);
      expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(julyOffset);
      fixture = await openBackupTimestampFixture({ ...process.env });
      const { source, sqlTarget, archiveTarget } = fixture;
      for (const pool of [source, sqlTarget, archiveTarget]) {
        await pool.query(SCHEMA);
        await pool.query("SET TIME ZONE 'UTC'; SET datestyle TO 'ISO, MDY'");
      }
      for (const day of DAYS) {
        const { rows: [staff] } = await source.query<{ id: number }>(
          "INSERT INTO staff_dates(hire_date,salary_effective_on,end_date) VALUES($1::date,$1::date,NULL) RETURNING id", [day]);
        await source.query(`INSERT INTO financial_dates
          (staff_id,due_date,accounting_date,amount_minor,currency,recorded_at,local_at)
          VALUES($1,$2::date,$2::date,9007199254740993,'YER',
            '2020-01-01T00:15:30.123456Z','2020-01-01T00:15:30.654321')`, [staff.id, day]);
      }
      await source.query("INSERT INTO patient_documents(storage_key,sha256,size_bytes) VALUES($1,$2,$3)",
        [STORAGE_KEY, DOCUMENT_HASH, DOCUMENT.length]);
      const original = await state(source);
      expect((await source.query("SELECT to_json(hire_date) AS day FROM staff_dates ORDER BY id")).rows.map(row => row.day)).toEqual(DAYS);
      const ordinaryDate = (await source.query<{ hire_date: Date }>("SELECT hire_date FROM staff_dates WHERE id=1")).rows[0].hire_date;
      expect(ordinaryDate).toBeInstanceOf(Date);
      expect(ordinaryDate.getHours()).toBe(0);
      // The old UTC conversion changes this day in positive-offset processes.
      expect(ordinaryDate.toISOString().slice(0, 10)).toBe(januaryOffset < 0 ? "2019-12-31" : "2020-01-01");

      // Both database session settings differ from the process timezone; neither
      // is changed by the export. A ::text cast alone fails the DateStyle cases.
      await source.query("SET TIME ZONE 'Asia/Kathmandu'");
      await source.query("SELECT set_config('DateStyle',$1,false)", [style]);
      const client = await source.connect();
      let sql = "";
      let archiveSql: string;
      try {
        for await (const line of backupSqlLines(client)) sql += line;
        const blocks: Uint8Array[] = [];
        for await (const block of fullBackupBlocks({ source: client, readDocument: async (key) => {
          expect(key).toBe(STORAGE_KEY);
          return DOCUMENT;
        } })) blocks.push(block);
        const parsed = parseTarBytes(Buffer.concat(blocks));
        expect(parsed.order).toEqual(["database.sql", documentEntryName(STORAGE_KEY), "manifest.json"]);
        const validated = validateBackupArchive(parsed);
        expect(validated.ok).toBe(true);
        if (!validated.ok) throw new Error(validated.errors.join("; "));
        expect(validated.documents).toHaveLength(1);
        expect(Buffer.from(validated.documents[0].bytes)).toEqual(DOCUMENT);
        expect(validated.documents[0].sha256).toBe(DOCUMENT_HASH);
        archiveSql = Buffer.from(validated.sql).toString("utf8");
      } finally { client.release(); }
      expect((await source.query("SELECT current_setting('DateStyle') AS style,current_setting('TimeZone') AS zone")).rows)
        .toEqual([{ style, zone: "Asia/Kathmandu" }]);
      for (const dump of [sql, archiveSql]) {
        for (const day of DAYS.filter(day => day !== null)) expect(dump).toContain(`'${day}'`);
        expect(dump).toContain("'2020-01-01T06:00:30.123456+05:45'");
        expect(dump).toContain("'2020-01-01T00:15:30.654321'");
      }
      for (const [target, dump] of [[sqlTarget, sql], [archiveTarget, archiveSql]] as const) {
        await target.query("SET TIME ZONE 'America/St_Johns'; SET datestyle TO 'German, DMY'");
        // Only new identity-checked fixture databases, never a supplied target.
        await target.query(dump);
        await target.query("SET TIME ZONE 'UTC'; SET datestyle TO 'ISO, MDY'");
        expect(await state(target)).toEqual(original);
        expect((await target.query("SELECT last_value::int,is_called FROM staff_dates_id_seq")).rows)
          .toEqual([{ last_value: DAYS.length, is_called: true }]);
      }
      await source.query("SET TIME ZONE 'UTC'; SET datestyle TO 'ISO, MDY'");
      expect(await state(source)).toEqual(original);
      expect((await source.query("SELECT hire_date FROM staff_dates WHERE id=1")).rows[0].hire_date).toBeInstanceOf(Date);
    } finally {
      if (originalZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalZone;
      await fixture?.close();
    }
  });
});
