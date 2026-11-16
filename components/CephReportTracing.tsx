import { cephReportLabels } from "@/lib/ceph-report-layout";
import { CEPH_REPORT_NOT_TO_SCALE, CEPH_REPORT_SAVED_TRACE, CEPH_REPORT_TRACE_UNAVAILABLE,
  type CephReportTracing as Tracing } from "@/lib/ceph-report-view";

/** Straight connections between explicitly stored landmarks. No template anatomy,
 * current measurement engine, inferred landmarks or mutation of patient points. */
const GUIDE_PAIRS = [
  ["S", "N"], ["Or", "Po"], ["Go", "Me"], ["N", "A"], ["N", "B"],
  ["N", "Pog"], ["A", "Pog"], ["ANS", "PNS"], ["OcclA", "OcclP"],
  ["U1A", "U1"], ["L1A", "L1"], ["S", "Ar"], ["Ar", "Go"],
  ["S", "Gn"], ["S", "Ba"], ["N", "Ba"], ["Prn", "PogS"],
] as const;

export function CephReportTracing({ tracing }: { tracing: Tracing }) {
  if (!tracing.available) return <p role="note" data-testid="ceph-report-tracing-unavailable"
    data-reason={tracing.reason} className="my-2 rounded border border-amber-200 p-2 text-xs">
    {CEPH_REPORT_TRACE_UNAVAILABLE}
  </p>;
  const byCode = new Map(tracing.points.map(point => [point.code, point]));
  const radius = tracing.markSize;
  const labels = cephReportLabels(tracing.points);
  return <section data-testid="ceph-report-tracing" data-source={tracing.source}
    aria-label="المخطط السيفالومتري التوضيحي" className="print-watermark-protected"
    style={{ margin: "2mm 0 3mm", border: "1px solid #e2e8f0", borderRadius: "2mm", padding: "2mm", backgroundColor: "#ffffff", breakInside: "avoid" }}>
    <h3 style={{ margin: 0, fontSize: "8pt", fontWeight: 700 }}>
      المخطط السيفالومتري التوضيحي · Cephalometric landmark diagram
    </h3>
    <p style={{ margin: "1mm 0", fontSize: "7pt" }}>
      {tracing.source === "sealed" ? CEPH_REPORT_SAVED_TRACE : "رسم من نقاط المسودة المقروءة عند فتح التقرير؛ ليس لقطة اعتماد."}
    </p>
    <p style={{ margin: "1mm 0", fontSize: "7pt", fontWeight: 600 }}>{CEPH_REPORT_NOT_TO_SCALE}</p>
    <p style={{ margin: "1mm 0", fontSize: "7pt" }}>خطوط التسمية الفاتحة للإيضاح فقط؛ لم تُحرّك مواضع المعالم.</p>
    <div style={{ width: "100%", height: "88mm", display: "flex", justifyContent: "center" }}>
      <svg viewBox={labels?.viewBox ?? tracing.viewBox} preserveAspectRatio="xMidYMid meet" role="img"
        aria-label={tracing.source === "sealed" ? "نقاط لقطة الاعتماد المحفوظة" : "نقاط المسودة"}
        style={{ height: "100%", width: "100%", maxWidth: "100%", backgroundColor: "#fafbfc" }}>
        <title>{tracing.source === "sealed" ? "Saved approval landmarks" : "Draft landmarks"}</title>
        {GUIDE_PAIRS.map(([a, b]) => {
          const from = byCode.get(a), to = byCode.get(b);
          if (!from || !to || (from.x === to.x && from.y === to.y)) return null;
          return <line key={`${a}-${b}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke={a === "U1A" || a === "L1A" ? "#036e92" : "#64748b"} strokeWidth={radius} strokeDasharray={`${radius * 3} ${radius * 2}`} />;
        })}
        {labels?.labels.map(label => <g key={`label-${label.code}`} aria-hidden="true">
          <line x1={label.pointX} y1={label.pointY} x2={label.x} y2={label.y}
            stroke="#b7c8d1" strokeWidth={radius / 2} />
          <text x={label.x} y={label.y} textAnchor={label.anchor} dominantBaseline="middle"
            fontSize={labels.fontSize} fill="#172b3a" direction="ltr">{label.code}</text>
        </g>)}
        {tracing.points.map(point => <g key={point.code} data-landmark={point.code}>
          <circle cx={point.x} cy={point.y} r={radius * 1.3} fill="#0f172a"><title>{point.code}</title></circle>
          {!labels && <text x={point.x + radius * 3} y={point.y - radius * 3}
            fontSize={radius * 10} fill="#0f172a" direction="ltr">{point.code}</text>}
        </g>)}
      </svg>
    </div>
  </section>;
}
