import { expect, it } from "vitest";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { loadMigrationFiles, migrate, applyRuntimeMigrationFiles } from "../../lib/migrations";

async function historicalRows(pool: Pool) {
  return {
    patients: (await pool.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows,
    invoices: (await pool.query("SELECT id,patient_id,invoice_number,total_minor::text,status FROM invoices ORDER BY id")).rows,
    visits: (await pool.query("SELECT id,patient_id,signed_at::text,signed_by,diagnosis FROM visits ORDER BY id")).rows,
  };
}
async function seed(pool: Pool, suffix: string) {
  const patient=(await pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic existing coverage patient') RETURNING id",[`SYN-0079-${suffix}`])).rows[0].id;
  await pool.query("INSERT INTO invoices(patient_id,invoice_number,total_minor) VALUES($1,$2,250000)",[patient,`SYN-0079-INV-${suffix}`]);
  await pool.query("INSERT INTO visits(patient_name,patient_id,signed_at,signed_by,diagnosis) VALUES('Synthetic historical visit',$1,'2026-01-01T12:34:56.123456Z','synthetic-historical-doctor','Historical unchanged findings')",[patient]);
}
it("adds missing registered 0079 after 0080/0081/0082 via migrator and bounded runtime without adopting hand-installed proposals",async()=>{
  const fixture=await openBackupTimestampFixture(process.env);
  try{
    const files=await loadMigrationFiles(),coverage=files.find(file=>file.version==='0079');
    expect(coverage).toBeDefined();if(!coverage)throw new Error('Registered orthodontic followup coverage migration missing');
    const preceding=files.filter(file=>file.version!=='0079');
    for(const target of [fixture.sqlTarget,fixture.archiveTarget]){
      await migrate(target,{apply:true,files:preceding});
      expect((await target.query("SELECT version FROM schema_migrations WHERE version IN ('0080','0081','0082') ORDER BY version")).rows)
        .toEqual([{version:'0080'},{version:'0081'},{version:'0082'}]);
      expect((await target.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBeNull();
    }
    await seed(fixture.sqlTarget,'migrator');const migratorBefore=await historicalRows(fixture.sqlTarget);
    expect((await migrate(fixture.sqlTarget,{apply:true,files})).appliedVersions).toEqual(['0079']);
    expect(await historicalRows(fixture.sqlTarget)).toEqual(migratorBefore);
    expect((await migrate(fixture.sqlTarget,{apply:true,files})).alreadyUpToDate).toBe(true);

    await seed(fixture.archiveTarget,'runtime');const runtimeBefore=await historicalRows(fixture.archiveTarget);
    const registryBefore=(await fixture.archiveTarget.query("SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version")).rows;
    expect(await applyRuntimeMigrationFiles(fixture.archiveTarget,[coverage])).toEqual(['0079']);
    expect(await historicalRows(fixture.archiveTarget)).toEqual(runtimeBefore);
    expect((await fixture.archiveTarget.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version<>'0079' ORDER BY version")).rows).toEqual(registryBefore);
    for(const target of [fixture.sqlTarget,fixture.archiveTarget]){
      expect((await target.query("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0079'")).rows)
        .toEqual([{name:coverage.name,checksum:coverage.checksum,adopted:false}]);
      expect((await target.query("SELECT count(*)::int AS n FROM ortho_followup_coverage_revisions")).rows[0].n).toBe(0);
      expect((await target.query("SELECT count(*)::int AS n FROM ortho_followup_coverage_rejections")).rows[0].n).toBe(0);
      expect((await target.query("SELECT ortho_followup_coverage_proof FROM visits")).rows).toEqual([{ortho_followup_coverage_proof:null}]);
    }
    expect(await applyRuntimeMigrationFiles(fixture.archiveTarget,[coverage])).toEqual([]);
    await expect(applyRuntimeMigrationFiles(fixture.archiveTarget,[{...coverage,sql:coverage.sql+'\n'}])).rejects.toThrow('SOURCE_MISMATCH');
    await expect(applyRuntimeMigrationFiles(fixture.archiveTarget,[{...coverage,name:'unreviewed_coverage_contract'}])).rejects.toThrow('REGISTRY_MISMATCH');

    // Manual source installation is intentionally NOT an automatic registry adoption.
    await migrate(fixture.source,{apply:true,files:preceding});
    await fixture.source.query(coverage.sql);
    await expect(applyRuntimeMigrationFiles(fixture.source,[coverage])).rejects.toMatchObject({code:'42P07'});
    expect((await fixture.source.query("SELECT version FROM schema_migrations WHERE version='0079'")).rows).toEqual([]);
    expect((await fixture.source.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBe('ortho_followup_coverage_revisions');
  }finally{await fixture.close();}
},180000);
