"use client";

/**
 * OW-1 — الخط الزمني للأسلاك (قراءة فقط، فوق سجل الشدّات).
 * العقد: docs/review/ortho-wire-timeline-photo-records-contract-20261118.md (v2.1).
 * لا يغيّر نموذج الشدّة ولا يضيف خطوة؛ لا اقتراحات ولا أحكام سريرية.
 */
import { useMemo, useState } from "react";
import { ELASTIC_LABEL, PHASE_LABEL, type Appliance, type Arches, type ElasticClass, type OrthoPhase, type SlotSize } from "@/lib/ortho";
import { buildWireTimeline, type WireArch, type WireSegment } from "@/lib/ortho-wire-timeline";

export interface OrthoWireTimelineProps {
  slot: SlotSize;
  appliance: Appliance;
  arches: Arches;
  upperWire: string | null;
  lowerWire: string | null;
  closed: boolean;
  adjustments: readonly {
    id: number; doneOn: string; phase: OrthoPhase | null;
    upperWire: string | null; lowerWire: string | null;
    elastics: ElasticClass; elasticNote: string | null;
  }[];
  /** غيابه يعني أن القراءة لم تحمل دليل الإزالة — يُقال ذلك صراحةً. */
  documentedWireRemovals?: readonly { adjustmentId: number; arch: WireArch }[];
  hasMore?: boolean;
  /** للعرض الأول فقط (الافتراضي: الخط الزمني). */
  initialView?: "timeline" | "table";
}

const ARCH_LABEL: Record<WireArch, string> = { upper: "الفك العلوي", lower: "الفك السفلي" };
const MATERIAL_CLASS: Record<string, string> = {
  NiTi: "border-sky-300 bg-sky-50",
  CuNiTi: "border-teal-300 bg-teal-50",
  SS: "border-slate-400 bg-slate-100",
  TMA: "border-amber-300 bg-amber-50",
};
const ENDED_LABEL: Record<WireSegment["endedBy"], string> = { change: "تغيّر", removal: "إزالة موثّقة", current: "الحالي" };

function weeksText(weeks: number | null): string {
  if (weeks === null) return "غير معروفة";
  if (weeks === 0) return "أقل من أسبوع";
  return weeks === 1 ? "أسبوع واحد" : weeks === 2 ? "أسبوعان" : `${weeks} أسابيع`;
}

/** التاريخ ISO يُعزل اتجاهه فلا يُقلب داخل نص عربي. */
function DateText({ value }: { value: string | null }) {
  return value === null ? <>غير معروف</> : <bdi dir="ltr">{value}</bdi>;
}

function segmentTitle(segment: WireSegment): string {
  if (segment.kind === "none") return "بلا سلك";
  if (segment.kind === "unknown") return "قبل أول تسجيل موثّق";
  return segment.text ?? "";
}

function segmentNotes(segment: WireSegment): string[] {
  const notes: string[] = [];
  if (segment.kind === "wire") {
    if (segment.catalogueStatus === "off_catalogue") notes.push("خارج الكتالوج");
    if (segment.catalogueStatus === "other_slot") notes.push("ليس من كتالوج قياس الحالة");
    if (segment.outOfOrder) notes.push("ليس بترتيب الكتالوج");
    if (segment.variants.length > 1) notes.push(`سُجّل أيضًا: ${segment.variants.slice(1).join("، ")}`);
    if (segment.recordedPhase) {
      notes.push(segment.phaseDiffers && segment.catalogue
        ? `المرحلة المسجّلة: ${PHASE_LABEL[segment.recordedPhase]} · حسب الكتالوج: ${PHASE_LABEL[segment.catalogue.phase]}`
        : `المرحلة المسجّلة: ${PHASE_LABEL[segment.recordedPhase]}`);
    } else if (segment.catalogue) notes.push(`حسب الكتالوج: ${PHASE_LABEL[segment.catalogue.phase]}`);
  }
  if (segment.blankSessionIds.length > 0) {
    const n = segment.blankSessionIds.length;
    notes.push(`${n === 1 ? "جلسة واحدة" : n === 2 ? "جلستان" : `${n} جلسات`} دون إعادة إدخال السلك (بلا تغيير)`);
  }
  if (segment.limitedToShown) notes.push("ضمن الجلسات المعروضة فقط");
  return notes;
}

