import { describe, expect, it } from "vitest";
import { projectTreatmentFinancialReferences } from "../lib/treatment-financial-context";
import { isTreatmentFinancialContext } from "../lib/treatment-financial-context-validation";
import { historicalSnapshot } from "./treatment-financial-historical-fixture";

describe("historical document financial references", () => {
  it("exposes current revision totals once, with exact multi-case membership and no allocated line balance", () => {
    const result = projectTreatmentFinancialReferences(historicalSnapshot());
    expect(isTreatmentFinancialContext(result, 10)).toBe(true);
    expect(result.historicalDocuments).toHaveLength(1);
    expect(result.historicalDocuments[0]).toMatchObject({ documentId: 30, patientId: 10, version: 2, revisionId: 32,
      agreedMinor: 540000, previouslyPaidMinor: 90000, remainingAtRevisionMinor: 450000, historicalAsOf: "2026-09-02",
      currentAllocatedRemainingMinor: null, allocationState: "not_allocated", scope: "historical_document",
      lines: [{ agreementId: 20, planId: 1, planItemId: 2, clinicalCaseId: 5, documentLine: 0 },
        { agreementId: 21, planId: 1, planItemId: 8, clinicalCaseId: 6, documentLine: 1 }] });
    for (const reference of result.references) {
      expect(reference.historicalAgreements[0]).toMatchObject({ documentId: 30, agreedMinor: 150000,
        previouslyPaidMinor: null, remainingAtRegistrationMinor: null, currentAgreementRemainingMinor: null });
      expect(reference.packageCoverage.state).toBe("unspecified");
      expect(reference).not.toHaveProperty("previouslyPaidMinor");
    }
    // Historical totals describe the source, never a second charge added on top of the opening position.
    expect(result.accountPositions.YER).toMatchObject({ billedMinor: 0, openingMinor: 450000, dueMinor: 450000 });
    expect(result.documents).toEqual([]);
  });

  it("retains actual single-agreement paid/remaining fields alongside document-backed nulls", () => {
    const data = historicalSnapshot();
    data.items.push({ ...data.items[1], planItemId: 9, clinicalCaseId: 7 });
    data.legacyAgreements.push({ id: 22, patientId: 10, planItemId: 9, clinicalCaseId: 7, currency: "YER",
      agreedMinor: 300000, previouslyPaidMinor: 120000, remainingAtRegistrationMinor: 180000,
      historicalAsOf: "2026-09-01", openingEffect: "increased", openingHistoryId: 40, status: "live" });
    const result = projectTreatmentFinancialReferences(data);
    expect(result.references[2].historicalAgreements[0]).toMatchObject({ documentId: null, documentLine: null,
      previouslyPaidMinor: 120000, remainingAtRegistrationMinor: 180000 });
    expect(isTreatmentFinancialContext(result, 10)).toBe(true);
  });

  it.each(["missing_document", "missing_revision", "missing_line", "cross_patient", "stale_line", "stale_case", "stale_plan", "currency", "malformed_amount", "totals", "duplicate_line", "fabricated_zero"])(
    "fails closed on %s instead of falling back to the original agreement or zero", (kind) => {
      const data = historicalSnapshot();
      const document = data.historicalDocuments![0];
      const revision = document.revision!;
      const lines = revision.lines as Record<string, unknown>[];
      switch (kind) {
        case "missing_document": data.historicalDocuments = []; break;
        case "missing_revision": document.revision = null; break;
        case "missing_line": data.legacyAgreements.pop(); break;
        case "cross_patient": document.patientId = 99; break;
        case "stale_line": lines[1].agreementId = 999; break;
        case "stale_case": lines[1].caseId = 999; break;
        case "stale_plan": lines[1].planId = 999; break;
        case "currency": document.currency = "USD"; break;
        case "malformed_amount": lines[1].unitPriceMinor = null; break;
        case "totals": revision.totalMinor += 1; revision.remainingMinor += 1; break;
        case "duplicate_line": data.legacyAgreements[1].documentLine = 0; break;
        case "fabricated_zero": data.legacyAgreements[0].previouslyPaidMinor = 0; break;
      }
      expect(() => projectTreatmentFinancialReferences(data)).toThrow(/review/);
    });

  it("rejects incomplete, duplicate, wrong-patient, allocated or stale-owner response documents", () => {
    const result = projectTreatmentFinancialReferences(historicalSnapshot());
    const document = result.historicalDocuments[0];
    const bad = [
      { ...result, historicalDocuments: [] },
      { ...result, historicalDocuments: undefined },
      { ...result, historicalDocuments: [document, document] },
      ...[{ patientId: 99 }, { version: 0 }, { previouslyPaidMinor: null }, { remainingAtRevisionMinor: 0 },
        { currentAllocatedRemainingMinor: 450000 }, { lines: [] }, { historicalAsOf: "2026-02-30" },
        { lines: [{ ...document.lines[0], planItemId: 999 }, document.lines[1]] },
        { lines: [{ ...document.lines[0], patientId: 99 }, document.lines[1]] },
        { lines: document.lines.slice(0, 1) },
      ].map((change) => ({ ...result, historicalDocuments: [{ ...document, ...change }] })),
      { ...result, references: result.references.slice(0, 1) },
      { ...result, references: result.references.map((reference) => ({ ...reference, historicalAgreements:
        reference.historicalAgreements.map((agreement) => ({ ...agreement, previouslyPaidMinor: 0 })) })) },
    ];
    for (const response of bad) expect(isTreatmentFinancialContext(response, 10)).toBe(false);
  });
});
