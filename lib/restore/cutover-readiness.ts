export type RestoreNumberingEvidence = "not-recorded" | "reconciled" | "unverified";
export type RestoreCutoverBlocker =
  | "numbering-history-not-recorded"
  | "numbering-freshness-unverified"
  | "numbering-evidence-unverified";

/** No current restore route has an independent, trusted freshness witness.
 * Even new, checked archive metadata only proves what that snapshot saw. */
export function numberingCutoverHold(evidence: unknown) {
  const patientNumberSequence: RestoreNumberingEvidence =
    evidence === "not-recorded" || evidence === "reconciled" ? evidence : "unverified";
  const cutoverBlocker: RestoreCutoverBlocker = patientNumberSequence === "not-recorded"
    ? "numbering-history-not-recorded"
    : patientNumberSequence === "reconciled"
      ? "numbering-freshness-unverified"
      : "numbering-evidence-unverified";
  return { readyForCutover: false as const, patientNumberSequence, cutoverBlocker };
}

export function numberingCutoverMessage(blocker: unknown): string {
  if (blocker === "numbering-history-not-recorded") {
    return "النسخة لم تحفظ عدّاد ملفات المرضى؛ التحويل غير جاهز. لا تستأنف إصدار الأرقام دون تحقق مستقل.";
  }
  if (blocker === "numbering-freshness-unverified") {
    return "استُعيد العدّاد المحفوظ، لكن لم يُتحقق مستقلاً من الأرقام الأحدث؛ التحويل غير جاهز.";
  }
  return "أدلة عدّاد ملفات المرضى غير متحققة؛ التحويل غير جاهز.";
}
