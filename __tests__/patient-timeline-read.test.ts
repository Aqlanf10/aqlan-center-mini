import { describe, expect, it } from "vitest";
import { patientTimelineSources, projectPatientTimeline, readPatientTimeline, timelineGroups, type PatientTimelineSources } from "../lib/patient-timeline-read";
import type { TimelineEvent, TimelineKind } from "../lib/workflow";

const all: PatientTimelineSources = { plans: true, documents: true, financial: true, appointments: "all" };
const clinicalKinds: TimelineKind[] = ["visit", "ortho", "diagnosis", "referral", "lab"];
const event = (kind: TimelineKind, id = 1): TimelineEvent => ({ key: `${kind}:${id}`, kind, at: "2026-10-01T09:00:00Z",
  title: `SENTINEL_${kind}`, detail: `${kind}_detail`, amountMinor: kind === "invoice" || kind === "payment" ? 123456 : null,
  currency: kind === "invoice" || kind === "payment" ? "USD" : null,
  href: kind === "visit" ? `/visits/${id}/clinical` : kind === "lab" ? "/lab" : kind === "document" ? "/patients/91?tab=files"
    : kind === "invoice" || kind === "payment" ? "/patients/91?tab=account" : kind === "appointment" ? "/patients/91?tab=summary" : "/patients/91?tab=treatment",
});
const payload = (events: TimelineEvent[] = [], sources = all) => ({ patientId: 91, events, sources, canSeeFinancial: sources.financial });

describe("patient timeline source contract", () => {
  it.each([false, true])("preserves clinical history with plans=%s and every other optional source denied", (plans) => {
    const sources = { ...all, plans, documents: false, financial: false, appointments: "hidden" as const };
    const events = [...clinicalKinds, "plan", "document", "invoice", "payment", "appointment"].map((kind) => event(kind as TimelineKind));
    const result = projectPatientTimeline(events, 91, sources);
    expect(result.map((row) => row.kind)).toEqual([...clinicalKinds, ...(plans ? ["plan"] : [])]);
    for (const kind of clinicalKinds) expect(result.find((row) => row.kind === kind)).toEqual(event(kind));
    for (const hidden of ["SENTINEL_document", "SENTINEL_invoice", "SENTINEL_payment", "SENTINEL_appointment", "123456", "tab=account", "tab=files"])
      expect(JSON.stringify(result)).not.toContain(hidden);
    expect(timelineGroups(sources)).toEqual(["all", "clinical", "lab"]);
  });
  it("uses canonical appointment visibility without hidden counts", () => {
    const scope = { kind: "doctor" as const, doctorPartyId: 7, ownedPatientIds: new Set<number>() };
    expect(patientTimelineSources({ plans: false, documents: false, financial: false, appointments: scope }, 91))
      .toEqual({ plans: false, documents: false, financial: false, appointments: "scoped" });
    scope.ownedPatientIds.add(91);
    expect(patientTimelineSources({ plans: true, documents: true, financial: false, appointments: scope }, 91).appointments).toBe("all");
  });
  it("accepts an explicitly scoped empty read without claiming complete history", () => {
    const result = readPatientTimeline(payload([], { ...all, appointments: "scoped" }), 91);
    expect(result?.sources.appointments).toBe("scoped"); expect(result?.events).toEqual([]);
    expect(Object.keys(result!.sources)).toEqual(["plans", "documents", "financial", "appointments"]);
  });
  it.each([undefined, null, {}, { events: [] }, { events: [], canSeeFinancial: true }, payload([], { ...all, appointments: "unknown" } as never),
    { ...payload(), patientId: 92 }, { ...payload(), canSeeFinancial: false }, { ...payload(), events: "bad" },
    payload([{ ...event("visit"), at: "invalid" }]), payload([{ ...event("visit"), amountMinor: 1 }]), payload([{ ...event("visit"), key: "payment:1" }]),
    payload([event("visit"), event("visit")]), payload([event("invoice")], { ...all, financial: false }),
  ])("fails closed for malformed, legacy, cross-patient, or contradictory payload %#", (value) => {
    expect(readPatientTimeline(value, 91)).toBeNull();
  });
  it.each(["javascript:alert(1)", "https://evil.invalid", "/patients/92?tab=account", "/patients/91?tab=account", "/patients/91?tab=files", "/patients/91?tab=treatment&sub=plans"])(
    "suppresses a substituted clinical source URL %s", (href) => {
      expect(readPatientTimeline(payload([{ ...event("visit"), href }]), 91)?.events[0].href).toBeNull();
    });
  it.each(["YER", "SAR", "USD", "UNKNOWN", "", "usd", " SAR ", null, undefined, 1])("preserves saved or explicitly unknown unit %s", (currency) => {
    const result = readPatientTimeline(payload([{ ...event("invoice"), currency } as TimelineEvent]), 91);
    expect(result?.events[0].amountMinor).toBe(123456);
    expect(result?.events[0].currency).toBe(typeof currency === "string" ? currency : null);
  });
  it("retains clinical referral scheduled progression when all calendar rows are hidden", () => {
    const row = { ...event("referral"), title: "إحالة: حُجزت", detail: "SYNTHETIC clinical progression" };
    expect(readPatientTimeline(payload([row], { ...all, appointments: "hidden" }), 91)?.events).toEqual([row]);
  });
});
