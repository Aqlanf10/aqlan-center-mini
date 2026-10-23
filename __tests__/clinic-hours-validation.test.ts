import { describe, expect, it } from "vitest";
import { validateSettingSet, validateTypedSetting } from "../lib/settings-validate";
const tuple = (start = "09:00", end = "13:00", secondStart = "16:00", secondEnd = "21:00") => ({
  "clinic.day_start": start, "clinic.day_end": end, "clinic.shift2_start": secondStart, "clinic.shift2_end": secondEnd,
});
describe("clinic hours tuple", () => {
  it("allows empty second times only", () => {
    expect(validateTypedSetting("clinic.shift2_start", "")).toBeNull();
    expect(validateTypedSetting("clinic.shift2_end", "  ")).toBeNull();
    expect(validateTypedSetting("clinic.day_start", "")).not.toBeNull();
    expect(validateTypedSetting("clinic.day_end", "")).not.toBeNull();
  });
  it("accepts complete continuous, split and adjacent same-day periods", () => {
    for (const value of [tuple(), tuple("09:00", "21:00", "", ""), tuple("09:00", "13:00", "13:00", "21:00")]) {
      expect(validateSettingSet(value, {})).toBeNull();
    }
  });
  it.each([
    tuple("09:00", "13:00", "16:00", ""), tuple("09:00", "13:00", "", "21:00"),
    tuple("09:00", "13:00", "21:00", "16:00"), tuple("09:00", "13:00", "16:00", "16:00"),
    tuple("09:00", "13:00", "12:00", "21:00"), tuple("09:00", "13:00", "07:00", "08:00"),
    tuple("21:00", "09:00", "", ""), tuple("09:00", "13:00", "bad", "21:00"),
  ])("rejects invalid tuples %j", (value) => expect(validateSettingSet(value, {})).not.toBeNull());
  it("rejects partial writes even when individually consistent, so all versions guard the tuple", () => {
    for (const key of Object.keys(tuple())) expect(validateSettingSet({ [key]: tuple()[key as keyof ReturnType<typeof tuple>] }, tuple())).not.toBeNull();
  });
  it("does not make unrelated edits repair legacy invalid hours", () => {
    expect(validateSettingSet({ "clinic.name": "Clinic" }, tuple("21:00", "09:00"))).toBeNull();
  });
});
