import { describe, expect, it } from "vitest";
import { parsePatientNumber, parseNumberingFloor, parseNumberingVersion, numberingReason } from "../lib/patient-numbering";
import { validatePortalLogin } from "../lib/portal";
describe("patient file number command parsing", () => {
  it("portal login accepts every supported full-width file number",()=>{
    expect(validatePortalLogin({phone:"777000111",patientNumber:"P-9223372036854775807"})).toMatchObject({ok:true});
  });
  it("retains the fixed prefix and full bigint width", () => {
    expect(parsePatientNumber("7000")).toBe("P-07000");
    expect(parsePatientNumber("P-0007000")).toBe("P-07000");
    expect(parsePatientNumber("100000")).toBe("P-100000");
    expect(parsePatientNumber("9223372036854775807")).toBe("P-9223372036854775807");
  });
  it.each([null, 7000, "0", "-1", "1e4", "1.5", "P-1'", "A-07000", "9223372036854775808", "9".repeat(1000)])("rejects invalid identifier %s", (value) => expect(parsePatientNumber(value)).toBeNull());
  it("allows explicit edits below the new-file floor but never lowers the floor", () => {
    expect(parsePatientNumber("42")).toBe("P-00042");
    expect(parseNumberingFloor("6999")).toBeNull();
    expect(parseNumberingFloor("7000")).toBe("7000");
    expect(parseNumberingFloor("9223372036854775808")).toBeNull();
  });
  it("requires exact positive versions and a bounded reason", () => {
    expect(parseNumberingVersion("1")).toBe("1");
    expect(parseNumberingVersion(1)).toBeNull();
    expect(parseNumberingVersion("01")).toBeNull();
    expect(numberingReason("  corrected paper file  ")).toBe("corrected paper file");
    expect(numberingReason("  ")).toBeNull();
    expect(numberingReason("a".repeat(301))).toBeNull();
  });
});

import { patientNumberSequenceRestoreSql } from "../lib/patient-numbering-backup";
it("validates every sequence literal before building monotonic restoration SQL",()=>{
  expect(patientNumberSequenceRestoreSql("7000",true)).toContain("GREATEST(last_value, 7000::bigint)");
  expect(patientNumberSequenceRestoreSql("7000",false)).toContain("last_value = 7000::bigint AND is_called");
  for(const value of ["0","1;DROP TABLE patients","9223372036854775808",7000,null])expect(()=>patientNumberSequenceRestoreSql(value,true)).toThrow();
});

import { patientNumberingReadiness } from "../lib/patient-numbering-readiness";
it("predeployment readiness only reads counts and refuses ambiguous aliases",async()=>{
 let sql="";const client={query:async(text:string)=>{sql=text;return {rows:[{ambiguous_alias_groups:2}]};}};
 expect(await patientNumberingReadiness(client)).toEqual({ready:false,ambiguousAliasGroups:2});
 expect(sql).toContain("FROM public.patients"); // Preflight deliberately restricts search_path to pg_catalog.
 expect(sql.trim().startsWith("SELECT")).toBe(true);expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALTER|CREATE|DROP/);
 expect(await patientNumberingReadiness({query:async()=>({rows:[{ambiguous_alias_groups:0}]})})).toEqual({ready:true,ambiguousAliasGroups:0});
});
