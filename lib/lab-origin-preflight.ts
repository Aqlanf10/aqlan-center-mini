import {normalizeLabWorkGroups,LabWorkContractError} from "./lab-work-intent-contract";
/** Structural preflight only; live authorization/provider/revision checks remain server authority. */
export function validateClinicalLabOriginBody(body:Record<string,unknown>,categories:ReadonlyMap<number,string|null>):void{
 if(!Array.isArray(body.procedures))throw new LabWorkContractError("invalid");
 const number=(value:unknown)=>typeof value==="number"?value:NaN;
 normalizeLabWorkGroups(body.procedures.map(raw=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new LabWorkContractError("invalid");
  const row=raw as Record<string,unknown>,serviceId=number(row.serviceId);
  return {serviceId,toothCode:row.toothCode===null?null:number(row.toothCode),quantity:number(row.quantity),
   planItemId:row.planItemId===null?null:number(row.planItemId),doctorId:row.doctorId===null?null:number(row.doctorId),
   category:categories.get(serviceId)??null,labWork:row.labWork};
 }),body.labRetirements??[]);
}
