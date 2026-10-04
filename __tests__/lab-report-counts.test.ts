import { describe, expect, it } from "vitest";
import { labSummary } from "../lib/lab";
import {
  LAB_REPORT_STATUSES, REPORT_LAB_TODAY, ZERO_LAB_COUNTS, legacyReportWindow,
  reportDisplacedReceived, reportLateOrders, reportLabOrder, reportStatusMatrix,
} from "./fixtures/lab-report-counts";
import { addDays } from "../lib/schedule";

/** Pure characterization controls. These should pass on the original source;
 * desired-red tests live in report-lab-counts-route and postgres/lab-report-counts. */
describe("daily-report lab count oracle and bounded-row counterfactuals", () => {
  it.each(LAB_REPORT_STATUSES)("pins %s on yesterday/today/tomorrow", (status) => {
    const outstanding = ["sent", "in_progress", "remake"].includes(status);
    for (const offset of [-1, 0, 1]) {
      expect(labSummary([reportLabOrder(1, status, addDays(REPORT_LAB_TODAY, offset))], REPORT_LAB_TODAY))
        .toEqual({ outstanding: Number(outstanding), late: Number(outstanding && offset < 0),
          dueToday: Number(outstanding && offset === 0), waitingFitting: Number(status === "received") });
    }
    expect(labSummary([reportLabOrder(1, status, "2000-01-01")], REPORT_LAB_TODAY).waitingFitting)
      .toBe(Number(status === "received"));
  });

  it("pins the complete matrix and successful empty result", () => {
    expect(labSummary(reportStatusMatrix(), REPORT_LAB_TODAY))
      .toEqual({ outstanding: 9, late: 3, dueToday: 3, waitingFitting: 3 });
    expect(labSummary([], REPORT_LAB_TODAY)).toEqual(ZERO_LAB_COUNTS);
  });

  it.each([301, 501])("shows why a %i-row workload cannot be counted from capped rows", (count) => {
    const full = reportLateOrders(count);
    expect(labSummary(full, REPORT_LAB_TODAY).late).toBe(count);
    expect(labSummary(legacyReportWindow(full), REPORT_LAB_TODAY).late).toBe(300);
    if (count > 500) expect(labSummary(legacyReportWindow(full, 500), REPORT_LAB_TODAY).late).toBe(500);
  });

  it("shows a received row displaced by 300 earlier terminal rows", () => {
    const full = reportDisplacedReceived();
    expect(labSummary(full, REPORT_LAB_TODAY)).toEqual({ ...ZERO_LAB_COUNTS, waitingFitting: 1 });
    expect(labSummary(legacyReportWindow(full), REPORT_LAB_TODAY)).toEqual(ZERO_LAB_COUNTS);
  });
});
