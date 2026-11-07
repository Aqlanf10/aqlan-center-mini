import { describe, expect, it } from "vitest";
import { adjustmentCommandStorageKey, createAdjustmentCommand, completeAdjustmentCommand, isAdjustmentReceipt,
  adjustmentNewCommandError, readAdjustmentCommand, retireAdjustmentCommand } from "../lib/ortho-adjustment-command";
const scope = { patientId: 19, caseId: 41, authority: '["synthetic","doctor"]' };
const body = { doneOn: "2026-11-05", upperWire: "", lowerWire: "", elastics: "none", elasticNote: "", done: "synthetic", nextWeeks: 4 };
function storage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}
describe("clinical adjustment command persistence", () => {
  it("retains exact serialized body and key, rejects replacement/retirement until verified ack", () => {
    const store = storage(); const command = createAdjustmentCommand(store, scope, body);
    expect(readAdjustmentCommand(store, scope)).toEqual(command);
    expect(() => createAdjustmentCommand(store, scope, body)).toThrow();
    expect(() => retireAdjustmentCommand(store, command)).toThrow();
    const receipt = { id: 81, patientId: 19, caseId: 41, requestKey: command.key, visitId: null, attachedToToday: false };
    const saved = completeAdjustmentCommand(store, command, receipt);
    expect(readAdjustmentCommand(store, scope)?.receipt).toEqual(receipt);
    retireAdjustmentCommand(store, saved);
    expect(createAdjustmentCommand(store, scope, body).key).not.toBe(command.key);
  });
  it.each(["id", "patientId", "caseId", "requestKey", "visitId", "attachedToToday"])("rejects wrong receipt %s", (field) => {
    const command = createAdjustmentCommand(storage(), scope, body);
    const receipt = { id: 81, patientId: 19, caseId: 41, requestKey: command.key, visitId: null, attachedToToday: false, [field]: "invalid" };
    expect(isAdjustmentReceipt(receipt, command)).toBe(false);
  });
  it("accepts explicit-visit receipt without claiming automatic today attachment", () => {
    const command = createAdjustmentCommand(storage(), scope, body);
    expect(isAdjustmentReceipt({ id: 81, patientId: 19, caseId: 41, requestKey: command.key, visitId: 61, attachedToToday: false }, command)).toBe(true);
  });
  it("rejects foreign authority and missing receipt state even under the expected storage key", () => {
    const store = storage(); const command = createAdjustmentCommand(store, scope, body);
    store.setItem(adjustmentCommandStorageKey(scope), JSON.stringify({ ...command, scope: { ...scope, authority: "foreign" } }));
    expect(() => readAdjustmentCommand(store, scope)).toThrow();
    store.setItem(adjustmentCommandStorageKey(scope), JSON.stringify({ ...command, receipt: undefined }));
    expect(() => readAdjustmentCommand(store, scope)).toThrow();
  });
});

describe("new adjustment authoring preserves complete text",()=>{
 it.each([["upperWire",40],["lowerWire",40],["elasticNote",120],["done",400]] as const)("rejects oversized %s before durable state exists",(field,limit)=>{
  const store=storage(), input={...body,[field]:"ع".repeat(limit+1)};
  expect(adjustmentNewCommandError(input)).toContain(String(limit));
  expect(()=>createAdjustmentCommand(store,scope,input)).toThrow();
  expect(readAdjustmentCommand(store,scope)).toBeNull();
  expect(input[field]).toBe("ع".repeat(limit+1));
  expect(createAdjustmentCommand(store,scope,{...body,[field]:"ع".repeat(limit)}).receipt).toBeNull();
 });
 it.each([["upperWire",40],["lowerWire",40],["elasticNote",120],["done",400]] as const)("retains exact boundary %s and surrounding whitespace",(field,limit)=>{
  const input={...body,[field]:"  "+"x".repeat(limit)+"  "};
  expect(adjustmentNewCommandError(input)).toBeNull();
  expect(JSON.parse(createAdjustmentCommand(storage(),scope,input).body)).toEqual(input);
 });
 it("does not reinterpret or rewrite an old oversized frozen command or receipt",()=>{
  const store=storage(), command=createAdjustmentCommand(store,scope,body);
  const old={...command,body:JSON.stringify({...body,done:"x".repeat(401)})};
  store.setItem(adjustmentCommandStorageKey(scope),JSON.stringify(old));
  expect(readAdjustmentCommand(store,scope)).toEqual(old);
  const saved=completeAdjustmentCommand(store,old,{id:81,patientId:19,caseId:41,requestKey:old.key,visitId:null,attachedToToday:false});
  expect(saved.body).toBe(old.body); expect(saved.key).toBe(old.key);
  expect(readAdjustmentCommand(store,scope)).toEqual(saved);
 });
});
