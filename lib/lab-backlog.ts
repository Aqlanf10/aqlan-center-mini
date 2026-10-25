import { isAdmin } from "./roles";
import { patientLocationHref } from "./patient-navigation";
import { clinicDateString } from "./schedule";
import type { LabReadinessStatus } from "./lab-readiness";

/** Current open work across all dates. Never a selected-day or financial report. */
export const LAB_BACKLOG_PAGE_SIZE = 20;
export const LAB_BACKLOG_FILTERS = ["all", "preparing", "with_lab", "overdue", "awaiting_fitting"] as const;
export type LabBacklogFilter = typeof LAB_BACKLOG_FILTERS[number];
export const canReadLabBacklog = isAdmin;
export const LAB_BACKLOG_FILTER_LABEL: Record<LabBacklogFilter, string> = {
  all: "كل المفتوح", preparing: "لم يُرسل بعد", with_lab: "عند المعمل", overdue: "متأخر عند المعمل", awaiting_fitting: "وصل ولم يُركّب",
};
export interface LabBacklogTask {
  id: number; title: string; status: "planned" | "in_progress" | "blocked";
  assignee: string | null; dueAt: string | null; updatedAt: string;
}
export interface LabBacklogItem {
  id: number; patientId: number; patientName: string; patientNumber: string | null;
  workType: string; teeth: string | null; doctorName: string | null; labName: string;
  status: LabReadinessStatus; createdAt: string; sentDate: string; dueDate: string;
  receivedAt: string | null;
  latestAction: { action: string; fromStatus: string | null; toStatus: string | null; actor: string; at: string } | null;
  visibleTaskCount: number; tasks: LabBacklogTask[];
}
export interface LabBacklogSnapshot {
  scope: "all_open_now"; asOf: string; today: string; timeZone: string; filter: LabBacklogFilter;
  counts: { orders: number; patients: number; preparing: number; withLab: number; overdue: number; awaitingFitting: number };
  total: number; page: number; hasMore: boolean; items: LabBacklogItem[];
}
export function parseLabBacklogQuery(params: URLSearchParams): { filter: LabBacklogFilter; page: number } | null {
  if ([...params.keys()].some(key => !["filter", "page"].includes(key) || params.getAll(key).length !== 1)) return null;
  const filter = params.get("filter") ?? "all", page = params.get("page") ?? "0";
  if (!(LAB_BACKLOG_FILTERS as readonly string[]).includes(filter) || !/^(0|[1-9]\d{0,5})$/.test(page)) return null;
  return { filter: filter as LabBacklogFilter, page: Number(page) };
}
export const labBacklogPatientHref = (patientId: number) => patientLocationHref(`/patients/${patientId}`, { tab: "treatment", sub: "lab" });
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const day = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const id = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
export function decodeLabBacklog(value: unknown, filter: LabBacklogFilter): LabBacklogSnapshot | null {
  if (!record(value) || value.scope !== "all_open_now" || value.filter !== filter || !instant(value.asOf) || !day(value.today)
    || typeof value.timeZone !== "string" || !record(value.counts) || !count(value.total) || !count(value.page)
    || !Array.isArray(value.items)) return null;
  try { if (clinicDateString(new Date(value.asOf), value.timeZone) !== value.today) return null; } catch { return null; }
  const c = value.counts;
  if (![c.orders, c.patients, c.preparing, c.withLab, c.overdue, c.awaitingFitting].every(count)
    || Number(c.orders) !== Number(c.preparing) + Number(c.withLab) + Number(c.awaitingFitting)
    || Number(c.overdue) > Number(c.withLab) || Number(c.patients) > Number(c.orders)
    || value.total !== ({ all: c.orders, preparing: c.preparing, with_lab: c.withLab, overdue: c.overdue, awaiting_fitting: c.awaitingFitting })[filter]
    || value.page > Math.max(0, Math.ceil(value.total / LAB_BACKLOG_PAGE_SIZE) - 1)
    || value.hasMore !== ((value.page + 1) * LAB_BACKLOG_PAGE_SIZE < value.total)
    || value.items.length !== Math.min(LAB_BACKLOG_PAGE_SIZE, value.total - value.page * LAB_BACKLOG_PAGE_SIZE)) return null;
  const seen = new Set<number>();
  for (const item of value.items) {
    if (!record(item) || !id(item.id) || seen.has(item.id) || !id(item.patientId)
      || ![item.patientName, item.workType, item.labName].every(v => typeof v === "string")
      || ![item.patientNumber, item.teeth, item.doctorName].every(nullableText)
      || !["needed", "sent", "in_progress", "remake", "received"].includes(String(item.status))
      || !instant(item.createdAt) || !day(item.sentDate) || !day(item.dueDate)
      || !(item.receivedAt === null || instant(item.receivedAt))
      || !count(item.visibleTaskCount) || !Array.isArray(item.tasks) || item.tasks.length !== Math.min(3, item.visibleTaskCount)) return null;
    if (filter === "preparing" && item.status !== "needed" || filter === "awaiting_fitting" && item.status !== "received"
      || ["with_lab", "overdue"].includes(filter) && !["sent", "in_progress", "remake"].includes(String(item.status))
      || filter === "overdue" && item.dueDate >= value.today) return null;
    seen.add(item.id);
    if (item.latestAction !== null && (!record(item.latestAction) || !instant(item.latestAction.at)
      || typeof item.latestAction.actor !== "string" || typeof item.latestAction.action !== "string"
      || !nullableText(item.latestAction.fromStatus) || !nullableText(item.latestAction.toStatus))) return null;
    const tasks = new Set<number>();
    for (const task of item.tasks) {
      if (!record(task) || !id(task.id) || tasks.has(task.id) || typeof task.title !== "string"
        || !["planned", "in_progress", "blocked"].includes(String(task.status)) || !nullableText(task.assignee)
        || !(task.dueAt === null || instant(task.dueAt)) || !instant(task.updatedAt)) return null;
      tasks.add(task.id);
    }
  }
  return value as unknown as LabBacklogSnapshot;
}
export function labBacklogAge(item: LabBacklogItem, today: string, timeZone: string): { label: string; days: number | null } {
  const label = item.status === "received" ? "من الوصول المسجّل" : item.status === "needed" ? "من تسجيل الطلب" : "بعد موعد الوصول المتوقع";
  const source = item.status === "received" ? item.receivedAt : item.status === "needed" ? item.createdAt : item.dueDate;
  if (!source) return { label, days: null };
  const date = item.status === "received" || item.status === "needed" ? clinicDateString(new Date(source), timeZone) : source;
  const delta = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000;
  return { label, days: !Number.isFinite(delta) || (delta < 0 && (item.status === "received" || item.status === "needed")) ? null : Math.max(0, Math.round(delta)) };
}
export function labBacklogNextAction(status: LabReadinessStatus): string {
  if (status === "needed") return "راجع التجهيز وبيانات المعمل قبل تسجيل الإرسال الفعلي.";
  if (status === "received") return "راجع المطابقة السريرية وموعد التجربة أو التركيب مع المريض؛ الوصول ليس اكتمال العلاج.";
  if (status === "remake") return "تحقّق من مرحلة الإعادة والموعد المتفق عليه مع المعمل.";
  return "تحقّق من تقدم المعمل وموعد الوصول المتوقع وسجّل المتابعة.";
}
