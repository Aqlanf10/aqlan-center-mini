import { describe, expect, it } from "vitest";
import { legacyConsentIsCurrent, legacyCoverageLabel, planConsentIsCurrent, readLegacyCoverageSite, hasLegacyHistory, legacyCoverageIsLive, ordinaryPlanProgress, readLegacyAgreements, readLegacyCases } from "../components/legacy-treatment-view";
import { planItemsProgress, planLedgerSummary, unlinkedSessionConflicts, type PlanItemLike } from "../lib/plans";
import { legacyCoverageStateFromSnapshot, type LegacyCoverageSnapshotRow } from "../lib/legacy-treatment-coverage";

function verifiedCoverage(patch: Partial<LegacyCoverageSnapshotRow> = {}) {
  const snapshot: LegacyCoverageSnapshotRow = { agreement_id: 5, format_version: 1, service_id: 7,
    service_category: "rct", anchor_tooth_code: 36, snapshot_mode: "per_tooth_episode",
    snapshot_tooth_codes: [36], snapshot_scope: null, snapshot_surfaces: null,
    recorded_by: "synthetic-owner", recorded_at: "2026-10-07T12:00:00Z", ...patch };
  const coverage = legacyCoverageStateFromSnapshot(snapshot, { agreementId: snapshot.agreement_id,
    serviceId: snapshot.service_id, anchorToothCode: snapshot.anchor_tooth_code });
  if (coverage.kind !== "verified") throw new Error("Invalid verified coverage fixture");
  return coverage;
}

const legacy = { id: 1, serviceId: 7, toothCode: 36, quantity: 1, unitPriceMinor: 300_000,
  totalMinor: 300_000, status: "planned", legacyAgreementId: 5, legacyAgreementStatus: "live",
  billingStatus: "included_in_package", legacyCoverageState: "verified",
  legacyCoverageSite: { mode: "per_tooth_episode", toothCode: 36, surfaces: null, episodeTeeth: null, scope: null },
  legacyCurrentConsentRequired: false } satisfies PlanItemLike;
const ordinary = [
  { id: 2, serviceId: 8, toothCode: 26, quantity: 1, unitPriceMinor: 40_000, status: "planned" },
  { id: 3, serviceId: 8, toothCode: 16, quantity: 1, unitPriceMinor: 20_000, status: "done" },
] satisfies PlanItemLike[];

