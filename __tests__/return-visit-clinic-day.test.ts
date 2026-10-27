import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clinicDateString } from "../lib/schedule";
import { friendlyDateLong } from "../lib/reminders";
import { CLINIC_ZONE_FALLBACK } from "../lib/clinicZone";

// Exercise the actual projection expressions: regressions to UTC slicing must
// fail behaviorally, not merely because a helper's spelling changed.
const db = readFileSync("lib/db.ts", "utf8");
const workflow = db.slice(db.indexOf("export async function patientWorkflow("));
const dateExpression = workflow.match(/id: rows\[0\]\.id, date: ([^\n]+),\n/)?.[1];
const tab = readFileSync("components/patient/TodayVisitTab.tsx", "utf8");
const historyExpression = tab.match(/\{friendlyDateLong\(([^\n]+)\)\}/g)?.find((text) => text.includes("visit.arrivedAt"));
function projectWorkflow(instant: string) {
  expect(dateExpression).toBeTruthy();
  return new Function("rows", "clinicDateString", "CLINIC_TIME_ZONE", `return ${dateExpression}`)(
    [{ id: 13, arrived_at: new Date(instant) }], clinicDateString, CLINIC_ZONE_FALLBACK);
}
function renderHistory(instant: string, timeZone?: string) {
  expect(historyExpression).toBeTruthy();
  return new Function("visit", "summary", "clinicDateString", "CLINIC_ZONE_FALLBACK", "friendlyDateLong",
    `return ${historyExpression!.slice(1, -1)}`)(
    { arrivedAt: instant }, { timeZone }, clinicDateString, CLINIC_ZONE_FALLBACK, friendlyDateLong);
}

describe("return visit presentation uses the clinic calendar day", () => {
  it.each([
    ["2026-10-25T20:59:59.000Z", "2026-10-25"],
    ["2026-10-25T21:00:00.000Z", "2026-10-26"],
    ["2026-10-25T21:02:00.000Z", "2026-10-26"],
    ["2026-10-25T12:00:00.000Z", "2026-10-25"],
  ])("projects %s consistently as %s", (instant, expected) => {
    expect.soft(projectWorkflow(instant)).toBe(expected);
    expect.soft(renderHistory(instant, "Asia/Aden")).toBe(friendlyDateLong(expected));
    expect(renderHistory(instant)).toBe(friendlyDateLong(expected));
  });
  it("honors the workflow timezone instead of the browser's calendar", () => {
    expect(renderHistory("2026-10-25T21:02:00.000Z", "UTC")).toBe(friendlyDateLong("2026-10-25"));
  });
  it("keeps already date-only latest-visit values as calendar dates", () => {
    expect(tab).toContain("friendlyDateLong(lastVisit.date)");
    const summary = readFileSync("components/patient/SummaryTab.tsx", "utf8");
    expect(summary).toContain("friendlyDateLong(summary.lastVisit.date)");
    expect(friendlyDateLong("2026-10-26")).toContain("26/10/2026");
  });
});
