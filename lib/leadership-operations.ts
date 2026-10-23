import { isAdmin } from "./roles";
import { clinicDateString } from "./schedule";
import { patientLocationHref } from "./patient-navigation";

/** Phase one: present-day reads of a selected day's events, not a historical snapshot or task ledger. */
export const OPERATIONAL_PAGE_SIZE = 10;
export type OperationalLane = "all" | "reception" | "doctor";
export type OperationalSource = "appointments" | "referrals";
export type AppointmentReviewState = "needs_review" | "history_review" | "replacement_active" | "replacement_finished" | "replacement_terminal";
export interface OperationalItem {
  id: number;
  patientId: number;
  patientName: string;
  patientNumber: string;
  status: string;
  state: AppointmentReviewState | "awaiting_referrer";
  eventAt: string;
  plannedVisitId: number | null;
  reviewDoctor: string | null;
  replacement: { id: number; date: string; time: string; status: string; auditId: string; recordedAt: string } | null;
}
export type OperationalSection = {
  source: OperationalSource;
  status: "ready";
  asOf: string;
  total: number;
  page: number;
  hasMore: boolean;
  items: OperationalItem[];
} | { source: OperationalSource; status: "error"; asOf: null; total: null; message: string };
export interface OperationalOverview {
  day: string;
  timeZone: string;
  lane: OperationalLane;
  sections: OperationalSection[];
}
export interface OperationalQuery { day: string; lane: OperationalLane; appointmentPage: number; referralPage: number }
export const canReadOperationalOverview = isAdmin;
export function isOperationalDay(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function parseOperationalQuery(params: URLSearchParams, now: Date, timeZone: string): OperationalQuery | null {
  const allowed = ["day", "lane", "appointmentPage", "referralPage"];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) return null;
  const day = params.get("day") ?? clinicDateString(now, timeZone);
  const lane = params.get("lane") ?? "all";
  const pages = [params.get("appointmentPage") ?? "0", params.get("referralPage") ?? "0"];
  if (!isOperationalDay(day) || !["all", "reception", "doctor"].includes(lane)
    || pages.some(page => !/^(0|[1-9]\d{0,5})$/.test(page))) return null;
  return { day, lane: lane as OperationalLane, appointmentPage: Number(pages[0]), referralPage: Number(pages[1]) };
}
export function operationalPatientHref(item: Pick<OperationalItem, "patientId">, source: OperationalSource): string {
  return patientLocationHref(`/patients/${item.patientId}`, source === "referrals"
    ? { tab: "treatment", sub: "referrals" } : { tab: "summary", sub: "chart" });
}

/** Fail closed on malformed/stale transport results; navigation identities never come from coercion. */
export function decodeOperationalOverview(value: unknown, expectedDay: string | null, lane: OperationalLane): OperationalOverview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as OperationalOverview;
  if (typeof data.day !== "string" || !isOperationalDay(data.day) || (expectedDay !== null && data.day !== expectedDay)
    || data.lane !== lane || typeof data.timeZone !== "string" || !Array.isArray(data.sections)) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: data.timeZone }); } catch { return null; }
  const expected = lane === "all" ? ["appointments", "referrals"] : [lane === "reception" ? "appointments" : "referrals"];
  if (data.sections.length !== expected.length) return null;
  const id = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 2147483647;
  const instant = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  for (const [index, section] of data.sections.entries()) {
    if (!section || section.source !== expected[index]) return null;
    if (section.status === "error") {
      if (section.total !== null || section.asOf !== null || typeof section.message !== "string") return null;
      continue;
    }
    if (section.status !== "ready" || !instant(section.asOf) || !count(section.total) || !count(section.page)
      || section.page > Math.max(0, Math.ceil(section.total / OPERATIONAL_PAGE_SIZE) - 1)
      || section.hasMore !== ((section.page + 1) * OPERATIONAL_PAGE_SIZE < section.total)
      || !Array.isArray(section.items) || section.items.length !== Math.min(OPERATIONAL_PAGE_SIZE, section.total - section.page * OPERATIONAL_PAGE_SIZE)) return null;
    const seen = new Set<number>();
    for (const item of section.items) {
      if (!item || !id(item.id) || seen.has(item.id) || !id(item.patientId) || typeof item.patientName !== "string"
        || typeof item.patientNumber !== "string" || typeof item.status !== "string" || typeof item.eventAt !== "string"
        || !(item.plannedVisitId === null || id(item.plannedVisitId)) || !(item.reviewDoctor === null || typeof item.reviewDoctor === "string")) return null;
      seen.add(item.id);
      if (section.source === "appointments") {
        if (!["no_show", "cancelled"].includes(item.status) || !["needs_review", "history_review", "replacement_active", "replacement_finished", "replacement_terminal"].includes(item.state)
          || !/^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d$/.test(item.eventAt)) return null;
      } else if (item.status !== "completed" || item.state !== "awaiting_referrer" || !instant(item.eventAt) || item.replacement !== null) return null;
      if (item.state.startsWith("replacement_") && item.replacement === null) return null;
      if (item.replacement !== null) {
        const proof = item.replacement;
        if (!proof || !id(proof.id) || !isOperationalDay(proof.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(proof.time)
          || typeof proof.status !== "string" || !/^[1-9]\d*$/.test(proof.auditId) || !instant(proof.recordedAt)) return null;
      }
    }
  }
  return data;
}
