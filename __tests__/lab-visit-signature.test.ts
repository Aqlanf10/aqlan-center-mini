import {describe,it,expect} from "vitest";
import {labVisitSignatureVersion} from "../lib/lab-visit-signature";
import type {ProcedureLine} from "../lib/clinical";
const line={id:1,serviceId:4,toothCode:27,surfaces:null,quantity:1,unitPriceMinor:1000,doctorId:2,planItemId:null,note:null,labWork:{intentId:"intent",memberId:"member",expectedRevision:1}} as ProcedureLine;
const snapshot={visitId:7,patientId:9,doctorId:2,billingCurrency:"YER",diagnosis:null,treatmentDone:null,procedures:[line]};
describe("laboratory sign review fence",()=>{
 it("is stable across row ordering",()=>{const two={...line,id:2};expect(labVisitSignatureVersion({...snapshot,procedures:[line,two]})).toBe(labVisitSignatureVersion({...snapshot,procedures:[two,line]}));});
 it.each(["id","serviceId","toothCode","quantity","unitPriceMinor","doctorId"] as const)("invalidates changed %s",key=>expect(labVisitSignatureVersion({...snapshot,procedures:[{...line,[key]:Number(line[key])+1}]})).not.toBe(labVisitSignatureVersion(snapshot)));
 it("invalidates intent revision or member changes",()=>{for(const labWork of [{...line.labWork!,expectedRevision:2},{...line.labWork!,memberId:"another"}])expect(labVisitSignatureVersion({...snapshot,procedures:[{...line,labWork}]})).not.toBe(labVisitSignatureVersion(snapshot));});
});
