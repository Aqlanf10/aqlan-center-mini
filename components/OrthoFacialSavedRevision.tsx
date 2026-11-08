import { FACIAL_LANDMARKS } from "@/lib/ortho-facial-analysis";
import type { FacialRevision } from "@/lib/ortho-facial-records";
const provenance = { contemporaneous_record: "سجل معاصر", retrospective_record: "توثيق لاحق", historical_source: "مصدر تاريخي", unknown: "غير معلوم" };
/** Exact saved values only. No canvas, current source substitution, or calculation. */
export function OrthoFacialSavedRevision({ revision }: { revision: FacialRevision }) {
  const c = revision.command.content;
  return <article className="space-y-3 rounded-lg border p-3 text-sm" data-testid="facial-older-revision">
    <h3 className="font-bold">مراجعة محفوظة #{revision.id} · نسخة {revision.version}</h3>
    <p>صورة #{revision.documentId} · الحالة #{revision.orthoCaseId} · الحالة السريرية #{revision.clinicalCaseId}</p>
    <p>هوية المريض وقت التسجيل: #{revision.recordedPatientId} · بروتوكول القياسات المحفوظ: <bdi>{c.protocol}</bdi></p>
    <p>حفظها {revision.createdBy} · المستخدم #{revision.actorId} · <time dir="ltr" dateTime={revision.createdAt}>{revision.createdAt}</time></p>
    <p>تاريخ الصورة الموثّق: {c.occurrence.occurredOn ?? "غير معلوم"} · مصدر التاريخ: {provenance[c.occurrence.dateProvenance]}</p>
    <p className="whitespace-pre-wrap">{c.occurrence.sourceNote}</p><p className="whitespace-pre-wrap">سبب المراجعة: {revision.command.reason}</p>
    <p>المراجعة السابقة المرتبطة: {revision.command.expectedHeadId ?? "لا توجد نسخة سابقة"} · حالة المراجعة المسجّلة: {c.review.state === "reviewed" ? "راجعها الطبيب" : "مسودة محفوظة، لم تسجل مراجعة الطبيب"}</p>
    <p className="whitespace-pre-wrap">{c.review.note}</p>
    <p><bdi dir="ltr">{`${c.image.width} × ${c.image.height} px`}</bdi> · اتجاه EXIF المحفوظ <bdi>{c.image.exifOrientation}</bdi></p>
    <p className="break-all">بصمة الصورة: <bdi>{c.image.sha256}</bdi></p><p className="break-all">بصمة المراجعة: <bdi>{revision.contentHash}</bdi></p>
    <ul>{([["frontalRest", "صورة أمامية في الراحة"], ["headPosition", "وضع الرأس"], ["visibleLandmarks", "وضوح المعالم"], ["perspectiveReviewed", "المنظور والمسافة"]] as const).map(([key, label]) => <li key={key}>{label}: {c.quality[key] ? "أكده الطبيب" : "لم يؤكده الطبيب"}</li>)}</ul>
    <p className="whitespace-pre-wrap">{c.quality.note}</p>
    <details><summary className="min-h-11 cursor-pointer py-3 font-bold">المعالم المحفوظة، بإحداثيات نسبية للصورة</summary>
      <p className="text-xs">القيم x وy محفوظة كنسبة من أبعاد الصورة (0 إلى 1)، وليست مليمترات أو قياسًا جديدًا.</p>
      <dl>{FACIAL_LANDMARKS.map(([key, label]) => { const point = c.landmarks[key]; return <div className="my-2" key={key}><dt>{label}</dt><dd className="whitespace-pre-wrap">{point?.state === "located" ? <bdi dir="ltr">{`x=${point.x}, y=${point.y}`}</bdi> : point?.state === "unavailable" ? `غير متاح: ${point.reason}` : "لم يُحدّد"}</dd></div>; })}</dl>
    </details>
    <section aria-label="النتائج المحفوظة للمراجعة القديمة" className="space-y-2"><p className="text-xs">نتائج محفوظة كما سُجلت؛ لا يُعاد تفسيرها أو تحويلها إلى تشخيص أو خطة.</p>
      {revision.results.measures.map(measure => <div key={measure.id} className="rounded border p-2"><h4 className="font-bold">{({ thirds: "أثلاث الوجه", fifths_postaurale: "أخماس الوجه، حدود الأذن", lower_third: "نسب الجزء السفلي", eye_widths: "عرض العينين والمسافة بينهما" })[measure.id]}</h4>
        <p>{measure.state === "ready" ? "نتيجة مسجّلة" : measure.state === "incomplete" ? "غير مكتملة" : "تعذّر الحساب بسبب هندسة المعالم"}</p><p className="whitespace-pre-wrap">{measure.message}</p>
        {measure.segments.map((segment, index) => <p key={index}>{segment.label}: <bdi dir="ltr">{`${segment.percent}% · ${segment.pixels} px`}</bdi></p>)}</div>)}
    </section>
  </article>;
}
