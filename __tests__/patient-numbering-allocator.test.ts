import {expect,it} from "vitest";
import {PATIENT_NUMBER_SQL} from "../lib/document-numbers";
it("all shared patient insert paths invoke the one concurrency-safe floor allocator",()=>{
  expect(PATIENT_NUMBER_SQL).toBe("aqlan_allocate_patient_number()");
});
