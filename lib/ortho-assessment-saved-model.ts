/** Presentation of an already verified and currently authorized selected revision.
 * These relationship checks are not a replacement for the version-pinned read
 * verifier or source authority. Stored witnesses are copied, never recomputed. */
import type { AssessmentReadResponseV2 } from './ortho-assessment-response-v2';
import { canonicalJourneyJSON } from './ortho-case-journey-json';

export interface SavedModelExpected {
  patientId: number; orthoCaseId: number; clinicalCaseId: number; revisionId: number;
}
const invalid = () => ({ok:false as const,code:'saved_model_invalid' as const});
const unavailable = () => ({ok:false as const,code:'saved_model_unavailable' as const});
const id = (value:number) => Number.isSafeInteger(value) && value > 0;
const hash = (value:string) => /^[a-f0-9]{64}$/.test(value);
function unique(values: readonly string[]) { return values.every(v=>typeof v==='string' && v.length>0) && new Set(values).size===values.length; }
function copy<T>(value:T):T { return JSON.parse(canonicalJourneyJSON(value)) as T; }

export function buildSavedModelReview(data:AssessmentReadResponseV2, expected:SavedModelExpected) {
  try {
    if(data.state==='bridge_missing'||!data.revision||data.revision.schemaVersion!==2) return unavailable();
    const revision=data.revision, content=revision.content, draft=content.draft;
    if(data.ok!==true||data.representation!==2||data.state!=='ready'
      ||!Object.values(expected).every(id)||data.patientId!==expected.patientId||data.orthoCaseId!==expected.orthoCaseId
      ||data.clinicalCaseId!==expected.clinicalCaseId||revision.id!==expected.revisionId
      ||revision.patientId!==data.patientId||revision.orthoCaseId!==data.orthoCaseId||revision.clinicalCaseId!==data.clinicalCaseId
      ||!id(revision.recordedPatientId)||!id(revision.version)||!hash(revision.contentHash)
      ||content.schemaVersion!==2||draft.schemaVersion!==2
      ||!['ortho-assessment-payload-2.1.0','ortho-assessment-payload-2.2.0','ortho-assessment-payload-2.2.1'].includes(content.verifierVersion)) return invalid();
    const observations=draft.observations.observations, sets=draft.measurementSets, selections=draft.analyses;
    if(!unique(observations.map(o=>o.id))||!unique(sets.map(s=>s.id))||!unique(selections.map(s=>s.id))
      ||sets.length>12||selections.length>36||content.results.length!==selections.length
      ||!unique(content.results.map(r=>r.analysisId))) return invalid();
    const byId=new Map(observations.map(o=>[o.id,o]));
    const castIds=new Set<string>();
    for(const set of sets) {
      if(!unique(set.toothWidthObservationIds)) return invalid();
      set.toothWidthObservationIds.forEach(value=>castIds.add(value));
      if(set.upperAvailableObservationId!==null) castIds.add(set.upperAvailableObservationId);
      if(set.lowerAvailableObservationId!==null) castIds.add(set.lowerAvailableObservationId);
    }
    if(sets.length&&draft.observations.dentitionObservationId!==null) castIds.add(draft.observations.dentitionObservationId);
    const analyses=selections.map((selection,index)=>{
      const stored=content.results[index];
      if(!sets.some(s=>s.id===selection.measurementSetId)||stored.analysisId!==selection.id||!hash(stored.resultHash)
        ||!['incomplete','unsupported_dentition','inapplicable','ready','outside_supported_predictor_domain'].includes(stored.result.state)
        ||!unique(stored.result.dependencyObservationIds)) throw Error('invalid_stored_analysis');
      stored.result.dependencyObservationIds.forEach(value=>castIds.add(value));
      return {selection,stored,clinicalApproval:'unapproved' as const};
    });
    const castObservations=[...castIds].map(value=>{const o=byId.get(value);if(!o)throw Error('missing_observation');return o;});
    // Current source availability is separate from historical provenance. Require
    // each direct source, but preserve the verifier's transitive closure as well.
    const sourceKeys=data.sourceStates.map(s=>`${s.source.kind}:${s.source.id}`);
    if(!unique(sourceKeys)) return invalid();
    const currentSources=new Map(data.sourceStates.map(s=>[`${s.source.kind}:${s.source.id}`,s]));
    for(const state of data.sourceStates) if(!['available','unavailable','changed'].includes(state.state)) return invalid();
    for(const observation of observations) for(const source of observation.provenance?.sources??[]) {
      const current=currentSources.get(`${source.kind}:${source.id}`);
      if(!current||canonicalJourneyJSON(current.source)!==canonicalJourneyJSON(source)) return invalid();
    }
    return copy({ok:true as const,
      revision:{id:revision.id,version:revision.version,contentHash:revision.contentHash,patientId:revision.patientId,
        recordedPatientId:revision.recordedPatientId,orthoCaseId:revision.orthoCaseId,clinicalCaseId:revision.clinicalCaseId,
        createdAt:revision.createdAt,createdBy:revision.createdBy,recordingContext:revision.recordingContext,reason:revision.reason},
      verifierVersion:content.verifierVersion,cast:{measurementSets:sets,observations:castObservations},analyses,
      sourceStates:data.sourceStates,clinicalApproval:'unapproved' as const});
  } catch { return invalid(); }
}
export type SavedModelReview = ReturnType<typeof buildSavedModelReview>;
