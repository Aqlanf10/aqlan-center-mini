"use client";
import { useEffect, useState } from "react";
import type { StudyOwner } from "@/lib/ortho-case-study-owner";
import type { StudyEditorRevision } from "@/lib/ortho-case-study-editor-contract";
import { studyDirection, type StudyDisplayLocale } from "@/lib/ortho-case-presentation-i18n";
import { STUDY_TIMEPOINTS } from "@/lib/ortho-case-study-timepoints";
import { readStudyLongitudinalReview, type StudyLongitudinalReview, type StudyLongitudinalReason, type StudyLongitudinalCompletion } from "@/lib/ortho-study-longitudinal-contract";
import { studyLongitudinalReasonText } from "@/lib/ortho-study-longitudinal-labels";
interface Props { locale?: StudyDisplayLocale; owner: StudyOwner; readVersion: number; revision: StudyEditorRevision }
type View = { owner: StudyOwner; revision: StudyEditorRevision; readVersion: number } &
  ({ state: "ready"; value: StudyLongitudinalReview } | { state: "error" });
const privateNoStore = (response: Response) => {
  const directives = response.headers.get("cache-control")?.split(",").map(value => value.trim().toLowerCase()) ?? [];
  return directives.includes("private") && directives.includes("no-store") && !directives.includes("public");
};

/** Only the exact saved revision may supply eligibility and provenance. This view
 * has no write controls, measurement calculator, or live-source fallback. */
export default function OrthoStudyLongitudinalReview({ owner, readVersion, revision, locale = "ar" }: Props) {
  const english = locale === "en";
  const [stored, setStored] = useState<View | null>(null);
  const view = stored?.owner === owner && stored.revision === revision && stored.readVersion === readVersion ? stored : null;
  useEffect(() => {
    let active = true; const abort = new AbortController();
    const current = () => active && owner.active() && owner.matches(revision) && owner.readVersion === readVersion;
    const cleanup = () => { active = false; abort.abort(); };
    if (!current()) return cleanup;
    void (async () => {
      try {
        const query = new URLSearchParams({ patientId: String(revision.patientId), revisionId: String(revision.id) });
        const response = await fetch(`/api/ortho/${revision.orthoCaseId}/case-study/longitudinal?${query}`, {
          credentials: "same-origin", cache: "no-store", signal: abort.signal,
        });
        if (!current()) return;
        if (response.status === 401 || response.status === 403) {
          setStored(null); owner.denied(); return;
        }
        if (response.status !== 200 || !privateNoStore(response)) throw Error("study_longitudinal_unavailable");
        const body = await response.text();
        if (!current()) return;
        if (new TextEncoder().encode(body).length > 4 * 1024 * 1024) throw Error("study_longitudinal_limit");
        const value = readStudyLongitudinalReview(JSON.parse(body), { patientId: revision.patientId, orthoCaseId: revision.orthoCaseId,
          clinicalCaseId: revision.clinicalCaseId, revisionId: revision.id, revisionHash: revision.contentHash, kind: revision.kind, authored: revision.authored });
        if (current()) setStored({ owner, revision, readVersion, state: "ready", value });
      } catch { if (current()) setStored({ owner, revision, readVersion, state: "error" }); }
    })();
    return cleanup;
  }, [owner, readVersion, revision]);
  if (!owner.active() || !owner.matches(revision) || owner.readVersion !== readVersion) return <p role="status">{english
    ? "View access or identity changed. Verification is required." : "تغيرت صلاحية أو هوية العرض؛ يلزم تحقق جديد."}</p>;
  if (view?.state === "error") return <p role="alert">{english
    ? "Saved comparison eligibility could not be verified. No replacement source or numeric difference is displayed. Refresh the saved study to recheck."
    : "تعذّر التحقق من أهلية المقارنة المحفوظة. لا يُعرض مصدر بديل أو فرق رقمي. حدّث قراءة الدراسة المحفوظة لإعادة التحقق."}</p>;
  if (view?.state !== "ready") return <p role="status">{english ? "Reading saved T1–T4 eligibility…" : "جارٍ قراءة أهلية المراحل المحفوظة T1–T4…"}</p>;
  return <StudyLongitudinalDetails value={view.value} locale={locale} />;
}

