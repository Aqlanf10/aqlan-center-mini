vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { beforeAll,afterAll,describe,expect,it,vi } from "vitest";
import { assertRealPostgresUrl,stubPostgresEnv } from "./_setup";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");const procurement=await import("../../lib/inventory-domain/procurement-store");
const custody=await import("../../lib/inventory-domain/custody-store");
const {INVENTORY_PROCUREMENT_SQL}=await import("../../lib/inventory-domain/schema-proposal");const {INVENTORY_CUSTODY_SQL}=await import("../../lib/inventory-domain/custody-schema-proposal");
const {valuationSnapshot}=await import("../../lib/inventory-domain/procurement");
import type {InventoryActor} from "../../lib/inventory-domain/procurement-store";
let admin:InventoryActor;let doctorA:InventoryActor;let doctorB:InventoryActor;let reception:InventoryActor;let partyA:number;let partyB:number;let supplier:number;
const key=()=>randomUUID();
beforeAll(async()=>{
 vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");await db.ensureSchema();await db.getPool().query(INVENTORY_PROCUREMENT_SQL);await db.getPool().query(INVENTORY_CUSTODY_SQL);
 for(const role of ["admin","doctorA","doctorB","reception"]){const party=role.startsWith("doctor")?(await db.getPool().query("INSERT INTO parties(name,kind) VALUES($1,'doctor') RETURNING id",[`SYN-CUSTODY-${role}`])).rows[0].id:null;const username=`SYN-CUSTODY-${role}-${key()}`;const result=await db.getPool().query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES($1,$1,'synthetic-disabled-login',$2,$3) RETURNING id",[username,role.startsWith("doctor")?"doctor":role,party]);const actor={userId:result.rows[0].id,username,role:role.startsWith("doctor")?"doctor":role};if(role==="admin")admin=actor;else if(role==="doctorA"){doctorA=actor;partyA=party;}else if(role==="doctorB"){doctorB=actor;partyB=party;}else reception=actor;}
 supplier=(await db.getPool().query("INSERT INTO parties(name,kind) VALUES('SYN-CUSTODY-supplier','supplier') RETURNING id")).rows[0].id;
 await db.getPool().query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,created_by) SELECT $1,'clinic',COALESCE(MAX(version),0)+1,'YER',150000,$2 FROM inventory_approval_policies WHERE branch_key='clinic'",[key(),admin.userId]);
});afterAll(async()=>{vi.unstubAllEnvs();await db.resetPoolForTesting();});
async function fixture(){const item=await db.createInventoryItem({name:`SYN-CUSTODY-${key()}`,unit:"cartridge",category:"anesthesia",minLevel:5,note:null,createdBy:admin.username});const conversion={itemId:item.id,version:1,enteredUnit:"box",baseUnit:"cartridge",baseUnitsPerEnteredUnit:"50",enteredPrecision:0,basePrecision:0};await db.getPool().query("INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'box','cartridge',50,0,0)",[item.id]);
 const store=`store-${key()}`,destination=`custody-${key()}`,other=`custody-${key()}`,transit=`transit-${key()}`;
 for(const [id,label,kind,doctor] of [[store,"Synthetic main store","store",null],[destination,"Synthetic Doctor A","custody",partyA],[other,"Synthetic Doctor B","custody",partyB],[transit,"Synthetic transit","transit",null]])await db.getPool().query("INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,'clinic',$2,$3,$4)",[id,label,kind,doctor]);
 const request={id:key(),version:1,branchId:"clinic",requestedBy:doctorA.userId,reason:"Synthetic custody stock",proposedSupplierPartyId:supplier,value:{currency:"SAR" as const,amountMinor:20000},lines:[{id:key(),itemId:item.id,quantity:"2",conversion}]};await procurement.submitPurchaseRequest(doctorA,key(),request);await procurement.approvePurchaseRequest(admin,key(),{requestId:request.id,version:1,decisions:[{lineId:request.lines[0].id,quantity:"2",reason:"synthetic approval"}],valuation:valuationSnapshot({purpose:"approval_estimate",currency:"SAR",amountMinor:20000,rateToBase:"500",capturedAt:"2026-10-14T01:00:00Z",sourceRef:"synthetic rate"})});
 const order={id:key(),version:1,branchId:"clinic",supplierPartyId:supplier,currency:"SAR" as const,shippingMinor:0,discountMinor:0,lines:[{id:key(),itemId:item.id,kind:"stock" as const,quantity:"2",conversion,price:{state:"known" as const,currency:"SAR" as const,unitPriceMinor:10000,reason:"synthetic quote"},trackLot:true,requiresExpiry:true,minimumShelfLifeDays:30,sources:[{id:key(),requestId:request.id,requestLineId:request.lines[0].id,baseQuantity:"100"}]}]};await procurement.issuePurchaseOrder(admin,key(),order);const portion=key();await procurement.postInspectedReceipt(admin,key(),{id:key(),version:1,orderId:order.id,orderVersion:1,branchId:"clinic",supplierPartyId:supplier,actualArrivalDate:"2026-10-14",lines:[{orderLineId:order.lines[0].id,arrivedQuantity:"2",portions:[{id:portion,quantity:"2",disposition:"accepted",lotCode:"SYN-CUSTODY-LOT",expiryDate:"2027-11-01",locationId:store,damaged:false,reason:"synthetic inspection"}]}]});const lot=(await db.getPool().query("SELECT id FROM stock_lots WHERE receipt_line_id=$1",[portion])).rows[0].id;
 return {itemId:item.id,store,destination,other,transit,lot};}
