import { describe, expect, it } from "vitest";
import { nextStep } from "../lib/workflow";

const base = { openVisit: null, todayAppointment: null, debtMinor: 0, unscheduledPlannedVisit: { id: 9 }, activePlan: { id: 4 } };

describe("(INV-LINK D) next action for treatment accepted by invoice but not started", () => {
  it("is the clinical assessment, not 'create plan' or plain follow-up", () => {
    expect(nextStep({ ...base, assessmentCase: { id: 7 } })).toEqual({ kind: "clinical_assessment", targetId: 7 });
  });
  it("an open visit, today's appointment and outstanding debt still come first", () => {
    expect(nextStep({ ...base, openVisit: { id: 1 }, assessmentCase: { id: 7 } }).kind).toBe("continue_visit");
    expect(nextStep({ ...base, todayAppointment: { id: 2 }, assessmentCase: { id: 7 } }).kind).toBe("start_today_visit");
    expect(nextStep({ ...base, debtMinor: 500, assessmentCase: { id: 7 } }).kind).toBe("collect_payment");
  });
  it("without a pending assessment the previous order is unchanged", () => {
    expect(nextStep(base).kind).toBe("schedule_next_visit");
    expect(nextStep({ ...base, unscheduledPlannedVisit: null }).kind).toBe("follow_up");
  });
});