export function StudyLongitudinalDetails({ value, locale = "ar" }: { value: StudyLongitudinalReview; locale?: StudyDisplayLocale }) {
  const english = locale === "en", unknown = english ? "Unknown / not recorded" : "غير معروف / غير مسجل";
  const matched = value.stages.some(stage => stage.sources.some(source => source.witness === "versioned_source_identity_matched"));
  const dateEvidence = {
    unknown: english ? "Unknown" : "غير معروف",
    historical_source: english ? "Historical source" : "مصدر تاريخي",
    contemporaneous_record: english ? "Contemporaneous record" : "سجل معاصر للحدث",
    retrospective_record: english ? "Retrospective report" : "توثيق بأثر رجعي",
  };
  const status = { draft: english ? "Draft" : "مسودة", completed: english ? "Completed" : "مكتمل", discarded: english ? "Discarded" : "مستبعد" };
  return <section dir={studyDirection(locale)} className="min-w-0 space-y-3 rounded border p-3" aria-label={english ? "Saved T1–T4 comparison eligibility" : "أهلية مقارنة المراحل المحفوظة T1–T4"}>
    <h4 className="font-semibold">{english ? "T1–T4: comparison eligibility and source provenance" : "T1–T4: أهلية المقارنة وتوثيق المصادر"}</h4>
    <p className="rounded border p-2" role="status">{matched ? english
      ? "Numeric differences are unavailable in this saved view. Source identity matching does not prove what the clinician viewed or establish independent clinical validation or comparable measurements. Legacy and earlier completion evidence retain their original limitations. Missing evidence is not zero change. Stage order and a completed record do not establish clinical improvement."
      : "الفروق الرقمية غير متاحة في هذا العرض المحفوظ. تطابق هوية المصدر لا يثبت ما شاهده الطبيب ولا يمثل اعتمادًا سريريًا مستقلاً أو تحققًا من قابلية القياسات للمقارنة. تحتفظ الالتقاطات القديمة وأدلة الإكمال السابقة بحدودها الأصلية. نقص الدليل لا يعني فرقًا يساوي صفرًا. ترتيب المراحل واكتمال السجل لا يثبتان تحسنًا سريريًا."
      : english
      ? "Numeric differences are unavailable in this saved view. A verified immutable completion record does not confirm the source the clinician viewed. Legacy captures remain unversioned. Neither establishes comparable measurements. Missing evidence is not zero change. Stage order and a completed record do not establish clinical improvement or comparability."
      : "الفروق الرقمية غير متاحة في هذا العرض المحفوظ. سجل الإكمال الثابت المتحقق السلامة لا يؤكد المصدر الذي شاهده الطبيب. تبقى الالتقاطات القديمة غير محددة النسخة؛ ولا يثبت أي منهما قابلية القياسات للمقارنة. نقص الدليل لا يعني فرقًا يساوي صفرًا. ترتيب المراحل ووسم السجل كمكتمل لا يثبتان تحسنًا سريريًا أو قابلية المقارنة."}</p>
    <p className="text-sm">{english ? "Saved capture time, not the event date:" : "وقت الالتقاط المحفوظ، وليس تاريخ الحدث:"} <time dir="ltr" className="inline-block" dateTime={value.capturedAt}>{value.capturedAt}</time></p>
    {!value.stages.length && <p>{english ? "No T1–T4 stages were explicitly assigned in this saved revision. No dates or stages have been inferred." : "لم تُربط أي مرحلة من T1–T4 صراحة في هذه النسخة المحفوظة. لم تُستنتج تواريخ أو مراحل."}</p>}
    <div className="grid min-w-0 gap-3 md:grid-cols-2">
      {STUDY_TIMEPOINTS.map(stageName => {
        const stage = value.stages.find(item => item.stage === stageName);
        return <article key={stageName} className="min-w-0 space-y-2 rounded border p-3" aria-label={`${stageName} ${english ? "saved stage" : "المرحلة المحفوظة"}`}>
          <h5 className="font-semibold" dir="ltr">{stageName}</h5>
          {!stage ? <p>{english ? "Not assigned in this saved revision." : "غير مرتبطة في هذه النسخة المحفوظة."}</p> : <>
            <p dir="auto" className="break-words">{stage.label}</p>
            <dl className="space-y-1 text-sm">
              <div><dt className="font-medium">{english ? "Recorded stage date" : "تاريخ المرحلة المسجل"}</dt><dd>{stage.occurrence.occurredOn
                ? <time dir="ltr" className="inline-block" dateTime={stage.occurrence.occurredOn}>{stage.occurrence.occurredOn}</time> : unknown}</dd></div>
              <div><dt className="font-medium">{english ? "Date evidence" : "نوع توثيق التاريخ"}</dt><dd>{dateEvidence[stage.occurrence.dateProvenance]}</dd></div>
              <div><dt className="font-medium">{english ? "Original date source / uncertainty note" : "ملاحظة مصدر التاريخ / حدود اليقين الأصلية"}</dt><dd dir="auto" className="whitespace-pre-wrap break-words">{stage.occurrence.sourceNote || unknown}</dd></div>
            </dl>
            <p className="font-medium">{english ? "Numeric comparison unavailable" : "المقارنة الرقمية غير متاحة"}</p>
            <ReasonList reasons={stage.reasons} locale={locale} />
            {stage.sources.map(source => <div key={source.key} className="min-w-0 space-y-2 border-t pt-2">
              <h6 className="font-medium">{english ? "Saved cephalometric source" : "المصدر السيفالومتري المحفوظ"} #{source.id}</h6>
              <dl className="space-y-1 text-sm">
                <div><dt className="font-medium">{english ? "Source key" : "مفتاح المصدر"}</dt><dd dir="ltr" className="break-all">{source.key}</dd></div>
                <div><dt className="font-medium">{english ? "Selected source fingerprint" : "بصمة المصدر المختار"}</dt><dd dir="ltr" className="break-all">{source.contentHash}</dd></div>
                <div><dt className="font-medium">{english ? "Saved source state" : "حالة المصدر المحفوظة"}</dt><dd>{source.captureState === "available" ? english ? "Available in saved capture" : "متاح في الالتقاط المحفوظ" : english ? "Unavailable in saved capture" : "غير متاح في الالتقاط المحفوظ"}</dd></div>
                <div><dt className="font-medium">{english ? "Recorded status, not a new clinical approval" : "الحالة المسجلة، وليست اعتمادًا سريريًا جديدًا"}</dt><dd>{source.status ? status[source.status] : unknown}</dd></div>
                <div><dt className="font-medium">{english ? "Recorded image acquisition date" : "تاريخ التقاط الصورة المسجل"}</dt><dd dir="auto" className="break-words">{source.acquisitionDate || unknown}</dd></div>
                <div><dt className="font-medium">{source.completion ? english ? "Saved reference-set code" : "رمز المجموعة المرجعية المحفوظ" : english ? "Recorded reference-set name, not its version" : "اسم المجموعة المرجعية المسجل، وليس نسختها"}</dt><dd dir="auto" className="break-words">{source.referenceSetKey || unknown}</dd></div>
                <div><dt className="font-medium">{english ? "Measurement provenance" : "توثيق أصل القياسات"}</dt><dd>{source.witness === "legacy_unversioned"
                  ? english ? "Legacy capture without versioned completion evidence" : "التقاط قديم بلا دليل إكمال محدد النسخة"
                  : source.witness === "versioned_source_identity_matched" ? english ? "Submitted source identity matched the server capture" : "تطابقت هوية المصدر المرسلة مع التقاط الخادم"
                  : source.witness === "versioned_unconfirmed_view" ? english ? "Verified immutable source record; viewed source unconfirmed" : "سجل مصدر ثابت متحقق السلامة؛ المصدر المشاهَد غير مؤكد" : english ? "Completion evidence unavailable" : "دليل الإكمال غير متاح"}</dd></div>
                {source.image && <>
                  <div><dt className="font-medium">{english ? "Recorded image document" : "مستند الصورة المسجل"}</dt><dd>#{source.image.documentId} · {source.image.state === "available" ? english ? "Available" : "متاح" : english ? "Removed" : "مُزال"}</dd></div>
                  <div><dt className="font-medium">{english ? "Recorded image fingerprint" : "بصمة الصورة المسجلة"}</dt><dd dir="ltr" className="break-all">{source.image.contentHash}</dd></div>
                </>}
              </dl>
              {source.completion && <CompletionDetails value={source.completion} locale={locale} />}
              {stage.sources.length > 1 && <ReasonList reasons={source.reasons} locale={locale} />}
            </div>)}
          </>}
        </article>;
      })}
    </div>
    {!!value.pairs.length && <div className="space-y-2"><h5 className="font-semibold">{english ? "Saved stage pairs" : "أزواج المراحل المحفوظة"}</h5>
      {value.pairs.map(pair => <details key={`${pair.from}:${pair.to}`} className="rounded border p-2"><summary className="min-h-11 cursor-pointer py-2">
        <span dir="ltr" className="inline-block">{pair.from} → {pair.to}</span>: {english ? "Numeric difference unavailable" : "الفرق الرقمي غير متاح"}</summary>
        <ReasonList reasons={pair.reasons} locale={locale} />
      </details>)}
    </div>}
  </section>;
}
function ReasonList({ reasons, locale }: { reasons: StudyLongitudinalReason[]; locale: StudyDisplayLocale }) {
  return <ul className="list-inside list-disc space-y-1 text-sm">{reasons.map(reason => <li key={reason}>{studyLongitudinalReasonText(reason, locale)}</li>)}</ul>;
}

