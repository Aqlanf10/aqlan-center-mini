/** Migration 0126 (doctors sharing a case, owner decision 2026-11-11): the numbered file and the
 * runtime constant are one text, the table is additive, append-only and wiped with its cases. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMISSION_CASE_PARTICIPATIONS_SQL } from "../lib/commission-participation-schema";
import { RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("commission case participations schema (0126)", () => {
  it("the numbered migration is byte-for-byte the runtime SQL", () => {
    expect(readFileSync(new URL("../migrations/0126_commission_case_participations.sql", import.meta.url), "utf8")).toBe(COMMISSION_CASE_PARTICIPATIONS_SQL);
  });

  it("is registered at runtime under 0126 with the checksum of the same text", () => {
    const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    expect(source).toContain('{ version: "0126", name: "commission_case_participations", filename: "0126_commission_case_participations.sql", sql: COMMISSION_CASE_PARTICIPATIONS_SQL, checksum: checksumOf(COMMISSION_CASE_PARTICIPATIONS_SQL) }');
  });

  it("is additive: creates its own table, functions, indexes and trigger and alters nothing else", () => {
    const sql = COMMISSION_CASE_PARTICIPATIONS_SQL;
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b|\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION)\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\b/i);
    expect([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(match => match[1])).toEqual(["commission_case_participations"]);
    expect([...sql.matchAll(/DROP TRIGGER IF EXISTS (\w+) ON (\w+)/g)].map(match => [match[1], match[2]]))
      .toEqual([["commission_case_participations_append_only", "commission_case_participations"]]);
  });

  it("an approved split must add up to 100%, anything else carries no participants, and nothing is updated or deleted", () => {
    const sql = COMMISSION_CASE_PARTICIPATIONS_SQL;
    expect(sql).toContain("WHEN 'approved' THEN aqlan_commission_participants_total_bp(participants) = 10000");
    expect(sql).toContain("ELSE participants = '[]'::jsonb END");
    expect(sql).toContain("CHECK (status <> 'void' OR supersedes_id IS NOT NULL)");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON commission_case_participations");
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS commission_case_participations_supersedes_uniq/);
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS commission_case_participations_root_uniq/);
  });

  it("is wiped with its cases on a clinic reset, before them", () => {
    const wipe: readonly string[] = RESET_WIPE_TABLES;
    expect(wipe).toContain("commission_case_participations");
    expect(wipe.indexOf("commission_case_participations")).toBeLessThan(wipe.indexOf("clinical_cases"));
    expect(RESET_KEEP_TABLES as readonly string[]).not.toContain("commission_case_participations");
  });
});
