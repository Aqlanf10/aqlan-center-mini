export interface ClinicalVisitLockScope {actor:string;visitId:number}
/** Same-browser cross-tab fence. Database authorization/locking still owns server concurrency. */
export async function withClinicalVisitBrowserLock<T>(scope:ClinicalVisitLockScope,run:()=>Promise<T>,allowUnavailable=false):Promise<T>{
 if(!scope.actor||!Number.isSafeInteger(scope.visitId)||scope.visitId<=0)throw Error("تعذّر إثبات نطاق قفل الزيارة.");
 if(typeof navigator==="undefined"||!navigator.locks?.request){
  if(allowUnavailable)return run();
  throw Error("الحفظ متوقف: يتطلب التحقق الآمن بين نوافذ الزيارة متصفحًا يدعم Web Locks عبر اتصال آمن.");
 }
 return navigator.locks.request(`aqlan-clinical-write:${JSON.stringify([scope.actor,scope.visitId])}`,{mode:"exclusive"},run);
}
