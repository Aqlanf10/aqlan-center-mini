import {expect,it,vi} from "vitest";
import {STAFF_AUTHORIZATION_POLICY_VERSION,STAFF_CAPABILITY_SCHEMA_VERSION,type StaffCapabilityDocument} from "../lib/staff-capability-catalogue";
import {hasStaffCapability,ownerContextFromTrustedBinding,resolveStaffCapabilities,parseStaffCapabilityDocument} from "../lib/staff-capabilities";
import {staffOperationReferenceCapabilities,staffOperationIdentity,assertStaffOperation} from "../lib/staff-operation-runtime";
const document=(grants:StaffCapabilityDocument["grants"]={}):StaffCapabilityDocument=>({schemaVersion:1,revision:1,patientScope:"none",appointmentScope:"none",grants});
const subject={userId:17,role:"doctor",isActive:true,clinicianPartyId:null};
const resolve=(grants:StaffCapabilityDocument["grants"])=>resolveStaffCapabilities({subject,permissionDocument:document(grants)});
it("changes policy semantics without changing schema1 documents or inferring creation",()=>{
 expect(STAFF_AUTHORIZATION_POLICY_VERSION).toBe(4);expect(STAFF_CAPABILITY_SCHEMA_VERSION).toBe(1);
 const old=document({"inventory.references.view":true});expect(parseStaffCapabilityDocument(old)).toMatchObject({ok:true,value:old});
 const access=resolveStaffCapabilities({subject,permissionDocument:old});expect(hasStaffCapability(access,"inventory.references.view")).toBe(true);expect(hasStaffCapability(access,"inventory.items.create")).toBe(false);
 expect(old.grants).toEqual({"inventory.references.view":true});
});
it("requires explicit view prerequisite for create and never grants other inventory writes",()=>{
 expect(parseStaffCapabilityDocument(document({"inventory.items.create":true})).ok).toBe(false);
 const access=resolve({"inventory.references.view":true,"inventory.items.create":true});
 expect(hasStaffCapability(access,"inventory.items.create")).toBe(true);
 for(const action of ["inventory.items.edit","inventory.items.disable","inventory.purchases.create","inventory.suppliers.view"])expect(hasStaffCapability(access,action)).toBe(false);
 expect(hasStaffCapability(resolve({"inventory.references.view":true,"inventory.items.create":false}),"inventory.items.create")).toBe(false);
});
it("does not infer admin grants; protected owner authority remains explicit",()=>{
 expect(hasStaffCapability(resolveStaffCapabilities({subject:{...subject,role:"admin"},permissionDocument:document()}),"inventory.items.create")).toBe(false);
 const owner=ownerContextFromTrustedBinding({ownerUserId:17,bindingVersion:"synthetic-explicit-binding"});
 expect(hasStaffCapability(resolveStaffCapabilities({subject,permissionDocument:document()},owner),"inventory.items.create")).toBe(true);
});
it("arbitrary projection/handle cannot preview or authorize SQL",async()=>{
 const client={query:vi.fn(),release:vi.fn()};
 for(const handle of [{},{userId:17,role:"admin",allowedActions:["inventory.items.create"]}]){
  await expect(Reflect.apply(staffOperationReferenceCapabilities,undefined,[client,handle,"public"])).rejects.toThrow("HANDLE_INVALID");
  await expect(Reflect.apply(staffOperationIdentity,undefined,[client,handle,"inventory.items.create","public"])).rejects.toThrow("HANDLE_INVALID");
  await expect(Reflect.apply(assertStaffOperation,undefined,[client,handle,"inventory.items.create","public"])).rejects.toThrow("HANDLE_INVALID");
 }
 expect(client.query).not.toHaveBeenCalled();
});
