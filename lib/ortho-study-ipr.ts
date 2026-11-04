/** Pure, versioned documentary snapshot. No patient/file fetch or treatment rule. */
import { journeyContentHash } from './ortho-case-journey-hash';
import { journeyId, journeyHash, type JourneyScope } from './ortho-case-journey-records';
import type { JourneyRevision } from './ortho-case-journey-history';
import { readSpaceSavedContent, type SpaceSavedContent } from './ortho-space-saved';
import { projectIpr } from './ortho-space-ledger';
export const STUDY_IPR_VERSION = 'ipr-documented-events-v1';
export const STUDY_IPR_LIMIT = 256;
export type StudyIprEntry = Pick<JourneyRevision<SpaceSavedContent>, 'id'|'version'|'predecessorId'|'recordedPatientId'|'createdAt'|'createdBy'|'reason'|'contentHash'|'content'>;
export interface StudyIprSnapshot extends JourneyScope {
  schemaVersion: 1; projectionVersion: typeof STUDY_IPR_VERSION; headId: number; headVersion: number;
  entries: StudyIprEntry[]; currentIds: number[];
  totals: {arch:'upper'|'lower';contact:string;performedUm:number|null}[];
}
function fail(): never { throw Error('invalid_study_ipr_snapshot'); }
function obj(raw: unknown, keys: string[]) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join('|')!==keys.sort().join('|'))fail();
  return raw as Record<string,unknown>;
}
export function studyIprEntry(r: JourneyRevision<SpaceSavedContent>): StudyIprEntry {
  const {id,version,predecessorId,recordedPatientId,createdAt,createdBy,reason,contentHash,content}=r;
  return {id,version,predecessorId,recordedPatientId,createdAt,createdBy,reason,contentHash,content};
}
export function makeStudyIprSnapshot(scope:JourneyScope,entries:StudyIprEntry[]):StudyIprSnapshot {
  const projected=projectIpr(entries.map(e=>({id:e.id,version:e.version,content:e.content.authored})));
  if(!projected.ok||!projected.value.current.length)fail();
  const head=entries.at(-1);if(!head)fail();
  return {schemaVersion:1,projectionVersion:STUDY_IPR_VERSION,patientId:scope.patientId,orthoCaseId:scope.orthoCaseId,clinicalCaseId:scope.clinicalCaseId,
    headId:head.id,headVersion:head.version,entries,currentIds:projected.value.current.map(e=>e.id),totals:projected.value.totals};
}
export function readStudyIprSnapshot(raw:unknown,scope:JourneyScope):StudyIprSnapshot {
  const p=obj(raw,['schemaVersion','projectionVersion','patientId','orthoCaseId','clinicalCaseId','headId','headVersion','entries','currentIds','totals']);
  if(p.schemaVersion!==1||p.projectionVersion!==STUDY_IPR_VERSION||p.patientId!==scope.patientId||p.orthoCaseId!==scope.orthoCaseId||p.clinicalCaseId!==scope.clinicalCaseId
    ||!Array.isArray(p.entries)||!p.entries.length||p.entries.length>STUDY_IPR_LIMIT)fail();
  const entries:StudyIprEntry[]=[],seen=new Set<number>();
  for(const rawEntry of p.entries){
    const e=obj(rawEntry,['id','version','predecessorId','recordedPatientId','createdAt','createdBy','reason','contentHash','content']);
    if(!journeyId(e.id)||seen.has(e.id)||!journeyId(e.recordedPatientId)||e.version!==entries.length+1||e.predecessorId!==(entries.at(-1)?.id??null)
      ||!journeyHash(e.contentHash)||typeof e.createdAt!=='string'||!Number.isFinite(Date.parse(e.createdAt))
      ||typeof e.createdBy!=='string'||!e.createdBy.trim()||e.createdBy.length>200||typeof e.reason!=='string'||!e.reason.trim()||e.reason.length>500)fail();
    const c=readSpaceSavedContent(e.content);if(!c.ok||journeyContentHash(c.value)!==e.contentHash||journeyContentHash(e.content)!==e.contentHash)fail();
    seen.add(e.id);entries.push({id:e.id,version:e.version as number,predecessorId:e.predecessorId as number|null,recordedPatientId:e.recordedPatientId,
      createdAt:e.createdAt,createdBy:e.createdBy,reason:e.reason,contentHash:e.contentHash,content:c.value});
  }
  const checked=makeStudyIprSnapshot(scope,entries);
  if(journeyContentHash(checked)!==journeyContentHash(raw))fail();
  return checked;
}
