import { authorizeJourney,assertJourneyCurrent,journeyFail,journeyTransaction,lockJourneyOwner,type JourneyOwnerInput } from './ortho-case-journey-authority';
import { lockFacialDocumentSource,readStoredFacialRevision } from './ortho-facial-store';
import { facialImageBasis } from './ortho-facial-image';
import { FACIAL_HISTORY_LIMITS,facialHistoryBytes,type FacialHistoryPage } from './ortho-facial-history';
import { canonicalJourneyJSON } from './ortho-case-journey-json';
export interface FacialHistoryRequest extends JourneyOwnerInput {documentId:number;beforeRevisionId:number;beforeContentHash:string}
export function getFacialHistoryPage(input:FacialHistoryRequest){
 return journeyTransaction(false,async client=>{
  if(![input.documentId,input.beforeRevisionId].every(id=>Number.isSafeInteger(id)&&id>0&&id<=2147483647)||!/^[a-f0-9]{64}$/.test(input.beforeContentHash))journeyFail(400,'invalid_history_cursor');
  const authority=await authorizeJourney(client,input,false);if(!authority.canViewImages)journeyFail(403,'image_access_denied');
  const doc=await lockFacialDocumentSource(client,input,input.documentId),owner=await lockJourneyOwner(client,input,false);
  const image=(await facialImageBasis(doc)).basis;
  const {rows:anchors}=await client.query('SELECT * FROM ortho_facial_revisions WHERE id=$1 AND ortho_case_id=$2 AND document_id=$3',[input.beforeRevisionId,owner.orthoCaseId,doc.id]);
  if(!anchors.length)journeyFail(404,'facial_history_anchor_unavailable');
  if(Buffer.byteLength(JSON.stringify(anchors[0]),'utf8')>FACIAL_HISTORY_LIMITS.rowBytes)journeyFail(413,'facial_history_too_large');
  const anchor=readStoredFacialRevision(anchors[0],owner);if(anchor.contentHash!==input.beforeContentHash)journeyFail(409,'facial_history_anchor_changed');
  const {rows}=await client.query('SELECT * FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND document_id=$2 AND version<$3 ORDER BY version DESC LIMIT 31',[owner.orthoCaseId,doc.id,anchor.version]);
  if(Buffer.byteLength(JSON.stringify([anchors[0],...rows.slice(0,FACIAL_HISTORY_LIMITS.rows)]),'utf8')>FACIAL_HISTORY_LIMITS.pageBytes)journeyFail(413,'facial_history_too_large');
  const history=[];let previous=anchor;
  for(const row of rows){
   if(Buffer.byteLength(JSON.stringify(row),'utf8')>FACIAL_HISTORY_LIMITS.rowBytes)journeyFail(413,'facial_history_too_large');
   const revision=readStoredFacialRevision(row,owner);
   if(canonicalJourneyJSON(revision.command.content.image)!==canonicalJourneyJSON(image))journeyFail(409,'facial_image_changed');
   if(revision.version!==previous.version-1||previous.command.expectedHeadId!==revision.id)journeyFail(500,'facial_history_invalid');
   previous=revision;if(history.length<FACIAL_HISTORY_LIMITS.rows)history.push(revision);
  }
  const hasMore=rows.length>FACIAL_HISTORY_LIMITS.rows;
  if(!hasMore&&previous.version!==1)journeyFail(500,'facial_history_invalid');
  const result:FacialHistoryPage={ok:true,patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId,actorId:authority.userId,documentId:doc.id,image,anchor,history,hasMore};
  if([anchor,...history].some(r=>r.clinicalCaseId!==owner.clinicalCaseId||canonicalJourneyJSON(r.command.content.image)!==canonicalJourneyJSON(image)))journeyFail(409,'facial_image_changed');
  if([anchor,...history].some(r=>facialHistoryBytes(r)>FACIAL_HISTORY_LIMITS.rowBytes)||facialHistoryBytes(result)>FACIAL_HISTORY_LIMITS.pageBytes)journeyFail(413,'facial_history_too_large');
  assertJourneyCurrent(authority);return result;
 });
}
