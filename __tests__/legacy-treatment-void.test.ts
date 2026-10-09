import { describe, expect, it } from "vitest";
import { parseLegacyVoidPreview, parseLegacyVoidRequest, previewLegacyVoid, type LegacyVoidFinancialFacts } from "../lib/legacy-treatment-void";

const facts: LegacyVoidFinancialFacts = {
  patientId: 7, agreementId: 11, currency: "YER", status: "live", openingPrincipalBeforeMinor: 220000,
  removedPrincipalMinor: 40000, netCollectionsMinor: 50000, financialEvidenceValid: true, periodLocked: false,
};
const expected = { patientId: 7, agreementId: 11, mode: "manager_authorized" as const };
const preview = () => ({ ...previewLegacyVoid(facts, "manager_authorized"), previewToken: "a".repeat(64) });

describe("two-level opening collection policy", () => {
  it("ordinary refuses any net same-currency collection although the manager exception remains covered", () => {
    expect(previewLegacyVoid(facts, "ordinary")).toMatchObject({ canVoid: false, refusal: "opening_collected",
      ordinaryAllowed: false, managerAuthorizedAllowed: true, openingPrincipalAfterMinor: 180000, remainingDueAfterMinor: 130000 });
    expect(previewLegacyVoid(facts, "manager_authorized")).toMatchObject({ canVoid: true, refusal: null });
  });
  it("ordinary also refuses a fully historically paid agreement with no own opening effect", () => {
    expect(previewLegacyVoid({ ...facts, removedPrincipalMinor: 0 }, "ordinary"))
      .toMatchObject({ canVoid: false, refusal: "opening_collected", openingPrincipalAfterMinor: 220000 });
  });
  it("manager exception permits exact cover, but not principal below net collections", () => {
    expect(previewLegacyVoid({ ...facts, removedPrincipalMinor: 170000 }, "manager_authorized"))
      .toMatchObject({ canVoid: true, remainingDueAfterMinor: 0 });
    expect(previewLegacyVoid({ ...facts, removedPrincipalMinor: 180000 }, "manager_authorized"))
      .toMatchObject({ canVoid: false, refusal: "opening_settled" });
  });
  it("ordinary works with no collection or a fully refunded aggregate and preserves the review hold", () => {
    expect(previewLegacyVoid({ ...facts, netCollectionsMinor: 0 }, "ordinary"))
      .toMatchObject({ canVoid: true, ordinaryAllowed: true, managerAuthorizedAllowed: true, financialReviewRequired: true });
  });
  it.each([-1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("fails closed on unsupported monetary evidence %s", (amount) => {
    expect(previewLegacyVoid({ ...facts, netCollectionsMinor: amount }, "manager_authorized"))
      .toMatchObject({ canVoid: false, refusal: "opening_changed" });
  });
  it.each(["ordinary", "manager_authorized"] as const)("%s never bypasses changed principal, closed periods or historical status", (mode) => {
    expect(previewLegacyVoid({ ...facts, financialEvidenceValid: false }, mode).refusal).toBe("opening_changed");
    expect(previewLegacyVoid({ ...facts, periodLocked: true }, mode).refusal).toBe("period_locked");
    expect(previewLegacyVoid({ ...facts, status: "void" }, mode).refusal).toBe("already_void");
  });
});

describe("strict void request and preview boundary", () => {
  it("defaults old callers to ordinary and requires explicit reviewed manager mode", () => {
    expect(parseLegacyVoidRequest({ reason: "Correct historical agreement" }))
      .toEqual({ ok: true, value: { reason: "Correct historical agreement", mode: "ordinary" } });
    expect(parseLegacyVoidRequest({ reason: "Reviewed correction", mode: "manager_authorized" }))
      .toEqual({ ok: false, reason: "preview_required" });
    expect(parseLegacyVoidRequest({ reason: "Reviewed correction", mode: "manager_authorized", previewToken: "a".repeat(64) }).ok).toBe(true);
  });
  it.each([null, [], { reason: "ok?", mode: "manager" }, { reason: "ok?", canOverride: true },
    { reason: "ok?", mode: null }, { reason: "ok?", actorRole: "admin" }])("rejects unrecognized request fields/modes: %j", (value) => {
    expect(parseLegacyVoidRequest(value).ok).toBe(false);
  });
  it.each(["", "ab", "x".repeat(301)])("requires a bounded reason without truncating the manager's explanation", (reason) => {
    expect(parseLegacyVoidRequest({ reason })).toEqual({ ok: false, reason: "bad_reason" });
  });
  it("parses a valid identity-bound preview without coercion", () => {
    expect(parseLegacyVoidPreview(preview(), expected)).toEqual(preview());
  });
  it.each([
    { patientId: 8 }, { agreementId: 12 }, { mode: "ordinary" }, { version: 2 }, { currency: "EUR" },
    { openingPrincipalAfterMinor: 1 }, { netCollectionsMinor: "50000" }, { remainingDueAfterMinor: 1 },
    { previewToken: "bad" }, { previewToken: "a".repeat(64) + "\n" }, { canVoid: "true" }, { canVoid: true, refusal: "opening_settled" },
    { ordinaryAllowed: true }, { financialReviewRequired: false },
  ])("rejects mismatched identity, stale-shape data and impossible arithmetic: %j", (patch) => {
    expect(parseLegacyVoidPreview({ ...preview(), ...patch }, expected)).toBeNull();
  });
});
