"use client";

/**
 * OW-1 — مسار الأسلاك (قراءة فقط، فوق سجل الشدّات).
 * العقد: docs/review/ortho-wire-timeline-photo-records-contract-20261118.md (v2.1).
 * التصميم بعد مراجعة د. عقلان (#483 6993812820): ملخص صغير لآخر سلك موثّق لكل فك،
 * ثم صفّ لكل جلسة بتاريخ واحد وأعمدة ثابتة (العلوي، السفلي، المطاط). على الجوال
 * الجلسات متتابعة رأسيًا بلا تمرير أفقي. العرض فقط: نموذج الشدّة ودلالة البيانات كما هي.
 */
import { ELASTIC_LABEL, type Appliance, type Arches, type ElasticClass, type OrthoPhase, type SlotSize } from "@/lib/ortho";
import {
  buildWireSessionView, type ElasticCell, type WireArch, type WireCell, type WireLaneSummary,
} from "@/lib/ortho-wire-timeline";

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
}

const ARCH_LABEL: Record<WireArch, string> = { upper: "العلوي", lower: "السفلي" };
const ARCH_TITLE: Record<WireArch, string> = { upper: "الفك العلوي", lower: "الفك السفلي" };

function weeksText(weeks: number): string {
  if (weeks === 0) return "أقل من أسبوع";
  return weeks === 1 ? "أسبوع واحد" : weeks === 2 ? "أسبوعان" : weeks <= 10 ? `${weeks} أسابيع` : `${weeks} أسبوعًا`;
}

function DateText({ value }: { value: string }) {
  return <bdi dir="ltr" className="tabular-nums">{value}</bdi>;
}

function WireText({ text, strong }: { text: string; strong: boolean }) {
  return <bdi dir="ltr" className={strong ? "font-extrabold text-navy-900" : "text-slate-500"}>{text}</bdi>;
}

