import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_TREATMENT_SQL } from "../lib/legacy-treatment-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";
import {
  LEGACY_TREATMENT_MESSAGE, LEGACY_TREATMENT_STATUS, legacyCaseTitle, legacyTreatmentFingerprint, parseLegacyTreatmentRequest,
} from "../lib/legacy-treatment";
import { classifyOrthoAdjustment } from "../lib/billing-classification";
import { planLedgerSummary, unlinkedSessionConflicts } from "../lib/plans";
import { legacyCoverageStateFromSnapshot, type LegacyCoverageSnapshotRow } from "../lib/legacy-treatment-coverage";

const TODAY = "2026-10-06";
const base = { serviceId: 7, currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30" };

describe("(INV-LEGACY) schema 0042", () => {
  it("keeps migration 0042 byte-equal to the runtime schema SQL and additive", () => {
    const lines = readFileSync("migrations/0042_legacy_treatment_agreements.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(LEGACY_TREATMENT_SQL.trim());
    expect(LEGACY_TREATMENT_SQL).not.toMatch(/\bDROP\b|ALTER TABLE/i);
    expect(LEGACY_TREATMENT_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
  });

  it("guards duplicates and history: one live agreement per scope and per item, unique key, append-only trigger", () => {
    expect(LEGACY_TREATMENT_SQL).toMatch(/legacy_treatment_agreements_live_scope_uniq[\s\S]+WHERE status = 'live'/);
    expect(LEGACY_TREATMENT_SQL).toMatch(/legacy_treatment_agreements_live_item_uniq[\s\S]+WHERE status = 'live'/);
    expect(LEGACY_TREATMENT_SQL).toMatch(/legacy_treatment_agreements_idempotency_uniq/);
    expect(LEGACY_TREATMENT_SQL).toMatch(/BEFORE UPDATE OR DELETE ON legacy_treatment_agreements/);
    expect(LEGACY_TREATMENT_SQL).toMatch(/remaining_minor = agreed_minor - previously_paid_minor/);
  });

  it("is wiped with patient data on clinic reset, before its plan items and patients", () => {
    expect(RESET_WIPE_TABLES.indexOf("legacy_treatment_agreements")).toBeGreaterThanOrEqual(0);
    expect(RESET_WIPE_TABLES.indexOf("legacy_treatment_agreements")).toBeLessThan(RESET_WIPE_TABLES.indexOf("plan_items"));
    expect(RESET_WIPE_TABLES.indexOf("legacy_treatment_agreements")).toBeLessThan(RESET_WIPE_TABLES.indexOf("patients"));
  });
});

describe("(INV-LEGACY) request parsing — the same computation as the preview", () => {
  it("300,000 agreed − 120,000 paid ⇒ 180,000 remaining", () => {
    expect(parseLegacyTreatmentRequest(base, TODAY)).toEqual({
      ok: true,
      value: {
        serviceId: 7, toothCode: null, surfaces: null, episodeTeeth: null, scope: null,
        caseId: null, sessions: null, currency: "YER", note: null, idempotencyKey: null,
        agreedMinor: 300_000, previouslyPaidMinor: 120_000, remainingMinor: 180_000, historicalAsOf: "2026-09-30",
      },
    });
  });

  it("paid == agreed is allowed with zero remaining; paid 0 keeps the whole agreement as remaining", () => {
    expect(parseLegacyTreatmentRequest({ ...base, previouslyPaidAmount: "300000" }, TODAY)).toMatchObject({ ok: true, value: { remainingMinor: 0 } });
    expect(parseLegacyTreatmentRequest({ ...base, previouslyPaidAmount: "0" }, TODAY)).toMatchObject({ ok: true, value: { remainingMinor: 300_000 } });
  });

  it.each([
    [{ previouslyPaidAmount: "300001" }, "أكبر من الاتفاق"],
    [{ historicalAsOf: "2026-10-07" }, "مستقبلي"],
    [{ historicalAsOf: "2026-02-30" }, "تاريخًا تقويميًا"],
    [{ currency: "EUR" }, "عملة"],
    [{ agreedAmount: "0", previouslyPaidAmount: "0" }, "أكبر من صفر"],
    [{ agreedAmount: "-5" }, "مبالغ صحيحة"],
    [{ serviceId: 0 }, "الخدمة"],
    [{ toothCode: 19 }, "السن"],
    [{ sessions: 99 }, "الجلسات"],
    [{ idempotencyKey: "bad key" }, "مفتاح"],
  ])("refuses %j in Arabic", (patch, fragment) => {
    const parsed = parseLegacyTreatmentRequest({ ...base, ...patch }, TODAY);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(fragment);
  });

  it("SAR amounts keep their minor units; the fingerprint covers every persisted field", () => {
    expect(parseLegacyTreatmentRequest({ ...base, currency: "SAR", agreedAmount: "900", previouslyPaidAmount: "400.50" }, TODAY))
      .toMatchObject({ ok: true, value: { agreedMinor: 90_000, previouslyPaidMinor: 40_050, remainingMinor: 49_950 } });
    const one = parseLegacyTreatmentRequest(base, TODAY);
    const two = parseLegacyTreatmentRequest({ ...base, note: "ملاحظة" }, TODAY);
    if (!one.ok || !two.ok) throw new Error("parse");
    expect(legacyTreatmentFingerprint(1, one.value)).not.toBe(legacyTreatmentFingerprint(1, two.value));
    expect(legacyTreatmentFingerprint(1, one.value)).not.toBe(legacyTreatmentFingerprint(2, one.value));
    expect(legacyTreatmentFingerprint(1, one.value)).toBe(legacyTreatmentFingerprint(1, { ...one.value, idempotencyKey: "other-key-1" }));
  });
});

describe("(INV-LEGACY) labels, messages and coverage classification", () => {
  it("every refusal has an Arabic message and a 4xx status", () => {
    for (const [reason, message] of Object.entries(LEGACY_TREATMENT_MESSAGE)) {
      expect({ reason, arabic: /[؀-ۿ]/.test(message) }).toEqual({ reason, arabic: true });
      const status = LEGACY_TREATMENT_STATUS[reason as keyof typeof LEGACY_TREATMENT_STATUS];
      expect(status >= 400 && status < 500).toBe(true);
    }
  });

  it("publishes bounded multi-tooth and incompatible-master refusal contracts", () => {
    expect(LEGACY_TREATMENT_STATUS.legacy_episode_unsupported).toBe(400);
    expect(LEGACY_TREATMENT_STATUS.incompatible_plan).toBe(409);
    expect(LEGACY_TREATMENT_STATUS.needs_financial_review).toBe(409);
    expect(LEGACY_TREATMENT_STATUS.bad_case).toBe(400);
  });

  it("the legacy case title states its origin without inventing a diagnosis", () => {
    const none = { toothCode: null, episodeTeeth: null, scope: null };
    expect(legacyCaseTitle("orthodontics", none)).toBe("تقويم — حالة بدأت قبل النظام");
    expect(legacyCaseTitle("orthodontics", { ...none, scope: "upper" })).toBe("تقويم — الفك العلوي — حالة بدأت قبل النظام");
    expect(legacyCaseTitle("endodontics", { ...none, toothCode: 36 })).toBe("علاج جذور — سن 36 — حالة بدأت قبل النظام");
    expect(legacyCaseTitle("prosthodontics", { ...none, toothCode: 14, episodeTeeth: [14, 15, 16] }))
      .toBe("تركيبات — أسنان 14، 15، 16 — حالة بدأت قبل النظام");
  });

  it("an ortho adjustment covered by a live historical agreement is LEGACY_INCLUDED, whatever the baseline mode", () => {
    const common = { openingCurrencies: [], fundedPlan: false };
    expect(classifyOrthoAdjustment({ legacy: false, financialMode: null, ...common, legacyAgreement: true })).toBe("LEGACY_INCLUDED");
    expect(classifyOrthoAdjustment({ legacy: true, financialMode: "per_session", ...common, legacyAgreement: true })).toBe("LEGACY_INCLUDED");
    expect(classifyOrthoAdjustment({ legacy: false, financialMode: null, ...common })).toBe("OUTSIDE_CONTRACT");
  });

  it("the ledger summary flags a historical-agreement plan whenever an item retains historical agreement identity, including void", () => {
    const plan = {
      id: 1, title: "علاج بدأ قبل النظام", status: "active" as const, totalMinor: 300_000, consentAt: null,
      installments: [],
      progress: { paidMinor: 0, remainingMinor: 0, overdueMinor: 0, nextDueDate: null, nextDueAmountMinor: 0, paidCount: 0, count: 0 },
      itemsProgress: { count: 1, doneCount: 0, doneMinor: 0, remainingMinor: 300_000 },
    } as unknown as Parameters<typeof planLedgerSummary>[0];
    expect(planLedgerSummary({ ...plan, items: [{ legacyAgreementId: 5 }] }).legacy).toBe(true);
    // The identifier represents durable origin, not a claim that financial coverage is still live.
    const reviewItem = { legacyAgreementId: 5, billingStatus: "needs_financial_review" as const };
    expect(planLedgerSummary({ ...plan, items: [reviewItem] }).legacy).toBe(true);
    expect(planLedgerSummary({ ...plan, items: [{}] })).not.toHaveProperty("legacy");
  });
});



describe("durable legacy history in free-procedure protection", () => {
  function verifiedCoverage(overrides: Partial<LegacyCoverageSnapshotRow> = {}) {
    const snapshot: LegacyCoverageSnapshotRow = {
      agreement_id: 5, format_version: 1, service_id: 7, service_category: "rct",
      anchor_tooth_code: 36, snapshot_mode: "per_tooth_episode", snapshot_tooth_codes: [36],
      snapshot_scope: null, snapshot_surfaces: null, recorded_by: "synthetic-reception",
      recorded_at: "2026-10-06T12:00:00.000Z", ...overrides,
    };
    const coverage = legacyCoverageStateFromSnapshot(snapshot, {
      agreementId: snapshot.agreement_id, serviceId: snapshot.service_id, anchorToothCode: snapshot.anchor_tooth_code,
    });
    if (coverage.kind !== "verified") throw new Error("Invalid legacy coverage fixture");
    return coverage;
  }

  const historicalItem = {
    id: 41, serviceId: 7, toothCode: 36, serviceName: "Historical root canal", status: "done",
    sessionCount: 1, doneSessions: 1, hasInvoiceLineage: false, hasLegacyLineage: true,
    billingStatus: "included_in_package" as const, caseSite: "36", legacyCoverage: verifiedCoverage(),
  };

  it("does not let a done or single-session legacy item become a fresh free procedure", () => {
    expect(unlinkedSessionConflicts([historicalItem], [{ serviceId: 7, toothCode: 36 }])).toHaveLength(1);
    expect(unlinkedSessionConflicts([{ ...historicalItem, status: "planned", doneSessions: 0 }], [{ serviceId: 7, toothCode: 36 }]))
      .toHaveLength(1);
  });

  it("keeps other teeth independent from the historical work identity", () => {
    expect(unlinkedSessionConflicts([historicalItem], [{ serviceId: 7, toothCode: 46 }])).toEqual([]);
  });

  it.each([undefined, { kind: "unknown", reason: "missing_snapshot" }] as const)(
    "holds another same-service tooth when immutable historical coverage is unavailable: %j", (legacyCoverage) => {
      expect(unlinkedSessionConflicts([{ ...historicalItem, legacyCoverage }], [{ serviceId: 7, toothCode: 46 }]))
        .toHaveLength(1);
    },
  );

  it("retains verified lower-arch protection despite mutable case-label drift and without invoice provenance", () => {
    const lowerArch = { ...historicalItem, toothCode: null, caseSite: "الفك العلوي",
      legacyCoverage: verifiedCoverage({ service_category: "ortho", anchor_tooth_code: null,
        snapshot_mode: "arch", snapshot_tooth_codes: [], snapshot_scope: "lower" }),
    };
    expect(unlinkedSessionConflicts([lowerArch], [{ serviceId: 7, toothCode: 36 }])).toHaveLength(1);
    expect(unlinkedSessionConflicts([lowerArch], [{ serviceId: 7, toothCode: 16 }])).toEqual([]);
  });
});
