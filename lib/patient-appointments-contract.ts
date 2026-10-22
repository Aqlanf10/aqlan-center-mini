import type { Appointment } from "./schedule";
import { isKnownZone } from "./clinicZone";

export const PATIENT_APPOINTMENTS_PAGE_SIZE = 20;
export type PatientAppointmentsView = "upcoming" | "history";
export interface PatientAppointmentsCursor {
  patientId: number;
  view: PatientAppointmentsView;
  today: string;
  date: string;
  time: string;
  id: number;
}
export interface PatientAppointmentsQuery {
  view: PatientAppointmentsView;
  cursor: PatientAppointmentsCursor | null;
  requestCursor: string | null;
}
export interface PatientAppointmentsPage {
  patientId: number;
  view: PatientAppointmentsView;
  requestCursor: string | null;
  today: string;
  timeZone: string;
  generatedAt: string;
  canRemind: boolean;
  appointments: Appointment[];
  nextCursor: string | null;
}

export function patientAppointmentId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}
export function validAppointmentDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1000-01-01") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const validTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validCursorTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}$/.test(value);
export function encodePatientAppointmentsCursor(cursor: PatientAppointmentsCursor): string {
  return ["1", cursor.patientId, cursor.view, cursor.today, cursor.date, cursor.time, cursor.id].join("|");
}
export function readPatientAppointmentsCursor(raw: string, patientId: number, view: PatientAppointmentsView): PatientAppointmentsCursor | null {
  if (raw.length > 150) return null;
  const parts = raw.split("|");
  if (parts.length !== 7 || parts[0] !== "1" || patientAppointmentId(parts[1]) !== patientId || parts[2] !== view
    || !validAppointmentDate(parts[3]) || !validAppointmentDate(parts[4]) || !validCursorTime(parts[5])) return null;
  const id = patientAppointmentId(parts[6]);
  return id ? { patientId, view, today: parts[3], date: parts[4], time: parts[5], id } : null;
}
export function readPatientAppointmentsQuery(params: URLSearchParams, patientId: number): PatientAppointmentsQuery | null {
  if ([...params.keys()].some(key => key !== "view" && key !== "cursor") || params.getAll("view").length > 1 || params.getAll("cursor").length > 1) return null;
  const view = params.get("view") ?? "upcoming";
  if (view !== "upcoming" && view !== "history") return null;
  const requestCursor = params.get("cursor");
  const cursor = requestCursor === null ? null : readPatientAppointmentsCursor(requestCursor, patientId, view);
  if (requestCursor !== null && !cursor) return null;
  return { view, cursor, requestCursor };
}
export function canRemindPatientRole(role: string | undefined): boolean {
  return role === "admin" || role === "reception" || role === "doctor";
}
const nullableString = (value: unknown) => value === null || typeof value === "string";
const validId = (value: unknown) => typeof value === "number" && patientAppointmentId(String(value)) === value;
const validTimestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  && validAppointmentDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const validStamp = (value: unknown) => value === null || validTimestamp(value);

/** A malformed or mismatched response is unknown, never an empty successful list. */
export function readPatientAppointmentsPage(value: unknown, patientId: number, view: PatientAppointmentsView, requestCursor: string | null): PatientAppointmentsPage | null {
  if (!value || typeof value !== "object") return null;
  const page = value as PatientAppointmentsPage;
  if (page.patientId !== patientId || page.view !== view || page.requestCursor !== requestCursor || !validAppointmentDate(page.today)
    || typeof page.timeZone !== "string" || !isKnownZone(page.timeZone) || !validTimestamp(page.generatedAt)
    || typeof page.canRemind !== "boolean" || !Array.isArray(page.appointments) || page.appointments.length > PATIENT_APPOINTMENTS_PAGE_SIZE
    || !(page.nextCursor === null || typeof page.nextCursor === "string")) return null;
  const cursor = requestCursor === null ? null : readPatientAppointmentsCursor(requestCursor, patientId, view);
  if (requestCursor !== null && (!cursor || cursor.today !== page.today)) return null;
  const next = page.nextCursor === null ? null : readPatientAppointmentsCursor(page.nextCursor, patientId, view);
  if (page.nextCursor !== null && (!next || next.today !== page.today || page.appointments.length !== PATIENT_APPOINTMENTS_PAGE_SIZE || page.nextCursor === requestCursor)) return null;
  const seen = new Set<number>();
  for (const item of page.appointments) {
    if (!item || !validId(item.id) || seen.has(item.id) || item.patientId !== patientId || typeof item.patientName !== "string" || !item.patientName.trim() || item.patientName.length > 500
      || !nullableString(item.patientPhone) || (typeof item.patientPhone === "string" && item.patientPhone.length > 100) || !validAppointmentDate(item.scheduledDate) || !validTime(item.scheduledTime)
      || !Number.isSafeInteger(item.durationMinutes) || item.durationMinutes < 1 || item.durationMinutes > 1440
      || !["booked", "arrived", "done", "cancelled", "no_show"].includes(item.status)
      || !nullableString(item.doctorName) || !(item.doctorId === null || validId(item.doctorId))
      || !nullableString(item.cancelReason) || !validStamp(item.reminderSentAt) || item.note !== null) return null;
    const upcoming = (item.status === "booked" || item.status === "arrived") && item.scheduledDate >= page.today;
    if (upcoming !== (view === "upcoming")) return null;
    seen.add(item.id);
  }
  const last = page.appointments.at(-1);
  if (next && (!last || next.id !== last.id || next.date !== last.scheduledDate || next.time.slice(0, 5) !== last.scheduledTime)) return null;
  return page;
}
