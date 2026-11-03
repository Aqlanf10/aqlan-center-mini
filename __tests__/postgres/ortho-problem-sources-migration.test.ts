import { describe, expect, it } from "vitest";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { loadMigrationFiles } from "../../lib/migration-files";
import { migrate } from "../../lib/migrations";
describe("0105 additive problem source upgrade", () => {
  it("preserves historical problems and unknown sources without fabricating retrospective reviews", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles(); await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0105") });
      const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-0105','Synthetic record migration') RETURNING id")).rows[0].id;
      const caseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patient])).rows[0].id;
      const clinicalCaseId = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic existing bridge',$2,'synthetic') RETURNING id", [patient, caseId])).rows[0].id;
      await f.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,site,specialty,noted_by) VALUES($1,$2,'Synthetic existing reviewed problem',NULL,'orthodontics','synthetic')", [patient, clinicalCaseId]);
      const snapshot = async () => ({ problems: (await f.pool.query("SELECT * FROM patient_problems ORDER BY id")).rows, cases: (await f.pool.query("SELECT * FROM ortho_cases ORDER BY id")).rows });
      const before = await snapshot(); await migrate(f.pool, { apply: true, files }); expect(await snapshot()).toEqual(before);
      expect((await f.pool.query("SELECT * FROM ortho_problem_source_reviews")).rows).toEqual([]);
      expect((await migrate(f.pool, { apply: true, files })).appliedVersions).toEqual([]);
      expect((await f.pool.query("SELECT adopted FROM schema_migrations WHERE version='0105'")).rows).toEqual([{ adopted: false }]);
    } finally { await f.close(); }
  });
  it("rejects an unregistered table collision without adopting or modifying its data", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles(); await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0105") });
      await f.pool.query("CREATE TABLE ortho_problem_source_reviews(synthetic_marker text); INSERT INTO ortho_problem_source_reviews VALUES('preserve')");
      await expect(migrate(f.pool, { apply: true, files })).rejects.toThrow();
      expect((await f.pool.query("SELECT * FROM ortho_problem_source_reviews")).rows).toEqual([{ synthetic_marker: "preserve" }]);
      expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version='0105'")).rows).toEqual([]);
      expect((await f.pool.query("SELECT proname FROM pg_proc WHERE proname='check_ortho_problem_source_scope'")).rows).toEqual([]);
    } finally { await f.close(); }
  });
});
