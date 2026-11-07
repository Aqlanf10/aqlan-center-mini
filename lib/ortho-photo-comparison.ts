import { buildComparison, PHOTO_STAGE_ORDER, PHOTO_VIEWS, type ComparisonColumn, type StagePhoto } from './ortho-photos';
import { isDocumentAcquisitionDate } from './document-acquisition-date';

export const PHOTO_COMPARISON_LIMITS = { bytes: 2 * 1024 * 1024, rows: 2000 } as const;
export interface ComparisonPhoto extends StagePhoto { title: string; note: string | null }
export type PhotoComparisonRead = {ok:true;patientId:number;orthoCaseId:number;
  columns:ComparisonColumn<ComparisonPhoto>[];unassigned:ComparisonPhoto[];excludedCount:number}
  | {ok:false;code:'invalid_photo_comparison'};
const plain=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const id=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const nullableId=(v:unknown)=>v===null||id(v);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  &&isDocumentAcquisitionDate(v.slice(0,10))&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
/** Shape/scope validation of an already authorized patient inventory, not a new
 * server authority or image-byte proof. Unrelated same-patient records are valid
 * inventory but excluded. Never promote unknown stage/date to clinical evidence. */
export function readPhotoComparison(payload:unknown,scope:{patientId:number;orthoCaseId:number}):PhotoComparisonRead {
  const invalid=():PhotoComparisonRead=>({ok:false,code:'invalid_photo_comparison'});
  if(!id(scope.patientId)||!id(scope.orthoCaseId)||!plain(payload)||!Array.isArray(payload.documents)
    ||payload.documents.length>PHOTO_COMPARISON_LIMITS.rows)return invalid();
  try{if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>PHOTO_COMPARISON_LIMITS.bytes)return invalid();}catch{return invalid();}
  const photos:ComparisonPhoto[]=[],seen=new Set<number>();let excludedCount=0;
  for(const row of payload.documents){
    // Patient-wide inventory legitimately includes other cases, nonimages and
    // legacy metadata. Validate ownership/identity first, then only interpret
    // acquisition fields for visible images in this exact case.
    if(!plain(row)||!id(row.id)||seen.has(row.id)||row.patientId!==scope.patientId||!nullableId(row.orthoCaseId)
      ||typeof row.isImage!=='boolean'||!(row.removedAt===null||timestamp(row.removedAt)))return invalid();
    seen.add(row.id);
    if(row.orthoCaseId!==scope.orthoCaseId||!row.isImage||row.removedAt!==null||row.photoStage==='archived'){excludedCount++;continue;}
    if(typeof row.title!=='string'||!(row.note===null||typeof row.note==='string')
      ||!(row.takenOn===null||isDocumentAcquisitionDate(row.takenOn))||!timestamp(row.uploadedAt)
      ||!(row.photoStage===null||PHOTO_STAGE_ORDER.some(s=>s===row.photoStage))
      ||!(row.photoView===null||PHOTO_VIEWS.some(v=>v===row.photoView)))return invalid();
    photos.push({id:row.id,stage:row.photoStage as ComparisonPhoto['stage'],view:row.photoView as ComparisonPhoto['view'],
      takenOn:row.takenOn as string|null,uploadedAt:row.uploadedAt,title:row.title,note:row.note as string|null});
  }
  return {ok:true,patientId:scope.patientId,orthoCaseId:scope.orthoCaseId,columns:buildComparison(photos),unassigned:photos.filter(p=>p.stage===null).sort((a,b)=>a.id-b.id),excludedCount};
}
