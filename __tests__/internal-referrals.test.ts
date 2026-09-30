import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTERNAL_REFERRALS_SQL } from "../lib/internal-referrals-schema";
import {
  canActOnReferral, checkInternalReferralDraft, checkReferralTransition, legacyStatusOf, nextReferralState,
} from "../lib/referrals";

describe("(REF-1) internal referral schema", () => {
  it("keeps migration 0033 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0033_internal_referrals.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(INTERNAL_REFERRALS_SQL.trim());
  });

  it("is additive: no DROP, no data rewrite; existing rows default to external", () => {
    expect(INTERNAL_REFERRALS_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(INTERNAL_REFERRALS_SQL).not.toMatch(/^\s*(DELETE|UPDATE)\s/im);
    expect(INTERNAL_REFERRALS_SQL).toMatch(/kind TEXT NOT NULL DEFAULT 'external'/);
    expect(INTERNAL_REFERRALS_SQL).toMatch(/workflow_state IN \('completed', 'returned_to_referrer'\) AND status = 'completed'/);
  });
});

describe("(REF-1) lifecycle", () => {
  it("moves along the designed path only", () => {
    expect(nextReferralState("requested", "accept")).toBe("accepted");
    expect(nextReferralState("accepted", "schedule")).toBe("scheduled");
    expect(nextReferralState("scheduled", "schedule")).toBe("scheduled");
    expect(nextReferralState("scheduled", "complete")).toBe("completed");
    expect(nextReferralState("completed", "acknowledge")).toBe("returned_to_referrer");
    expect(nextReferralState("requested", "complete")).toBeNull();
    expect(nextReferralState("completed", "cancel")).toBeNull();
    expect(nextReferralState("declined", "accept")).toBeNull();
    expect(nextReferralState("scheduled", "decline")).toBeNull();
  });

  it("maps every workflow state onto the existing status", () => {
    expect(legacyStatusOf("scheduled")).toBe("sent");
    expect(legacyStatusOf("returned_to_referrer")).toBe("completed");
    expect(legacyStatusOf("declined")).toBe("cancelled");
  });

  it("who acts: receiver accepts/completes, referrer cancels/acknowledges, reception schedules, admin anything", () => {
    const base = { referringPartyId: 1, receivingPartyId: 2 };
    expect(canActOnReferral({ ...base, action: "accept", role: "doctor", actorPartyId: 2 })).toBe(true);
    expect(canActOnReferral({ ...base, action: "accept", role: "doctor", actorPartyId: 1 })).toBe(false);
    expect(canActOnReferral({ ...base, action: "complete", role: "reception", actorPartyId: null })).toBe(false);
    expect(canActOnReferral({ ...base, action: "schedule", role: "reception", actorPartyId: null })).toBe(true);
    expect(canActOnReferral({ ...base, action: "cancel", role: "doctor", actorPartyId: 1 })).toBe(true);
    expect(canActOnReferral({ ...base, action: "cancel", role: "doctor", actorPartyId: 2 })).toBe(false);
    expect(canActOnReferral({ ...base, action: "acknowledge", role: "doctor", actorPartyId: 1 })).toBe(true);
    expect(canActOnReferral({ ...base, action: "complete", role: "admin", actorPartyId: null })).toBe(true);
  });

  it("validates drafts and steps with Arabic messages", () => {
    expect(checkInternalReferralDraft({ toSpecialty: "endodontics", reason: "عصب ٢١" })).toEqual({ ok: false, message: "اختر الطبيب المحال إليه داخل المركز." });
    expect(checkInternalReferralDraft({ toPartyId: "5", toSpecialty: "endodontics", reason: "علاج عصب 21", teeth: "21", blocksCaseId: 3 }))
      .toMatchObject({ ok: true, value: { toPartyId: 5, teeth: "21", blocksCaseId: 3, caseId: null, requestedServiceId: null } });
    expect(checkInternalReferralDraft({ toPartyId: 5, toSpecialty: "endodontics", reason: "علاج عصب", requestedServiceId: "7" }))
      .toMatchObject({ ok: true, value: { requestedServiceId: 7 } });
    expect(checkInternalReferralDraft({ toPartyId: 5, toSpecialty: "endodontics", reason: "علاج عصب", requestedServiceId: -1 }))
      .toEqual({ ok: false, message: "رابط الحالة أو البند أو الخدمة غير صالح." });
    expect(checkInternalReferralDraft({ toPartyId: 5, toSpecialty: "endodontics", reason: "x x x", caseId: "abc" })).toMatchObject({ ok: false });
    expect(checkReferralTransition({ action: "decline" })).toEqual({ ok: false, message: "اكتب سبب الاعتذار عن الإحالة." });
    expect(checkReferralTransition({ action: "schedule" })).toEqual({ ok: false, message: "اختر موعد الإحالة." });
    expect(checkReferralTransition({ action: "complete" })).toEqual({ ok: false, message: "اكتب ما أُنجز للمريض ليعود إلى المحيل." });
    expect(checkReferralTransition({ action: "complete", procedurePerformed: "حشو قنوات 21", followupRequired: true }))
      .toMatchObject({ ok: true, value: { procedurePerformed: "حشو قنوات 21", followupRequired: true, mayReturn: null } });
    expect(checkReferralTransition({ action: "fly" })).toMatchObject({ ok: false });
  });
});
