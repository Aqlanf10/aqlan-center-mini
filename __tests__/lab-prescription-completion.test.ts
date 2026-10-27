import { describe, expect, it } from "vitest";
import { dispatchOrder } from "./fixtures/lab-dispatch";
import { toLabDispatchExternal } from "../lib/lab";
import { validateLabPrescription, labPrescriptionVersion, hasPostedLabPayable, assertAutoLabSource } from "../lib/lab-prescription-input";
const valid = { partyId: 47, shade: "A2", stumpShade: "", toothNumbers: "27(Abutment), 26(Pontic), 25(Abutment)", dueDate: "2026-11-01", impressionType: "digital_scan", priority: "normal" } as const;
describe("same-order lab prescription completion", () => {
 it("does not claim a posting preference is an actual posted liability",()=>{
  expect(hasPostedLabPayable({isPosted:true,payableId:null})).toBe(false);
  expect(hasPostedLabPayable({isPosted:false,payableId:12})).toBe(false);
  expect(hasPostedLabPayable({isPosted:true,payableId:12})).toBe(true);
 });
 it("saves an incomplete draft but refuses to dispatch it",()=>{
  const draft={...valid,partyId:null,shade:"",toothNumbers:""};
  expect(validateLabPrescription(draft,false)).toEqual(draft);
  expect(()=>validateLabPrescription(draft,true)).toThrow();
 });
 it("retains the original tooth and compatible source work roles",()=>{
  const source={source:"auto",tooth_code:27,work_type:"جسر"};
  expect(()=>assertAutoLabSource(valid,source)).not.toThrow();
  expect(()=>assertAutoLabSource({...valid,toothNumbers:"18(Crown)"},source)).toThrow();
  expect(()=>assertAutoLabSource({...valid,toothNumbers:"27(Crown)"},source)).toThrow();
 });
 it("accepts explicit provider, standardized shade and tooth roles", () => expect(validateLabPrescription(valid)).toMatchObject({ partyId:47, shade:"A2" }));
 it.each([{partyId:null},{shade:""},{shade:"patient secret"},{toothNumbers:"27"},{toothNumbers:"27(Crown),27(Pontic)"},{toothNumbers:"29(Crown)"},{toothNumbers:"27(Crown) secret"},{dueDate:"2026-02-30"},{cost:500},{status:"sent"},{patientId:1}])("rejects incomplete/unsafe/unknown fields %j", change => expect(()=>validateLabPrescription({...valid,...change})).toThrow());
 it("fences stale clinical metadata without reading private or financial fields", () => {
  const order = dispatchOrder();
  expect(labPrescriptionVersion(order)).not.toContain(order.patientName);
  const costOnly = {...order,costMinor:99};
  expect(labPrescriptionVersion(order)).toBe(labPrescriptionVersion(costOnly));
  expect(labPrescriptionVersion(order)).not.toBe(labPrescriptionVersion({...order,shade:"A3"}));
 });
 it("never labels an unsent auto order with a dispatch date", () => expect(toLabDispatchExternal(dispatchOrder({status:"needed"})).sentDate).toBe("لم يُرسل بعد"));
});
