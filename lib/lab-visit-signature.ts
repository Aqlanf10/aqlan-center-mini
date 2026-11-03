import {createHash} from "node:crypto";
import type {ProcedureLine} from "./clinical";
/** Review fence, not clinical identity. Computed from the DTO and checked under source locks. */
export function labVisitSignatureVersion(input:{visitId:number;patientId:number|null;doctorId:number|null;billingCurrency:string|null;diagnosis:string|null;treatmentDone:string|null;procedures:readonly ProcedureLine[]}):string{
 return createHash("sha256").update(JSON.stringify([input.visitId,input.patientId,input.doctorId,input.billingCurrency,input.diagnosis,input.treatmentDone,
  [...input.procedures].sort((a,b)=>a.id-b.id).map(line=>[line.id,line.serviceId,line.toothCode,line.surfaces,line.quantity,line.unitPriceMinor,line.doctorId,line.planItemId,line.note,
   line.labWork?[line.labWork.intentId,line.labWork.memberId,line.labWork.expectedRevision]:null])])).digest("hex");
}
