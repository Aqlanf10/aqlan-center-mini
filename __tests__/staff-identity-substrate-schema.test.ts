import { expect, it } from "vitest";
import { staffIdentitySchemaName, staffIdentitySubstrateSql } from "../lib/staff-identity-substrate-schema.mjs";
it("accepts only literal allowlisted schema strings without coercion",()=>{
 expect(staffIdentitySchemaName()).toBe("public");
 expect(staffIdentitySchemaName("public")).toBe("public");
 expect(staffIdentitySchemaName("aqlan_identity_0123456789abcdef")).toBe("aqlan_identity_0123456789abcdef");
 let calls=0;
 const deceptive={toString(){calls++;return calls===1?"public":"public; DROP SCHEMA public";}};
 for(const value of [deceptive,null,0,true,Symbol("public"),[],{},"PUBLIC","public;","aqlan_identity_0123"])
  expect(()=>staffIdentitySchemaName(value)).toThrow("STAFF_IDENTITY_SCHEMA_INVALID");
 expect(calls).toBe(0);
 expect(staffIdentitySubstrateSql("public")).toContain("CREATE TABLE public.staff_identity_generations");
});
