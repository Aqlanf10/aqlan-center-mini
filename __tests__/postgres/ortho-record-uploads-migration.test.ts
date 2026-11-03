import { describe, expect, it } from "vitest";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { loadMigrationFiles } from "../../lib/migration-files";
import { migrate } from "../../lib/migrations";
describe("0104 additive record provenance upgrade", () => {
  it("preserves existing photos and unknown capture facts without fabricating retrospective upload commands", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles(); await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0104") });
      const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-0104','Synthetic record migration') RETURNING id")).rows[0].id;
      const caseId = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patient])).rows[0].id;
      await f.pool.query("INSERT INTO patient_documents(patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,photo_view,taken_on,photo_stage) VALUES($1,$2,'photo','Synthetic historical unknown','image/png',4,$3,'synthetic-0104.png','synthetic','extraoral_frontal',NULL,NULL)", [patient, caseId, "a".repeat(64)]);
      const snapshot = async () => ({ photos: (await f.pool.query("SELECT * FROM patient_documents ORDER BY id")).rows, cases: (await f.pool.query("SELECT * FROM ortho_cases ORDER BY id")).rows });
      const before = await snapshot(); await migrate(f.pool, { apply: true, files }); expect(await snapshot()).toEqual(before);
      expect((await f.pool.query("SELECT * FROM ortho_record_uploads")).rows).toEqual([]);
      expect((await migrate(f.pool, { apply: true, files })).appliedVersions).toEqual([]);
      expect((await f.pool.query("SELECT adopted FROM schema_migrations WHERE version='0104'")).rows).toEqual([{ adopted: false }]);
    } finally { await f.close(); }
  });
  it("rejects an unregistered table collision without adopting or modifying its data", async () => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = await loadMigrationFiles(); await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0104") });
      await f.pool.query("CREATE TABLE ortho_record_uploads(synthetic_marker text); INSERT INTO ortho_record_uploads VALUES('preserve')");
      await expect(migrate(f.pool, { apply: true, files })).rejects.toThrow();
      expect((await f.pool.query("SELECT * FROM ortho_record_uploads")).rows).toEqual([{ synthetic_marker: "preserve" }]);
      expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version='0104'")).rows).toEqual([]);
      expect((await f.pool.query("SELECT proname FROM pg_proc WHERE proname='check_ortho_record_upload_scope'")).rows).toEqual([]);
    } finally { await f.close(); }
  });
});
