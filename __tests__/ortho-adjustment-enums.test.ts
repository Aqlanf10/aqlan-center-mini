import { expect, it } from "vitest";
import { adjustmentEnumAdmissionError } from "../lib/ortho-adjustment-enum-input";
import { PHASE_LABEL, ELASTIC_LABEL } from "../lib/ortho";
for(const field of ["phase","elastics"] as const){
 it.each([""," ","unknown","constructor","toString","__proto__"," none ",false,123,[],{}])(`${field} refuses explicit invalid %j`,value=>expect(adjustmentEnumAdmissionError({[field]:value})).toBeTypeOf("string"));
 it.each([undefined,null])(`${field} preserves absence/default %j`,value=>expect(adjustmentEnumAdmissionError({[field]:value})).toBeNull());
}
it.each(Object.keys(PHASE_LABEL))("preserves own phase %s and existing writer policy",phase=>expect(adjustmentEnumAdmissionError({phase})).toBeNull());
it.each(Object.keys(ELASTIC_LABEL))("preserves own elastics %s",elastics=>expect(adjustmentEnumAdmissionError({elastics})).toBeNull());
it("keeps omitted enum fields compatible",()=>expect(adjustmentEnumAdmissionError({})).toBeNull());