describe("historical provenance is not clinical progress or payment authority", () => {
  it.each(["live", "void"] as const)("keeps a %s 300,000 agreement out of ordinary remaining-work totals", (status) => {
    const history = { ...legacy, legacyAgreementStatus: status };
    expect(hasLegacyHistory(history)).toBe(true);
    expect(ordinaryPlanProgress([history, ...ordinary])).toEqual({ count: 2, doneCount: 1,
      totalMinor: 60_000, doneMinor: 20_000, remainingMinor: 40_000 });
    expect(ordinaryPlanProgress([history]).remainingMinor).toBe(0);
  });
  it("requires live verified immutable coverage and included classification before saying covered", () => {
    expect(legacyCoverageIsLive(legacy)).toBe(true);
    expect(legacyCoverageIsLive({ ...legacy, legacyAgreementStatus: "void" })).toBe(false);
    expect(legacyCoverageIsLive({ ...legacy, legacyAgreementStatus: undefined })).toBe(false);
    expect(legacyCoverageIsLive({ ...legacy, billingStatus: "needs_financial_review" })).toBe(false);
    expect(legacyCoverageIsLive({ ...legacy, legacyAgreementId: -1 })).toBe(false);
    expect(legacyCoverageIsLive({ ...legacy, legacyCoverageState: undefined })).toBe(false);
    expect(legacyCoverageIsLive({ ...legacy, legacyCoverageState: "unknown" })).toBe(false);
    expect(legacyCoverageIsLive({ ...legacy, legacyCoverageState: "conflict" })).toBe(false);
    expect(legacyCoverageIsLive({ ...legacy, legacyCoverageSite: null })).toBe(false);
  });
  it("retains contract identity and compatibility summary while adding a separate ordinary projection", () => {
    const items = [{ ...legacy, legacyAgreementStatus: "void" as const }, ...ordinary];
    const summary = planLedgerSummary({ id: 9, title: "Mixed canonical master", status: "active",
      totalMinor: 360_000, baseCurrency: "YER", consentAt: null, installments: [], items,
      progress: { totalMinor: 360_000, dueToDateMinor: 0, paidMinor: 0, remainingMinor: 360_000,
        overdueMinor: 0, nextDueDate: null, nextDueAmountMinor: 0, paidCount: 0, count: 0 },
      itemsProgress: planItemsProgress(items) });
    expect(summary).toMatchObject({ totalMinor: 360_000, consented: false, legacy: true, legacyItemCount: 1,
      ordinaryItemsProgress: { count: 2, doneCount: 1, doneMinor: 20_000, remainingMinor: 40_000 } });
    expect(summary.items?.remainingMinor).toBe(340_000); // compatibility only; UI must not label this historical progress.
  });
  it.each(["planned", "done", "cancelled"])("keeps %s historical single-session work out of free-procedure rebilling", (status) => {
    const item = { id: 1, serviceId: 7, serviceName: "Historical root canal", toothCode: 36,
      status, sessionCount: 1, doneSessions: 0, billingStatus: "included_in_package" as const,
      hasLegacyLineage: true, legacyCoverage: verifiedCoverage() };
    expect(unlinkedSessionConflicts([item], [{ serviceId: 7, toothCode: 36 }])).toHaveLength(1);
    expect(unlinkedSessionConflicts([{ ...item, hasLegacyLineage: false, hasInvoiceLineage: true }],
      [{ serviceId: 7, toothCode: 36 }])).toHaveLength(1);
    expect(unlinkedSessionConflicts([item], [{ serviceId: 7, toothCode: 26 }])).toEqual([]);
  });
  it("protects a scoped historical parent without pretending it has invoice lineage", () => {
    const item = { id: 1, serviceId: 7, serviceName: "Historical upper arch", toothCode: null,
      caseSite: "upper", status: "planned", sessionCount: 1, doneSessions: 0, hasLegacyLineage: true,
      legacyCoverage: verifiedCoverage({ service_category: "ortho", anchor_tooth_code: null,
        snapshot_mode: "arch", snapshot_tooth_codes: [], snapshot_scope: "upper" }) };
    expect(unlinkedSessionConflicts([item], [{ serviceId: 7, toothCode: 16 }])).toHaveLength(1);
    expect(unlinkedSessionConflicts([item], [{ serviceId: 7, toothCode: 36 }])).toEqual([]);
  });
  it.each([undefined, { kind: "unknown", reason: "missing_snapshot" },
    { kind: "conflict", reason: "identity_mismatch" }] as const)("holds same-service work with unavailable coverage %j", (legacyCoverage) => {
    for (const shape of [{ toothCode: 36, caseSite: "36" }, { toothCode: null, caseSite: "upper" }]) {
      const item = { id: 1, serviceId: 7, serviceName: "Historical work", ...shape, status: "planned",
        sessionCount: 1, doneSessions: 0, hasLegacyLineage: true, legacyCoverage };
      // Mutable anchors and arch labels cannot prove disjointness without an immutable snapshot.
      for (const toothCode of [16, 26, 36, 46]) {
        expect(unlinkedSessionConflicts([item], [{ serviceId: 7, toothCode }])).toHaveLength(1);
      }
      expect(unlinkedSessionConflicts([item], [{ serviceId: 8, toothCode: 36 }])).toEqual([]);
    }
  });
});

