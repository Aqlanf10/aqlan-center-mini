import { expect, it } from "vitest";
import { APPOINTMENT_FOLLOWUP_RESET_KEEP_TABLES, APPOINTMENT_FOLLOWUP_RESET_WIPE_TABLES,
  RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";

it("candidate reset classification wipes only links and retains the three history tables", () => {
  expect(APPOINTMENT_FOLLOWUP_RESET_WIPE_TABLES).toEqual(["appointment_followup_links"]);
  expect(APPOINTMENT_FOLLOWUP_RESET_KEEP_TABLES).toEqual([
    "appointment_followups", "appointment_followup_events", "appointment_followup_receipts",
  ]);
  const wipe = new Set<string>([...RESET_WIPE_TABLES, ...APPOINTMENT_FOLLOWUP_RESET_WIPE_TABLES]);
  const keep = new Set<string>([...RESET_KEEP_TABLES, ...APPOINTMENT_FOLLOWUP_RESET_KEEP_TABLES]);
  expect([...wipe].filter(table => keep.has(table))).toEqual([]);
});
it("registers followup tables with the additive runtime migration", () => {
  const active = new Set<string>([...RESET_WIPE_TABLES, ...RESET_KEEP_TABLES]);
  for (const table of [...APPOINTMENT_FOLLOWUP_RESET_WIPE_TABLES, ...APPOINTMENT_FOLLOWUP_RESET_KEEP_TABLES]) {
    expect(active.has(table)).toBe(true);
  }
});
