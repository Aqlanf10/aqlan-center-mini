import { expect, it, vi } from "vitest";
import { isCanonicalProposalFeed } from "../lib/canonical-proposal-projection";
import { proposalContactVersion } from "../lib/canonical-proposal-version";
vi.mock("server-only", () => ({}));
const { canonicalProposalQuery } = await import("../lib/canonical-proposals");
const row = { planId: 1, patientId: 2, patientName: "SYN", patientPhone: null, title: "SYN", doctorName: null, createdOn: "2026-10-01", lastContactOn: null, items: 1, timing: { stage: "due", ageDays: 8, daysSinceContact: null }, contactVersion: "a".repeat(64) };
const feed = { projection: "pending-plan-proposals", proposals: [row], followUpDays: 7, today: "2026-10-09", hasMore: false, limit: 300, canSeeMoney: false };
it("accepts only bounded scoped summary shape and explicit money projection", () => {
  expect(isCanonicalProposalFeed(feed)).toBe(true);
  expect(isCanonicalProposalFeed({ ...feed, canSeeMoney: true, proposals: [{ ...row, money: { totalMinor: 123, currency: "SAR" } }] })).toBe(true);
});
it.each([{ canSeeMoney: true }, { limit: 301 }, { followUpDays: 0 }, { proposals: Array(301).fill(row) }, { today: null }, { proposals: [{ ...row, money: { totalMinor: 123, currency: "YER" } }] }, { proposals: [{ ...row, planId: 0 }] }, { proposals: [{ ...row, contactVersion: "abc" }] }, { proposals: [{ ...row, timing: { stage: "invented" } }] }])("rejects malformed or hidden projection %j", patch => { expect(isCanonicalProposalFeed({ ...feed, ...patch })).toBe(false); });
it.each(["patientId=1", "scope=all", "money=1", "limit=1", "doctor=1"])("refuses caller expansion %s", value => { expect(() => canonicalProposalQuery(new URLSearchParams(value))).toThrow(); });
it("contact observation changes with plan identity or contact history, not an invented request receipt", () => {
  const source = { planId: 1, planXmin: "100", planTid: "(0,1)", contactCount: "0", contactId: null, contactEpoch: null }, version = proposalContactVersion(source);
  expect(version).toMatch(/^[a-f0-9]{64}$/); expect(proposalContactVersion({ ...source })).toBe(version);
  for (const changed of [{ planXmin: "101" }, { planTid: "(0,2)" }, { contactCount: "1" }, { contactId: "9007199254740993" }, { contactEpoch: "123456.1" }]) expect(proposalContactVersion({ ...source, ...changed })).not.toBe(version);
});
