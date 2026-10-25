import { isAdmin } from "./roles";
import { isOperationalDay } from "./leadership-operations";
import { clinicDateString } from "./schedule";
import { patientLocationHref } from "./patient-navigation";

export const LEADERSHIP_PAGE_SIZE = 10;
export const canReadLeadershipPulse = isAdmin;
export type PulseView = "day" | "tasks";
export interface PulseQuery { view: PulseView; day: string; page: number }
export interface PulseRow {
  id: number; title: string; status: string; patientId: number | null;
  eventAt: string; doctorName: string | null; assignee: string | null; dueAt: string | null;
  latestAction: { actor: string; action: string; at: string } | null;
}
export interface LeadershipPulse {
  view: PulseView; scope: "selected_arrival_day" | "visible_open_tasks_now";
  day: string; today: string; timeZone: string; asOf: string;
  counts: Record<string, number>; total: number; page: number; hasMore: boolean; items: PulseRow[];
}
export function parsePulseQuery(params: URLSearchParams, now: Date, timeZone: string): PulseQuery | null {
  if ([...params.keys()].some(key => !["view", "day", "page"].includes(key) || params.getAll(key).length !== 1)) return null;
  const view = params.get("view") ?? "day", day = params.get("day") ?? clinicDateString(now, timeZone), page = params.get("page") ?? "0";
  if (!["day", "tasks"].includes(view) || !isOperationalDay(day) || !/^(0|[1-9]\d{0,5})$/.test(page)
    || (view === "tasks" && params.has("day"))) return null;
  return { view: view as PulseView, day, page: Number(page) };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is number => number(v) && v > 0 && v <= 2147483647;
const time = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableText = (v: unknown) => v === null || typeof v === "string";
export function decodeLeadershipPulse(value: unknown, view: PulseView, day: string | null): LeadershipPulse | null {
  if (!object(value) || value.view !== view || value.scope !== (view === "day" ? "selected_arrival_day" : "visible_open_tasks_now")
    || typeof value.day !== "string" || !isOperationalDay(value.day) || typeof value.today !== "string" || !isOperationalDay(value.today)
    || (day !== null && value.day !== day) || typeof value.timeZone !== "string" || !time(value.asOf)
    || !object(value.counts) || !number(value.total) || !number(value.page) || !Array.isArray(value.items)) return null;
  try { if (clinicDateString(new Date(value.asOf), value.timeZone) !== value.today) return null; } catch { return null; }
  const keys = view === "day" ? ["arrived", "waiting", "called", "inChair", "done", "appointments", "noShow", "cancelled"] : ["open", "overdue", "blocked", "unassigned"];
  const counts = value.counts as Record<string, number>;
  if (Object.keys(counts).length !== keys.length || keys.some(key => !number(counts[key]))) return null;
  if (view === "day" && (counts.arrived !== counts.waiting + counts.called + counts.inChair + counts.done
    || value.total !== counts.waiting + counts.called + counts.inChair || counts.noShow + counts.cancelled > counts.appointments)) return null;
  if (view === "tasks" && (value.total !== counts.open || [counts.overdue, counts.blocked, counts.unassigned].some(n => n > counts.open))) return null;
  if (value.page > Math.max(0, Math.ceil(value.total / LEADERSHIP_PAGE_SIZE) - 1)
    || value.hasMore !== ((value.page + 1) * LEADERSHIP_PAGE_SIZE < value.total)
    || value.items.length !== Math.min(LEADERSHIP_PAGE_SIZE, value.total - value.page * LEADERSHIP_PAGE_SIZE)) return null;
  const seen = new Set<number>();
  for (const row of value.items) {
    if (!object(row) || !id(row.id) || seen.has(row.id) || typeof row.title !== "string" || !time(row.eventAt)
      || !(row.patientId === null || id(row.patientId)) || !nullableText(row.doctorName) || !nullableText(row.assignee)
      || !(row.dueAt === null || time(row.dueAt))) return null;
    seen.add(row.id);
    if (view === "day" && (!["waiting", "called", "in_chair"].includes(String(row.status)) || row.assignee !== null || row.dueAt !== null || row.latestAction !== null)) return null;
    if (view === "tasks" && (!["planned", "in_progress", "blocked"].includes(String(row.status)) || row.patientId !== null || row.doctorName !== null)) return null;
    if (row.latestAction !== null && (!object(row.latestAction) || typeof row.latestAction.actor !== "string"
      || typeof row.latestAction.action !== "string" || !time(row.latestAction.at))) return null;
  }
  return value as unknown as LeadershipPulse;
}
/** For historical arrival cohorts do not claim that the current Today tab is that historical visit. */
export function leadershipVisitHref(row: Pick<PulseRow, "id" | "patientId">): string {
  return row.patientId ? patientLocationHref(`/patients/${row.patientId}`, { tab: "summary", sub: "chart" }) : `/visits/${row.id}`;
}

/** A future or invalid arrival is not a measured zero-minute wait. */
export function leadershipWaitingMinutes(arrivedAt: string, asOf: string): number | null {
  const elapsed = Date.parse(asOf) - Date.parse(arrivedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.floor(elapsed / 60000) : null;
}