function Badge({ tone, children }: { tone: "sky" | "amber"; children: React.ReactNode }) {
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${tone === "sky"
      ? "border-sky-200 bg-sky-100 text-sky-800" : "border-amber-300 bg-amber-50 text-amber-800"}`}>{children}</span>
  );
}

function flagsOf(cell: WireCell): string[] {
  const flags: string[] = [];
  if (cell.catalogueStatus === "off_catalogue") flags.push("خارج الكتالوج");
  if (cell.catalogueStatus === "other_slot") flags.push("ليس من كتالوج قياس الحالة");
  if (cell.outOfOrder) flags.push("ليس بترتيب الكتالوج");
  return flags;
}

function WireCellView({ cell }: { cell: WireCell }) {
  switch (cell.kind) {
    case "first":
    case "change":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <WireText text={cell.text ?? ""} strong />
          <Badge tone="sky">{cell.kind === "first" ? "أول تسجيل" : "تغيير"}</Badge>
          {flagsOf(cell).map(flag => <span key={flag} className="text-[10px] text-slate-500">{flag}</span>)}
        </span>
      );
    case "same":
      return <WireText text={cell.text ?? ""} strong={false} />;
    case "removal":
      return <Badge tone="amber">إزالة موثّقة</Badge>;
    case "unchanged":
      return <span className="text-slate-400">بلا تغيير</span>;
    case "unknown":
      return <span className="text-slate-400">غير موثّق</span>;
  }
}

function ElasticCellView({ cell }: { cell: ElasticCell }) {
  if (cell.kind === "same") return <span className="text-slate-400">بلا تغيير</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={cell.elastics === "none" ? "text-slate-600" : "font-bold text-navy-900"}>
        {ELASTIC_LABEL[cell.elastics]}{cell.note ? ` — ${cell.note}` : ""}
      </span>
      {cell.kind === "change" ? <Badge tone="sky">تغيير</Badge> : null}
    </span>
  );
}

function SummaryCard({ item }: { item: WireLaneSummary }) {
  return (
    <div className="rounded-xl border border-sky-100 bg-sky-50/70 p-3">
      <p className="text-[11px] font-bold text-sky-800">{ARCH_TITLE[item.arch]}{item.treated ? "" : " — غير مشمول في الحالة"}</p>
      <p className="mt-1 text-sm">
        {item.kind === "wire" ? <WireText text={item.text ?? ""} strong />
          : item.kind === "none" ? <span className="font-bold text-amber-800">بلا سلك — إزالة موثّقة</span>
            : <span className="text-slate-500">لا سلك موثّق بعد</span>}
      </p>
      {item.kind !== "unknown" && item.firstDocumentedOn ? (
        <p className="mt-1 text-[11px] text-slate-600">
          {item.kind === "none" ? "منذ" : "أول تسجيل موثّق"}: <DateText value={item.firstDocumentedOn} />
          {item.lastSessionOn ? <> · آخر جلسة: <DateText value={item.lastSessionOn} /></> : null}
        </p>
      ) : null}
      {item.kind === "wire" && item.documentedWeeks !== null ? (
        <p className="text-[11px] text-slate-600">الفترة الموثّقة: {weeksText(item.documentedWeeks)}</p>
      ) : null}
    </div>
  );
}

export function OrthoWireTimeline(props: OrthoWireTimelineProps) {
  let view: ReturnType<typeof buildWireSessionView> | null;
  try {
    view = buildWireSessionView({
      case: { slot: props.slot, appliance: props.appliance, arches: props.arches, upperWire: props.upperWire, lowerWire: props.lowerWire },
      adjustments: props.adjustments,
      documentedRemovals: props.documentedWireRemovals ?? [],
      hasMore: props.hasMore === true,
    });
  } catch {
    view = null;
  }

  if (view === null) {
    return <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">تعذّر بناء مسار الأسلاك من بيانات الجلسات.</p>;
  }
  if (view.kind === "not_applicable") {
    return <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600" data-testid="wire-timeline-na">هذا الجهاز لا يستخدم أسلاكًا.</p>;
  }

  const columns = view.arches;
  return (
    <details open={!props.closed} className="rounded-2xl border border-sky-100 bg-white p-4" data-testid="wire-timeline">
      <summary className="cursor-pointer text-xs font-extrabold text-navy-900">
        مسار الأسلاك <span className="font-normal text-slate-500">· صفّ لكل جلسة، الأحدث أولًا</span>
      </summary>
      <div className="mt-3 space-y-3">
        {view.truncated ? (
          <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs font-bold text-amber-900">
            يُعرض آخر 100 جلسة فقط؛ أقدم الجلسات غير معروضة.
          </p>
        ) : null}
        {props.documentedWireRemovals === undefined ? (
          <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
            دليل إزالة السلك غير متاح في هذه القراءة؛ الجلسات بلا سلك تُعرض «بلا تغيير».
          </p>
        ) : null}

        <div className={`grid gap-2 ${view.summary.length > 1 ? "sm:grid-cols-2" : ""}`} data-testid="wire-summary">
          {view.summary.map(item => <SummaryCard key={item.arch} item={item} />)}
        </div>
        {view.mismatches.map(item => (
          <p key={item.arch} role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
            {ARCH_TITLE[item.arch]} — سلك الحالة: {item.caseWire ? <WireText text={item.caseWire} strong={false} /> : "بلا سلك"} ·
            آخر جلسة: {item.lastWire ? <WireText text={item.lastWire} strong={false} /> : "بلا سلك"}
          </p>
        ))}

        {view.rows.length === 0 ? <p className="text-xs text-slate-500">لا جلسات مسجّلة بعد.</p> : (
          <>
            {/* الحاسوب: جدول بأعمدة ثابتة */}
            <table className="hidden w-full text-right text-xs sm:table" data-testid="wire-sessions-table">
              <thead>
                <tr className="border-b border-sky-100 text-[11px] text-sky-800">
                  <th className="p-2 font-bold">التاريخ</th>
                  {columns.map(arch => <th key={arch} className="p-2 font-bold">{ARCH_LABEL[arch]}</th>)}
                  <th className="p-2 font-bold">المطاط</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map(row => (
                  <tr key={row.id} className="border-b border-slate-100 align-top last:border-0">
                    <td className="whitespace-nowrap p-2 font-bold text-slate-700"><DateText value={row.doneOn} /></td>
                    {columns.map(arch => {
                      const cell = arch === "upper" ? row.upper : row.lower;
                      return <td key={arch} className="p-2">{cell ? <WireCellView cell={cell} /> : null}</td>;
                    })}
                    <td className="p-2"><ElasticCellView cell={row.elastics} /></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* الجوال: الجلسات متتابعة رأسيًا — التاريخ ثم الفكّان والمطاط */}
            <ol className="space-y-2 sm:hidden" data-testid="wire-sessions-list">
              {view.rows.map(row => (
                <li key={row.id} className="rounded-xl border border-slate-100 bg-white p-3 text-xs">
                  <p className="mb-1.5 font-bold text-sky-800"><DateText value={row.doneOn} /></p>
                  <dl className="space-y-1">
                    {columns.map(arch => {
                      const cell = arch === "upper" ? row.upper : row.lower;
                      return (
                        <div key={arch} className="flex items-start gap-2">
                          <dt className="w-12 shrink-0 text-slate-500">{ARCH_LABEL[arch]}</dt>
                          <dd className="min-w-0">{cell ? <WireCellView cell={cell} /> : null}</dd>
                        </div>
                      );
                    })}
                    <div className="flex items-start gap-2">
                      <dt className="w-12 shrink-0 text-slate-500">المطاط</dt>
                      <dd className="min-w-0"><ElasticCellView cell={row.elastics} /></dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </details>
  );
}
