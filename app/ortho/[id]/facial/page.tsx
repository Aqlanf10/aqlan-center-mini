import { OrthoFacialAnalysis } from "@/components/OrthoFacialAnalysis";
import { parseClinicalId } from "@/lib/patient-navigation";
export default async function FacialPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{patientId?:string|string[]}>}){
  const path=await params,query=await searchParams,orthoCaseId=parseClinicalId(path.id),patientId=typeof query.patientId==="string"?parseClinicalId(query.patientId):null;
  if(!patientId||!orthoCaseId)return <p role="alert">افتح قياسات الوجه من حالة مريض محددة.</p>;
  return <OrthoFacialAnalysis patientId={patientId} orthoCaseId={orthoCaseId}/>;
}
