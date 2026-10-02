import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENDODONTICS_SQL } from "../lib/endodontics-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("(ENDO-1) endodontics schema", () => {
  it("keeps migration 0040 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0040_endodontics.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(ENDODONTICS_SQL.trim());
  });

  it("is additive only: four new tables, no DROP, no rewrite of existing data or columns", () => {
    expect(ENDODONTICS_SQL).not.toMatch(/DROP\s/i);
    expect(ENDODONTICS_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    expect(ENDODONTICS_SQL).not.toMatch(/ALTER TABLE/i);
    expect(ENDODONTICS_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)?.map((m) => m.split(" ").pop())).toEqual([
      "endo_treatments", "endo_visits", "endo_canal_records", "endo_addenda",
    ]);
  });

  it("holds no money: billing stays on visit_procedures / plan_items", () => {
    expect(ENDODONTICS_SQL).not.toMatch(/minor|amount|currency|balance|price/i);
  });

  it("every link is RESTRICT (clinical history is never silently cascaded away) except the optional crown item", () => {
    expect(ENDODONTICS_SQL).not.toMatch(/ON DELETE CASCADE/i);
    expect(ENDODONTICS_SQL).toMatch(/crown_plan_item_id INTEGER\s+REFERENCES plan_items\(id\) ON DELETE SET NULL/);
  });

  it("one active episode per tooth and one record per visit and per canal are database-enforced", () => {
    expect(ENDODONTICS_SQL).toMatch(/endo_treatments_one_active_tooth_idx\s+ON endo_treatments \(patient_id, tooth_code\) WHERE status = 'in_progress'/);
    expect(ENDODONTICS_SQL).toMatch(/UNIQUE \(treatment_id, visit_id\)/);
    expect(ENDODONTICS_SQL).toMatch(/UNIQUE \(endo_visit_id, canal_label\)/);
  });

  it("factory reset wipes endo tables children-first, before patients", () => {
    const wipe: readonly string[] = RESET_WIPE_TABLES;
    const order = ["endo_addenda", "endo_canal_records", "endo_visits", "endo_treatments"].map((t) => wipe.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[3]).toBeLessThan(wipe.indexOf("patients"));
  });
});
