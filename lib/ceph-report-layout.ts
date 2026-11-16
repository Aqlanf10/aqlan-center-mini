/** Presentation only: no clinical computation, normative grading or mutation.
 * Recorded units, labels, sources and values remain owned by the caller. */
export interface CephReportRow {
  code: string; en: string; ar: string; group: string; unit: string;
  value: number | null; refMean: number | null; refSd: number | null;
  source: string; note?: string; descriptiveOnly?: boolean;
}
export const CEPH_REPORT_GROUPS = [
  { id: "sagittal", ar: "العلاقات الهيكلية السهمية", en: "Sagittal skeletal" },
  { id: "vertical", ar: "العلاقات الهيكلية العمودية", en: "Vertical skeletal" },
  { id: "dental", ar: "الأسنان والقواطع", en: "Dental relationships" },
  { id: "softTissue", ar: "الأنسجة الرخوة", en: "Soft tissue" },
  { id: "other", ar: "قياسات أخرى محفوظة", en: "Other recorded measurements" },
] as const;
export function cephReportLayout(rows: readonly CephReportRow[]) {
  const sources = [...new Set(rows.map(row => row.source))];
  const known = new Set<string>(CEPH_REPORT_GROUPS.map(group => group.id));
  const groups = CEPH_REPORT_GROUPS.map(group => ({ ...group, rows: rows.filter(row =>
    group.id === "other" ? row.group === "other" || !known.has(row.group) : row.group === group.id),
  })).filter(group => group.rows.length > 0);
  const available = rows.filter(row => typeof row.value === "number" && Number.isFinite(row.value)).length;
  return { groups, sources, available, unavailable: rows.length - available, total: rows.length };
}
export function cephReportValue(row: Pick<CephReportRow, "value" | "unit">): string {
  return typeof row.value === "number" && Number.isFinite(row.value) ? `${row.value}${row.unit}` : "—";
}
export function cephReportReference(row: Pick<CephReportRow, "descriptiveOnly" | "refMean" | "refSd">): string {
  if (row.descriptiveOnly) return "وصفي · بلا تصنيف";
  return typeof row.refMean === "number" && Number.isFinite(row.refMean)
    && typeof row.refSd === "number" && Number.isFinite(row.refSd) && row.refSd > 0
    ? `${row.refMean}±${row.refSd}` : "غير متاح";
}

/** Layout of labels only. Coordinates remain verbatim; no tracing correction.
 * Two external rails keep tightly packed incisor names off their source points. */
export function cephReportLabels(points: readonly { code: string; x: number; y: number }[]) {
  if (points.length === 0 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
  const span = Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(span) || span <= 0) return null;
  const fontSize = span * 0.027, gap = fontSize * 1.7, midX = (minX + maxX) / 2;
  const left = points.filter(point => point.x <= midX), right = points.filter(point => point.x > midX);
  const height = Math.max(span, Math.max(left.length, right.length) * gap);
  const top = (minY + maxY - height) / 2;
  const labels = [left, right].flatMap((side, sideIndex) => {
    let previous = top - gap;
    return [...side].sort((a,b) => a.y-b.y || a.x-b.x || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map((point,index) => {
      const y = Math.max(previous + gap, Math.min(point.y, top + height - (side.length-1-index)*gap));
      previous = y;
      return { code: point.code, pointX: point.x, pointY: point.y,
        x: sideIndex === 0 ? minX - span * 0.16 : maxX + span * 0.16, y,
        anchor: sideIndex === 0 ? "end" as const : "start" as const };
    });
  });
  const labelWidth = Math.max(...points.map(point=>point.code.length)) * fontSize * 0.7;
  const padding = span * 0.2 + labelWidth;
  const box = [minX-padding, top-fontSize*2, maxX-minX+padding*2, height+fontSize*4];
  if (![fontSize,gap,...box,...labels.flatMap(label=>[label.x,label.y])].every(Number.isFinite) || fontSize <= 0) return null;
  return { labels, fontSize, gap, viewBox: box.join(" ") };
}