const transfer=(f:Awaited<ReturnType<typeof fixture>>,quantity="30")=>({id:key(),fromLocationId:f.store,toLocationId:f.destination,transitLocationId:f.transit,reason:"Synthetic monthly custody supply",lines:[{id:key(),lotId:f.lot,quantity}]});
const ack=(t:ReturnType<typeof transfer>,accepted="30",returned="0")=>({id:key(),transferId:t.id,reason:"Synthetic recipient count",lines:[{lineId:t.lines[0].id,acceptedQuantity:accepted,returnedQuantity:returned}]});
const quantity=(read:Awaited<ReturnType<typeof custody.readDoctorCustody>>,location:string,lot:string)=>read.locations.find(row=>row.id===location)?.lots.find(row=>row.lotId===lot)?.quantity??"0";
async function moneyEffects(){return (await db.getPool().query("SELECT (SELECT count(*) FROM inventory_movements)::int AS movements,(SELECT count(*) FROM payables)::int AS payables,(SELECT count(*) FROM expenses)::int AS expenses")).rows[0];}
describe("P49/51/55/61 custody allocation transactions (no financial posting)",()=>{
 it("100 clinic pieces become 70 store+30 transit, then 30 doctor; stock and debt/cash records unchanged",async()=>{const f=await fixture();const t=transfer(f);const before=await moneyEffects();const movementBefore=(await db.getPool().query("SELECT * FROM inventory_movements WHERE item_id=$1 ORDER BY id",[f.itemId])).rows;await custody.dispatchCustodyTransfer(admin,key(),t);const pending=await custody.readDoctorCustody(admin);expect(quantity(pending,f.store,f.lot)).toBe("70");expect(quantity(pending,f.transit,f.lot)).toBe("30");expect(quantity(pending,f.destination,f.lot)).toBe("0");await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t));const done=await custody.readDoctorCustody(admin);expect(quantity(done,f.store,f.lot)).toBe("70");expect(quantity(done,f.destination,f.lot)).toBe("30");expect(quantity(done,f.transit,f.lot)).toBe("0");expect(await moneyEffects()).toEqual(before);expect((await db.getPool().query("SELECT * FROM inventory_movements WHERE item_id=$1 ORDER BY id",[f.itemId])).rows).toEqual(movementBefore);const values=done.locations.flatMap(row=>row.lots.filter(lot=>lot.lotId===f.lot).map(lot=>"quote" in lot?lot.quote?.amountMinor??0:0));expect(values.reduce((sum,value)=>sum+value,0)).toBe(20000);});
 it("partial acceptance/return conserves source+transit+custody and rejects over-acknowledgement",async()=>{const f=await fixture();const t=transfer(f);await custody.dispatchCustodyTransfer(admin,key(),t);await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t,"10","5"));const read=await custody.readDoctorCustody(admin);expect(quantity(read,f.store,f.lot)).toBe("75");expect(quantity(read,f.destination,f.lot)).toBe("10");expect(quantity(read,f.transit,f.lot)).toBe("15");await expect(custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t,"16"))).rejects.toMatchObject({code:"transfer_overacknowledged"});});
 it("same key replays once; concurrent different dispatches cannot use 100 twice",async()=>{const f=await fixture();const t=transfer(f,"70");const op=key();const first=await Promise.all([custody.dispatchCustodyTransfer(admin,op,t),custody.dispatchCustodyTransfer(admin,op,t)]);expect(first.filter(row=>row.replayed)).toHaveLength(1);await expect(custody.dispatchCustodyTransfer(admin,key(),transfer(f,"40"))).rejects.toMatchObject({code:"insufficient_location_stock"});const a=ack(t,"70");const outcomes=await Promise.allSettled([custody.acknowledgeCustodyTransfer(doctorA,key(),a),custody.acknowledgeCustodyTransfer(doctorA,key(),{...a,id:key()})]);expect(outcomes.filter(row=>row.status==="fulfilled")).toHaveLength(1);});
 it("doctor cannot receive another doctor's custody or view their locations/prices; reception cannot dispatch/receive",async()=>{const f=await fixture();const t=transfer(f);await custody.dispatchCustodyTransfer(admin,key(),t);await expect(custody.acknowledgeCustodyTransfer(doctorB,key(),ack(t))).rejects.toMatchObject({code:"custody_owner_forbidden"});await expect(custody.dispatchCustodyTransfer(reception,key(),transfer(f))).rejects.toMatchObject({code:"operation_forbidden"});await expect(custody.acknowledgeCustodyTransfer(reception,key(),ack(t))).rejects.toMatchObject({code:"custody_owner_forbidden"});const read=await custody.readDoctorCustody(doctorA);expect(read.locations.every(row=>row.doctorPartyId===partyA)).toBe(true);expect(JSON.stringify(read)).not.toContain('"quote"');expect(JSON.stringify(read)).not.toContain('unitPriceMinor');});
 it("unallocated old out movement blocks new transfers rather than inventing a lot attribution",async()=>{const f=await fixture();await db.createInventoryMovement({itemId:f.itemId,kind:"out",qty:1,createdBy:admin.username});await expect(custody.dispatchCustodyTransfer(admin,key(),transfer(f))).rejects.toMatchObject({code:"legacy_allocation_incomplete"});});
 it("piece precision rejects a fractional cartridge before writing a transfer",async()=>{const f=await fixture();await expect(custody.dispatchCustodyTransfer(admin,key(),transfer(f,"0.5"))).rejects.toMatchObject({code:"quantity_precision"});});
 it("doctor-to-doctor reallocation conserves clinic stock without patient consumption",async()=>{const f=await fixture();const t=transfer(f);await custody.dispatchCustodyTransfer(admin,key(),t);await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t));const next={...transfer(f,"10"),fromLocationId:f.destination,toLocationId:f.other};await custody.dispatchCustodyTransfer(admin,key(),next);await custody.acknowledgeCustodyTransfer(doctorB,key(),ack(next,"10"));const read=await custody.readDoctorCustody(admin);expect(quantity(read,f.store,f.lot)).toBe("70");expect(quantity(read,f.destination,f.lot)).toBe("20");expect(quantity(read,f.other,f.lot)).toBe("10");});
 it("expiry while in transit blocks acceptance without consuming or charging",async()=>{const f=await fixture(),t=transfer(f);await custody.dispatchCustodyTransfer(admin,key(),t);const before=await moneyEffects();vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2027-11-02T12:00:00Z"));try{await expect(custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t))).rejects.toMatchObject({code:"lot_unavailable"});await expect(custody.dispatchCustodyTransfer(admin,key(),transfer(f))).rejects.toMatchObject({code:"lot_unavailable"});expect((await custody.readDoctorCustody(admin)).locations.find(row=>row.id===f.transit)?.lots[0].availability).toBe("unavailable");expect(await moneyEffects()).toEqual(before);}finally{vi.useRealTimers();}});
 it("inactive receiving doctor party cannot acknowledge an earlier transfer",async()=>{const f=await fixture(),t=transfer(f);await custody.dispatchCustodyTransfer(admin,key(),t);await db.getPool().query("UPDATE parties SET is_active=FALSE WHERE id=$1",[partyA]);try{await expect(custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t))).rejects.toMatchObject({code:"doctor_unavailable"});}finally{await db.getPool().query("UPDATE parties SET is_active=TRUE WHERE id=$1",[partyA]);}});
 it("21 newer completed transfers do not hide an older pending receipt",async()=>{const f=await fixture(),old=transfer(f,"1");await custody.dispatchCustodyTransfer(admin,key(),old);const completed=new Set<string>();for(let i=0;i<21;i++){const t=transfer(f,"1");completed.add(t.id);await custody.dispatchCustodyTransfer(admin,key(),t);await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t,"1"));}const read=await custody.readDoctorCustody(admin);expect(read.pendingTransfers.some(row=>row.id===old.id)).toBe(true);expect(read.pendingTransfers.some(row=>completed.has(row.id))).toBe(false);await expect(custody.readDoctorCustody(admin,-1)).rejects.toMatchObject({code:"invalid_page"});});
 it("P62/R07/R08: reconcileHistoricalMovements quarantines missing-expiry legacy lots, rejects outflow-before-inflow, and unblocks mixed-state custody transfers",async()=>{const f=await fixture();const freshItem=await db.createInventoryItem({name:`SYN-R08-${key()}`,unit:"cartridge",category:"anesthesia",minLevel:5,note:null,createdBy:admin.username});await db.getPool().query("INSERT INTO inventory_movements(item_id,kind,qty,created_by) VALUES($1,'out',5,$2)",[freshItem.id,admin.username]);await db.createInventoryMovement({itemId:freshItem.id,kind:"in",qty:20,createdBy:admin.username});await expect(custody.reconcileHistoricalMovements(admin,key(),{id:key(),itemId:freshItem.id,locationId:f.store,reason:"Outflow before inflow must fail"})).rejects.toMatchObject({code:"unresolved_historical_lineage"});await db.createInventoryMovement({itemId:f.itemId,kind:"in",qty:20,createdBy:admin.username});await db.createInventoryMovement({itemId:f.itemId,kind:"out",qty:5,createdBy:admin.username});await expect(custody.dispatchCustodyTransfer(admin,key(),transfer(f,"10"))).rejects.toMatchObject({code:"legacy_allocation_incomplete"});const before=await moneyEffects();const rec=await custody.reconcileHistoricalMovements(admin,key(),{id:key(),itemId:f.itemId,locationId:f.store,reason:"Historical opening balance reconciliation",requiresExpiry:false});expect(rec.netReconciledBaseQuantity).toBe("15");expect((await db.getPool().query("SELECT status,(cost_snapshot->>'requiresExpiry')::boolean AS requires_expiry FROM stock_lots WHERE item_id=$1 AND receipt_line_id IS NULL",[f.itemId])).rows[0]).toEqual({status:"quarantined",requires_expiry:true});expect(await moneyEffects()).toEqual(before);await expect(custody.dispatchCustodyTransfer(admin,key(),transfer(f,"10"))).resolves.toMatchObject({status:"in_transit"});});
 it("P50/P42/R03/R05: recordCustodyUsage verifies clinical context and waste approvals, records patient consumption once, and returns unused stock without clinic movement",async()=>{const f=await fixture();const t=transfer(f,"30");await custody.dispatchCustodyTransfer(admin,key(),t);await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t,"30"));const patA=(await db.getPool().query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PAT-' || nextval('patient_number_seq'),'SYN-PAT-A','777000111',$1) RETURNING id",[partyA])).rows[0].id;const patB=(await db.getPool().query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PAT-' || nextval('patient_number_seq'),'SYN-PAT-B','777000222',$1) RETURNING id",[partyB])).rows[0].id;const patUnowned=(await db.getPool().query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PAT-' || nextval('patient_number_seq'),'SYN-PAT-UNOWNED','777000333',NULL) RETURNING id")).rows[0].id;const visA=(await db.getPool().query("INSERT INTO visits(patient_name,patient_phone,patient_id,doctor_id) VALUES('SYN-PAT-A','777000111',$1,$2) RETURNING id",[patA,partyA])).rows[0].id;const visUnlinked=(await db.getPool().query("INSERT INTO visits(patient_name,patient_phone,patient_id,doctor_id) VALUES('SYN-WALKIN','777000999',NULL,$1) RETURNING id",[partyA])).rows[0].id;const planA=(await db.getPool().query("INSERT INTO treatment_plans(patient_id,title,total_minor,primary_doctor_id) VALUES($1,'SYN-PLAN',50000,$2) RETURNING id",[patA,partyA])).rows[0].id;const planUnowned=(await db.getPool().query("INSERT INTO treatment_plans(patient_id,title,total_minor,primary_doctor_id) VALUES($1,'SYN-PLAN-UNOWNED',50000,NULL) RETURNING id",[patUnowned])).rows[0].id;const procA=(await db.getPool().query("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,doctor_id,visit_id) VALUES($1,$2,1,'SYN-PROC',$3,$4) RETURNING id",[patA,planA,partyA,visA])).rows[0].id;const procNoVisit=(await db.getPool().query("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,doctor_id,visit_id) VALUES($1,$2,2,'SYN-PROC-NO-VISIT',$3,NULL) RETURNING id",[patA,planA,partyA])).rows[0].id;const procUnowned=(await db.getPool().query("INSERT INTO planned_visits(patient_id,plan_id,sequence,title,doctor_id,visit_id) VALUES($1,NULL,1,'SYN-PROC-UNOWNED',NULL,NULL) RETURNING id",[patUnowned])).rows[0].id;await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"1",patientId:"99999999",reason:"Nonexistent patient"})).rejects.toMatchObject({code:"clinical_context_mismatch"});await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"1",patientId:String(patB),reason:"Other doctor patient"})).rejects.toMatchObject({code:"clinical_context_forbidden"});await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"1",visitId:String(visUnlinked),reason:"Walk-in visit without patient_id"})).rejects.toMatchObject({code:"clinical_context_mismatch"});await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"1",caseId:String(planUnowned),reason:"Case-only for unowned patient with null primary_doctor_id"})).rejects.toMatchObject({code:"clinical_context_forbidden"});await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"1",procedureId:String(procUnowned),reason:"Procedure-only for unowned patient with null doctor_id"})).rejects.toMatchObject({code:"clinical_context_forbidden"});await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"1",patientId:String(patA),visitId:String(visA),procedureId:String(procNoVisit),reason:"Procedure has null visit_id while visitId supplied"})).rejects.toMatchObject({code:"clinical_context_mismatch"});const uKey=`visit-${visA}/proc-${procA}/${key()}`;const used=await custody.recordCustodyUsage(doctorA,key(),{id:key(),usageKey:uKey,locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"8",quantityState:"confirmed",patientId:String(patA),visitId:String(visA),caseId:String(planA),procedureId:String(procA),reason:"Endodontic obturation"});expect(used.clinicMovementEffects).toBe(1);await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),usageKey:uKey,locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"8",reason:"Duplicate usageKey"})).rejects.toMatchObject({code:"duplicate_consumption"});await expect(custody.recordCustodyUsage(doctorB,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"1",reason:"Cross doctor"})).rejects.toMatchObject({code:"custody_owner_forbidden"});await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"approved_waste",quantity:"1",approvalId:"forged-approval",reason:"Unapproved waste"})).rejects.toMatchObject({code:"invalid_waste_approval"});await expect(custody.approveCustodyWaste(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,quantity:"1",reason:"Doctor self-approval attempt"})).rejects.toMatchObject({code:"operation_forbidden"});const wasteApprovalId=key();await custody.approveCustodyWaste(admin,key(),{id:wasteApprovalId,locationId:f.destination,lotId:f.lot,quantity:"2",reason:"Admin verified broken ampoules"});const waste=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"approved_waste",quantity:"2",approvalId:wasteApprovalId,reason:"Recorded approved waste"});expect(waste.clinicMovementEffects).toBe(1);await expect(custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"approved_waste",quantity:"1",approvalId:wasteApprovalId,reason:"Exceeds approved waste"})).rejects.toMatchObject({code:"invalid_waste_approval"});const ret=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,storeLocationId:f.store,lotId:f.lot,kind:"returned_to_store",quantity:"2",reason:"Return 2 unused cartridges to store"});expect(ret.clinicMovementEffects).toBe(0);const read=await custody.readDoctorCustody(admin);expect(quantity(read,f.store,f.lot)).toBe("72");expect(quantity(read,f.destination,f.lot)).toBe("18");});
 it("P51/P64/P68/P54/R01/R02/R04/R06: stocktake, server-verified package closure, multi-tranche closure, and provisional/unposted annual settlement preserve zero automatic financial adjustments",async()=>{const f=await fixture();const t=transfer(f,"30");await custody.dispatchCustodyTransfer(admin,key(),t);const ack1=ack(t,"30");await custody.acknowledgeCustodyTransfer(doctorA,key(),ack1);const st=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,countedQuantity:"25",reason:"Monthly physical count"});expect(st).toMatchObject({expectedQuantity:"30",countedQuantity:"25",differenceQuantity:"-5",reviewRequired:true,automaticFinancialAdjustmentMinor:0,clinicMovementEffects:0});await expect(custody.closeCustodyPackage(doctorB,key(),{id:key(),packageId:t.lines[0].id,evidenceEventId:st.id,locationId:f.other,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"30",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Lot never in doctorB custody"})).rejects.toMatchObject({code:"lot_not_in_custody_location"});await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t.lines[0].id,evidenceEventId:st.id,locationId:f.destination,lotId:f.lot,hazard:"none",policy:"safe_empty_return",originalQuantity:"30",recordedConsumptionQuantity:"30",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Attempt to downgrade sharp cartridge hazard"})).rejects.toMatchObject({code:"package_hazard_downgrade_forbidden"});await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`PKG-${key()}`,evidenceEventId:st.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"30",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Fabricated packageId must be rejected"})).rejects.toMatchObject({code:"invalid_package_source"});await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t.lines[0].id,evidenceEventId:`EV-${key()}`,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"30",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Fabricated evidenceEventId must be rejected"})).rejects.toMatchObject({code:"invalid_package_evidence"});await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t.lines[0].id,evidenceEventId:st.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"25",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Contradicts server balance before consumption"})).rejects.toMatchObject({code:"package_history_mismatch"});const u1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"25",reason:"Consumed 25 cartridges"});await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,storeLocationId:f.store,lotId:f.lot,kind:"returned_to_store",quantity:"5",reason:"Returned 5 cartridges to store"});const afterDepletion=await custody.readDoctorCustody(doctorA);const closableRow1=afterDepletion.closableLots.find(row=>row.locationId===f.destination&&row.lotId===f.lot&&row.remainingQuantity==="0");expect(closableRow1).toBeDefined();const closed=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:closableRow1!.defaultPackageId!,evidenceEventId:u1.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_empty_return",originalQuantity:"30",recordedConsumptionQuantity:"25",returnedOrTransferredQuantity:"5",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Sharps container disposal log"});expect(closed).toMatchObject({evidenceAction:"document_safe_disposal",unexplainedAtoms:0,reviewRequired:true,evidenceVerificationStatus:"unverified_attestation_requires_review",automaticDebtMinor:0});await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:closableRow1!.defaultPackageId!,evidenceEventId:st.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"25",returnedOrTransferredQuantity:"5",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Reuse packageId"})).rejects.toMatchObject({code:"package_or_evidence_already_closed"});await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t.id,evidenceEventId:st.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"25",returnedOrTransferredQuantity:"5",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Cannot re-close already closed tranche even with another source ID"})).rejects.toMatchObject({code:"package_or_evidence_already_closed"});const t2=transfer(f,"20");await custody.dispatchCustodyTransfer(admin,key(),t2);await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t2,"20"));const u2=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"20",reason:"Consumed second tranche of 20 cartridges"});const closed2=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t2.lines[0].id,evidenceEventId:u2.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"20",recordedConsumptionQuantity:"20",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Second tranche sharps container disposal"});expect(closed2).toMatchObject({evidenceAction:"document_safe_disposal",unexplainedAtoms:0,reviewRequired:true,evidenceVerificationStatus:"unverified_attestation_requires_review",automaticDebtMinor:0});await expect(custody.proposeAnnualCustodySettlement(admin,key(),{id:key(),doctorPartyId:partyA,periodId:"bad-period",currency:"SAR",appliedDeductionsMinor:12000,attributableConsumptionMinor:10000,reason:"Invalid period format"})).rejects.toMatchObject({code:"invalid_period_id"});const settlementId=key();const prop=await custody.proposeAnnualCustodySettlement(admin,key(),{id:settlementId,doctorPartyId:partyA,periodId:"2026",currency:"SAR",appliedDeductionsMinor:12000,attributableConsumptionMinor:10000,reason:"Annual D-A review with canonical periodId"});expect(prop).toMatchObject({periodId:"2026-annual",supplementalMinor:2000,direction:"due_to_doctor",status:"provisional",cashDeltaMinor:0,automaticWageDeductionMinor:0});const secondProp=await custody.proposeAnnualCustodySettlement(admin,key(),{id:key(),doctorPartyId:partyA,periodId:"2026-annual",currency:"SAR",appliedDeductionsMinor:12000,attributableConsumptionMinor:10000,reason:"Second unposted proposal must not zero out supplementalMinor"});expect(secondProp.supplementalMinor).toBe(2000);const obj=await custody.objectCustodySettlement(doctorA,key(),{id:key(),settlementId,reason:"Requesting review of visit #202 return credit"});expect(obj.status).toBe("objected_under_review");const doctorView=await custody.readDoctorCustody(doctorA);expect(doctorView.settlements.find(row=>row.id===settlementId)?.status).toBe("objected_under_review");expect(JSON.stringify(doctorView)).not.toContain('"quote"');expect(JSON.stringify(doctorView)).not.toContain("unitPriceMinor");});
 it("PR338 Round 2 Items 2, 3, 4, 7: canonical source/evidence prevents alias reuse across new inflows, binds tranche quantities (10 vs 30), preserves accountability after remaining>0 checkpoint until terminal closure, and verifies executed safe disposal",async()=>{
  const f=await fixture();
  // 1) Inflow 30 -> checkpoint with remaining=30 -> lot stays in closableLots with original=30 -> consume 28 + approved_waste 2 -> terminal closure with verified disposal
  const t1=transfer(f,"30");
  await custody.dispatchCustodyTransfer(admin,key(),t1);
  const ack1=ack(t1,"30");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ack1);
  const st1=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,countedQuantity:"30",reason:"Initial custody count"});
  const cp=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t1.lines[0].id,evidenceEventId:st1.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"0",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"30",reason:"Mid-cycle custody checkpoint with 30 remaining"});
  expect(cp).toMatchObject({closureKind:"checkpoint",terminalClosure:false,originalQuantity:"30",retiredOriginalQuantity:"0",remainingQuantity:"30",reviewRequired:true});
  const afterCp=await custody.readDoctorCustody(doctorA);
  const stillClosable=afterCp.closableLots.find(row=>row.locationId===f.destination&&row.lotId===f.lot);
  expect(stillClosable).toMatchObject({originalQuantity:"30",remainingQuantity:"30",alreadyClosed:false});

  const uKey1=`u-canon-${key()}`;
  const u1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),usageKey:uKey1,locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"28",reason:"Consumed 28 cartridges"});
  const wAppId=key();
  await custody.approveCustodyWaste(admin,key(),{id:wAppId,locationId:f.destination,lotId:f.lot,quantity:"2",reason:"Approve 2 broken cartridges for sharps disposal"});
  const wExec=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"approved_waste",quantity:"2",approvalId:wAppId,reason:"Executed sharps disposal of 2 cartridges"});
  const term1=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`pkg:${ack1.id}`,evidenceEventId:`ev:${wAppId}`,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",evidenceAction:"document_safe_disposal",originalQuantity:"30",recordedConsumptionQuantity:"28",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"2",remainingQuantity:"0",reason:"Terminal closure with executed waste approval"});
  expect(term1).toMatchObject({closureKind:"terminal",terminalClosure:true,reviewRequired:false,evidenceVerificationStatus:"verified_disposal_record"});

  // 2) New inflow of 10 and 20 (total 30): old source/evidence aliases are rejected, and source of 10 cannot close original=30
  const t10=transfer(f,"10");
  await custody.dispatchCustodyTransfer(admin,key(),t10);
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t10,"10"));
  const t20=transfer(f,"20");
  await custody.dispatchCustodyTransfer(admin,key(),t20);
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(t20,"20"));
  const uNew=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"30",reason:"Consumed 30 across t10+t20"});

  // Alias of old closed source (t1.lines[0].id / t1.id / pkg:...) or old used evidence (wExec.id / st1.id) is rejected
  await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`pkg:${t1.lines[0].id}`,evidenceEventId:uNew.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"30",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Attempt alias reuse of old source"})).rejects.toMatchObject({code:"package_or_evidence_already_closed"});
  await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t10.lines[0].id,evidenceEventId:`ev:${wExec.id}`,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"10",recordedConsumptionQuantity:"10",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Attempt alias reuse of old waste evidence"})).rejects.toMatchObject({code:"package_or_evidence_already_closed"});
  // Old unused evidence (u1 from before t10 arrived) is rejected for t10 due to temporal provenance (ev_ts < src_ts)
  await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t10.lines[0].id,evidenceEventId:u1.usageKey,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"10",recordedConsumptionQuantity:"10",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Attempt old unused evidence from prior tranche"})).rejects.toMatchObject({code:"package_evidence_mismatch"});
  // Source of 10 (t10) cannot attest to closing 30 units
  await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t10.lines[0].id,evidenceEventId:uNew.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"30",recordedConsumptionQuantity:"30",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"10-unit source cannot close 30 total units"})).rejects.toMatchObject({code:"package_history_mismatch"});

  // Closing 10 on t10 and then 20 on t20 succeeds
  const close10=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t10.lines[0].id,evidenceEventId:uNew.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"10",recordedConsumptionQuantity:"10",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Close 10-unit tranche"});
  expect(close10).toMatchObject({closureKind:"terminal",originalQuantity:"10",retiredOriginalQuantity:"10"});
  const stNew=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,countedQuantity:"0",reason:"Zero count after 30 consumed"});
  const close20=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t20.lines[0].id,evidenceEventId:stNew.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"20",recordedConsumptionQuantity:"20",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Close 20-unit tranche"});
  expect(close20).toMatchObject({closureKind:"terminal",originalQuantity:"20",retiredOriginalQuantity:"20"});
 });
 it("a657 review Points 3, 4 & 5: partial acknowledgement tranches on one transfer_line close independently, source/evidence timestamps use actual receipt/ack/execution times, and readDoctorCustody returns per-tranche open quantities",async()=>{
  // Point 3: dispatch 30 -> ack 10 -> consume 10 -> close 10 -> ack 20 -> consume 20 -> close 20 on same transfer_line; aliases of closed ack 10 rejected
  const f=await fixture();
  const t30=transfer(f,"30");
  await custody.dispatchCustodyTransfer(admin,key(),t30);
  const ack10=ack(t30,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ack10);
  const u10=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"10",reason:"Consume first partial ack of 10"});
  const readAfterAck10=await custody.readDoctorCustody(doctorA);
  const lotAfterAck10=readAfterAck10.closableLots.find(r=>r.locationId===f.destination&&r.lotId===f.lot)!;
  expect(lotAfterAck10.defaultPackageId).toBe(`${ack10.id}:${t30.lines[0].id}`);
  expect(lotAfterAck10).toMatchObject({originalQuantity:"10",recordedConsumptionQuantity:"10",remainingQuantity:"0"});
  const closedAck10=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:lotAfterAck10.defaultPackageId!,evidenceEventId:u10.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"10",recordedConsumptionQuantity:"10",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Close first partial ack tranche 10"});
  expect(closedAck10).toMatchObject({closureKind:"terminal",terminalClosure:true,originalQuantity:"10",retiredOriginalQuantity:"10"});

  const ack20=ack(t30,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ack20);
  const u20=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f.destination,lotId:f.lot,kind:"consumed",quantity:"20",reason:"Consume second partial ack of 20 on same transfer line"});
  // Attempting to reuse first closed partial ack via any alias is rejected
  for(const alias of [ack10.id,`pkg:${ack10.id}`,`${ack10.id}:${t30.lines[0].id}`,`transfer_ack:${ack10.id}:${t30.lines[0].id}`,`pkg:transfer_ack:${ack10.id}:${t30.lines[0].id}`]){
   await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:alias,evidenceEventId:u20.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"10",recordedConsumptionQuantity:"10",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Reject alias of closed ack10"})).rejects.toMatchObject({code:"package_or_evidence_already_closed"});
  }
  const readAfterAck20=await custody.readDoctorCustody(doctorA);
  const lotAfterAck20=readAfterAck20.closableLots.find(r=>r.locationId===f.destination&&r.lotId===f.lot)!;
  expect(lotAfterAck20.defaultPackageId).toBe(`${ack20.id}:${t30.lines[0].id}`);
  expect(lotAfterAck20).toMatchObject({originalQuantity:"20",recordedConsumptionQuantity:"20",remainingQuantity:"0"});
  const closedAck20=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:t30.lines[0].id,evidenceEventId:u20.id,locationId:f.destination,lotId:f.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"20",recordedConsumptionQuantity:"20",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Close second partial ack tranche 20 on same transfer line"});
  expect(closedAck20).toMatchObject({closureKind:"terminal",terminalClosure:true,originalQuantity:"20",retiredOriginalQuantity:"20"});

  // Point 4a: Direct goods receipt into custody location uses receipt/movement created_at (not NOW()), accepting evidence recorded after receipt and before close
  const fDirect=await fixture();
  const reqDir={id:key(),version:1,branchId:"clinic",requestedBy:doctorA.userId,reason:"Direct custody receipt",proposedSupplierPartyId:supplier,value:{currency:"SAR" as const,amountMinor:10000},lines:[{id:key(),itemId:fDirect.itemId,quantity:"1",conversion:{itemId:fDirect.itemId,version:1,enteredUnit:"box",baseUnit:"cartridge",baseUnitsPerEnteredUnit:"50",enteredPrecision:0,basePrecision:0}}]};
  await procurement.submitPurchaseRequest(doctorA,key(),reqDir);
  await procurement.approvePurchaseRequest(admin,key(),{requestId:reqDir.id,version:1,decisions:[{lineId:reqDir.lines[0].id,quantity:"1",reason:"Approve direct custody receipt"}],valuation:valuationSnapshot({purpose:"approval_estimate",currency:"SAR",amountMinor:10000,rateToBase:"500",capturedAt:"2026-10-15T01:00:00Z",sourceRef:"direct-rate"})});
  const poDir={id:key(),version:1,branchId:"clinic",supplierPartyId:supplier,currency:"SAR" as const,shippingMinor:0,discountMinor:0,lines:[{id:key(),itemId:fDirect.itemId,kind:"stock" as const,quantity:"1",conversion:reqDir.lines[0].conversion,price:{state:"known" as const,currency:"SAR" as const,unitPriceMinor:10000,reason:"direct quote"},trackLot:true,requiresExpiry:true,minimumShelfLifeDays:30,sources:[{id:key(),requestId:reqDir.id,requestLineId:reqDir.lines[0].id,baseQuantity:"50"}]}]};
  await procurement.issuePurchaseOrder(admin,key(),poDir);
  const directPortionId=key();
  await procurement.postInspectedReceipt(admin,key(),{id:key(),version:1,orderId:poDir.id,orderVersion:1,branchId:"clinic",supplierPartyId:supplier,actualArrivalDate:"2026-10-15",lines:[{orderLineId:poDir.lines[0].id,arrivedQuantity:"1",portions:[{id:directPortionId,quantity:"1",disposition:"accepted",lotCode:"SYN-DIRECT-CUSTODY-LOT",expiryDate:"2027-11-01",locationId:fDirect.destination,damaged:false,reason:"Direct receipt into custody location"}]}]});
  const directLotId=(await db.getPool().query("SELECT id FROM stock_lots WHERE receipt_line_id=$1",[directPortionId])).rows[0].id;
  const uDirect=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fDirect.destination,lotId:directLotId,kind:"consumed",quantity:"50",reason:"Consume 50 from direct receipt before closing"});
  const readDirect=await custody.readDoctorCustody(doctorA);
  const directClosable=readDirect.closableLots.find(r=>r.locationId===fDirect.destination&&r.lotId===directLotId)!;
  expect(directClosable.tranches[0].canonicalPackageId).toMatch(/^mov_alloc:/);
  const closedDirect=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:directClosable.defaultPackageId!,evidenceEventId:uDirect.id,locationId:fDirect.destination,lotId:directLotId,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"50",recordedConsumptionQuantity:"50",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Close direct movement allocation tranche with post-receipt evidence"});
  expect(closedDirect).toMatchObject({closureKind:"terminal",terminalClosure:true,originalQuantity:"50",retiredOriginalQuantity:"50"});

  // Point 4b: Evidence created after dispatch but before acknowledgement (or from a prior retired waste event) is rejected; waste approval resolved to executed event uses execution timestamp
  const fTime=await fixture();
  const tOld=transfer(fTime,"10");
  await custody.dispatchCustodyTransfer(admin,key(),tOld);
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ack(tOld,"10","0"));
  const tNew=transfer(fTime,"10");
  await custody.dispatchCustodyTransfer(admin,key(),tNew);
  // While tNew is in transit (dispatched, not yet acknowledged), waste 10 from tOld and close tOld using stocktake evidence (leaving wAppOld/wExecOld unused in closures)
  const wAppOld=key();
  await custody.approveCustodyWaste(admin,key(),{id:wAppOld,locationId:fTime.destination,lotId:fTime.lot,quantity:"10",reason:"Waste 10 on old tranche"});
  const wExecOld=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fTime.destination,lotId:fTime.lot,kind:"approved_waste",quantity:"10",approvalId:wAppOld,reason:"Execute waste 10 on old tranche before tNew ack"});
  const stOld=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:fTime.destination,lotId:fTime.lot,countedQuantity:"0",reason:"Stocktake 0 to close old tranche"});
  await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:tOld.lines[0].id,evidenceEventId:stOld.id,locationId:fTime.destination,lotId:fTime.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"10",recordedConsumptionQuantity:"0",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"10",remainingQuantity:"0",reason:"Close tOld with stocktake"});
  // Approve wAppForNew before ackNew, but execute it AFTER ackNew
  const wAppForNew=key();
  await custody.approveCustodyWaste(admin,key(),{id:wAppForNew,locationId:fTime.destination,lotId:fTime.lot,quantity:"2",reason:"Pre-approved waste 2 before ackNew"});
  await new Promise(resolve=>setTimeout(resolve,15));
  const ackNew=ack(tNew,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackNew);
  const uNew8=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fTime.destination,lotId:fTime.lot,kind:"consumed",quantity:"8",reason:"Consume 8 after ackNew"});
  // Attempting to close tNew (consumed=8, remaining=2 or consumed=10) using wAppOld or wExecOld (created before ackNew and with waste=0 on tNew) must fail package_evidence_mismatch
  await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:tNew.lines[0].id,evidenceEventId:wAppOld,locationId:fTime.destination,lotId:fTime.lot,hazard:"sharp",policy:"safe_disposal_record",evidenceAction:"document_safe_disposal",originalQuantity:"10",recordedConsumptionQuantity:"8",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"2",reason:"Reject pre-ack waste evidence"})).rejects.toMatchObject({code:"package_evidence_mismatch"});
  await expect(custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:tNew.lines[0].id,evidenceEventId:wExecOld.id,locationId:fTime.destination,lotId:fTime.lot,hazard:"sharp",policy:"safe_disposal_record",evidenceAction:"document_safe_disposal",originalQuantity:"10",recordedConsumptionQuantity:"8",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"2",reason:"Reject pre-ack waste usage evidence"})).rejects.toMatchObject({code:"package_evidence_mismatch"});
  // Now execute wAppForNew AFTER ackNew; closing tNew with wAppForNew uses the execution timestamp (>= ackNew) and succeeds as verified_disposal_record
  await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fTime.destination,lotId:fTime.lot,kind:"approved_waste",quantity:"2",approvalId:wAppForNew,reason:"Execute 2 waste after ackNew"});
  const closedNew=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:tNew.lines[0].id,evidenceEventId:wAppForNew,locationId:fTime.destination,lotId:fTime.lot,hazard:"sharp",policy:"safe_disposal_record",evidenceAction:"document_safe_disposal",originalQuantity:"10",recordedConsumptionQuantity:"8",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"2",remainingQuantity:"0",reason:"Close tNew with post-ack executed waste"});
  expect(closedNew).toMatchObject({closureKind:"terminal",terminalClosure:true,reviewRequired:false,evidenceVerificationStatus:"verified_disposal_record"});
  void uNew8;

  // Point 5: Two open tranches (10 and 20) in same lot do not produce source10/original30 in readDoctorCustody; each tranche reports its own open quantities and updates after partial checkpoint
  const fUi=await fixture();
  const trA=transfer(fUi,"10"),trB=transfer(fUi,"20");
  await custody.dispatchCustodyTransfer(admin,key(),trA);
  const ackTrA=ack(trA,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackTrA);
  await custody.dispatchCustodyTransfer(admin,key(),trB);
  const ackTrB=ack(trB,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackTrB);
  await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fUi.destination,lotId:fUi.lot,kind:"consumed",quantity:"15",reason:"Consume 15 across tranche A (10) and tranche B (5)"});
  const readMulti=await custody.readDoctorCustody(doctorA);
  const lotMulti=readMulti.closableLots.find(r=>r.locationId===fUi.destination&&r.lotId===fUi.lot)!;
  expect(lotMulti.defaultPackageId).toBe(`${ackTrA.id}:${trA.lines[0].id}`);
  expect(lotMulti).toMatchObject({
   originalQuantity:"10",
   recordedConsumptionQuantity:"10",
   remainingQuantity:"0"
  });
  expect(lotMulti.tranches).toEqual([
   expect.objectContaining({packageId:`${ackTrA.id}:${trA.lines[0].id}`,canonicalPackageId:`transfer_ack:${ackTrA.id}:${trA.lines[0].id}`,originalQuantity:"10",recordedConsumptionQuantity:"10",remainingQuantity:"0"}),
   expect.objectContaining({packageId:`${ackTrB.id}:${trB.lines[0].id}`,canonicalPackageId:`transfer_ack:${ackTrB.id}:${trB.lines[0].id}`,originalQuantity:"20",recordedConsumptionQuantity:"5",remainingQuantity:"15"})
  ]);
 });
 it("Requirements 1 & 2: checkpoint on ackA (10/5/5) never subtracts from ackB (20) on the same transfer line, supports multiple and out-of-order checkpoints, serializes concurrent closures, and enforces legacy_source_reconciliation_required on unmapped multi-ack legacy line closures",async()=>{
  // 1. ackA=10 -> checkpoint 10/5/5 -> ackB=20 on the SAME transfer_line (open = 5 + 20 = 25), then terminalA=5 and terminalB=20 -> open = 0
  const f1=await fixture();
  const tSameLine=transfer(f1,"30");
  const lineId1=tSameLine.lines[0].id;
  await custody.dispatchCustodyTransfer(admin,key(),tSameLine);
  const ackA=ack(tSameLine,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackA);
  const uA1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f1.destination,lotId:f1.lot,kind:"consumed",quantity:"5",reason:"Consume 5 from ackA before checkpoint"});
  const cpA=await custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackA.id}:${lineId1}`,
   evidenceEventId:uA1.id,
   locationId:f1.destination,
   lotId:f1.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"10",
   recordedConsumptionQuantity:"5",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"0",
   remainingQuantity:"5",
   reason:"Checkpoint ackA retiring 5 of 10 with 5 remaining",
  });
  expect(cpA).toMatchObject({closureKind:"checkpoint",terminalClosure:false,originalQuantity:"10",retiredOriginalQuantity:"5",remainingQuantity:"5"});

  const ackB=ack(tSameLine,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackB);
  const viewAfterAckB=await custody.readDoctorCustody(doctorA);
  const lotAfterAckB=viewAfterAckB.closableLots.find(r=>r.locationId===f1.destination&&r.lotId===f1.lot)!;
  expect(lotAfterAckB).toBeDefined();
  expect(lotAfterAckB.lotOriginalQuantity).toBe("25");
  expect(lotAfterAckB.tranches).toEqual([
   expect.objectContaining({packageId:`${ackA.id}:${lineId1}`,originalQuantity:"5",remainingQuantity:"5"}),
   expect.objectContaining({packageId:`${ackB.id}:${lineId1}`,originalQuantity:"20",remainingQuantity:"20"}),
  ]);

  // Consume remaining 5 on ackA and 20 on ackB
  const uA2=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f1.destination,lotId:f1.lot,kind:"consumed",quantity:"5",reason:"Consume remaining 5 from ackA"});
  const uB1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f1.destination,lotId:f1.lot,kind:"consumed",quantity:"20",reason:"Consume 20 from ackB"});
  const stRace=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:f1.destination,lotId:f1.lot,countedQuantity:"0",reason:"Stocktake 0 for concurrency check"});

  // Real PostgreSQL concurrency check: two simultaneous terminal closures on ackA (5) with distinct keys and distinct evidence
  const raceOutcomes=await Promise.allSettled([
   custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`${ackA.id}:${lineId1}`,evidenceEventId:uA2.id,locationId:f1.destination,lotId:f1.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"5",recordedConsumptionQuantity:"5",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Concurrent terminalA #1"}),
   custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`${ackA.id}:${lineId1}`,evidenceEventId:stRace.id,locationId:f1.destination,lotId:f1.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"5",recordedConsumptionQuantity:"5",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"Concurrent terminalA #2"}),
  ]);
  expect(raceOutcomes.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(raceOutcomes.filter(r=>r.status==="rejected")).toHaveLength(1);

  // After terminalA=5, only ackB=20 remains open
  const viewAfterTermA=await custody.readDoctorCustody(doctorA);
  const lotAfterTermA=viewAfterTermA.closableLots.find(r=>r.locationId===f1.destination&&r.lotId===f1.lot)!;
  expect(lotAfterTermA.lotOriginalQuantity).toBe("20");
  expect(lotAfterTermA.tranches).toEqual([
   expect.objectContaining({packageId:`${ackB.id}:${lineId1}`,originalQuantity:"20",recordedConsumptionQuantity:"20",remainingQuantity:"0"}),
  ]);

  // TerminalB=20 closes the rest with zero hidden remainder
  const termB=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`${ackB.id}:${lineId1}`,evidenceEventId:uB1.id,locationId:f1.destination,lotId:f1.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"20",recordedConsumptionQuantity:"20",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"0",reason:"TerminalB closes full 20"});
  expect(termB).toMatchObject({closureKind:"terminal",terminalClosure:true,originalQuantity:"20",retiredOriginalQuantity:"20"});
  const viewAfterTermB=await custody.readDoctorCustody(doctorA);
  expect(viewAfterTermB.closableLots.find(r=>r.locationId===f1.destination&&r.lotId===f1.lot)).toBeUndefined();

  // 2. Multiple checkpoints on ackA2 and out-of-order checkpoint on ackB2 BEFORE ackA2
  const f2=await fixture();
  const t2=transfer(f2,"30");
  const lineId2=t2.lines[0].id;
  await custody.dispatchCustodyTransfer(admin,key(),t2);
  const ackA2=ack(t2,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackA2);
  const u2_a1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f2.destination,lotId:f2.lot,kind:"consumed",quantity:"3",reason:"Consume 3 on ackA2"});
  const u2_a2=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f2.destination,lotId:f2.lot,kind:"consumed",quantity:"4",reason:"Consume 4 on ackA2"});
  const ackB2=ack(t2,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackB2);
  const u2_b1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f2.destination,lotId:f2.lot,kind:"consumed",quantity:"8",reason:"Consume 8 on ackB2"});

  // Checkpoint ackB2 FIRST (20 -> consume 8 -> remaining 12) before any checkpoint on ackA2
  const cpB2First=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`${ackB2.id}:${lineId2}`,evidenceEventId:u2_b1.id,locationId:f2.destination,lotId:f2.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"20",recordedConsumptionQuantity:"8",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"12",reason:"Out-of-order checkpoint on ackB2 before ackA2"});
  expect(cpB2First).toMatchObject({closureKind:"checkpoint",originalQuantity:"20",retiredOriginalQuantity:"8",remainingQuantity:"12"});

  // Now two consecutive checkpoints on ackA2 (10 -> 7 -> 3) using u2_a1 and u2_a2
  const cpA2_1=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`${ackA2.id}:${lineId2}`,evidenceEventId:u2_a1.id,locationId:f2.destination,lotId:f2.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"10",recordedConsumptionQuantity:"3",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"7",reason:"First checkpoint on ackA2"});
  expect(cpA2_1).toMatchObject({closureKind:"checkpoint",originalQuantity:"10",retiredOriginalQuantity:"3",remainingQuantity:"7"});
  const cpA2_2=await custody.closeCustodyPackage(doctorA,key(),{id:key(),packageId:`${ackA2.id}:${lineId2}`,evidenceEventId:u2_a2.id,locationId:f2.destination,lotId:f2.lot,hazard:"sharp",policy:"safe_disposal_record",originalQuantity:"7",recordedConsumptionQuantity:"4",returnedOrTransferredQuantity:"0",approvedWasteQuantity:"0",remainingQuantity:"3",reason:"Second checkpoint on ackA2"});
  expect(cpA2_2).toMatchObject({closureKind:"checkpoint",originalQuantity:"7",retiredOriginalQuantity:"4",remainingQuantity:"3"});

  const viewMultiCp=await custody.readDoctorCustody(doctorA);
  const lotMultiCp=viewMultiCp.closableLots.find(r=>r.locationId===f2.destination&&r.lotId===f2.lot)!;
  expect(lotMultiCp.lotOriginalQuantity).toBe("15");
  expect(lotMultiCp.tranches).toEqual([
   expect.objectContaining({packageId:`${ackA2.id}:${lineId2}`,originalQuantity:"3"}),
   expect.objectContaining({packageId:`${ackB2.id}:${lineId2}`,originalQuantity:"12"}),
  ]);

  // 3. Requirement 2: Legacy line-only closure (<lineId> or checkpoint:<id>:<lineId>)
  // 3a) Unambiguous single-ack line: legacy checkpoint:<id>:<lineId> retiring 4 from 10 leaves 6 open
  const f3=await fixture();
  const tSingle=transfer(f3,"10");
  const lineSingle=tSingle.lines[0].id;
  await custody.dispatchCustodyTransfer(admin,key(),tSingle);
  const ackSingle=ack(tSingle,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackSingle);
  const uSingle4=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f3.destination,lotId:f3.lot,kind:"consumed",quantity:"4",reason:"Consume 4 before legacy line-only checkpoint"});
  const legacySingleId=key();
  await db.getPool().query(
   "INSERT INTO custody_package_closures(id,package_id,evidence_event_id,location_id,lot_id,hazard,policy,evidence_action,original_qty,consumed_qty,returned_qty,waste_qty,remaining_qty,unexplained_atoms,review_required,reason,document,created_by) VALUES($1,$2,$3,$4,$5,'sharp','safe_disposal_record','document_safe_disposal',4,4,0,0,6,0,TRUE,'Legacy line-only checkpoint on single-ack line',$6::jsonb,$7)",
   [legacySingleId,`checkpoint:${legacySingleId}:${lineSingle}`,uSingle4.id,f3.destination,f3.lot,JSON.stringify({id:legacySingleId,canonicalPackageSourceId:`transfer_line:${lineSingle}`}),doctorA.userId],
  );
  const viewSingleLegacy=await custody.readDoctorCustody(doctorA);
  expect(viewSingleLegacy.legacySourceReconciliationRequired.filter(r=>r.lotId===f3.lot)).toEqual([]);
  const lotSingleLegacy=viewSingleLegacy.closableLots.find(r=>r.locationId===f3.destination&&r.lotId===f3.lot)!;
  expect(lotSingleLegacy.tranches).toEqual([
   expect.objectContaining({packageId:`${ackSingle.id}:${lineSingle}`,originalQuantity:"6"}),
  ]);

  // 3b) Ambiguous multi-ack line with unmapped legacy line-only closure -> exposes legacy_source_reconciliation_required & blocks closure until mapped
  const f4=await fixture();
  const tMultiLeg=transfer(f4,"30");
  const lineMultiLeg=tMultiLeg.lines[0].id;
  await custody.dispatchCustodyTransfer(admin,key(),tMultiLeg);
  const ackLegA=ack(tMultiLeg,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackLegA);
  const ackLegB=ack(tMultiLeg,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackLegB);
  const uLeg5=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f4.destination,lotId:f4.lot,kind:"consumed",quantity:"5",reason:"Consume 5 on multi-ack legacy line"});
  const uLegMore=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f4.destination,lotId:f4.lot,kind:"consumed",quantity:"25",reason:"Consume remaining 25 on multi-ack legacy line"});
  const legacyAmbigId=key();
  await db.getPool().query(
   "INSERT INTO custody_package_closures(id,package_id,evidence_event_id,location_id,lot_id,hazard,policy,evidence_action,original_qty,consumed_qty,returned_qty,waste_qty,remaining_qty,unexplained_atoms,review_required,reason,document,created_by) VALUES($1,$2,$3,$4,$5,'sharp','safe_disposal_record','document_safe_disposal',5,5,0,0,25,0,TRUE,'Unmapped legacy line-only checkpoint on multi-ack line',$6::jsonb,$7)",
   [legacyAmbigId,`checkpoint:${legacyAmbigId}:${lineMultiLeg}`,uLeg5.id,f4.destination,f4.lot,JSON.stringify({id:legacyAmbigId,canonicalPackageSourceId:`transfer_line:${lineMultiLeg}`}),doctorA.userId],
  );

  const viewAmbig=await custody.readDoctorCustody(doctorA);
  expect(viewAmbig.legacySourceReconciliationRequired).toContainEqual(
   expect.objectContaining({
    locationId:f4.destination,
    lotId:f4.lot,
    transferLineIds:[lineMultiLeg],
    reason:"legacy_source_reconciliation_required",
   }),
  );
  // Rejects closure on lineMultiLeg, ackLegA, or ackLegB with legacy_source_reconciliation_required
  for(const targetPkg of [lineMultiLeg,`${ackLegA.id}:${lineMultiLeg}`,`${ackLegB.id}:${lineMultiLeg}`]){
   await expect(custody.closeCustodyPackage(doctorA,key(),{
    id:key(),
    packageId:targetPkg,
    evidenceEventId:uLegMore.id,
    locationId:f4.destination,
    lotId:f4.lot,
    hazard:"sharp",
    policy:"safe_disposal_record",
    originalQuantity:"8",
    recordedConsumptionQuantity:"8",
    returnedOrTransferredQuantity:"0",
    approvedWasteQuantity:"0",
    remainingQuantity:"0",
    reason:"Attempt closure while legacy line-only closure is unmapped",
   })).rejects.toMatchObject({code:"legacy_source_reconciliation_required"});
  }

  // Historical closure records remain strictly immutable (append-only trigger blocks UPDATE)
  await expect(
   db.getPool().query(
    "UPDATE custody_package_closures SET document = document || $2::jsonb WHERE id = $1",
    [legacyAmbigId,JSON.stringify({legacyAckAllocations:[{acknowledgementId:ackLegA.id,retiredOriginalQuantity:"2"},{acknowledgementId:ackLegB.id,retiredOriginalQuantity:"3"}]})],
   ),
  ).rejects.toThrow(/append-only/i);

  // 3c) Multi-ack line with a documented one-time legacyAckAllocations mapping (2 from ackMapA + 3 from ackMapB = 5) attributes each share once and allows closing remaining 8 and 17
  const f5=await fixture();
  const tMappedLeg=transfer(f5,"30");
  const lineMappedLeg=tMappedLeg.lines[0].id;
  await custody.dispatchCustodyTransfer(admin,key(),tMappedLeg);
  const ackMapA=ack(tMappedLeg,"10","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackMapA);
  const ackMapB=ack(tMappedLeg,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackMapB);
  const uMap5=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f5.destination,lotId:f5.lot,kind:"consumed",quantity:"5",reason:"Consume 5 on mapped legacy multi-ack line"});
  const uMap8=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f5.destination,lotId:f5.lot,kind:"consumed",quantity:"8",reason:"Consume remaining 8 of ackMapA"});
  const uMap17=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:f5.destination,lotId:f5.lot,kind:"consumed",quantity:"17",reason:"Consume remaining 17 of ackMapB"});
  const legacyMappedId=key();
  await db.getPool().query(
   "INSERT INTO custody_package_closures(id,package_id,evidence_event_id,location_id,lot_id,hazard,policy,evidence_action,original_qty,consumed_qty,returned_qty,waste_qty,remaining_qty,unexplained_atoms,review_required,reason,document,created_by) VALUES($1,$2,$3,$4,$5,'sharp','safe_disposal_record','document_safe_disposal',5,5,0,0,25,0,TRUE,'Mapped legacy line-only checkpoint on multi-ack line',$6::jsonb,$7)",
   [
    legacyMappedId,
    `checkpoint:${legacyMappedId}:${lineMappedLeg}`,
    uMap5.id,
    f5.destination,
    f5.lot,
    JSON.stringify({
     id:legacyMappedId,
     canonicalPackageSourceId:`transfer_line:${lineMappedLeg}`,
     legacyAckAllocations:[
      {acknowledgementId:ackMapA.id,retiredOriginalQuantity:"2"},
      {acknowledgementId:ackMapB.id,retiredOriginalQuantity:"3"},
     ],
    }),
    doctorA.userId,
   ],
  );
  const viewMapped=await custody.readDoctorCustody(doctorA);
  expect(viewMapped.legacySourceReconciliationRequired.filter(r=>r.lotId===f5.lot)).toEqual([]);
  const lotMapped=viewMapped.closableLots.find(r=>r.locationId===f5.destination&&r.lotId===f5.lot)!;
  expect(lotMapped.tranches).toEqual([
   expect.objectContaining({packageId:`${ackMapA.id}:${lineMappedLeg}`,originalQuantity:"8"}),
   expect.objectContaining({packageId:`${ackMapB.id}:${lineMappedLeg}`,originalQuantity:"17"}),
  ]);
  await expect(custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackMapA.id}:${lineMappedLeg}`,
   evidenceEventId:uMap8.id,
   locationId:f5.destination,
   lotId:f5.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"8",
   recordedConsumptionQuantity:"8",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"0",
   remainingQuantity:"0",
   reason:"Terminal close remaining 8 on ackMapA",
  })).resolves.toMatchObject({reviewRequired:true,remainingQuantity:"0"});
  await expect(custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackMapB.id}:${lineMappedLeg}`,
   evidenceEventId:uMap17.id,
   locationId:f5.destination,
   lotId:f5.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"17",
   recordedConsumptionQuantity:"17",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"0",
   remainingQuantity:"0",
   reason:"Terminal close remaining 17 on ackMapB",
  })).resolves.toMatchObject({reviewRequired:true,remainingQuantity:"0"});
  expect((await custody.readDoctorCustody(doctorA)).closableLots.find(r=>r.lotId===f5.lot)).toBeUndefined();
 });
 it("fa900 review P2: cumulative evidence retirement prevents subtracting later event w2/c2 across two earlier closures to revive exhausted w1/c1 after w3/c3 arrives",async()=>{
  const pause=()=>new Promise(resolve=>setTimeout(resolve,15));

  // 1) Approved waste branch: sources A=10, B=10, C=20 -> w1=10, w2=10 -> closeA(waste=10, stocktake), closeB(waste=10, stocktake) -> w3=10 -> checkpoint C(20/waste 10/rem 10) rejects w1 & w2 with zero DB writes, accepts w3 with verified_disposal_record
  const fWaste=await fixture();
  const trWA=transfer(fWaste,"10"),trWB=transfer(fWaste,"10"),trWC=transfer(fWaste,"20");
  await custody.dispatchCustodyTransfer(admin,key(),trWA);
  await custody.dispatchCustodyTransfer(admin,key(),trWB);
  await custody.dispatchCustodyTransfer(admin,key(),trWC);
  const ackWA=ack(trWA,"10","0"),ackWB=ack(trWB,"10","0"),ackWC=ack(trWC,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackWA);
  await pause();
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackWB);
  await pause();
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackWC);
  await pause();

  const appW1=key();
  await custody.approveCustodyWaste(admin,key(),{id:appW1,locationId:fWaste.destination,lotId:fWaste.lot,quantity:"10",reason:"Approve w1=10"});
  const w1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fWaste.destination,lotId:fWaste.lot,kind:"approved_waste",quantity:"10",approvalId:appW1,reason:"Execute w1=10"});
  await pause();

  const appW2=key();
  await custody.approveCustodyWaste(admin,key(),{id:appW2,locationId:fWaste.destination,lotId:fWaste.lot,quantity:"10",reason:"Approve w2=10"});
  const w2=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fWaste.destination,lotId:fWaste.lot,kind:"approved_waste",quantity:"10",approvalId:appW2,reason:"Execute w2=10"});
  await pause();

  const stWA=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:fWaste.destination,lotId:fWaste.lot,countedQuantity:"20",reason:"Stocktake after w1+w2 for closeA"});
  const closeWA=await custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackWA.id}:${trWA.lines[0].id}`,
   evidenceEventId:stWA.id,
   locationId:fWaste.destination,
   lotId:fWaste.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"10",
   recordedConsumptionQuantity:"0",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"10",
   remainingQuantity:"0",
   reason:"Close source A=10 waste=10 with stocktake stWA",
  });
  expect(closeWA).toMatchObject({closureKind:"terminal",reviewRequired:true});
  await pause();

  const stWB=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:fWaste.destination,lotId:fWaste.lot,countedQuantity:"20",reason:"Stocktake after w1+w2 for closeB"});
  const closeWB=await custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackWB.id}:${trWB.lines[0].id}`,
   evidenceEventId:stWB.id,
   locationId:fWaste.destination,
   lotId:fWaste.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"10",
   recordedConsumptionQuantity:"0",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"10",
   remainingQuantity:"0",
   reason:"Close source B=10 waste=10 with stocktake stWB",
  });
  expect(closeWB).toMatchObject({closureKind:"terminal",reviewRequired:true});
  await pause();

  const appW3=key();
  await custody.approveCustodyWaste(admin,key(),{id:appW3,locationId:fWaste.destination,lotId:fWaste.lot,quantity:"10",reason:"Approve w3=10 after closeA and closeB"});
  const w3=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fWaste.destination,lotId:fWaste.lot,kind:"approved_waste",quantity:"10",approvalId:appW3,reason:"Execute w3=10 after closeA and closeB"});

  // Verify strict chronological ordering of timestamps in PostgreSQL
  const wasteOrder=(await db.getPool().query<{ordered:boolean}>(
   `SELECT (
      (SELECT created_at FROM custody_usage_events WHERE id=$1::uuid) < (SELECT created_at FROM custody_usage_events WHERE id=$2::uuid)
      AND (SELECT created_at FROM custody_usage_events WHERE id=$2::uuid) < (SELECT created_at FROM custody_package_closures WHERE id=$3::uuid)
      AND (SELECT created_at FROM custody_package_closures WHERE id=$3::uuid) < (SELECT created_at FROM custody_package_closures WHERE id=$4::uuid)
      AND (SELECT created_at FROM custody_package_closures WHERE id=$4::uuid) < (SELECT created_at FROM custody_usage_events WHERE id=$5::uuid)
    ) AS ordered`,
   [w1.id,w2.id,closeWA.id,closeWB.id,w3.id],
  )).rows[0].ordered;
  expect(wasteOrder).toBe(true);

  const wasteCountsBefore=(await db.getPool().query<{closures:number;usages:number}>(
   "SELECT (SELECT COUNT(*)::int FROM custody_package_closures WHERE location_id=$1 AND lot_id=$2) AS closures,(SELECT COUNT(*)::int FROM custody_usage_events WHERE location_id=$1 AND lot_id=$2) AS usages",
   [fWaste.destination,fWaste.lot],
  )).rows[0];

  // Presenting exhausted w1 (or its approval appW1, or exhausted w2) on C checkpoint (20 / waste 10 / remaining 10) must fail package_evidence_mismatch with zero DB writes
  for(const retiredEvId of [w1.id,appW1,w2.id,appW2]){
   await expect(custody.closeCustodyPackage(doctorA,key(),{
    id:key(),
    packageId:`${ackWC.id}:${trWC.lines[0].id}`,
    evidenceEventId:retiredEvId,
    locationId:fWaste.destination,
    lotId:fWaste.lot,
    hazard:"sharp",
    policy:"safe_disposal_record",
    evidenceAction:"document_safe_disposal",
    originalQuantity:"20",
    recordedConsumptionQuantity:"0",
    returnedOrTransferredQuantity:"0",
    approvedWasteQuantity:"10",
    remainingQuantity:"10",
    reason:"Reject exhausted waste evidence on source C checkpoint",
   })).rejects.toMatchObject({code:"package_evidence_mismatch"});
  }

  const wasteCountsAfterReject=(await db.getPool().query<{closures:number;usages:number}>(
   "SELECT (SELECT COUNT(*)::int FROM custody_package_closures WHERE location_id=$1 AND lot_id=$2) AS closures,(SELECT COUNT(*)::int FROM custody_usage_events WHERE location_id=$1 AND lot_id=$2) AS usages",
   [fWaste.destination,fWaste.lot],
  )).rows[0];
  expect(wasteCountsAfterReject).toEqual(wasteCountsBefore);

  // Presenting fresh unretired w3 succeeds on C checkpoint (20 / waste 10 / remaining 10) with verified_disposal_record and reviewRequired: false
  const closeWC=await custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackWC.id}:${trWC.lines[0].id}`,
   evidenceEventId:w3.id,
   locationId:fWaste.destination,
   lotId:fWaste.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   evidenceAction:"document_safe_disposal",
   originalQuantity:"20",
   recordedConsumptionQuantity:"0",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"10",
   remainingQuantity:"10",
   reason:"Accept fresh w3=10 on source C checkpoint",
  });
  expect(closeWC).toMatchObject({
   closureKind:"checkpoint",
   terminalClosure:false,
   reviewRequired:false,
   evidenceVerificationStatus:"verified_disposal_record",
   retiredOriginalQuantity:"10",
   remainingQuantity:"10",
  });

  // 2) Confirmed consumption branch: sources A=10, B=10, C=20 -> c1=10, c2=10 -> closeA(consumed=10, stocktake), closeB(consumed=10, stocktake) -> c3=10 -> checkpoint C(20/consumed 10/rem 10) rejects c1 & c2 with zero DB writes, accepts c3
  const fCons=await fixture();
  const trCA=transfer(fCons,"10"),trCB=transfer(fCons,"10"),trCC=transfer(fCons,"20");
  await custody.dispatchCustodyTransfer(admin,key(),trCA);
  await custody.dispatchCustodyTransfer(admin,key(),trCB);
  await custody.dispatchCustodyTransfer(admin,key(),trCC);
  const ackCA=ack(trCA,"10","0"),ackCB=ack(trCB,"10","0"),ackCC=ack(trCC,"20","0");
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackCA);
  await pause();
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackCB);
  await pause();
  await custody.acknowledgeCustodyTransfer(doctorA,key(),ackCC);
  await pause();

  const c1=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fCons.destination,lotId:fCons.lot,kind:"consumed",quantity:"10",reason:"Record c1=10"});
  await pause();
  const c2=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fCons.destination,lotId:fCons.lot,kind:"consumed",quantity:"10",reason:"Record c2=10"});
  await pause();

  const stCA=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:fCons.destination,lotId:fCons.lot,countedQuantity:"20",reason:"Stocktake after c1+c2 for closeCA"});
  const closeCA=await custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackCA.id}:${trCA.lines[0].id}`,
   evidenceEventId:stCA.id,
   locationId:fCons.destination,
   lotId:fCons.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"10",
   recordedConsumptionQuantity:"10",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"0",
   remainingQuantity:"0",
   reason:"Close source A=10 consumed=10 with stocktake stCA",
  });
  expect(closeCA).toMatchObject({closureKind:"terminal",reviewRequired:true});
  await pause();

  const stCB=await custody.recordCustodyStocktake(doctorA,key(),{id:key(),locationId:fCons.destination,lotId:fCons.lot,countedQuantity:"20",reason:"Stocktake after c1+c2 for closeCB"});
  const closeCB=await custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackCB.id}:${trCB.lines[0].id}`,
   evidenceEventId:stCB.id,
   locationId:fCons.destination,
   lotId:fCons.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"10",
   recordedConsumptionQuantity:"10",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"0",
   remainingQuantity:"0",
   reason:"Close source B=10 consumed=10 with stocktake stCB",
  });
  expect(closeCB).toMatchObject({closureKind:"terminal",reviewRequired:true});
  await pause();

  const c3=await custody.recordCustodyUsage(doctorA,key(),{id:key(),locationId:fCons.destination,lotId:fCons.lot,kind:"consumed",quantity:"10",reason:"Record c3=10 after closeCA and closeCB"});

  const consCountsBefore=(await db.getPool().query<{closures:number;usages:number}>(
   "SELECT (SELECT COUNT(*)::int FROM custody_package_closures WHERE location_id=$1 AND lot_id=$2) AS closures,(SELECT COUNT(*)::int FROM custody_usage_events WHERE location_id=$1 AND lot_id=$2) AS usages",
   [fCons.destination,fCons.lot],
  )).rows[0];

  for(const retiredConsId of [c1.id,c2.id]){
   await expect(custody.closeCustodyPackage(doctorA,key(),{
    id:key(),
    packageId:`${ackCC.id}:${trCC.lines[0].id}`,
    evidenceEventId:retiredConsId,
    locationId:fCons.destination,
    lotId:fCons.lot,
    hazard:"sharp",
    policy:"safe_disposal_record",
    originalQuantity:"20",
    recordedConsumptionQuantity:"10",
    returnedOrTransferredQuantity:"0",
    approvedWasteQuantity:"0",
    remainingQuantity:"10",
    reason:"Reject exhausted consumption evidence on source C checkpoint",
   })).rejects.toMatchObject({code:"package_evidence_mismatch"});
  }

  const consCountsAfterReject=(await db.getPool().query<{closures:number;usages:number}>(
   "SELECT (SELECT COUNT(*)::int FROM custody_package_closures WHERE location_id=$1 AND lot_id=$2) AS closures,(SELECT COUNT(*)::int FROM custody_usage_events WHERE location_id=$1 AND lot_id=$2) AS usages",
   [fCons.destination,fCons.lot],
  )).rows[0];
  expect(consCountsAfterReject).toEqual(consCountsBefore);

  const closeCC=await custody.closeCustodyPackage(doctorA,key(),{
   id:key(),
   packageId:`${ackCC.id}:${trCC.lines[0].id}`,
   evidenceEventId:c3.id,
   locationId:fCons.destination,
   lotId:fCons.lot,
   hazard:"sharp",
   policy:"safe_disposal_record",
   originalQuantity:"20",
   recordedConsumptionQuantity:"10",
   returnedOrTransferredQuantity:"0",
   approvedWasteQuantity:"0",
   remainingQuantity:"10",
   reason:"Accept fresh c3=10 on source C checkpoint",
  });
  expect(closeCC).toMatchObject({
   closureKind:"checkpoint",
   terminalClosure:false,
   reviewRequired:true,
   retiredOriginalQuantity:"10",
   remainingQuantity:"10",
  });
 });
});



