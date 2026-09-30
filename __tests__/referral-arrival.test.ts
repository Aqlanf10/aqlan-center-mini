import { describe, expect, it } from "vitest";
import { MISSED_APPOINTMENT_LABEL, REFERRAL_TIMELINE_LABEL, systemReferralStep, WORKFLOW_STATES } from "../lib/referrals";
import { TIMELINE_KIND_LABEL, timelineGroupOf } from "../lib/workflow";
import { AUDIT_LABEL } from "../lib/audit";

describe("(REF-2) system steps on an internal referral", () => {
  it("arrival moves only a scheduled referral", () => {
    expect(systemReferralStep("scheduled", "arrive")).toBe("arrived");
    for (const state of WORKFLOW_STATES.filter((one) => one !== "scheduled")) {
      expect(systemReferralStep(state, "arrive")).toBeNull();
    }
  });

  it("sign-off progress from accepted/scheduled/arrived only — idempotent once in progress", () => {
    expect(systemReferralStep("accepted", "progress")).toBe("in_progress");
    expect(systemReferralStep("scheduled", "progress")).toBe("in_progress");
    expect(systemReferralStep("arrived", "progress")).toBe("in_progress");
    for (const state of ["requested", "in_progress", "completed", "returned_to_referrer", "declined", "cancelled"] as const) {
      expect(systemReferralStep(state, "progress")).toBeNull();
    }
  });

  it("a fallen appointment returns a scheduled referral to waiting for booking (accepted, or requested if never accepted)", () => {
    expect(systemReferralStep("scheduled", "unschedule")).toBe("accepted");
    expect(systemReferralStep("scheduled", "unschedule", { wasAccepted: false })).toBe("requested");
    expect(systemReferralStep("arrived", "unschedule")).toBeNull();
    expect(systemReferralStep("in_progress", "unschedule")).toBeNull();
  });

  it("labels: Arabic, and every referral audit action has a timeline label and an audit label", () => {
    expect(MISSED_APPOINTMENT_LABEL).toEqual({ no_show: "لم يحضر", cancelled: "أُلغي الموعد" });
    expect(TIMELINE_KIND_LABEL.referral).toBe("إحالة داخلية");
    expect(timelineGroupOf("referral")).toBe("clinical");
    for (const action of Object.keys(REFERRAL_TIMELINE_LABEL)) {
      expect(AUDIT_LABEL[action as keyof typeof AUDIT_LABEL]).toMatch(/[؀-ۿ]/);
    }
  });
});
