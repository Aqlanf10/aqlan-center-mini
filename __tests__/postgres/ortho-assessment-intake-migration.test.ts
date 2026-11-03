import { describe, expect, it } from "vitest";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { openPeriodontalFixture } from "./_periodontal-fixture";

describe("0103 upgrade of populated treatment records", () => {
  it("preserves all prior lifecycle states, unknown retention dates, agreement installments and opening balances", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles();
      await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0103") });
      for (const [index, status] of ["active", "retention", "completed", "discontinued"].entries()) {
        const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic 0103 upgrade') RETURNING id", [`SYN-UPGRADE-0103-${index}`])).rows[0].id;
        const plan = (await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'Synthetic existing agreement',900000) RETURNING id", [patient])).rows[0].id;
        await f.pool.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-12-01',900000)", [plan]);
        await f.pool.query("INSERT INTO patient_opening_balances(patient_id,amount_minor,as_of_date,note) VALUES($1,12000,'2025-01-01','Synthetic historic balance')", [patient]);
        const ortho = (await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status,phase,retainer,retainer_on,start_date,plan_id) VALUES($1,'synthetic',$2,'finishing','essix',NULL,'2022-01-01',$3) RETURNING id", [patient, status, plan])).rows[0].id;
        await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic existing bridge',$2,'synthetic')", [patient, ortho]);
      }
      const snapshot = async () => {
        const result: Record<string, unknown> = {};
        for (const table of ["ortho_cases", "clinical_cases", "treatment_plans", "plan_installments", "patient_opening_balances", "invoices", "payments", "ortho_assessment_revisions"]) {
          result[table] = (await f.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
        }
        return result;
      };
      const before = await snapshot();
      await migrate(f.pool, { apply: true, files });
      expect(await snapshot()).toEqual(before);
      expect((await f.pool.query("SELECT * FROM ortho_case_intake_events")).rows).toEqual([]);
      expect((await f.pool.query("SELECT adopted FROM schema_migrations WHERE version='0103'")).rows).toEqual([{ adopted: false }]);
      await migrate(f.pool, { apply: true, files });
      expect(await snapshot()).toEqual(before);
      // New nullable fields do not relax the treatment branch of the CHECK.
      await expect(f.pool.query("UPDATE ortho_cases SET start_date=NULL WHERE status='active'")).rejects.toThrow("ortho_assessment_state_check");
      expect(await snapshot()).toEqual(before);
    } finally { await f.close(); }
  });
  it("rolls back every nullable-column change if an unregistered intake table collides", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles();
      await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0103") });
      await f.pool.query("CREATE TABLE ortho_case_intake_events(id INTEGER PRIMARY KEY,marker TEXT); INSERT INTO ortho_case_intake_events VALUES(1,'synthetic-unknown-object')");
      await expect(migrate(f.pool, { apply: true, files })).rejects.toThrow();
      expect((await f.pool.query("SELECT * FROM ortho_case_intake_events")).rows).toEqual([{ id: 1, marker: "synthetic-unknown-object" }]);
      expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version='0103'")).rows).toEqual([]);
      const columns = await f.pool.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='ortho_cases' AND column_name IN ('appliance','arches','slot','start_date','planned_months')");
      expect(columns.rows).toHaveLength(5); expect(columns.rows.every(row => row.is_nullable === "NO")).toBe(true);
    } finally { await f.close(); }
  });
  it("refuses an incompatible historical state without guessing a repair or leaving a partial migration", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles();
      await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0103") });
      const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-UNKNOWN-0103','Synthetic unknown state') RETURNING id")).rows[0].id;
      await f.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status,phase) VALUES($1,'synthetic','assessment','aligning')", [patient]);
      const before = (await f.pool.query("SELECT * FROM ortho_cases")).rows;
      await expect(migrate(f.pool, { apply: true, files })).rejects.toThrow();
      expect((await f.pool.query("SELECT * FROM ortho_cases")).rows).toEqual(before);
      expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version='0103'")).rows).toEqual([]);
      expect((await f.pool.query("SELECT to_regclass('public.ortho_case_intake_events') AS relation")).rows).toEqual([{ relation: null }]);
    } finally { await f.close(); }
  });
});
