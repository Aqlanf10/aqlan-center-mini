import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectReferralAppointmentMetadata } from "../lib/referral-appointment-read";
import type { AppointmentReadScope } from "../lib/appointment-read-scope";
import type { Referral } from "../lib/referrals";

// Authored only: patient-linked synthetic referral/appointment values. No visits,
// database, HTTP server, browser, credentials, or external network are involved.
const referral: Referral = {
  id: 41, patientId: 91, kind: "internal", toName: "Synthetic receiver", toSpecialty: "endodontics",
  reason: "Synthetic referral reason", teeth: "16", urgency: "routine", status: "sent",
  outcomeNote: "Synthetic preserved outcome", doctorPartyId: 7, doctorName: "Synthetic referrer",
  createdBy: "synthetic-referrer", createdAt: "2026-10-03T08:00:00Z", closedBy: null, closedAt: null,
  toPartyId: 8, workflowState: "accepted", caseId: 22, caseTitle: "Synthetic clinical case",
  blocksCaseId: null, planItemId: 23, requestedServiceId: 24, returnToPartyId: 7,
  appointmentId: 301, appointmentDate: "2026-10-04 09:00", acceptedAt: null, completedBy: null,
  completedAt: null, returnedAt: null, procedurePerformed: "Synthetic preserved procedure",
  followupRequired: true, mayReturn: true, missedAppointment: "no_show",
};
const scoped: AppointmentReadScope = { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set() };
const current = { id: 301, patientId: 91, doctorId: 8 };
const last = { id: 302, patientId: 91, doctorId: 8 };
const withoutCalendar = (value: Referral) => {
  const { appointmentId, appointmentDate, missedAppointment, appointmentVisibility, ...clinical } = value;
  void appointmentId; void appointmentDate; void missedAppointment; void appointmentVisibility;
  return clinical;
};

describe("referral appointment response projection", () => {
  it("hides another provider's appointment without removing referral clinical or workflow state", () => {
    const projected = projectReferralAppointmentMetadata(referral, scoped, { current, last });
    expect(projected).toMatchObject({ appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "scoped" });
    expect(withoutCalendar(projected)).toEqual(withoutCalendar(referral));
    expect(referral.appointmentId).toBe(301);
    expect(referral.missedAppointment).toBe("no_show");
  });

  it.each([null, 7])("preserves the canonical unassigned/own-provider exception for %s", (doctorId) => {
    const projected = projectReferralAppointmentMetadata(referral, scoped, {
      current: { ...current, doctorId }, last: { ...last, doctorId },
    });
    expect(projected).toEqual({ ...referral, appointmentVisibility: "scoped" });
  });

  it("uses the appointment's actual provider, never the referral recipient or referrer", () => {
    const projected = projectReferralAppointmentMetadata({ ...referral, toPartyId: 7 }, scoped, { current, last });
    expect(projected.appointmentId).toBeNull();
    expect(projected.missedAppointment).toBeNull();
  });

  it.each([
    { kind: "all" },
    { kind: "doctor", doctorPartyId: 7, ownedPatientIds: new Set([91]) },
  ] as AppointmentReadScope[])("retains full-patient reads under the canonical %o scope", (scope) => {
    expect(projectReferralAppointmentMetadata(referral, scope, { current, last }))
      .toEqual({ ...referral, appointmentVisibility: "all" });
  });

  it("closes all metadata under no-calendar scope, including unassigned appointments", () => {
    const projected = projectReferralAppointmentMetadata(referral, { kind: "none" }, {
      current: { ...current, doctorId: null }, last: { ...last, doctorId: null },
    });
    expect(projected).toMatchObject({ appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "hidden" });
    expect(withoutCalendar(projected)).toEqual(withoutCalendar(referral));
  });

  it("scopes the current and latest joined appointments independently", () => {
    const projected = projectReferralAppointmentMetadata(referral, scoped, {
      current: { ...current, doctorId: 7 }, last,
    });
    expect(projected.appointmentId).toBe(301);
    expect(projected.appointmentDate).toBe("2026-10-04 09:00");
    expect(projected.missedAppointment).toBeNull();
    const reversed = projectReferralAppointmentMetadata(referral, scoped, {
      current, last: { ...last, doctorId: 7 },
    });
    expect(reversed.appointmentId).toBeNull();
    expect(reversed.missedAppointment).toBe("no_show");
  });

  it.each(["current", "last"] as const)("does not expose a wrong-patient %s link even to a full reader", (field) => {
    const projected = projectReferralAppointmentMetadata(referral, { kind: "all" }, {
      current, last, [field]: { ...(field === "current" ? current : last), patientId: 92 },
    });
    expect(projected).toMatchObject({ appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "unknown" });
    expect(withoutCalendar(projected)).toEqual(withoutCalendar(referral));
  });

  it("fails closed when the current appointment reference cannot substantiate the selected metadata", () => {
    expect(projectReferralAppointmentMetadata(referral, { kind: "all" }, {
      current: { ...current, id: 999 }, last,
    })).toMatchObject({ appointmentId: null, appointmentDate: null, missedAppointment: null, appointmentVisibility: "unknown" });
  });

  it("keeps deleted-appointment audit evidence only for a full-patient calendar reader", () => {
    const auditReferral = { ...referral, appointmentId: null, appointmentDate: null };
    expect(projectReferralAppointmentMetadata(auditReferral, scoped, { current: null, last: null }))
      .toMatchObject({ missedAppointment: null, appointmentVisibility: "scoped" });
    expect(projectReferralAppointmentMetadata(auditReferral, { kind: "all" }, { current: null, last: null }))
      .toMatchObject({ missedAppointment: "no_show", appointmentVisibility: "all" });
  });
});

describe("database projection source contract", () => {
  it("carries each joined appointment's real identity into the read-only projection", () => {
    const source = readFileSync("lib/db.ts", "utf8");
    const select = source.slice(source.indexOf("const REFERRAL_SELECT ="), source.indexOf("function toReferral("));
    expect(select).toContain("a.patient_id AS appointment_patient_id, a.doctor_id AS appointment_doctor_id");
    expect(select).toContain("last_a.id AS last_appointment_id, last_a.patient_id AS last_appointment_patient_id");
    expect(select).toContain("last_a.doctor_id AS last_appointment_doctor_id");
    const scopedRead = source.slice(source.indexOf("export async function listPatientReferralsForRead("), source.indexOf("export async function getReferral("));
    expect(scopedRead).toContain("appointmentScope: AppointmentReadScope");
    expect(scopedRead).toContain("projectReferralAppointmentMetadata(");
    expect(scopedRead).toContain("patientId: row.appointment_patient_id, doctorId: row.appointment_doctor_id");
    expect(scopedRead).toContain("patientId: row.last_appointment_patient_id, doctorId: row.last_appointment_doctor_id");
    expect(scopedRead).not.toMatch(/UPDATE |INSERT |DELETE /);
    const mapper = source.slice(source.indexOf("function toReferral("), source.indexOf("async function patientReferralRows("));
    expect(mapper).not.toContain("appointment_patient_id");
    expect(mapper).not.toContain("appointment_doctor_id");
  });
});
