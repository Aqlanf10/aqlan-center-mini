import type { Currency } from "./money";

/** Read-only presentation of existing reports, never a second financial engine. */
export type LeadershipClinicalSource = "unscheduled-treatment" | "plan-intelligence" | "provider-utilization";
export type LeadershipClinicalPreset = "today" | "this_week" | "this_month" | "prev_month";
export type ClinicalMetric = { key: string; count: number } | { key: string; minor: number; currency: Currency };
export type ClinicalRow = Record<string, string | number | null>;
export interface LeadershipClinicalRead {
  report: LeadershipClinicalSource;
  from: string;
  to: string;
  generatedAt: string;
  timeZone: string;
  metrics: ClinicalMetric[];
  rows: ClinicalRow[];
}

const countKeys: Record<LeadershipClinicalSource, readonly string[]> = {
  "unscheduled-treatment": ["plans", "patients", "items"],
  "plan-intelligence": ["created", "active", "completed", "stopped"],
  "provider-utilization": ["doctors", "appointments", "visits", "chair-minutes"],
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const amount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const currency = (v: unknown): v is Currency => v === "YER" || v === "SAR" || v === "USD";
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

function projectRow(value: unknown, source: LeadershipClinicalSource): ClinicalRow | null {
  if (!object(value)) return null;
  const keys = source === "unscheduled-treatment"
    ? ["patientId", "patientName", "planTitle", "doctorName", "startDate", "pendingItems", "currency", "pendingMinor", "lastVisit"]
    : source === "provider-utilization"
    ? ["doctorId", "doctorName", "appointments", "attended", "noShow", "visits", "chairMinutes", "avgVisitMinutes", "productionText", "collectedText"]
    : ["dimension", "name", "currency", "plans", "active", "completed", "stopped", "remainingMinor"];
  if (source === "unscheduled-treatment") {
    if (!count(value.patientId) || value.patientId === 0 || !count(value.pendingItems) || !currency(value.currency)
      || !amount(value.pendingMinor) || !date(value.startDate) || !(value.lastVisit === "" || date(value.lastVisit))
      || ![value.patientName, value.planTitle, value.doctorName].every(text)) return null;
  } else if (source === "provider-utilization") {
    if (!count(value.doctorId) || value.doctorId === 0 || ![value.appointments, value.attended, value.noShow, value.visits, value.chairMinutes].every(count)
      || !(value.avgVisitMinutes === null || count(value.avgVisitMinutes))
      || ![value.doctorName, value.productionText, value.collectedText].every(text)) return null;
  } else if (!currency(value.currency) || ![value.dimension, value.name].every(text)
    || ![value.plans, value.active, value.completed, value.stopped].every(count) || !amount(value.remainingMinor)) return null;
  // Whitelist fields: no phone, commission, salary, arbitrary notes, or source links.
  return Object.fromEntries(keys.map(key => [key, value[key]])) as ClinicalRow;
}

export function decodeLeadershipClinical(value: unknown, source: LeadershipClinicalSource): LeadershipClinicalRead | null {
  if (!object(value) || !object(value.result)) return null;
  const result = value.result;
  if (result.report !== source || !date(result.from) || !date(result.to) || result.from > result.to
    || !currency(result.baseCurrency) || !Array.isArray(result.kpis) || !Array.isArray(result.rows)
    || !text(value.generatedAt) || !Number.isFinite(Date.parse(value.generatedAt)) || !text(value.clinicTimeZone)) return null;
  try { new Intl.DateTimeFormat("ar-YE", { timeZone: value.clinicTimeZone }); } catch { return null; }
  const metrics: ClinicalMetric[] = [];
  for (const key of countKeys[source]) {
    const matches = result.kpis.filter(k => object(k) && k.key === key);
    if (matches.length !== 1 || !count(matches[0].count)) return null;
    metrics.push({ key, count: matches[0].count });
  }
  const prefix = source === "unscheduled-treatment" ? "pending" : source === "plan-intelligence" ? "remaining" : null;
  if (prefix) {
    const currencies = new Set<Currency>();
    const money = result.kpis.filter(k => object(k) && typeof k.key === "string" && (k.key === prefix || k.key.startsWith(`${prefix}-`)));
    if (money.length === 0) return null;
    for (const metric of money) {
      if (!currency(metric.currency) || !amount(metric.minor) || currencies.has(metric.currency)
        || metric.key !== (metric.currency === result.baseCurrency ? prefix : `${prefix}-${metric.currency}`)) return null;
      currencies.add(metric.currency);
      metrics.push({ key: metric.key, minor: metric.minor, currency: metric.currency });
    }
  }
  const rows: ClinicalRow[] = [];
  for (const row of result.rows) {
    const projected = projectRow(row, source);
    if (!projected) return null;
    rows.push(projected);
  }
  const totalKey = source === "unscheduled-treatment" ? "plans" : source === "provider-utilization" ? "doctors" : null;
  if (totalKey && metrics.find(k => k.key === totalKey && "count" in k && k.count === rows.length) === undefined) return null;
  return { report: source, from: result.from, to: result.to, generatedAt: value.generatedAt, timeZone: value.clinicTimeZone, metrics, rows };
}

export function leadershipClinicalHref(read: Pick<LeadershipClinicalRead, "report" | "from" | "to">, doctorId?: number): string {
  const params = new URLSearchParams({ section: "intelligence", report: read.report, preset: "custom", from: read.from, to: read.to });
  if (doctorId !== undefined) params.set("doctorId", String(doctorId));
  return `/reports?${params.toString()}`;
}

export function leadershipClinicalUrl(source: LeadershipClinicalSource, preset: LeadershipClinicalPreset): string {
  // The current unscheduled worklist does not acquire a misleading period filter.
  return `/api/reports?report=${source}&preset=${source === "unscheduled-treatment" ? "today" : preset}`;
}
