/** Archive integrity proves an isolated restore, not latest patient-number issuance.
 * This release has no independent source-fence/high-water evidence verifier. */
export const PATIENT_NUMBER_CUTOVER_HOLD = {
  readyForCutover: false,
  cutoverBlocker: "patient-number-freshness-unverified",
} as const;

export const PATIENT_NUMBER_CUTOVER_HOLD_TEXT =
  "الاستعادة المعزولة سليمة، لكن لم يُتحقق مستقلاً من آخر رقم ملف صدر في المصدر. لا تحوّل للاستخدام الفعلي ولا تستأنف إصدار الأرقام.";
