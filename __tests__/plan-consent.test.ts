import { describe, expect, it } from "vitest";
import { parseConsentSchedule } from "../lib/plan-consent";
const today = "2026-10-03";
describe("consent schedule intent before effects", () => {
  it.each([{}, { count: 0 }, { count: "0" }])("supports consent only: %j", (body) => {
    expect(parseConsentSchedule(body, today)).toEqual({ ok: true, schedule: null });
  });
  it("preserves numeric strings, rounding and clinic-date/interval defaults", () => {
    expect(parseConsentSchedule({ count: "2.6" }, today)).toEqual({ ok: true,
      schedule: { count: 3, everyDays: 30, firstDueDate: today } });
    expect(parseConsentSchedule({ count: "3", everyDays: "30", firstDueDate: "2028-02-29" }, today)).toEqual({
      ok: true, schedule: { count: 3, everyDays: 30, firstDueDate: "2028-02-29" } });
  });
  it.each([NaN, Infinity, -Infinity, -1, -0.1, 0.1, 61, "bad", "", " ", null, false, [], {}])(
    "rejects explicitly invalid count %j", (count) => expect(parseConsentSchedule({ count }, today).ok).toBe(false));
  it.each([0, -1, 366, NaN, Infinity, "bad", "", null, true, [], {}])(
    "rejects explicitly invalid interval %j", (everyDays) => expect(parseConsentSchedule({ count: 2, everyDays }, today).ok).toBe(false));
  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-10-00", "bad", "", "0099-01-01", null, 20261003])(
    "rejects explicitly invalid calendar date %j", (firstDueDate) => expect(parseConsentSchedule({ count: 2, firstDueDate }, today).ok).toBe(false));
  it("does not silently ignore malformed optional fields on consent-only", () => {
    expect(parseConsentSchedule({ count: 0, everyDays: 0 }, today).ok).toBe(false);
    expect(parseConsentSchedule({ firstDueDate: "2026-02-30" }, today).ok).toBe(false);
  });
});
