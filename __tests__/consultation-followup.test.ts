import { describe, expect, it } from "vitest";
import { followUpDaysFrom, proposalTiming, sortProposals } from "../lib/consultation-followup";
import { settingDefinition } from "../lib/settings-definitions";
import { SETTING_DEFAULTS, validateSetting } from "../lib/settings";

/** (P1-E) عروض العلاج بعد الكشف: متى يحين الاتصال — بمدّة الإعدادات، ودون أن يتغيّر مبلغ. */
describe("(P1-E) proposal follow-up timing", () => {
  const base = { today: "2026-10-01", followUpDays: 7 };

  it("fresh, due, stale and recently contacted", () => {
    expect(proposalTiming({ ...base, createdOn: "2026-09-28", lastContactOn: null })).toEqual({ stage: "fresh", ageDays: 3, daysSinceContact: null });
    expect(proposalTiming({ ...base, createdOn: "2026-09-24", lastContactOn: null }).stage).toBe("due");
    expect(proposalTiming({ ...base, createdOn: "2026-08-20", lastContactOn: null }).stage).toBe("stale");
    expect(proposalTiming({ ...base, createdOn: "2026-08-20", lastContactOn: "2026-09-29" })).toEqual({ stage: "contacted", ageDays: 42, daysSinceContact: 2 });
    /* تواصلٌ قديم لا يُسكت المتابعة. */
    expect(proposalTiming({ ...base, createdOn: "2026-09-10", lastContactOn: "2026-09-20" }).stage).toBe("due");
  });

  it("orders due first, then stale, contacted, fresh — oldest first inside each", () => {
    const row = (id: number, createdOn: string, lastContactOn: string | null = null) =>
      ({ id, timing: proposalTiming({ ...base, createdOn, lastContactOn }) });
    expect(sortProposals([row(1, "2026-09-30"), row(2, "2026-08-01"), row(3, "2026-09-20"), row(4, "2026-09-15"), row(5, "2026-09-01", "2026-09-30")])
      .map((one) => one.id)).toEqual([4, 3, 2, 5, 1]);
  });

  it("the follow-up period is a validated clinic setting (default 7 days)", () => {
    expect(SETTING_DEFAULTS["followup.proposal_days"]).toBe("7");
    expect(settingDefinition("followup.proposal_days")).toMatchObject({ category: "patient_workflow", type: "DURATION_DAYS", min: 1, max: 90 });
    expect(validateSetting("followup.proposal_days", "0")).toMatch(/[؀-ۿ]/);
    expect(validateSetting("followup.proposal_days", "14")).toBeNull();
    expect(followUpDaysFrom("abc")).toBe(7);
    expect(followUpDaysFrom("14")).toBe(14);
  });
});
