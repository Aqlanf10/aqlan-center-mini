import {describe,it,expect} from "vitest";
import {adjustmentTextAdmissionError} from "../lib/ortho-adjustment-text-input";
describe("new HTTP adjustment text admission",()=>{
 it.each([["upperWire",40],["lowerWire",40],["elasticNote",120],["done",400],["note",300]] as const)("bounds %s without coercion",(field,limit)=>{
  expect(adjustmentTextAdmissionError({[field]:" "+"ع".repeat(limit)+" "})).toBeNull();
  expect(adjustmentTextAdmissionError({[field]:"ع".repeat(limit+1)})).not.toBeNull();
  for(const value of [false,1,{},[],undefined]) expect(adjustmentTextAdmissionError({[field]:value})).not.toBeNull();
  for(const value of [null,"","  "]) expect(adjustmentTextAdmissionError({[field]:value})).toBeNull();
 });
 it("accepts omission and cannot be bypassed by a request-shaped body property",()=>{
  expect(adjustmentTextAdmissionError({})).toBeNull();
  expect(adjustmentTextAdmissionError({done:"x".repeat(401),newTextAdmissionError:null,request:{newTextAdmissionError:null}})).not.toBeNull();
 });
});
