import {expect,it,vi} from "vitest";
import {STAFF_AUTHORIZATION_POLICY_VERSION,STAFF_CAPABILITY_SCHEMA_VERSION,type StaffCapabilityDocument} from "../lib/staff-capability-catalogue";
import {hasStaffCapability,ownerContextFromTrustedBinding,resolveStaffCapabilities,parseStaffCapabilityDocument} from "../lib/staff-capabilities";
import {staffOperationReferenceCapabilities,assertStaffOperation} from "../lib/staff-operation-runtime";
const actions=["inventory.units.revise","inventory.locations.create"] as const;
const document=(grants:StaffCapabilityDocument["grants"]={}):StaffCapabilityDocument=>({schemaVersion:1,revision:1,patientScope:"none",appointmentScope:"none",grants});
const subject={userId:17,role:"doctor",isActive:true,clinicianPartyId:null};
const resolve=(grants:StaffCapabilityDocument["grants"])=>resolveStaffCapabilities({subject,permissionDocument:document(grants)});
it("policy4 keeps schema1 and old item grants unchanged without new implied access",()=>{
 expect(STAFF_AUTHORIZATION_POLICY_VERSION).toBe(4);expect(STAFF_CAPABILITY_SCHEMA_VERSION).toBe(1);
 const old=document({"inventory.references.view":true,"inventory.items.create":true});
 expect(parseStaffCapabilityDocument(old)).toMatchObject({ok:true,value:old});
 const access=resolveStaffCapabilities({subject,permissionDocument:old});
 expect(hasStaffCapability(access,"inventory.items.create")).toBe(true);
 for(const action of actions)expect(hasStaffCapability(access,action)).toBe(false);
 expect(old.grants).toEqual({"inventory.references.view":true,"inventory.items.create":true});
});
it.each(actions)("%s requires only explicit view and its own grant, never item creation",action=>{
 expect(parseStaffCapabilityDocument(document({[action]:true})).ok).toBe(false);
 const grants={"inventory.references.view":true,[action]:true};
 expect(parseStaffCapabilityDocument(document(grants)).ok).toBe(true);
 const access=resolve(grants);
 expect(hasStaffCapability(access,action)).toBe(true);
 expect(hasStaffCapability(access,"inventory.items.create")).toBe(false);
 for(const other of actions.filter(a=>a!==action))expect(hasStaffCapability(access,other)).toBe(false);
 expect(hasStaffCapability(resolve({"inventory.references.view":true,[action]:false}),action)).toBe(false);
 expect(hasStaffCapability(access,"inventory.policy.revise")).toBe(false);
});
it("admin does not infer grants and protected owner behavior remains explicit",()=>{
 const admin=resolveStaffCapabilities({subject:{...subject,role:"admin"},permissionDocument:document()});
 const owner=resolveStaffCapabilities({subject,permissionDocument:document()},ownerContextFromTrustedBinding({ownerUserId:17,bindingVersion:"synthetic-explicit-binding"}));
 for(const action of actions){expect(hasStaffCapability(admin,action)).toBe(false);expect(hasStaffCapability(owner,action)).toBe(true);}
});
it("projection grants cannot become preview or mutation handles",async()=>{
 const client={query:vi.fn(),release:vi.fn()};
 const projection={userId:17,role:"admin",allowedActions:actions};
 await expect(Reflect.apply(staffOperationReferenceCapabilities,undefined,[client,projection,"public"])).rejects.toThrow("HANDLE_INVALID");
 for(const action of actions)await expect(Reflect.apply(assertStaffOperation,undefined,[client,projection,action,"public"])).rejects.toThrow("HANDLE_INVALID");
 expect(client.query).not.toHaveBeenCalled();
});
