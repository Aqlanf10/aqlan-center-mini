import type { CephCompletionWitness } from "@/lib/ceph-completion-provenance";

/** Presentation of an already verified saved witness, not a validator or engine.
 * Never supply a draft/current analysis as a substitute for historical evidence. */
export function CephSavedCompletionEvidence({ witness }: { witness: CephCompletionWitness }) {
  const { calibration, mmPerPixel } = witness.snapshot;
  return <section data-testid="ceph-saved-completion-evidence" aria-label="المعايرة وهوية الاعتماد المحفوظة" className="space-y-2 break-words rounded border border-slate-200 p-3 text-xs">
    <h4 className="font-bold">المعايرة وهوية الاعتماد المحفوظة</h4>
    <p>من سجل الاعتماد نفسه؛ لا تُعاد الحسابات ولا تُستبدل القيم بمعايرة المسودة أو المراجع الحالية.</p>
    <dl className="grid gap-2 sm:grid-cols-2">
      <div><dt>رقم التحليل</dt><dd><bdi>{witness.analysisId}</bdi></dd></div>
      <div><dt>رقم مستند الصورة المحفوظ</dt><dd><bdi>{witness.image.documentId}</bdi></dd></div>
      <div><dt>أبعاد الصورة المصدرية المحفوظة</dt><dd>العرض <bdi dir="ltr">{witness.image.width === null ? "غير موثّق" : `${witness.image.width} px`}</bdi> · الارتفاع <bdi dir="ltr">{witness.image.height === null ? "غير موثّق" : `${witness.image.height} px`}</bdi></dd></div>
      <div><dt>إصدار سجل الاعتماد</dt><dd><bdi dir="ltr">{`v${witness.schemaVersion}`}</bdi></dd></div>
      <div><dt>بداية المسطرة في الصورة المصدرية (x, y)</dt><dd>{calibration ? <bdi dir="ltr">{`(${calibration.x1}, ${calibration.y1}) px`}</bdi> : "غير موثّقة"}</dd></div>
      <div><dt>نهاية المسطرة في الصورة المصدرية (x, y)</dt><dd>{calibration ? <bdi dir="ltr">{`(${calibration.x2}, ${calibration.y2}) px`}</bdi> : "غير موثّقة"}</dd></div>
      <div><dt>طول المسطرة المصرّح به</dt><dd>{calibration ? <bdi dir="ltr">{`${calibration.mm} mm`}</bdi> : "غير موثّق"}</dd></div>
      <div><dt>المقياس المحفوظ (مم لكل بكسل)</dt><dd>{mmPerPixel === null ? "غير موثّق" : <bdi dir="ltr">{`${mmPerPixel} mm/px`}</bdi>}</dd></div>
      <div><dt>صاحب الاعتماد المسجّل</dt><dd>{witness.actor.username} · رقم المستخدم <bdi>{witness.actor.userId}</bdi></dd></div>
      <div><dt>وقت تسجيل الاعتماد، وليس وقت التقاط الصورة</dt><dd><time dateTime={witness.sealedAt} dir="ltr">{witness.sealedAt}</time></dd></div>
    </dl>
    <p>{witness.schemaVersion === 1
      ? "v1: التقط الخادم هوية المصادر عند الاعتماد؛ لم يؤكد السجل أنها المصادر التي عُرضت للطبيب."
      : "v2: طابقت هوية المصادر المرسلة مع طلب الاعتماد الهوية التي التقطها الخادم؛ هذا التطابق ليس دليلًا على المشاهدة البشرية أو المراجعة البصرية."}</p>
    <p>البصمات لفحص سلامة السجل، وليست توقيعًا رقميًا. توثيق الاعتماد والمصادر ليس تحققًا سريريًا مستقلًا ولا ضمانًا لدقة القياسات.</p>
  </section>;
}
