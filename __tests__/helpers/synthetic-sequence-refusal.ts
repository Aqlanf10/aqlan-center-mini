/** Recognize only the existing nonempty-target guard; never print its input. */
export function knownNonEmptyRefusal(result:{ok:boolean;readyForCutover:boolean;validationErrors:readonly unknown[];errors:readonly string[]}) {
  const known=/^الهدف ليس فارغًا \([1-9]\d* جدولًا\)\. الاستعادة فوق بيانات قائمة مرفوضة افتراضًا — إن كان المقصود فعلًا فمرّر allowNonEmptyTarget بوعي كامل\.$/u;
  return !result.ok && !result.readyForCutover && result.validationErrors.length===0
    && result.errors.length===1 && known.test(result.errors[0]);
}