const agreement = { id: 5, patientId: 7, serviceName: "Historical root canal", specialtyLabel: "علاج جذور",
  toothCode: 36, caseTitle: "Historical case", currency: "YER", agreedMinor: 300_000,
  previouslyPaidMinor: 120_000, remainingMinor: 180_000, historicalAsOf: "2026-09-30",
  openingEffect: "created", status: "live", createdBy: "admin", voidReason: null };
const payload = { agreements: [agreement], access: { void: true } };

describe("legacy read validation", () => {
  it("reads exact historical facts and server-owned mutation authority", () => {
    expect(readLegacyAgreements(payload, 7)).toMatchObject({ agreements: [agreement], canVoid: true });
    expect(readLegacyAgreements({ ...payload, access: { void: false } }, 7)?.canVoid).toBe(false);
  });
  it.each([
    { patientId: 8 }, { currency: "invalid" }, { remainingMinor: 300_000 }, { remainingMinor: "180000" },
    { agreedMinor: Number.POSITIVE_INFINITY }, { status: "released" }, { id: null }, { createdBy: null },
  ])("rejects %j without currency fallback, coercion, or cross-patient display", (patch) => {
    expect(readLegacyAgreements({ ...payload, agreements: [{ ...agreement, ...patch }] }, 7)).toBeNull();
  });
  it("rejects omitted authority and duplicate rows", () => {
    expect(readLegacyAgreements({ agreements: [agreement] }, 7)).toBeNull();
    expect(readLegacyAgreements({ ...payload, agreements: [agreement, agreement] }, 7)).toBeNull();
  });
  it("accepts the real null-ID ortho projection and rejects foreign/malformed case rows", () => {
    const history = { id: 12, kind: "specialty", orthoCaseId: null, patientId: 7, specialty: "endodontics",
      title: "Historical case", site: "36", legacy: true, status: "active" };
    const ortho = { id: null, kind: "ortho", orthoCaseId: 91, patientId: 7, specialty: "orthodontics",
      title: "Unbridged ortho", site: null, status: "active" };
    expect(readLegacyCases({ cases: [ortho, history] }, 7, "endodontics"))
      .toEqual([{ key: "case-12", title: history.title, site: "36" }]);
    expect(readLegacyCases({ cases: [{ ...ortho, patientId: 8 }, history] }, 7, "endodontics")).toBeNull();
    expect(readLegacyCases({ cases: [{ ...history, legacy: "true" }] }, 7, "endodontics")).toBeNull();
    expect(readLegacyCases({ cases: [history, history] }, 7, "endodontics")).toBeNull();
  });
});