export function OrthoWireTimeline(props: OrthoWireTimelineProps) {
  const [asTable, setAsTable] = useState(props.initialView === "table");
  const timeline = useMemo(() => {
    try {
      return buildWireTimeline({
        case: { slot: props.slot, appliance: props.appliance, arches: props.arches, upperWire: props.upperWire, lowerWire: props.lowerWire },
        adjustments: props.adjustments,
        documentedRemovals: props.documentedWireRemovals ?? [],
        hasMore: props.hasMore === true,
      });
    } catch {
      return null;
    }
  }, [props.slot, props.appliance, props.arches, props.upperWire, props.lowerWire, props.adjustments, props.documentedWireRemovals, props.hasMore]);

  if (timeline === null) {
    return <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">تعذّر بناء الخط الزمني للأسلاك من بيانات الجلسات.</p>;
  }
  if (timeline.kind === "not_applicable") {
    return <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600" data-testid="wire-timeline-na">هذا الجهاز لا يستخدم أسلاكًا.</p>;
  }

  const empty = timeline.lanes.every(lane => lane.segments.length === 0);
  return (
    <details open={!props.closed} className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="wire-timeline">
      <summary className="cursor-pointer text-xs font-extrabold text-navy-900">الخط الزمني للأسلاك</summary>
      <div className="mt-3 space-y-3">
        {timeline.truncated ? (
          <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs font-bold text-amber-900">
            يُعرض آخر 100 جلسة فقط؛ أقدم الجلسات غير معروضة.
          </p>
        ) : null}
        {props.documentedWireRemovals === undefined ? (
          <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
            دليل إزالة السلك غير متاح في هذه القراءة؛ الجلسات بلا سلك تُعرض «بلا تغيير».
          </p>
        ) : null}
        {timeline.mismatches.map(item => (
          <p key={item.arch} role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
            {ARCH_LABEL[item.arch]} — الحالة: {item.caseWire ?? "بلا سلك"} · آخر جلسة: {item.lastWire ?? "بلا سلك"}
          </p>
        ))}
        {empty ? <p className="text-xs text-slate-500">لا جلسات مسجّلة بعد.</p> : (
          <>
            <button type="button" onClick={() => setAsTable(value => !value)} aria-pressed={asTable}
              className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-bold text-navy-900 hover:bg-slate-50">
              {asTable ? "عرض كخط زمني" : "عرض كجدول"}
            </button>
            {timeline.lanes.map(lane => (
              <section key={lane.arch} aria-label={ARCH_LABEL[lane.arch]}>
                <h5 className="mb-2 text-xs font-extrabold text-slate-700">
                  {ARCH_LABEL[lane.arch]}{lane.treated ? "" : " — فك غير مشمول في الحالة"}
                </h5>
                {asTable ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-right text-xs">
                      <thead className="text-slate-500">
                        <tr><th className="p-1">السلك</th><th className="p-1">أول تسجيل موثّق</th><th className="p-1">آخر جلسة موثّقة</th><th className="p-1">الفترة الموثّقة</th><th className="p-1">الجلسات</th><th className="p-1">الانتهاء</th></tr>
                      </thead>
                      <tbody>
                        {lane.segments.map(segment => (
                          <tr key={segment.sessionIds[0]} className="border-t border-slate-100">
                            <td className="p-1 font-bold" dir="ltr">{segmentTitle(segment)}</td>
                            <td className="p-1"><DateText value={segment.firstDocumentedOn} /></td>
                            <td className="p-1"><DateText value={segment.lastSessionOn} /></td>
                            <td className="p-1">{weeksText(segment.documentedWeeks)}</td>
                            <td className="p-1">{segment.sessionIds.length}</td>
                            <td className="p-1">{ENDED_LABEL[segment.endedBy]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {lane.segments.map(segment => (
                      <li key={segment.sessionIds[0]}
                        className={`min-w-0 rounded-xl border p-2 text-xs sm:min-w-[11rem] ${segment.kind === "wire"
                          ? MATERIAL_CLASS[segment.catalogue?.material ?? ""] ?? "border-slate-300 bg-white"
                          : "border-dashed border-slate-300 bg-white"}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-extrabold text-navy-900" dir={segment.kind === "wire" ? "ltr" : undefined}>{segmentTitle(segment)}</span>
                          <span className="text-[11px] font-bold text-slate-600">{ENDED_LABEL[segment.endedBy]}</span>
                        </div>
                        {segment.catalogue && segment.kind === "wire" ? <p className="text-[11px] text-slate-600">{segment.catalogue.material}{segment.catalogue.round ? " · دائري" : " · مستطيل"}</p> : null}
                        <p className="mt-1 text-slate-700">أول تسجيل موثّق: <DateText value={segment.firstDocumentedOn} /></p>
                        <p className="text-slate-700">آخر جلسة موثّقة: <DateText value={segment.lastSessionOn} /></p>
                        <p className="text-slate-700">الفترة الموثّقة: {weeksText(segment.documentedWeeks)} · {segment.sessionIds.length} جلسة</p>
                        {segmentNotes(segment).map(note => <p key={note} className="text-[11px] text-slate-500">{note}</p>)}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ))}
            {timeline.elastics.some(period => period.elastics !== "none") ? (
              <section aria-label="المطاطات">
                <h5 className="mb-2 text-xs font-extrabold text-slate-700">المطاطات</h5>
                <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {timeline.elastics.map(period => (
                    <li key={`${period.firstDocumentedOn}-${period.elastics}`} className="rounded-xl border border-slate-200 bg-white p-2 text-xs">
                      <p className="font-extrabold text-navy-900">{ELASTIC_LABEL[period.elastics]}{period.note ? ` — ${period.note}` : ""}</p>
                      <p className="text-slate-700">أول تسجيل موثّق: <DateText value={period.firstDocumentedOn} /> · آخر جلسة: <DateText value={period.lastSessionOn} /> · {period.sessions} جلسة</p>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
