import { describe, expect, it } from "vitest";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { openPeriodontalFixture } from "./_periodontal-fixture";

describe("0102 upgrade from the populated 0101 candidate", () => {
  it("preserves legacy dates, lifecycle and balances, and records no inferred measurements", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles();
      await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0102") });
      for (const [n, status] of ["active", "retention", "completed"].entries()) {
        const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic historic patient') RETURNING id", [`SYN-UPGRADE-${n}`])).rows[0];
        const ortho = (await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status,phase,retainer,retainer_on,start_date) VALUES($1,'synthetic',$2,'finishing','essix',NULL,'2022-01-01') RETURNING id", [patient.id, status])).rows[0];
        await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic historical bridge',$2,'synthetic')", [patient.id, ortho.id]);
      }
      const snapshot = async () => ({ cases: (await f.pool.query("SELECT * FROM ortho_cases ORDER BY id")).rows, bridges: (await f.pool.query("SELECT * FROM clinical_cases ORDER BY id")).rows,
        money: (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening")).rows });
      const before = await snapshot();
      await migrate(f.pool, { apply: true, files });
      expect(await snapshot()).toEqual(before);
      expect((await f.pool.query("SELECT count(*)::int n FROM ortho_facial_revisions")).rows[0].n).toBe(0);
      expect((await f.pool.query("SELECT adopted FROM schema_migrations WHERE version='0102'")).rows).toEqual([{ adopted: false }]);
      await migrate(f.pool, { apply: true, files });
      expect(await snapshot()).toEqual(before);
    } finally { await f.close(); }
  });
  it("refuses an unregistered object collision and preserves the existing canary", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles();
      await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0102") });
      await f.pool.query("CREATE TABLE ortho_facial_revisions(id INTEGER PRIMARY KEY,marker TEXT); INSERT INTO ortho_facial_revisions VALUES(1,'synthetic-unregistered-canary')");
      await expect(migrate(f.pool, { apply: true, files })).rejects.toThrow();
      expect((await f.pool.query("SELECT * FROM ortho_facial_revisions")).rows).toEqual([{ id: 1, marker: "synthetic-unregistered-canary" }]);
      expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version='0102'")).rows).toEqual([]);
    } finally { await f.close(); }
  });
});
