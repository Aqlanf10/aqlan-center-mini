/** Recognize the two exact existing guards without printing their input. */
export function classifyPatientReplayRefusal(result:{ok:boolean;readyForCutover:boolean;validationErrors:readonly unknown[];errors:readonly string[]}):'BUSY'|'NONEMPTY'|'UNKNOWN'{
  if(result.ok || result.readyForCutover || result.validationErrors.length!==0 || result.errors.length!==1)return 'UNKNOWN';
  const error=result.errors[0];
  if(error==='فشل تطبيق بيانات الاستعادة على الهدف المعزول: patient numbering busy; refresh and retry')return 'BUSY';
  if(/^الهدف ليس فارغًا \([1-9]\d* جدولًا\)\. الاستعادة فوق بيانات قائمة مرفوضة افتراضًا — إن كان المقصود فعلًا فمرّر allowNonEmptyTarget بوعي كامل\.$/u.test(error))return 'NONEMPTY';
  return 'UNKNOWN';
}
