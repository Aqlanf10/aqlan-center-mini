import { describe, expect, it } from "vitest";
import { addMonthsClamped, legacyArrangementProgress } from "../lib/legacy-balance-arrangements";

describe("legacy balance arrangement progress", () => {
  it("suggests one visit installment without creating a new principal", () => {
    expect(legacyArrangementProgress({
      startingDueMinor: 350_000,
      installmentMinor: 30_000,
      cadence: "per_visit",
      firstDueDate: null,
      currentOpeningDueMinor: 320_000,
      paidSinceStartMinor: 30_000,
      today: "2026-10-01",
    })).toMatchObject({
      arrangementRemainingMinor: 320_000,
      suggestedMinor: 30_000,
      overdueMinor: 0,
      completed: false,
    });
  });

  it("keeps exact calendar months and clamps month-end dates", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-31", 2)).toBe("2026-03-31");
  });

  it("separates monthly overdue from the normal suggested installment", () => {
    const progress = legacyArrangementProgress({
      startingDueMinor: 120_000,
      installmentMinor: 30_000,
      cadence: "monthly",
      firstDueDate: "2026-08-01",
      currentOpeningDueMinor: 90_000,
      paidSinceStartMinor: 30_000,
      today: "2026-10-01",
    });
    expect(progress).toMatchObject({
      arrangementRemainingMinor: 90_000,
      suggestedMinor: 30_000,
      overdueMinor: 60_000,
      nextDueDate: "2026-09-01",
      nextDueAmountMinor: 30_000,
      completed: false,
    });
  });

  it("never covers more than the current opening receivable", () => {
    expect(legacyArrangementProgress({
      startingDueMinor: 350_000,
      installmentMinor: 30_000,
      cadence: "per_visit",
      firstDueDate: null,
      currentOpeningDueMinor: 20_000,
      paidSinceStartMinor: 100_000,
      today: "2026-10-01",
    }).arrangementRemainingMinor).toBe(20_000);
  });

  it("completes when the opening receivable is settled", () => {
    expect(legacyArrangementProgress({
      startingDueMinor: 350_000,
      installmentMinor: 30_000,
      cadence: "per_visit",
      firstDueDate: null,
      currentOpeningDueMinor: 0,
      paidSinceStartMinor: 350_000,
      today: "2026-10-01",
    })).toMatchObject({ completed: true, suggestedMinor: 0, arrangementRemainingMinor: 0 });
  });
});
