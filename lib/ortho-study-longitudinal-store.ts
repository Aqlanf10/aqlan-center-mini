import {getOrthoCaseStudy} from './ortho-case-study-store';
import {projectStudyLongitudinalEligibility} from './ortho-study-longitudinal';
import type {JourneyOwnerInput} from './ortho-case-journey-authority';
/** All patient, source-union and current-role checks remain in the canonical
 * immutable revision reader. No direct ceph read or alternate authority path. */
export async function getStudyLongitudinalEligibility(input:JourneyOwnerInput&{revisionId:number}){
 const result=await getOrthoCaseStudy(input);if(!result.ok)return result;
 if(!result.revision||result.revision.id!==input.revisionId)return {ok:false as const,status:404,code:'study_revision_not_found'};
 return projectStudyLongitudinalEligibility(result.revision,{patientId:result.patientId,orthoCaseId:result.orthoCaseId,clinicalCaseId:result.clinicalCaseId});
}