function CompletionDetails({ value, locale }: { value: StudyLongitudinalCompletion; locale: StudyDisplayLocale }) {
  const english = locale === "en";
  const fields: [string, string][] = [
    [english ? "Saved witness fingerprint" : "بصمة دليل الإكمال المحفوظ", value.witnessSha256],
    [english ? "Witness sealed at, not acquisition date" : "وقت ختم الدليل، وليس تاريخ التقاط الصورة", value.sealedAt],
    [english ? "Saved reference version" : "نسخة المرجع المحفوظة", value.referenceSet.version],
    [english ? "Saved reference fingerprint" : "بصمة المرجع المحفوظ", value.referenceSet.sha256],
    [english ? "Exact saved calibration (endpoints, mm and mm per pixel)" : "المعايرة المحفوظة الدقيقة (النقاط والمليمتر والمليمتر لكل بكسل)", JSON.stringify(value.calibration)],
    [english ? "Source identity limitation" : "حدود هوية المصدر", value.sourceIdentityMeaning],
  ];
  if (value.schemaVersion === 2) fields.push(
    [english ? "Saved witness schema version" : "نسخة بنية دليل الإكمال المحفوظ", String(value.schemaVersion)],
    [english ? "Submitted source identity matched at completion" : "هوية المصدر المرسلة المتطابقة عند الإكمال", JSON.stringify(value.sourceReview)],
  );
  return <div className="space-y-2 text-sm">
    <p>{english ? "Integrity verification is not independent clinical validation. Codes and versions below are saved provenance, not current clinical names or norms." : "التحقق من السلامة ليس اعتمادًا سريريًا مستقلاً. الرموز والنسخ التالية توثيق محفوظ، وليست أسماء سريرية أو قيمًا مرجعية حالية."}</p>
    <dl className="space-y-1">{fields.map(([label, content]) => <div key={label}><dt className="font-medium">{label}</dt><dd dir="ltr" className="break-all">{content}</dd></div>)}</dl>
    {value.algorithms.map(algorithm => <dl key={JSON.stringify(algorithm)} className="space-y-1 border-t pt-1">
      {([
        [english ? "Saved algorithm code" : "رمز الخوارزمية المحفوظ", algorithm.id],
        [english ? "Saved engine version" : "نسخة المحرك المحفوظة", algorithm.version],
        [english ? "Saved engine fingerprint" : "بصمة المحرك المحفوظ", algorithm.sourceSha256],
        [english ? "Saved calculation version" : "نسخة الحساب المحفوظة", algorithm.calculationVersion ?? (english ? "Not recorded" : "غير مسجلة")],
        [english ? "Saved rounding rule" : "قاعدة التقريب المحفوظة", algorithm.rounding],
      ] as const).map(([label, content]) => <div key={label}><dt className="font-medium">{label}</dt><dd dir="ltr" className="break-all">{content}</dd></div>)}
    </dl>)}
  </div>;
}
