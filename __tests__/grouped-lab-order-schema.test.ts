/** Migration 0136 (grouped lab orders, owner #483 6930647956 / 6931868779 / 6932010630): the numbered file and the
 * runtime constant are one text; it only adds (no row rewrite, no data removal, the published 0074 triggers stay);
 * the per-tooth price snapshots are append-only lab history that a clinic reset protects. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROUPED_LAB_ORDER_SQL } from "../lib/grouped-lab-order-schema";
import { LAB_HISTORY_TABLES, RESET_KEEP_TABLES } from "../lib/clinic-reset";

describe("grouped lab order schema (0136)", () => {
  it("the numbered migration is byte-for-byte the runtime SQL", () => {
    expect(readFileSync(new URL("../migrations/0136_grouped_lab_orders.sql", import.meta.url), "utf8")).toBe(GROUPED_LAB_ORDER_SQL);
  });

  it("is registered at runtime under 0136 with the checksum of the same text", () => {
    const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    expect(source).toContain('{ version: "0136", name: "grouped_lab_orders", filename: "0136_grouped_lab_orders.sql", sql: GROUPED_LAB_ORDER_SQL, checksum: checksumOf(GROUPED_LAB_ORDER_SQL) }');
  });

  it("only adds: no row rewrite, no data removal, no change to the published 0074 trigger functions", () => {
    const sql = GROUPED_LAB_ORDER_SQL;
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION)\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+aqlan_lab_(member_scope|member_graph|member_immutable|intent_immutable|order_graph|append_only)\s*\(/);
    // The only constraint replaced is the kind list, widened to admit 'grouped'.
    expect(sql).toContain("CHECK (group_kind IN ('single','bridge','grouped'))");
  });

  it("per-tooth price snapshots are append-only and protected by a clinic reset like the rest of lab history", () => {
    expect(GROUPED_LAB_ORDER_SQL).toMatch(/BEFORE UPDATE OR DELETE ON lab_order_member_prices\s+FOR EACH ROW EXECUTE FUNCTION aqlan_lab_append_only\(\)/);
    expect(LAB_HISTORY_TABLES).toContain("lab_order_member_prices");
    expect(RESET_KEEP_TABLES).toContain("lab_order_member_prices");
  });
});