const episode = { mode: "multi_tooth_episode" as const, toothCode: 14, surfaces: null, episodeTeeth: [14, 15, 16], scope: null };
describe("immutable coverage and current consent projections", () => {
  it("reads the full normalized episode, surfaces and scope without using an anchor/title fallback", () => {
    expect(readLegacyCoverageSite(episode)).toEqual(episode);
    expect(legacyCoverageLabel(episode)).toBe("أسنان الحلقة: 14، 15، 16");
    const surfaces = { mode: "tooth_surfaces" as const, toothCode: 36, surfaces: "MDO", episodeTeeth: null, scope: null };
    expect(readLegacyCoverageSite(surfaces)).toEqual(surfaces);
    expect(legacyCoverageLabel(surfaces)).toBe("سن 36 · الأسطح: MDO");
    const scope = { mode: "arch" as const, toothCode: null, surfaces: null, episodeTeeth: null, scope: "upper" as const };
    expect(readLegacyCoverageSite(scope)).toEqual(scope);
    expect(legacyCoverageLabel(scope)).toBe("الفك العلوي");
  });
  it.each([
    null, {}, { ...episode, mode: "other" }, { ...episode, toothCode: 18 }, { ...episode, toothCode: "14" },
    { ...episode, episodeTeeth: null }, { ...episode, episodeTeeth: [16, 14, 15] },
    { ...episode, episodeTeeth: [14, 14, 15] }, { ...episode, scope: "upper" },
    { ...episode, surfaces: "M" }, { ...episode, episodeTeeth: [14, 19] },
  ])("rejects malformed/non-normalized snapshot %j without repair", (site) => {
    expect(readLegacyCoverageSite(site)).toBeNull();
  });
  it("downgrades omitted old snapshot fields to explicit unknown without changing historical facts", () => {
    const read = readLegacyAgreements(payload, 7)!;
    expect(read.agreements[0]).toMatchObject({ ...agreement, coverageState: "unknown", coverageSite: null });
    expect(agreement).not.toHaveProperty("coverageState");
    expect(readLegacyAgreements({ ...payload, agreements: [{ ...agreement, coverageState: "verified", coverageSite: episode }] }, 7)?.agreements[0].coverageSite).toEqual(episode);
  });
  it.each([
    { coverageState: "verified", coverageSite: null }, { coverageState: "verified", coverageSite: { ...episode, episodeTeeth: [14, 14] } },
    { coverageState: "unknown", coverageSite: episode }, { coverageState: "conflict", coverageSite: episode },
    { coverageState: "old-verified", coverageSite: episode },
  ])("retires read/mutation authority for contradictory coverage %j", (patch) => {
    expect(readLegacyAgreements({ ...payload, agreements: [{ ...agreement, ...patch }] }, 7)).toBeNull();
  });
  it.each(["unknown", "conflict", undefined] as const)("does not treat stored consent as current with %s coverage", (state) => {
    const item = { ...legacy, legacyCoverageState: state, legacyCoverageSite: null, legacyCurrentConsentRequired: true };
    const plan = { consentAt: "2026-09-30T10:00:00Z", items: [item] };
    expect(legacyConsentIsCurrent(item, true)).toBe(false);
    expect(planConsentIsCurrent(plan)).toBe(false);
    expect(plan.consentAt).toBe("2026-09-30T10:00:00Z");
  });
  it("requires the explicit current-consent signal even after a verified snapshot", () => {
    expect(planConsentIsCurrent({ consentAt: null, items: [legacy] })).toBe(false);
    expect(planConsentIsCurrent({ consentAt: "2026-10-01", items: [{ ...legacy, legacyCurrentConsentRequired: true }] })).toBe(false);
    expect(planConsentIsCurrent({ consentAt: "2026-10-01", items: [{ ...legacy, legacyCurrentConsentRequired: undefined }] })).toBe(false);
    expect(planConsentIsCurrent({ consentAt: "2026-10-01", items: [legacy] })).toBe(true);
    expect(planConsentIsCurrent({ consentAt: "2026-10-01", items: [{ ...legacy, legacyAgreementStatus: "void" }] })).toBe(false);
  });
  it.each(["unknown", "conflict", "verified"] as const)("summary preserves original totals while requiring real current consent for %s", (state) => {
    const items = [{ ...legacy, legacyCoverageState: state, legacyCurrentConsentRequired: state !== "verified" }];
    const plan = { id: 9, title: "Historical", status: "active" as const, totalMinor: 300_000, baseCurrency: "YER" as const,
      consentAt: "2026-09-30", installments: [], items, itemsProgress: planItemsProgress(items),
      progress: { totalMinor: 300_000, dueToDateMinor: 0, paidMinor: 0, remainingMinor: 300_000,
        overdueMinor: 0, nextDueDate: null, nextDueAmountMinor: 0, paidCount: 0, count: 0 } };
    expect(planLedgerSummary(plan)).toMatchObject({ totalMinor: 300_000, consented: state === "verified", legacyItemCount: 1,
      ordinaryItemsProgress: { count: 0, doneCount: 0, doneMinor: 0, remainingMinor: 0 } });
    expect(plan.consentAt).toBe("2026-09-30");
  });
});
