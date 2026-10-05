import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  previewLegacyReconciliation,
  type OpeningSnapshot,
  type PreviewDraft,
  type PreviewReceipt,
} from "../lib/legacy-reconciliation-preview";

const draft: PreviewDraft = {
  currency: "SAR", agreedAmount: "600", previouslyPaidAmount: "250", historicalAsOf: "2026-09-01",
};
const position: OpeningSnapshot = {
  currency: "SAR", openingMinor: 35_000, settledMinor: 5_000, remainingMinor: 30_000,
};
function receipt(overrides: Partial<PreviewReceipt> = {}): PreviewReceipt {
  return {
    id: 1, receiptNumber: "RC-001", invoiceId: null, planId: null, openingCurrency: "SAR",
    kind: "payment", amountMinor: 5_000, currency: "SAR", baseAmountMinor: 700_000,
    method: "cash", createdAt: "2026-09-02T08:00:00.000Z", ...overrides,
  };
}
function preview(overrides: Partial<Parameters<typeof previewLegacyReconciliation>[0]> = {}) {
  return previewLegacyReconciliation({ draft, today: "2026-10-05", positions: [position], payments: [receipt()], ...overrides });
}

describe("legacy reconciliation preview: separate historical facts and recorded ledger", () => {
  it("keeps SAR 600 minus 250 = historical 350 beside principal 350 and current remaining 300", () => {
    expect(preview()).toEqual({
      draftState: "valid", message: null,
      historical: {
        currency: "SAR", agreedMinor: 60_000, previouslyPaidMinor: 25_000,
        remainingMinor: 35_000, historicalAsOf: "2026-09-01",
      },
      recorded: { kind: "available", position },
      receipts: { kind: "available", recordedAfterCutoff: [receipt()] },
      provenance: "unverified",
    });
  });

  it("never subtracts the later 50 again or proposes replacement principal 300 and remaining 250", () => {
    const result = preview();
    expect(result.historical?.remainingMinor).toBe(35_000);
    expect(result.historical?.remainingMinor).not.toBe(30_000);
    expect(result.recorded).toEqual({ kind: "available", position });
    expect(Object.keys(result).sort()).toEqual([
      "draftState", "historical", "message", "provenance", "receipts", "recorded",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/replacement|allocation|authorized|matched|consistent/i);
  });

  it("does not allocate an aggregate principal between two same-currency historical agreements", () => {
    // These independent agreements share one patient-level SAR opening, not separate principals.
    const aggregate: OpeningSnapshot = {
      currency: "SAR", openingMinor: 55_000, settledMinor: 10_000, remainingMinor: 45_000,
    };
    const first = preview({ positions: [aggregate] });
    const second = preview({
      draft: { ...draft, agreedAmount: "300", previouslyPaidAmount: "100" }, positions: [aggregate],
    });
    expect(first.historical?.remainingMinor).toBe(35_000);
    expect(second.historical?.remainingMinor).toBe(20_000);
    expect(first.recorded).toEqual({ kind: "available", position: aggregate });
    expect(second.recorded).toEqual(first.recorded);
    expect(first.provenance).toBe("unverified");
    expect(second.provenance).toBe("unverified");
  });

  it("does not allocate an aggregate to the typed draft even when its principal equals that draft", () => {
    // The 350 principal could comprise unrelated agreements of 200 and 150; no history is supplied.
    const result = preview();
    expect(result.historical?.remainingMinor).toBe(position.openingMinor);
    expect(result.recorded).toEqual({ kind: "available", position });
    expect(result.provenance).toBe("unverified");
    expect(result).not.toHaveProperty("agreementId");
    expect(result).not.toHaveProperty("allocatedMinor");
    expect(result).not.toHaveProperty("canLink");
  });

  it("does not establish provenance when the current net remaining happens to equal history", () => {
    const matchingNet = { ...position, openingMinor: 40_000, remainingMinor: 35_000 };
    const result = preview({ positions: [matchingNet] });
    expect(result.recorded).toEqual({ kind: "available", position: matchingNet });
    expect(result.historical?.remainingMinor).toBe(matchingNet.remainingMinor);
    expect(result.provenance).toBe("unverified");
  });

  it("keeps provenance unverified for absent, unavailable, zero, matching and different ledgers", () => {
    for (const positions of [
      undefined, [], [position], [{ ...position, openingMinor: 0, settledMinor: 0, remainingMinor: 0 }],
      [{ ...position, openingMinor: 75_000, remainingMinor: 70_000 }],
    ]) {
      expect(preview({ positions }).provenance).toBe("unverified");
    }
    expect(preview({ draft: { ...draft, agreedAmount: "" } }).provenance).toBe("unverified");
  });

  it("keeps a missing positions payload unavailable instead of reporting zero or absence", () => {
    expect(preview({ positions: undefined }).recorded).toEqual({ kind: "unavailable" });
    expect(preview({ positions: undefined }).historical?.remainingMinor).toBe(35_000);
  });

  it("keeps missing payments unavailable instead of asserting no later records", () => {
    const result = preview({ payments: undefined });
    expect(result.receipts).toEqual({ kind: "unavailable" });
    expect(result.recorded).toEqual({ kind: "available", position });
  });

  it("rejects null or non-array payloads at the runtime boundary", () => {
    for (const value of [null, {}, "", 0]) {
      expect(preview({ positions: value as unknown as OpeningSnapshot[] }).recorded)
        .toEqual({ kind: "unavailable" });
      expect(preview({ payments: value as unknown as PreviewReceipt[] }).receipts)
        .toEqual({ kind: "unavailable" });
    }
  });

  it("recognizes an explicitly empty opening list as known absence in the selected currency", () => {
    expect(preview({ positions: [] }).recorded).toEqual({ kind: "absent" });
  });

  it("does not borrow an opening snapshot from another currency", () => {
    expect(preview({ positions: [{ ...position, currency: "USD" }] }).recorded)
      .toEqual({ kind: "absent" });
  });

  it("rejects duplicate selected-currency opening snapshots rather than taking the first or sum", () => {
    expect(preview({ positions: [position, { ...position, openingMinor: 90_000 }] }).recorded)
      .toEqual({ kind: "unavailable" });
  });

  it("does not claim absence from a payload with duplicate other-currency positions", () => {
    const usd: OpeningSnapshot = { ...position, currency: "USD" };
    expect(preview({ positions: [usd, usd] }).recorded).toEqual({ kind: "unavailable" });
  });

  it("keeps malformed opening rows unavailable, including unknown currency and unsafe amounts", () => {
    const invalidRows: unknown[] = [
      null, {}, { ...position, currency: "EUR" }, { ...position, openingMinor: "35000" },
      { ...position, openingMinor: Number.MAX_SAFE_INTEGER + 1 }, { ...position, settledMinor: NaN },
      { ...position, settledMinor: Infinity }, { ...position, settledMinor: 1.5 },
      { ...position, remainingMinor: -1 }, { ...position, remainingMinor: undefined },
      { ...position, remainingMinor: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const row of invalidRows) {
      expect(preview({ positions: [row] as OpeningSnapshot[] }).recorded).toEqual({ kind: "unavailable" });
    }
  });

  it("preserves an explicit zero opening and zero remaining as an available snapshot", () => {
    const zero = { ...position, openingMinor: 0, settledMinor: 0, remainingMinor: 0 };
    expect(preview({ positions: [zero] }).recorded).toEqual({ kind: "available", position: zero });
  });

  it("preserves signed server settlement and opening values without clamping or recomputing", () => {
    const refunded = { ...position, settledMinor: -5_000, remainingMinor: 40_000 };
    const credit = { ...position, openingMinor: -5_000, settledMinor: 0, remainingMinor: 0 };
    expect(preview({ positions: [refunded] }).recorded).toEqual({ kind: "available", position: refunded });
    expect(preview({ positions: [credit] }).recorded).toEqual({ kind: "available", position: credit });
    expect(preview({ positions: [credit] }).historical?.remainingMinor).toBe(35_000);
  });

  it("compares only the selected currency while keeping all supplied snapshots unchanged", () => {
    const positions: OpeningSnapshot[] = [
      { currency: "YER", openingMinor: 900_000, settledMinor: 100_000, remainingMinor: 800_000 },
      position, { currency: "USD", openingMinor: 10_000, settledMinor: 1_000, remainingMinor: 9_000 },
    ];
    expect(preview({ positions }).recorded).toEqual({ kind: "available", position });
    expect(preview({ positions }).historical?.remainingMinor).toBe(35_000);
  });

  it("marks each missing required text field incomplete instead of treating it as zero", () => {
    for (const field of ["agreedAmount", "previouslyPaidAmount", "historicalAsOf"] as const) {
      for (const empty of ["", "   "]) {
        expect(preview({ draft: { ...draft, [field]: empty } })).toMatchObject({
          draftState: "incomplete", historical: null, receipts: { kind: "unavailable" },
        });
      }
    }
  });

  it("rejects non-string draft fields rather than coercing null, numbers or objects", () => {
    for (const field of ["agreedAmount", "previouslyPaidAmount", "historicalAsOf"]) {
      for (const value of [null, undefined, 0, {}, []]) {
        expect(preview({ draft: { ...draft, [field]: value } as PreviewDraft }))
          .toMatchObject({ draftState: "invalid", historical: null });
      }
    }
    expect(preview({ draft: null as unknown as PreviewDraft }).draftState).toBe("invalid");
  });

  it("uses existing amount parsing for Arabic digits, decimal separators and whitespace", () => {
    const result = preview({ draft: { ...draft, agreedAmount: " ٦٠٠٫٥٠ ", previouslyPaidAmount: "٢٥٠٫٢٥" } });
    expect(result.historical).toMatchObject({
      agreedMinor: 60_050, previouslyPaidMinor: 25_025, remainingMinor: 35_025,
    });
  });

  it("uses YER major units without a synthetic hundredfold conversion", () => {
    const result = preview({ draft: { ...draft, currency: "YER", agreedAmount: "600", previouslyPaidAmount: "250" } });
    expect(result.historical).toMatchObject({ currency: "YER", agreedMinor: 600, previouslyPaidMinor: 250, remainingMinor: 350 });
    expect(result.recorded).toEqual({ kind: "absent" });
  });

  it("keeps USD minor units separate from the SAR opening and its receipts", () => {
    const result = preview({ draft: { ...draft, currency: "USD" } });
    expect(result.historical).toMatchObject({ currency: "USD", remainingMinor: 35_000 });
    expect(result.recorded).toEqual({ kind: "absent" });
    expect(result.receipts).toEqual({ kind: "available", recordedAfterCutoff: [] });
  });

  it("rejects unsupported historical credit when previously paid exceeds agreed", () => {
    const result = preview({ draft: { ...draft, previouslyPaidAmount: "601" } });
    expect(result).toMatchObject({ draftState: "invalid", historical: null });
    expect(result.message).toMatch(/الرصيد الدائن/);
  });

  it("rejects unparseable or signed historical inputs without silently converting them to zero", () => {
    for (const value of ["-1", "+1", "NaN", "Infinity", ".", "abc", "1e3", "1.2.3"]) {
      expect(preview({ draft: { ...draft, agreedAmount: value } }).draftState).toBe("invalid");
      expect(preview({ draft: { ...draft, previouslyPaidAmount: value } }).draftState).toBe("invalid");
    }
  });

  it("rejects finite but unsafe amounts and numeric overflow", () => {
    for (const value of ["9007199254740992", "90071992547409.92", "9".repeat(400)]) {
      expect(preview({ draft: { ...draft, agreedAmount: value } })).toMatchObject({
        draftState: "invalid", historical: null,
      });
    }
  });

  it("fails closed for unknown currencies even when the amounts and ledger otherwise match", () => {
    for (const currency of ["EUR", "sar", "", null, 1]) {
      expect(preview({ draft: { ...draft, currency } as PreviewDraft })).toMatchObject({
        draftState: "invalid", historical: null, recorded: { kind: "unavailable" },
        receipts: { kind: "unavailable" }, provenance: "unverified",
      });
    }
  });

  it("rejects malformed and impossible calendar dates instead of accepting Date rollover", () => {
    for (const historicalAsOf of [
      "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "0000-01-01",
      "2026-9-1", "09/01/2026", "2026-09-01T00:00:00Z", "2026-09-01x", "not-a-date",
    ]) {
      expect(preview({ draft: { ...draft, historicalAsOf } })).toMatchObject({
        draftState: "invalid", historical: null, receipts: { kind: "unavailable" },
      });
    }
  });

  it("accepts real leap days and normalizes only surrounding draft whitespace", () => {
    const result = preview({ draft: { ...draft, historicalAsOf: " 2024-02-29 " } });
    expect(result.draftState).toBe("valid");
    expect(result.historical?.historicalAsOf).toBe("2024-02-29");
    expect(preview({ draft: { ...draft, historicalAsOf: "2000-02-29" } }).draftState).toBe("valid");
    expect(preview({ draft: { ...draft, historicalAsOf: "1900-02-29" } }).draftState).toBe("invalid");
  });

  it("rejects missing or invalid current clinic days without reading or inventing today's date", () => {
    for (const today of [undefined, null, 20261005, "", " 2026-10-05 ", "2026-02-29",
      "2026-04-31", "0000-01-01", "2026-10-05T00:00:00Z", "not-a-date"]) {
      const result = preview({ today: today as string });
      expect(result).toMatchObject({
        draftState: "invalid", historical: null, recorded: { kind: "available", position },
        receipts: { kind: "unavailable" }, provenance: "unverified",
      });
      expect(result.message).toMatch(/تاريخ اليوم في العيادة/);
    }
  });

  it("rejects future historical cutoffs with explicit unsupported future-data copy", () => {
    for (const historicalAsOf of ["2026-10-06", "2027-01-01"]) {
      const result = preview({ draft: { ...draft, historicalAsOf } });
      expect(result).toMatchObject({
        draftState: "invalid", historical: null, recorded: { kind: "available", position },
        receipts: { kind: "unavailable" }, provenance: "unverified",
      });
      expect(result.message).toMatch(/تاريخًا مستقبليًا غير مدعومة/);
    }
  });

  it("accepts the exact current clinic day while preserving historical arithmetic and projections", () => {
    const result = preview({ today: "2026-09-01" });
    expect(result).toMatchObject({
      draftState: "valid", message: null,
      historical: { historicalAsOf: "2026-09-01", remainingMinor: 35_000 },
      recorded: { kind: "available", position }, provenance: "unverified",
    });
    expect(preview({ draft: { ...draft, historicalAsOf: "2026-10-05" } }).draftState).toBe("valid");
  });

  it("accepts explicit historical zero and a fully paid historical agreement", () => {
    const zero = preview({ draft: { ...draft, agreedAmount: "0", previouslyPaidAmount: "0" } });
    expect(zero).toMatchObject({ draftState: "valid", historical: { agreedMinor: 0, previouslyPaidMinor: 0, remainingMinor: 0 } });
    expect(preview({ draft: { ...draft, previouslyPaidAmount: "600" } }).historical?.remainingMinor).toBe(0);
  });

  it("keeps the safe integer boundary without adding ledger values to it", () => {
    const result = preview({ draft: { ...draft, currency: "YER", agreedAmount: "9007199254740991", previouslyPaidAmount: "0" } });
    expect(result.historical?.remainingMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.draftState).toBe("valid");
  });

  it("filters strictly after the clinic date, including the exact local-midnight boundary", () => {
    const sameDay = receipt({ id: 1, createdAt: "2026-09-01T20:59:59.999Z" });
    const nextDay = receipt({ id: 2, createdAt: "2026-09-01T21:00:00.000Z" });
    const result = preview({ payments: [sameDay, nextDay] });
    expect(result.receipts).toEqual({ kind: "available", recordedAfterCutoff: [nextDay] });
  });

  it("accepts explicit ISO offsets as absolute record times rather than device-local times", () => {
    const sameDay = receipt({ id: 1, createdAt: "2026-09-01T23:59:59+03:00" });
    const nextDay = receipt({ id: 2, createdAt: "2026-09-02T00:00:00+03:00" });
    expect(preview({ payments: [sameDay, nextDay] }).receipts)
      .toEqual({ kind: "available", recordedAfterCutoff: [nextDay] });
  });

  it("fails the relevant receipt list for malformed, rolled-over or timezone-less timestamps", () => {
    for (const createdAt of [
      "", "bad", "2026-09-02", "2026-09-02T00:00:00", "2026-02-30T10:00:00Z",
      "2026-09-02T24:00:00Z", "2026-09-02T00:60:00Z", "2026-09-02T00:00:60Z",
      "2026-09-02T00:00:00+25:00", "2026-09-02T00:00:00+03:99",
    ]) {
      expect(preview({ payments: [receipt({ createdAt })] }).receipts).toEqual({ kind: "unavailable" });
    }
  });

  it("does not silently drop malformed relevant timestamps that appear to precede the cutoff", () => {
    expect(preview({ payments: [receipt({ createdAt: "2025-02-30T00:00:00Z" })] }).receipts)
      .toEqual({ kind: "unavailable" });
  });

  it("does not interpret unrelated invoice timestamps or include invoice payments", () => {
    const invoice = receipt({ id: 2, openingCurrency: null, invoiceId: 50, createdAt: "bad" });
    expect(preview({ payments: [receipt(), invoice] }).receipts)
      .toEqual({ kind: "available", recordedAfterCutoff: [receipt()] });
  });

  it("does not include another currency's opening receipt even when its amount matches", () => {
    const usd = receipt({ id: 2, openingCurrency: "USD", currency: "USD", createdAt: "bad" });
    expect(preview({ payments: [receipt(), usd] }).receipts)
      .toEqual({ kind: "available", recordedAfterCutoff: [receipt()] });
  });

  it("rejects relevant opening metadata colliding with invoice or plan targets", () => {
    for (const overrides of [{ invoiceId: 10 }, { planId: 20 }, { invoiceId: 10, planId: 20 }, { invoiceId: 0 }, { planId: 0 }]) {
      expect(preview({ payments: [receipt(overrides)] }).receipts).toEqual({ kind: "unavailable" });
    }
  });

  it("never synthesizes opening receipt classification from an untargeted payment or refund", () => {
    const untargeted = [
      receipt({ openingCurrency: null }),
      receipt({ id: 3, openingCurrency: null, kind: "refund" }),
      receipt({ id: 4, openingCurrency: null, planId: 9 }),
    ];
    expect(preview({ payments: untargeted }).receipts).toEqual({ kind: "available", recordedAfterCutoff: [] });
  });

  it("keeps missing openingCurrency metadata unavailable instead of inventing a non-opening target", () => {
    const missing = receipt();
    delete missing.openingCurrency;
    for (const payment of [missing, receipt({ openingCurrency: undefined }),
      receipt({ openingCurrency: undefined, invoiceId: 10 })]) {
      expect(preview({ payments: [payment] }).receipts).toEqual({ kind: "unavailable" });
    }
    expect(preview({ payments: [receipt({ openingCurrency: null })] }).receipts)
      .toEqual({ kind: "available", recordedAfterCutoff: [] });
  });

  it("keeps a selected opening's missing planId unavailable instead of assuming no competing target", () => {
    const missing = receipt();
    delete missing.planId;
    for (const payment of [missing, receipt({ planId: undefined })]) {
      expect(preview({ payments: [payment] }).receipts).toEqual({ kind: "unavailable" });
    }
    expect(preview({ payments: [receipt({ planId: null })] }).receipts)
      .toEqual({ kind: "available", recordedAfterCutoff: [receipt()] });
  });

  it("preserves valid cross-currency base-target receipts in their original currencies without totals", () => {
    const sar = receipt({ openingCurrency: "YER" });
    const usd = receipt({ id: 2, openingCurrency: "YER", currency: "USD", amountMinor: 1_000, baseAmountMinor: 5_300 });
    const result = preview({ draft: { ...draft, currency: "YER" }, payments: [sar, usd] });
    expect(result.receipts).toEqual({ kind: "available", recordedAfterCutoff: [sar, usd] });
    expect(result.historical?.remainingMinor).toBe(350);
    expect(result.receipts).not.toHaveProperty("totalMinor");
  });

  it("rejects unsupported cross-currency foreign targets rather than silently converting them", () => {
    for (const currency of ["USD", "YER"] as const) {
      expect(preview({ payments: [receipt({ currency })] }).receipts).toEqual({ kind: "unavailable" });
    }
  });

  it("preserves refund direction, positive stored amount, original currency and all receipt metadata", () => {
    const refund = receipt({
      id: 2, receiptNumber: "RF-002", kind: "refund", amountMinor: 2_500,
      baseAmountMinor: 350_000, method: "bank_transfer", createdAt: "2026-09-03T08:00:00Z",
    });
    const result = preview({ payments: [receipt(), refund] });
    expect(result.receipts).toEqual({ kind: "available", recordedAfterCutoff: [receipt(), refund] });
    expect(result.historical?.remainingMinor).toBe(35_000);
    expect(result.recorded).toEqual({ kind: "available", position });
  });

  it("rejects negative stored receipt amounts instead of double-signing a refund", () => {
    for (const kind of ["payment", "refund"] as const) {
      expect(preview({ payments: [receipt({ kind, amountMinor: -1 })] }).receipts).toEqual({ kind: "unavailable" });
      expect(preview({ payments: [receipt({ kind, baseAmountMinor: -1 })] }).receipts).toEqual({ kind: "unavailable" });
    }
  });

  it("rejects malformed identity, direction, currency, amount and target metadata on relevant receipts", () => {
    const patches: unknown[] = [
      { id: 0 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { receiptNumber: " " },
      { receiptNumber: null }, { kind: "reversal" }, { currency: "EUR" }, { amountMinor: NaN },
      { amountMinor: "5000" }, { amountMinor: 1.5 }, { baseAmountMinor: Infinity },
      { baseAmountMinor: Number.MAX_SAFE_INTEGER + 1 }, { method: null }, { method: "" },
      { invoiceId: undefined }, { createdAt: null }, { openingCurrency: "EUR" },
    ];
    for (const patch of patches) {
      const invalid = { ...receipt(), ...(patch as Record<string, unknown>) } as PreviewReceipt;
      expect(preview({ payments: [invalid] }).receipts).toEqual({ kind: "unavailable" });
    }
  });

  it("rejects duplicate relevant receipt IDs rather than displaying or deduplicating an uncertain history", () => {
    expect(preview({ payments: [receipt(), receipt({ amountMinor: 7_500 })] }).receipts)
      .toEqual({ kind: "unavailable" });
  });

  it("recognizes explicitly empty payments as an available empty receipt list", () => {
    expect(preview({ payments: [] }).receipts).toEqual({ kind: "available", recordedAfterCutoff: [] });
  });

  it("does not mutate frozen input drafts, snapshots or receipt arrays", () => {
    const frozenDraft = Object.freeze({ ...draft });
    const frozenPosition = Object.freeze({ ...position });
    const frozenReceipt = Object.freeze(receipt());
    const input = Object.freeze({
      draft: frozenDraft, today: "2026-10-05", positions: Object.freeze([frozenPosition]), payments: Object.freeze([frozenReceipt]),
    });
    const before = JSON.stringify(input);
    const result = previewLegacyReconciliation(input);
    expect(result.draftState).toBe("valid");
    expect(JSON.stringify(input)).toBe(before);
    if (result.recorded.kind === "available") expect(result.recorded.position).not.toBe(frozenPosition);
    if (result.receipts.kind === "available") expect(result.receipts.recordedAfterCutoff[0]).not.toBe(frozenReceipt);
  });

  it("has only pure money, calendar and clinic-zone imports and no persistence or remote calls", () => {
    const source = readFileSync(new URL("../lib/legacy-reconciliation-preview.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/^import .* from "([^"]+)";/gm)].map((match) => match[1]).sort())
      .toEqual(["./clinicZone", "./money", "./schedule"]);
    expect(source).not.toMatch(/\b(?:fetch|localStorage|sessionStorage|session|window|document|process)\b/);
    expect(source).not.toMatch(/(?:\.\/db|server-only|\.query\s*\(|\.execute\s*\()/);
    expect(source).toContain("remainingMinor: agreedMinor - previouslyPaidMinor");
    expect(source).not.toMatch(/\.reduce\s*\(|settlePaymentMinor|toBaseAmount/);
  });

  it("changing the selected cutoff changes only the receipt filter, never historical remaining", () => {
    const before = preview();
    const after = preview({ draft: { ...draft, historicalAsOf: "2026-09-03" } });
    expect(before.historical?.remainingMinor).toBe(after.historical?.remainingMinor);
    expect(before.recorded).toEqual(after.recorded);
    expect(after.receipts).toEqual({ kind: "available", recordedAfterCutoff: [] });
    expect(after.provenance).toBe("unverified");
  });

  it("excludes valid receipts recorded before or on the selected day without calling them historical cash", () => {
    const payments = [
      receipt({ id: 1, createdAt: "2026-08-01T08:00:00Z" }),
      receipt({ id: 2, createdAt: "2026-09-01T08:00:00Z" }),
    ];
    expect(preview({ payments }).receipts).toEqual({ kind: "available", recordedAfterCutoff: [] });
    expect(preview({ payments }).historical?.previouslyPaidMinor).toBe(25_000);
  });

  it("does not assert an empty receipt history from malformed payload entries", () => {
    for (const value of [null, 10, "receipt", [], {}, { openingCurrency: null }]) {
      expect(preview({ payments: [value] as PreviewReceipt[] }).receipts).toEqual({ kind: "unavailable" });
    }
  });

  it("can still show the selected server snapshot while incomplete history leaves receipts unavailable", () => {
    const result = preview({ draft: { ...draft, historicalAsOf: "" } });
    expect(result.recorded).toEqual({ kind: "available", position });
    expect(result.historical).toBeNull();
    expect(result.receipts).toEqual({ kind: "unavailable" });
    expect(result.message).not.toBeNull();
  });
});
