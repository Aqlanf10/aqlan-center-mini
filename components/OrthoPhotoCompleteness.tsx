"use client";

/**
 * OP-2 — لوحة اكتمال صور التقويم (قراءة فقط).
 * العقد: docs/review/ortho-wire-timeline-photo-records-contract-20261118.md (v2.1).
 * لا تضيف خطوة إلى الشدّة ولا تمنع حفظًا؛ الأشعة سطرٌ منفصل لا يدخل النسبة.
 */
import { useEffect, useMemo, useState } from "react";
import { PHOTO_STAGE_LABEL, PHOTO_VIEW_LABEL, photoStageRequirements, type PhotoStageRequirements } from "@/lib/ortho-photos";
import {
  PHOTO_COMPLETENESS_READ_FAILURE, decodeCompletenessDocuments, photoCompleteness,
  type CompletenessDocument, type PhotoCompleteness,
} from "@/lib/ortho-photo-completeness";
import { useSetting } from "./SettingsProvider";

const HIDDEN_TEXT = "لا صلاحية لعرض صور المريض.";

function DateText({ value }: { value: string }) {
  return <bdi dir="ltr">{value}</bdi>;
}

export function PhotoCompletenessView({ result, requirements }: { result: PhotoCompleteness; requirements: PhotoStageRequirements }) {
  if (result.status === "hidden") {
    return <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">{HIDDEN_TEXT}</p>;
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="photo-completeness">
      <h4 className="mb-1 text-xs font-extrabold text-navy-900">اكتمال صور الحالة لكل مرحلة</h4>
      <p className="mb-3 text-[11px] text-slate-500">
        كل صفّ مجموعة تصوير واحدة (مرحلة + تاريخ + جلسة). لا تُجمع صور تواريخ أو جلسات مختلفة.
      </p>
      {result.sets.length === 0 ? <p className="text-xs text-slate-500">لا مجموعات تصوير مصنّفة لهذه الحالة بعد.</p> : (
        <ul className="space-y-2">
          {result.sets.map(set => {
            const complete = set.missingRequired.length === 0;
            return (
              <li key={`${set.stage}|${set.takenOn}|${set.adjustmentId ?? "none"}`}
                className={`rounded-xl border p-3 text-xs ${complete ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-extrabold text-navy-900">
                    {PHOTO_STAGE_LABEL[set.stage]} · <DateText value={set.takenOn} />{set.adjustmentId === null ? " · بلا جلسة" : ""}
                  </span>
                  <span className="font-bold text-slate-700">
                    {set.requiredPresent} من {set.requiredCount} مطلوبة{complete ? " · مكتملة" : ""}
                  </span>
                </div>
                {!complete ? (
                  <p className="mt-1 text-amber-900">ينقص: {set.missingRequired.map(view => PHOTO_VIEW_LABEL[view]).join("، ")}</p>
                ) : null}
                {set.optionalPresent.length > 0 || set.optionalMissing.length > 0 ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    اختياري (لا يدخل النسبة):{" "}
                    {[...set.optionalPresent.map(view => `${PHOTO_VIEW_LABEL[view]}: مصوّرة`), ...set.optionalMissing.map(view => `${PHOTO_VIEW_LABEL[view]}: غير مصوّرة`)].join(" · ")}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {result.stagesWithoutSets.length > 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">
          لم تُصوَّر بعد: {result.stagesWithoutSets.map(stage => `${PHOTO_STAGE_LABEL[stage]} (${requirements[stage].required.length} مطلوبة)`).join("، ")}
        </p>
      ) : null}
      {result.unclassified > 0 ? (
        <p className="mt-1 text-[11px] text-slate-500">
          {result.unclassified} صورة غير مصنّفة (بلا مرحلة أو منظر أو تاريخ التقاط) — لا تُحتسب في أي مجموعة.
        </p>
      ) : null}
      <div className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-600" data-testid="radiograph-indicator">
        <p className="font-bold">الأشعة (مؤشر منفصل، لا يدخل نسبة الصور):</p>
        {result.radiographs.map(row => (
          <p key={row.stage}>
            {PHOTO_STAGE_LABEL[row.stage]}: سيفالومترية جانبية{" "}
            {row.lateralCeph.length ? <>موجودة بتاريخ {row.lateralCeph.map((date, i) => <span key={date}>{i ? "، " : ""}<DateText value={date} /></span>)}</> : "غير موجودة"} · بانوراما{" "}
            {row.panoramic.length ? <>موجودة بتاريخ {row.panoramic.map((date, i) => <span key={date}>{i ? "، " : ""}<DateText value={date} /></span>)}</> : "غير موجودة"}
          </p>
        ))}
      </div>
    </div>
  );
}

export function OrthoPhotoCompletenessPanel({ patientId, caseId, photosVisible }: {
  patientId: number; caseId: number; photosVisible: boolean | undefined;
}) {
  const requirements = photoStageRequirements(useSetting("ortho.photo_stage_requirements"));
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; documents: CompletenessDocument[] }>({ status: "loading" });

  useEffect(() => {
    if (photosVisible !== true) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/patients/${patientId}/documents`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(PHOTO_COMPLETENESS_READ_FAILURE);
        const documents = decodeCompletenessDocuments(await response.json(), patientId);
        if (!controller.signal.aborted) setState({ status: "ready", documents });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error" }); });
    return () => controller.abort();
  }, [patientId, caseId, photosVisible]);

  const result = useMemo(() => state.status === "ready"
    ? photoCompleteness({ documents: state.documents, patientId, caseId, photosVisible, requirements })
    : null, [state, patientId, caseId, photosVisible, requirements]);

  if (photosVisible !== true) return <PhotoCompletenessView result={{ status: "hidden" }} requirements={requirements} />;
  if (state.status === "error") return <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{PHOTO_COMPLETENESS_READ_FAILURE}</p>;
  if (!result) return <p className="text-xs text-slate-500">جارٍ تحميل اكتمال الصور…</p>;
  return <PhotoCompletenessView result={result} requirements={requirements} />;
}
