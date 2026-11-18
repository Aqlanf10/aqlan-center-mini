/** Browser-safe Arabic wording for a completion's provenance state (screen and print). Text only. */
import type { CephProvenanceState } from "./capture";

export function cephProvenanceLabelAr(p: CephProvenanceState | undefined): string | null {
  if (!p || p.state === "not-completed") return null;
  if (p.state === "unversioned") {
    if (p.reason === "completed_before_provenance") return "اعتماد سابق لتفعيل سجل الاعتماد الموثّق؛ القيم كما حُفظت ولم يُعَد حسابها.";
    if (p.reason === "completed_without_seal") return "اعتُمد بعد تفعيل سجل الاعتماد عبر مسار لا يكتب سجلًا موثّقًا (مسار الجلسات القديم)؛ لا شهادة لهذا الاعتماد، والقيم كما حُفظت.";
    return "اعتماد بلا سجل موثّق، وتعذّر تحديد تاريخ تفعيل السجل؛ القيم كما حُفظت.";
  }
  if (p.state === "integrity-unavailable") return "تعذّر التحقق من سجل الاعتماد: البيانات المحفوظة الآن لا تطابق ما خُتم. لا تعتمد هذه الدراسة قبل مراجعة السجل.";
  const viewed = p.sourceIdentityMeaning === "submitted_source_identity_matches_server_capture"
    ? "طابقت الصورة والمرجع ومحرك الحساب ما عُرض عند المراجعة" : "لم يُرسل ما عُرض عند المراجعة؛ سُجّلت المصادر من الخادم فقط";
  const flags = [
    p.measurementsWithAssumption ? `${p.measurementsWithAssumption} قيمة غير مقيسة بالكامل` : null,
    p.measurementsWithLegacyDefinitionDifference ? `${p.measurementsWithLegacyDefinitionDifference} قيمة يخالف تعريفها القديم المصدر` : null,
  ].filter(Boolean).join("، ");
  return `سجل اعتماد موثّق: ${p.sealedBy}، محرك ${p.engineVersion}، بصمة ${p.witnessSha256.slice(0, 12)}…؛ ${viewed}${flags ? `؛ ${flags}` : ""}. السجل يثبت المدخلات المعتمدة ولا يعني تحققًا سريريًا مستقلًا.`;
}
