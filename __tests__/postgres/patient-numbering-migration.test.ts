import {expect,it} from "vitest";
import {openBackupTimestampFixture} from "./_backup-timestamp-fixture";
import {loadMigrationFiles,migrate,applyRuntimeMigrationFiles} from "../../lib/migrations";
import {patientNumberingReadiness} from "../../lib/patient-numbering-readiness";
import {inspectSchemaReadOnly} from "../../lib/schema-preflight";

it("adds reserved 0080 after recorded 0081/0082 without rewriting existing identifiers or weakening checksum guards",async()=>{
 const fixture=await openBackupTimestampFixture(process.env);
 try{
  const target=fixture.sqlTarget,files=await loadMigrationFiles();
  const numbering=files.find(file=>file.version==="0080");
  expect(numbering).toBeDefined();if(!numbering)throw new Error("Registered patient numbering migration missing");
  await migrate(target,{apply:true,files:files.filter(file=>file.version!=="0080")});
  expect((await target.query("SELECT version FROM schema_migrations WHERE version IN ('0081','0082') ORDER BY version")).rows).toEqual([{version:"0081"},{version:"0082"}]);
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
  const disclosed=JSON.stringify(blocked);
  expect(disclosed).not.toContain("Synthetic alias");
  expect(disclosed).not.toContain("P-7000");
  expect(disclosed).not.toContain("P-07000");
  expect((await target.query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows).toEqual(before);
  await expect(migrate(target,{apply:true,files})).rejects.toThrow("readiness refused");
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
  expect((await migrate(target,{apply:true,files})).appliedVersions).toEqual(["0080"]);
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
