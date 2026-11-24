/** The archive identifies a point in time. The clinic has no independent witness
 * for numbers consumed between that point and loss of the original database. */
export const NUMBERING_CUTOVER_BLOCKER = "numbering-freshness-unverified" as const;
export const NUMBERING_CUTOVER_MESSAGE = "اكتمل التحقق من النسخة المعزولة. استئناف إصدار أرقام الملفات يتطلب إثباتًا مستقلًا لآخر رقم استُهلك.";
