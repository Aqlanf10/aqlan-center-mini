import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PATIENT_NUMBERING_SQL } from "../lib/patient-numbering-schema";
import { checksumOf, loadMigrationFiles } from "../lib/migration-files";
import { RESET_KEEP_TABLES, RESET_SEQUENCES, RESET_WIPE_TABLES } from "../lib/clinic-reset";
it("registers exact 0080 bytes between reconciliation and already published reminder metadata",async()=>{
 const files=await loadMigrationFiles();
 expect(checksumOf(PATIENT_NUMBERING_SQL)).toBe("b2bee7694f0781775bbddeea3715cb16ab701f4ee3fd748785ef1016c0f2e10a");
 expect(readFileSync("migrations/0080_patient_numbering.sql","utf8")).toBe(PATIENT_NUMBERING_SQL);
 expect(files.filter(file=>file.version>="0078").map(file=>file.version)).toEqual(["0078","0080","0087"]);
 expect(files.find(file=>file.version==="0080")).toEqual({version:"0080",name:"patient_numbering",filename:"0080_patient_numbering.sql",sql:PATIENT_NUMBERING_SQL,checksum:checksumOf(PATIENT_NUMBERING_SQL)});
 const runtime=readFileSync("lib/db.ts","utf8");
 expect(runtime).toContain('version: "0080", name: "patient_numbering", filename: "0080_patient_numbering.sql", sql: PATIENT_NUMBERING_SQL, checksum: checksumOf(PATIENT_NUMBERING_SQL)');
 expect(runtime.indexOf('version: "0078"')).toBeLessThan(runtime.indexOf('version: "0080"'));
 expect(runtime.indexOf('version: "0080"')).toBeLessThan(runtime.indexOf('version: "0087"'));
 expect(PATIENT_NUMBERING_SQL).not.toMatch(/UPDATE patients SET|DISABLE TRIGGER|DELETE FROM patients/);
});
it("never resets patient-number sequence or removes identifier history",()=>{
 expect(RESET_SEQUENCES).not.toContain("patient_number_seq");
 for(const table of ["retired_patient_numbers","patient_numbering_policy"]){expect(RESET_KEEP_TABLES).toContain(table);expect(RESET_WIPE_TABLES).not.toContain(table);}
});
it("exposes count-only readiness in the bounded read-only preflight path",()=>{
 expect(readFileSync("scripts/db-preflight.ts","utf8")).toContain('--patient-numbering-readiness');
 expect(readFileSync("lib/schema-preflight.ts","utf8")).toContain('report.patientNumberingReadiness = await patientNumberingReadiness(client)');
});
