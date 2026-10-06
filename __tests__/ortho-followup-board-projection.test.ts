import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectFollowupBookings, type ProjectedFollowupBooking } from "../lib/ortho-followup-board";

const target = { patientId: 10, orthoCaseId: 41, clinicalCaseId: 51, startDate: "2026-01-01" };
const appointment = (changes: Partial<ProjectedFollowupBooking> = {}): ProjectedFollowupBooking => ({
  id: 101, patientId: 10, scheduledDate: "2026-10-08", scheduledTime: "10:30", status: "booked",
  serviceId: 7, service: { id: 7, code: "ORTHO_FOLLOW_UP", specialty: "orthodontics", legacyType: "follow_up" },
  serviceName: "متابعة تقويم مسجلة", doctorName: "الطبيب المسند", appointmentType: "follow_up",
  referralId: null, referral: null, plannedVisitId: null, ...changes,
});
const project = (appointments: readonly ProjectedFollowupBooking[]) => projectFollowupBookings({ target, today: "2026-10-05", appointments });

describe("read-only follow-up DTO projection", () => {
  it("classifies all candidates and keeps the actual service/doctor for another earlier booking", () => {
    const result = project([
      appointment({ id: 102, scheduledDate: "2026-10-06", appointmentType: "endo", serviceName: "علاج جذور", doctorName: "طبيب العصب",
        service: { id: 7, code: "ROOT_CANAL", specialty: "endodontics", legacyType: "endo" } }), appointment(),
    ]);
    expect(result.nextAppointment).toMatchObject({ id: 101, date: "2026-10-08", time: "10:30", status: "booked", matchBasis: "designated_service" });
    expect(result.bookingContext.otherAppointments).toEqual([expect.objectContaining({
      id: 102, date: "2026-10-06", serviceName: "علاج جذور", doctorName: "طبيب العصب", status: "booked",
    })]);
  });
  it("keeps unresolved joins visible rather than dropping the appointment", () => {
    const result = project([appointment({ referralId: 62, referral: null, doctorName: null })]);
    expect(result.nextAppointment).toBeNull();
    expect(result.bookingContext.reviewAppointments).toEqual([expect.objectContaining({ id: 101, reason: "unresolved_referral", doctorName: null })]);
  });
  it("does not publish raw referral/case metadata or a different patient's display values", () => {
    const result = project([appointment(), appointment({ id: 201, patientId: 20, doctorName: "Foreign secret name", serviceName: "Foreign service" })]);
    expect(JSON.stringify(result)).not.toContain("Foreign");
    expect(result.nextAppointment).not.toHaveProperty("referral");
    expect(result.nextAppointment).not.toHaveProperty("patientId");
  });
  it("preserves arrived status and puts past unresolved in its own field", () => {
    const result = project([appointment({ status: "arrived", scheduledDate: "2026-10-05" }), appointment({ id: 99, scheduledDate: "2026-10-04" })]);
    expect(result.nextAppointment).toMatchObject({ id: 101, status: "arrived", date: "2026-10-05" });
    expect(result.bookingContext.pastUnresolvedAppointment).toMatchObject({ id: 99, date: "2026-10-04" });
  });
  it("preserves the legacy evidence label with no invented service or clinician", () => {
    const result = project([appointment({ serviceId: null, service: null, serviceName: null, doctorName: null })]);
    expect(result.nextAppointment).toMatchObject({ matchBasis: "legacy_type", serviceName: null, doctorName: null });
  });
  it("distinguishes an explicit empty projection from a missing projection", () => {
    expect(project([])).toEqual({ nextAppointment: null, bookingContext: { verified: true, pastUnresolvedAppointment: null, reviewAppointments: [], otherAppointments: [] } });
    expect(() => project(undefined as unknown as ProjectedFollowupBooking[])).toThrow("Booking projection is required");
  });
});

describe("board query source contract (not a substitute for real PostgreSQL)", () => {
  const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  const board = source.slice(source.indexOf("export async function orthoFollowupBoard("), source.indexOf("/** Read projection only: suppress inconsistent legacy links"));
  it("projects every open candidate using same-patient LEFT joins", () => {
    expect(board).toContain("LEFT JOIN clinical_cases bridge ON bridge.ortho_case_id = c.id AND bridge.patient_id = c.patient_id");
    expect(board).toContain("LEFT JOIN patient_referrals r ON r.id = ap.referral_id AND r.patient_id = ap.patient_id");
    expect(board).toContain("LEFT JOIN clinical_cases rc ON rc.id = r.case_id AND rc.patient_id = ap.patient_id");
    expect(board).toContain("LEFT JOIN ortho_cases linked_ortho ON linked_ortho.id = rc.ortho_case_id AND linked_ortho.patient_id = ap.patient_id");
    expect(board).toContain("WHERE ap.status IN ('booked', 'arrived')");
    expect(board).toContain("GROUP BY ap.patient_id");
    expect(board).toContain("LEFT JOIN bookings ON bookings.patient_id = c.patient_id");
    expect(board).toContain("appointments: row.bookings");
    expect(board).not.toContain("ROW_NUMBER");
    expect(board).not.toContain("nearest.rn");
    expect(board).toContain("bookings AS (");
    const candidateQuery = board.slice(board.indexOf("bookings AS ("), board.indexOf("SELECT c.id AS case_id"));
    expect(candidateQuery.match(/FROM appointments ap/g)).toHaveLength(1);
    expect(candidateQuery).not.toContain("LATERAL");
    expect(candidateQuery).not.toContain("LIMIT");
    expect(candidateQuery).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  });
  it("retains historical no-show semantics independently of future bookings", () => {
    expect(board).toContain("WHERE a.status = 'no_show'");
    expect(board).toContain("WHERE a2.patient_id = a.patient_id AND a2.status = 'no_show'");
    expect(board).toContain("ORDER BY a2.scheduled_date DESC, a2.id DESC LIMIT 1");
    expect(board).toContain("lastWasNoShow: row.last_no_show");
  });
});
