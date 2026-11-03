import { computeFacialResults, readFacialCommand, type FacialCommand, type FacialContent, type FacialResults } from "./ortho-facial-analysis";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
export interface FacialScope { patientId: number; orthoCaseId: number; clinicalCaseId: number }
export interface FacialRevision extends FacialScope {
  id: number; documentId: number; version: number; recordedPatientId: number; actorId: number; createdBy: string; createdAt: string;
  requestFingerprint: string; contentHash: string; command: FacialCommand; results: FacialResults;
}
export interface FacialDocument { id: number; title: string; sha256: string; takenOn: string | null }
export interface FacialRead extends FacialScope {
  ok: true; actorId: number; canWrite: boolean; documents: FacialDocument[]; documentsTruncated: boolean;
  selectedDocumentId: number | null; image: FacialContent["image"] | null; history: FacialRevision[]; historyTruncated: boolean;
}
const id=(v:unknown):v is number=>typeof v==="number"&&Number.isInteger(v)&&v>0&&v<=2147483647;
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const fail=():never=>{throw Error("invalid_facial_record");};
export function readFacialRevision(raw:unknown,scope:Pick<FacialScope,"patientId"|"orthoCaseId">):FacialRevision {
  if(!plain(raw)||Object.keys(raw).sort().join(',')!=="actorId,clinicalCaseId,command,contentHash,createdAt,createdBy,documentId,id,orthoCaseId,patientId,recordedPatientId,requestFingerprint,results,version"
    || raw.patientId!==scope.patientId||raw.orthoCaseId!==scope.orthoCaseId||![raw.id,raw.documentId,raw.version,raw.clinicalCaseId,raw.actorId,raw.recordedPatientId].every(id)
    ||typeof raw.createdBy!=="string"||!raw.createdBy.trim()||typeof raw.createdAt!=="string"||!Number.isFinite(Date.parse(raw.createdAt))||!hash(raw.requestFingerprint)||!hash(raw.contentHash))return fail();
  const command=readFacialCommand(raw.command);
  if(command.documentId!==raw.documentId||((raw.version===1)!==(command.expectedHeadId===null))
    ||canonicalJourneyJSON(computeFacialResults(command.content))!==canonicalJourneyJSON(raw.results))return fail();
  return raw as unknown as FacialRevision;
}
async function digest(value:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonicalJourneyJSON(value))))].map(v=>v.toString(16).padStart(2,"0")).join("");}
export async function verifyFacialRevision(raw:unknown,scope:Pick<FacialScope,"patientId"|"orthoCaseId">){
  const r=readFacialRevision(raw,scope);
  if(await digest(r.command)!==r.requestFingerprint||await digest({content:r.command.content,results:r.results})!==r.contentHash)return fail();return r;
}
export async function readFacialRead(raw:unknown,scope:Pick<FacialScope,"patientId"|"orthoCaseId">,documentId:number|null):Promise<FacialRead>{
  if(!plain(raw)||Object.keys(raw).sort().join(',')!=="actorId,canWrite,clinicalCaseId,documents,documentsTruncated,history,historyTruncated,image,ok,orthoCaseId,patientId,selectedDocumentId"
    ||raw.ok!==true||raw.patientId!==scope.patientId||raw.orthoCaseId!==scope.orthoCaseId||!id(raw.clinicalCaseId)||!id(raw.actorId)
    ||typeof raw.canWrite!=="boolean"||typeof raw.documentsTruncated!=="boolean"||typeof raw.historyTruncated!=="boolean"||raw.selectedDocumentId!==documentId
    ||!Array.isArray(raw.documents)||raw.documents.length>100||!Array.isArray(raw.history)||raw.history.length>30)return fail();
  const ids=new Set<number>();for(const d of raw.documents){if(!plain(d)||Object.keys(d).sort().join(',')!=="id,sha256,takenOn,title"||!id(d.id)||ids.has(d.id)||!hash(d.sha256)||typeof d.title!=="string"||!(d.takenOn===null||typeof d.takenOn==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(d.takenOn)))return fail();ids.add(d.id);}
  if(documentId===null ? raw.image!==null||raw.history.length!==0 : !ids.has(documentId)||!plain(raw.image))return fail();
  if(documentId!==null){const i=raw.image as Record<string,unknown>,d=raw.documents.find(d=>d.id===documentId);
    if(Object.keys(i).sort().join(',')!=="exifOrientation,height,sha256,width"||i.sha256!==d.sha256||!id(i.width)||!id(i.height)||!id(i.exifOrientation)||i.exifOrientation>8)return fail();}
  let previous:FacialRevision|null=null;for(const item of raw.history){const r=await verifyFacialRevision(item,scope);if(r.documentId!==documentId||r.clinicalCaseId!==raw.clinicalCaseId||canonicalJourneyJSON(r.command.content.image)!==canonicalJourneyJSON(raw.image)||previous&&(r.version!==previous.version-1||previous.command.expectedHeadId!==r.id))return fail();previous=r;}
  return raw as unknown as FacialRead;
}
export async function verifyFacialSaved(raw:unknown,expected:FacialScope&{actorId:number;command:FacialCommand},status:number){
  if(!plain(raw)||Object.keys(raw).sort().join(',')!=="ok,replayed,revision"||raw.ok!==true||typeof raw.replayed!=="boolean"||status!==(raw.replayed?200:201))return fail();
  const r=await verifyFacialRevision(raw.revision,expected);
  if(r.actorId!==expected.actorId||r.clinicalCaseId!==expected.clinicalCaseId||canonicalJourneyJSON(r.command)!==canonicalJourneyJSON(expected.command))return fail();return r;
}
