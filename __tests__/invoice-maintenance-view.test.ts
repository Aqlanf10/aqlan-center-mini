import { describe, expect, it } from "vitest";
import {
  durableInvoiceMaintenance, restoreInvoiceMaintenance, readInvoiceMaintenanceReceipt,
  readInvoiceMaintenanceRejection, type InvoiceMaintenanceCommand,
} from "../lib/invoice-maintenance-view";

const hash = "a".repeat(64);
function addition(): InvoiceMaintenanceCommand {
  return {operation:"add-service",key:"synthetic-add-01",actor:"synthetic-admin",patientId:9,invoiceId:10,
    body:JSON.stringify({idempotencyKey:"synthetic-add-01",expectedSourceHash:hash,serviceId:5,doctorId:6,price:"150",discount:"10",currency:"YER",reason:"Synthetic extra treatment"}),
    expected:{kind:"add-service",currency:"YER",invoiceNumber:"INV-SYN-10",addedNetMinor:140,requestHash:hash,sourceVisitIds:[12]},outcome:"pending",message:""};
}
function archived(action:"archive"|"restore"="archive"): InvoiceMaintenanceCommand {
  return {operation:"archive",key:"synthetic-archive-01",actor:"synthetic-admin",patientId:9,invoiceId:10,
    body:JSON.stringify({idempotencyKey:"synthetic-archive-01",expectedVersion:2,action,reason:"Synthetic archive reason"}),
    expected:{kind:"archive",currency:"YER",invoiceNumber:"INV-SYN-10",action,expectedVersion:2,reason:"Synthetic archive reason"},outcome:"pending",message:""};
}
const addReceipt = () => ({originalInvoiceId:10,additionalInvoiceId:11,additionalInvoiceNumber:"INV-SYN-11",additionalCreatedAt:"2026-10-26T10:00:00Z",patientId:9,currency:"YER",addedNetMinor:140,sourceVisitIds:[12],idempotencyKey:"synthetic-add-01",requestHash:hash,createdBy:"synthetic-admin",cashMovementMinor:0,clinical:{planId:null,links:[{line:0,kind:"financial",planItemId:null,caseId:null}]},replayed:false});
const current = (version=3,archived=true) => ({invoiceId:10,patientId:9,invoiceNumber:"INV-SYN-10",currency:"YER",status:"paid",version,archived,latest:null,readiness:"ready",eligibility:{canArchive:true,code:null,message:null,remainingMinor:0}});
function archiveReceipt() {
  return {acknowledgment:{idempotencyKey:"synthetic-archive-01",action:"archive",expectedVersion:2,actor:"synthetic-admin",invoiceId:10,patientId:9},
    receipt:{eventId:"42",invoiceId:10,patientId:9,invoiceNumber:"INV-SYN-10",invoiceCreatedAt:"2026-10-25T10:00:00Z",currency:"YER",version:3,action:"archive",archived:true,reason:"Synthetic archive reason",idempotencyKey:"synthetic-archive-01",actorUserId:1,actor:"synthetic-admin",at:"2026-10-26T10:00:00Z"},
    current:current(),replayed:false,noop:false};
}
describe("invoice maintenance durable intent and exact acknowledgement",()=>{
  it.each([addition,archived])("restores exact body/key and marks outcome uncertain",factory=>{
    const command=factory();const restored=restoreInvoiceMaintenance(durableInvoiceMaintenance(command),9,"synthetic-admin");
    expect(restored).toMatchObject({key:command.key,body:command.body,outcome:"uncertain"});
  });
  it("rejects another patient, actor or modified stored body",()=>{
    const saved=durableInvoiceMaintenance(addition());
    expect(()=>restoreInvoiceMaintenance(saved,19,"synthetic-admin")).toThrow();
    expect(()=>restoreInvoiceMaintenance(saved,9,"another-admin")).toThrow();
    expect(()=>restoreInvoiceMaintenance({...saved,payload:JSON.stringify({...addition(),body:addition().body.replace('"150"','"300"')})},9,"synthetic-admin")).toThrow();
  });
  it("accepts the distinct dated final invoice only",()=>{
    expect(readInvoiceMaintenanceReceipt(addReceipt(),addition())).toMatchObject({invoiceId:11,invoiceNumber:"INV-SYN-11"});
    expect(readInvoiceMaintenanceReceipt({...addReceipt(),additionalInvoiceId:10},addition())).toBeNull();
  });
  it.each([{patientId:99},{createdBy:"another-admin"},{idempotencyKey:"another-key-01"},{addedNetMinor:141},{requestHash:"b".repeat(64)},{cashMovementMinor:1},{sourceVisitIds:[13]},{currency:"SAR"}])("does not clear recovery for mismatched additional receipt %j",patch=>{
    expect(readInvoiceMaintenanceReceipt({...addReceipt(),...patch},addition())).toBeNull();
  });
  it("accepts exact old archive replay while showing newer restored state",()=>{
    const receipt={...archiveReceipt(),replayed:true,current:current(4,false)};
    expect(readInvoiceMaintenanceReceipt(receipt,archived())).toMatchObject({archived:false,version:4});
  });
  it("validates no-op against current version and explicit request acknowledgement",()=>{
    const receipt={...archiveReceipt(),noop:true,current:current(2,true),receipt:null};
    expect(readInvoiceMaintenanceReceipt(receipt,archived())).not.toBeNull();
    expect(readInvoiceMaintenanceReceipt({...receipt,current:current(3,true)},archived())).toBeNull();
    expect(readInvoiceMaintenanceReceipt({...receipt,acknowledgment:{...receipt.acknowledgment,idempotencyKey:"different-01"}},archived())).toBeNull();
  });
  it("keeps uncertain requests unless durable rejection matches original intent",()=>{
    const rejection={code:"stale",terminal:true,idempotencyKey:"synthetic-add-01",requestHash:hash,message:"Synthetic stale preview"};
    expect(readInvoiceMaintenanceRejection(rejection,addition())).toBe("Synthetic stale preview");
    expect(readInvoiceMaintenanceRejection({...rejection,terminal:false},addition())).toBeNull();
    expect(readInvoiceMaintenanceRejection({...rejection,requestHash:"b".repeat(64)},addition())).toBeNull();
  });
  it("retires archive only on an exact monotonic version-advanced proof",()=>{
    const command=archived(),refusal={kind:"version_advanced",invoiceId:10,patientId:9,actor:"synthetic-admin",idempotencyKey:command.key,action:"archive",reason:"Synthetic archive reason",expectedVersion:2,currentVersion:4};
    expect(readInvoiceMaintenanceRejection({code:"stale",message:"Synthetic version advanced",refusal},command)).toBe("Synthetic version advanced");
    for(const patch of [{currentVersion:2},{patientId:11},{expectedVersion:1},{reason:"Another reason"},{actor:"another"}])
      expect(readInvoiceMaintenanceRejection({code:"stale",message:"Synthetic version advanced",refusal:{...refusal,...patch}},command)).toBeNull();
  });
  it.each(["period_locked","policy_decision_required"])("retires exact durable %s refusal but not generic or mismatched replies",code=>{
    const command=archived(),refusal={kind:"durable_rejection",invoiceId:10,patientId:9,actor:command.actor,idempotencyKey:command.key,action:"archive",reason:"Synthetic archive reason",expectedVersion:2,currentVersion:2};
    expect(readInvoiceMaintenanceRejection({code,message:"Synthetic durable refusal",refusal},command)).toBe("Synthetic durable refusal");
    expect(readInvoiceMaintenanceRejection({code,message:"Generic conflict"},command)).toBeNull();
    for(const patch of [{currentVersion:3},{invoiceId:12},{patientId:11},{expectedVersion:1},{reason:"Another reason"},{actor:"another"},{idempotencyKey:"another-key"},{action:"restore"},{kind:"version_advanced"}])
      expect(readInvoiceMaintenanceRejection({code,message:"Synthetic refusal",refusal:{...refusal,...patch}},command)).toBeNull();
  });

});
