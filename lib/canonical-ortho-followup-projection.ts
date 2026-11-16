import { BUCKET_ORDER, type FollowupBucket, type NextAppointmentInfo } from "./ortho-followup";

export interface CanonicalOrthoFollowupRow {
  caseId: number; patientId: number; patientName: string; status: "active" | "retention"; phase: string;
  startDate: string; lastAdjustmentDate: string | null; nextWeeks: number; dueDate: string | null; daysSinceLast: number;
  buckets: FollowupBucket[];
  schedule: null | {
    nextAppointment: NextAppointmentInfo | null; pastUnresolvedAppointment: NextAppointmentInfo | null;
    reviewAppointments: NextAppointmentInfo[]; otherAppointments: NextAppointmentInfo[]; hasRecordedNoShow: boolean;
  };
}
export interface CanonicalOrthoFollowups {
  projection: "ortho-followups"; today: string; appointmentCoverage: "none" | "own" | "all";
  hasMore: boolean; rows: CanonicalOrthoFollowupRow[];
}
export const CLINICAL_FOLLOWUP_BUCKETS: readonly FollowupBucket[] = ["lapsed_4", "lapsed_6", "lapsed_8", "retention"];
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
function appointment(v: NextAppointmentInfo): boolean {
  return !!v && id(v.id) && date(v.date) && /^\d{2}:\d{2}$/.test(v.time) && ["booked", "arrived"].includes(v.status)
    && [v.serviceName, v.doctorName, v.appointmentType].every(t => t === null || typeof t === "string")
    && [null, "designated_service", "legacy_type", "planned_case_sessions"].includes(v.matchBasis ?? null) && typeof v.reason === "string";
}
export function isCanonicalOrthoFollowups(v: unknown): v is CanonicalOrthoFollowups {
  if (!v || typeof v !== "object") return false;
  const b = v as CanonicalOrthoFollowups, seen = new Set<number>();
  if (b.projection !== "ortho-followups" || !date(b.today) || !["none", "own", "all"].includes(b.appointmentCoverage)
    || typeof b.hasMore !== "boolean" || !Array.isArray(b.rows) || b.rows.length > 300) return false;
  return b.rows.every(r => {
    if (!r || !id(r.caseId) || seen.has(r.caseId) || !id(r.patientId) || typeof r.patientName !== "string"
      || !["active", "retention"].includes(r.status) || typeof r.phase !== "string" || !date(r.startDate) || r.dueDate !== null && !date(r.dueDate)
      || r.lastAdjustmentDate !== null && !date(r.lastAdjustmentDate) || !id(r.nextWeeks) || !Number.isSafeInteger(r.daysSinceLast)
      || !Array.isArray(r.buckets) || new Set(r.buckets).size !== r.buckets.length || r.buckets.some(x => !BUCKET_ORDER.includes(x))) return false;
    seen.add(r.caseId);
    if (b.appointmentCoverage === "none") return r.schedule === null && r.buckets.every(x => CLINICAL_FOLLOWUP_BUCKETS.includes(x));
    if (b.appointmentCoverage === "own" && r.buckets.includes("no_appointment")) return false;
    const s = r.schedule;
    return !!s && typeof s.hasRecordedNoShow === "boolean" && (s.nextAppointment === null || appointment(s.nextAppointment))
      && (s.pastUnresolvedAppointment === null || appointment(s.pastUnresolvedAppointment))
      && Array.isArray(s.reviewAppointments) && Array.isArray(s.otherAppointments)
      && s.reviewAppointments.length + s.otherAppointments.length <= 2000
      && s.reviewAppointments.every(appointment) && s.otherAppointments.every(appointment);
  });
}
