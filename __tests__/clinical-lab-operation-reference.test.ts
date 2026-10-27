import {describe,it,expect} from "vitest";
import {clinicalLabBodyReference,reserveClinicalLabReferenceState as reserve,acknowledgeClinicalLabReferenceState as ack,validClinicalLabReference,readClinicalLabReference} from "../lib/clinical-lab-operation-reference";
import {validateClinicalLabOriginBody} from "../lib/lab-origin-preflight";
import {hasExactLabOriginReceipt} from "../lib/lab-origin-receipt";
const reference={requestKey:"operation-1234",requestHash:"a".repeat(64)};
describe("minimal clinical command evidence",()=>{
 it("stores no clinical body and rejects unexpected data",async()=>{const body=JSON.stringify({notes:"synthetic clinical note",labRequestKey:reference.requestKey});const value=await clinicalLabBodyReference(reference.requestKey,body);expect(Object.keys(value).sort()).toEqual(["requestHash","requestKey"]);expect(JSON.stringify(value)).not.toContain("synthetic");expect(validClinicalLabReference({...value,notes:"private"})).toBe(false);});
 it("preserves unresolved command rather than replacing it",()=>{const first=reserve({revision:0,pending:null},0,reference);expect(reserve(first,0,{...reference,requestKey:"different-key"})).toEqual(first);expect(()=>reserve(first,0,{...reference,requestHash:"b".repeat(64)})).toThrow();});
 it("requires exact acknowledgment and refuses stale tabs",()=>{const first=reserve({revision:0,pending:null},0,reference);expect(()=>ack(first,{...reference,requestHash:"b".repeat(64)})).toThrow();const done=ack(first,reference);expect(done).toEqual({revision:1,pending:null,acknowledged:reference});expect(ack(done,reference)).toEqual(done);expect(()=>reserve(done,0,{...reference,requestKey:"different-key"})).toThrow();});
 it("does not resurrect acknowledged retry",()=>{const done=ack(reserve({revision:0,pending:null},0,reference),reference);expect(reserve(done,0,reference)).toEqual(done);});
 it("fails closed when durable reference storage unavailable",async()=>{await expect(readClinicalLabReference({actor:"test",patientId:1,visitId:1})).rejects.toThrow();});
});
const work={intentId:"11111111-1111-4111-8111-111111111111",memberId:"22222222-2222-4222-8222-222222222222",expectedRevision:0,groupKind:"single",prescription:{partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:"2026-10-25",impressionType:"physical",priority:"normal"}};
describe("sealed invoice lab receipt",()=>{
 const body={items:[{labWork:work}]};const receipt={labWork:[{intentId:work.intentId,orderId:1,revision:1,memberIds:[work.memberId]}]};
 it("requires exact intent, positive order and all stable source members",()=>{expect(hasExactLabOriginReceipt(body,receipt)).toBe(true);expect(hasExactLabOriginReceipt(body,{})).toBe(false);expect(hasExactLabOriginReceipt(body,{labWork:[{...receipt.labWork[0],memberIds:[]}]})).toBe(false);expect(hasExactLabOriginReceipt(body,{labWork:[{...receipt.labWork[0],orderId:0}]})).toBe(false);});
 it("rejects receipt revisions older than sealed expected revision",()=>{expect(hasExactLabOriginReceipt({items:[{labWork:{...work,expectedRevision:3}}]},receipt)).toBe(false);});
 it("preserves legacy absence without inventing lab identity",()=>{expect(hasExactLabOriginReceipt({items:[{}]},{})).toBe(true);});
});

describe("pre-reservation structural lab preflight",()=>{
 const row={serviceId:1,toothCode:27,quantity:1,doctorId:null,planItemId:null,labWork:work};
 const categories=new Map([[1,"crown"]]);
 it("allows incomplete but structurally valid draft",()=>{expect(()=>validateClinicalLabOriginBody({procedures:[row]},categories)).not.toThrow();});
 it("refuses wrong source role, missing source tooth, invalid date and duplicate member before request sealing",()=>{
  for(const patch of [{toothNumbers:"27(Pontic)"},{toothNumbers:"18(Crown)"},{dueDate:"invalid"}])expect(()=>validateClinicalLabOriginBody({procedures:[{...row,labWork:{...work,prescription:{...work.prescription,...patch}}}]},categories)).toThrow();
  expect(()=>validateClinicalLabOriginBody({procedures:[row,row]},categories)).toThrow();
  expect(()=>validateClinicalLabOriginBody({procedures:[{...row,toothCode:null}]},categories)).toThrow();
 });
 it("refuses active/retired membership overlap and revision conflicts",()=>{expect(()=>validateClinicalLabOriginBody({procedures:[row],labRetirements:[{intentId:work.intentId,expectedRevision:0,memberIds:[work.memberId]}]},categories)).toThrow();});
});
