import { verifyFacialRevision, type FacialRevision, type FacialScope } from './ortho-facial-records';
import type { FacialContent } from './ortho-facial-analysis';
import { canonicalJourneyJSON } from './ortho-case-journey-json';
export const FACIAL_HISTORY_LIMITS={rows:30,rowBytes:128*1024,pageBytes:2*1024*1024} as const;
export interface FacialHistoryPage extends FacialScope {
 ok:true; actorId:number; documentId:number; image:FacialContent['image']; anchor:FacialRevision; history:FacialRevision[]; hasMore:boolean;
}
export interface FacialHistoryExpected extends FacialScope { actorId:number;documentId:number;anchor:FacialRevision }
export function facialHistoryBytes(value:unknown){return new TextEncoder().encode(canonicalJourneyJSON(value)).byteLength;}
/** Saved integrity verification is inherited unchanged. No replacement calculation,
 * latest-head substitution or editor permission is supplied by this read-only page. */
export async function verifyFacialHistoryPage(raw:unknown,expected:FacialHistoryExpected):Promise<FacialHistoryPage>{
 const fail=():never=>{throw Error('invalid_facial_history_page');};
 if(facialHistoryBytes(raw)>FACIAL_HISTORY_LIMITS.pageBytes)return fail();
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='actorId,anchor,clinicalCaseId,documentId,hasMore,history,image,ok,orthoCaseId,patientId')return fail();
 const r=raw as FacialHistoryPage;
 if(r.ok!==true||r.patientId!==expected.patientId||r.orthoCaseId!==expected.orthoCaseId||r.clinicalCaseId!==expected.clinicalCaseId||r.actorId!==expected.actorId||r.documentId!==expected.documentId
  ||typeof r.hasMore!=='boolean'||!Array.isArray(r.history)||r.history.length>FACIAL_HISTORY_LIMITS.rows)return fail();
 const rows=[r.anchor,...r.history];
 if(rows.some(row=>facialHistoryBytes(row)>FACIAL_HISTORY_LIMITS.rowBytes))return fail();
 const anchor=await verifyFacialRevision(r.anchor,expected);
 if(anchor.id!==expected.anchor.id||anchor.version!==expected.anchor.version||anchor.contentHash!==expected.anchor.contentHash||anchor.requestFingerprint!==expected.anchor.requestFingerprint
  ||canonicalJourneyJSON(anchor)!==canonicalJourneyJSON(expected.anchor))return fail();
 let previous=anchor;const ids=new Set<number>([anchor.id]);
 for(const row of rows){
  const checked=row===r.anchor?anchor:await verifyFacialRevision(row,expected);
  if(checked.clinicalCaseId!==expected.clinicalCaseId||checked.documentId!==expected.documentId||canonicalJourneyJSON(checked.command.content.image)!==canonicalJourneyJSON(r.image))return fail();
  if(row!==r.anchor){if(ids.has(checked.id)||checked.version!==previous.version-1||previous.command.expectedHeadId!==checked.id)return fail();ids.add(checked.id);previous=checked;}
 }
 if(r.hasMore?r.history.length!==FACIAL_HISTORY_LIMITS.rows||previous.version<=1:previous.version!==1)return fail();
 return r;
}
