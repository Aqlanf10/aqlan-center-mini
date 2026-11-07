/** Existing clinical/restore tests model a client that receives and acknowledges
 * its result. Durable-loss tests call the unwrapped public store explicitly. */
import {saveOrthoCaseStudy} from '../../lib/ortho-case-study-store';
import {transitionStudySubmission} from '../../lib/ortho-study-submission-store';
import {checkStudySaveCommand} from '../../lib/ortho-case-study';
import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
export async function saveConfirmedStudy(input:Omit<Parameters<typeof saveOrthoCaseStudy>[0],"actorId">){
 const result=await saveOrthoCaseStudy({...input,actorId:input.session.userId!}),checked=checkStudySaveCommand(input.command);
 if(!checked.ok)return result;
 if(result.ok){
  const acknowledged=await transitionStudySubmission({...input,actorId:input.session.userId!,clinicalCaseId:result.revision.clinicalCaseId,commandId:checked.value.clientRequestId,requestFingerprint:journeyContentHash(checked.value),action:'acknowledge'});
  if(!acknowledged.ok)throw Error(`Synthetic client acknowledgment failed: ${acknowledged.code}`);
 }else if(result.status===409){
  // Tests that deliberately edit a refused command explicitly cancel that exact
  // intent before trying another one. The server proves cancellation atomically.
  const scope=input as typeof input&{clinicalCaseId?:number};
  if(scope.clinicalCaseId){const args={...input,actorId:input.session.userId!,clinicalCaseId:scope.clinicalCaseId,commandId:checked.value.clientRequestId,requestFingerprint:journeyContentHash(checked.value)};
   const cancelled=await transitionStudySubmission({...args,action:'cancel'});if(cancelled.ok&&cancelled.state==='cancelled')await transitionStudySubmission({...args,action:'acknowledge'});
  }
 }
 return result;
}
