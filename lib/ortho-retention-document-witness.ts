import { assertRetentionData } from "./ortho-retention-data";
/** Immutable documentary identity. This is evidence, never a live image URL. */
import { journeyId, journeyHash, type Checked } from './ortho-case-journey-records';
export interface RetentionDocumentWitness { id:number; patientId:number; orthoCaseId:number; sha256:string; metadataHash:string }
export function readRetentionDocumentWitnesses(raw:unknown,ids:readonly number[]):Checked<RetentionDocumentWitness[]> {
 try { assertRetentionData(raw, 10000); } catch { return {ok:false,code:"invalid_retention_data"}; }
 if(!Array.isArray(raw)||raw.length!==ids.length||raw.length>30||Object.keys(raw).length!==raw.length)return {ok:false,code:'retention_document_witness'};
 const result:RetentionDocumentWitness[]=[];
 for(let i=0;i<raw.length;i++){
  const w=raw[i];
  if(!w||typeof w!=='object'||Array.isArray(w)||Object.getPrototypeOf(w)!==Object.prototype||Object.getOwnPropertySymbols(w).length
   ||Object.keys(w).sort().join('|')!=='id|metadataHash|orthoCaseId|patientId|sha256'||!journeyId(w.id)||w.id!==ids[i]
   ||!journeyId(w.patientId)||!journeyId(w.orthoCaseId)||!journeyHash(w.sha256)||!journeyHash(w.metadataHash))return {ok:false,code:'retention_document_witness'};
  result.push({id:w.id,patientId:w.patientId,orthoCaseId:w.orthoCaseId,sha256:w.sha256,metadataHash:w.metadataHash});
 }
 return {ok:true,value:result};
}
