import {expect,it} from "vitest";
import {openBackupTimestampFixture} from "./_backup-timestamp-fixture";
import {loadMigrationFiles,migrate,applyRuntimeMigrationFiles,migrationStatus} from "../../lib/migrations";
import {patientNumberingReadiness} from "../../lib/patient-numbering-readiness";
import {inspectSchemaReadOnly} from "../../lib/schema-preflight";

it("adds unchanged reserved 0080 after main 0087 without rewriting existing identifiers or weakening checksum guards",async()=>{
 const fixture=await openBackupTimestampFixture(process.env);
 try{
  const target=fixture.sqlTarget,files=await loadMigrationFiles();
  const numbering=files.find(file=>file.version==="0080");
  expect(numbering).toBeDefined();if(!numbering)throw new Error("Registered patient numbering migration missing");
  await migrate(target,{apply:true,files:files.filter(file=>file.version!=="0080")});
  expect((await target.query("SELECT version FROM schema_migrations WHERE version='0087'")).rows).toEqual([{version:"0087"}]);
  // Registry order is set membership, not max(version): 0080 remains pending after 0087.
  const registryBefore=(await target.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
  const pending=await migrationStatus(target,files);
  expect(pending.pending.map(file=>file.version)).toEqual(["0080"]);
  expect(pending.unknownApplied).toEqual([]);
  expect(pending.checksumMismatches).toEqual([]);
  expect((await migrate(target,{apply:false,files})).appliedVersions).toEqual(["0080"]);
  expect((await target.query("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(registryBefore);
  await target.query("INSERT INTO patients(patient_number,full_name) VALUES('P-00042','Synthetic old file'),('P-7000','Synthetic alias A'),('P-07000','Synthetic alias B')");
  const before=(await target.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows;
  expect(await patientNumberingReadiness(target)).toEqual({ready:false,ambiguousAliasGroups:1});
  const inspect=async()=>{
   const client=await target.connect();
   try{return await inspectSchemaReadOnly(client,files,{patientNumberingReadiness:true});}
   finally{client.release();}
  };
  const blocked=await inspect();
  expect(blocked.patientNumberingReadiness).toEqual({ready:false,ambiguousAliasGroups:1});
  expect(blocked.transaction).toEqual({readOnly:true,isolation:"repeatable read"});
  expect(blocked.registry).toMatchObject({missingVersions:["0080"],unknownVersions:[],checksumMismatches:[],nameMismatches:[],matchesFiles:false});
  const disclosed=JSON.stringify(blocked);
  expect(disclosed).not.toContain("Synthetic alias");
  expect(disclosed).not.toContain("P-7000");
  expect(disclosed).not.toContain("P-07000");
  expect((await target.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows).toEqual(before);
  await expect(migrate(target,{apply:true,files})).rejects.toThrow("readiness refused");
  // Runtime startup uses the same per-migration transaction and must also roll back.
  await expect(applyRuntimeMigrationFiles(target,[numbering])).rejects.toThrow("readiness refused");
  expect((await target.query("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(registryBefore);
  expect((await target.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='patients' AND column_name='patient_number_version'")).rows).toEqual([]);
  expect((await target.query("SELECT to_regprocedure('aqlan_allocate_patient_number()') AS fn")).rows[0].fn).toBeNull();
  expect((await target.query("SELECT to_regclass('patient_numbering_policy') AS relation")).rows[0].relation).toBeNull();
  expect((await target.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows).toEqual(before);
  expect((await target.query("SELECT 1 FROM schema_migrations WHERE version='0080'")).rows).toEqual([]);
  // Exact synthetic ambiguity resolution is explicit; migration itself must never renumber.
  await target.query("UPDATE patients SET patient_number='P-00043' WHERE full_name='Synthetic alias B'");
  const resolved=(await target.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows;
  expect(await patientNumberingReadiness(target)).toEqual({ready:true,ambiguousAliasGroups:0});
  const ready=await inspect();
  expect(ready.patientNumberingReadiness).toEqual({ready:true,ambiguousAliasGroups:0});
  expect(ready.transaction).toEqual({readOnly:true,isolation:"repeatable read"});
  expect((await target.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows).toEqual(resolved);
  expect(await applyRuntimeMigrationFiles(target,[numbering])).toEqual(["0080"]);
  expect((await target.query("SELECT * FROM schema_migrations WHERE version<>'0080' ORDER BY version")).rows).toEqual(registryBefore);
  expect((await inspect()).registry).toMatchObject({missingVersions:[],unknownVersions:[],checksumMismatches:[],nameMismatches:[],matchesFiles:true});
  // Rolling application code back must retain the durable extension: old source is
  // reported as missing provenance for 0080, not permission for a down migration.
  const oldSource=await migrationStatus(target,files.filter(file=>file.version!=="0080"));
  expect(oldSource.unknownApplied.map(row=>row.version)).toEqual(["0080"]);
  expect(oldSource.consistent).toBe(false);
  expect((await target.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows).toEqual(resolved);
  expect((await target.query("SELECT count(*)::int AS n FROM retired_patient_numbers")).rows[0].n).toBe(0);
  expect((await target.query("SELECT aqlan_allocate_patient_number() AS number")).rows[0].number).toBe("P-07001");
  expect((await migrate(target,{apply:true,files})).alreadyUpToDate).toBe(true);
  await expect(applyRuntimeMigrationFiles(target,[numbering])).resolves.toEqual([]);
  await expect(applyRuntimeMigrationFiles(target,[{...numbering,sql:numbering.sql+'\n'}])).rejects.toThrow("SOURCE_MISMATCH");
  await expect(applyRuntimeMigrationFiles(target,[{...numbering,name:"unexpected_contract"}])).rejects.toThrow("REGISTRY_MISMATCH");
  expect((await target.query("SELECT name,checksum,adopted FROM schema_migrations WHERE version='0080'")).rows).toEqual([{name:numbering.name,checksum:numbering.checksum,adopted:false}]);
  // A hand-installed proposal is not silently adopted as a registered release.
  await migrate(fixture.source,{apply:true,files:files.filter(file=>file.version!=="0080")});
  await fixture.source.query(numbering.sql);
  await expect(applyRuntimeMigrationFiles(fixture.source,[numbering])).rejects.toMatchObject({code:"42P07"});
  expect((await fixture.source.query("SELECT 1 FROM schema_migrations WHERE version='0080'")).rows).toEqual([]);
  expect((await fixture.source.query("SELECT to_regclass('patient_numbering_policy') AS relation")).rows[0].relation).toBe("patient_numbering_policy");

 }finally{await fixture.close();}
});
