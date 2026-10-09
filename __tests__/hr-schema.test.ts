import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HR_STAFF_SQL } from "../lib/hr-schema";
import { HR_TASKS_SQL } from "../lib/hr-tasks-schema";
import { RESET_WIPE_TABLES, RESET_KEEP_TABLES } from "../lib/clinic-reset";

/**
 * (HR-1/HR-2) عقود مخطط الموارد البشرية والمهام — نفس حراسة الأنماط السابقة:
 * الهجرة جسدُ الثابت حرفيًّا، والإضافة خالصة، والتصنيف في إعادة الضبط مكتمل.
 */

describe("(HR-1) hr_staff schema", () => {
  it("keeps migration 0044 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0044_hr_staff.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(HR_STAFF_SQL.trim());
  });

  it("is additive only: two new tables, no DROP of data, no ALTER of existing tables", () => {
    expect(HR_STAFF_SQL).not.toMatch(/DROP\s+TABLE/i);
    expect(HR_STAFF_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    expect(HR_STAFF_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)?.map((m) => m.split(" ").pop())).toEqual([
      "hr_staff", "hr_staff_changes",
    ]);
  });

  it("the staff change log is append-only at the database level", () => {
    expect(HR_STAFF_SQL).toMatch(/CREATE OR REPLACE FUNCTION aqlan_hr_staff_changes_append_only/);
    expect(HR_STAFF_SQL).toMatch(/CREATE TRIGGER hr_staff_changes_append_only\s+BEFORE UPDATE OR DELETE ON hr_staff_changes/);
  });

  it("a linked login account is unique and optional — one account, one file, by decision not by name similarity", () => {
    expect(HR_STAFF_SQL).toMatch(/user_id\s+INTEGER\s+UNIQUE REFERENCES users\(id\)/);
  });

  it("a salary amount is stored with its currency, period and effective date — all three or none", () => {
    expect(HR_STAFF_SQL).toMatch(/CHECK \(\s*\(contract_kind = 'commission'\)\s+OR \(\s+contract_kind IN \('salary','salary_commission'\)/);
    expect(HR_STAFF_SQL).toMatch(/salary_amount_minor IS NOT NULL\s+AND salary_currency IS NOT NULL\s+AND salary_period IS NOT NULL\s+AND salary_effective_on IS NOT NULL/);
    expect(HR_STAFF_SQL).toMatch(/CHECK \(contract_kind <> 'commission' OR salary_amount_minor IS NULL\)/);
  });

  it("commission-only files hold no salary row, and staff files hold no commission engine", () => {
    expect(HR_STAFF_SQL).not.toMatch(/commission_percent/);
  });
});

describe("(HR-2) hr_tasks schema", () => {
  it("keeps migration 0045 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0045_hr_tasks.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(HR_TASKS_SQL.trim());
  });

  it("is additive only: five new tables", () => {
    expect(HR_TASKS_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)?.map((m) => m.split(" ").pop())).toEqual([
      "hr_tasks", "hr_task_links", "hr_task_checklist", "hr_task_comments", "hr_task_events",
    ]);
    expect(HR_TASKS_SQL).not.toMatch(/DROP\s+TABLE/i);
    expect(HR_TASKS_SQL).not.toMatch(/ALTER\s+TABLE/i);
  });

  it("a private task cannot carry an assignee — privacy is a database constraint, not a UI detail", () => {
    expect(HR_TASKS_SQL).toMatch(
      /CHECK \(is_private = FALSE OR \(assignee_staff_id IS NULL AND assignee_user_id IS NULL AND btrim\(assignee_label\) = ''\)\)/,
    );
  });

  it("completed/cancelled states and their timestamps are database-enforced", () => {
    expect(HR_TASKS_SQL).toMatch(/CHECK \(status <> 'completed' OR completed_at IS NOT NULL\)/);
    expect(HR_TASKS_SQL).toMatch(/CHECK \(status = 'completed' OR completed_at IS NULL\)/);
  });

  it("the task event log is append-only at the database level", () => {
    expect(HR_TASKS_SQL).toMatch(/CREATE OR REPLACE FUNCTION aqlan_hr_task_events_append_only/);
    expect(HR_TASKS_SQL).toMatch(/CREATE TRIGGER hr_task_events_append_only\s+BEFORE UPDATE OR DELETE ON hr_task_events/);
  });

  it("links are unique per task and record, and hold no money", () => {
    expect(HR_TASKS_SQL).toMatch(/UNIQUE \(task_id, link_kind, link_id\)/);
    expect(HR_TASKS_SQL).not.toMatch(/minor|amount|currency|balance|price/i);
  });
});

describe("(HR) clinic reset classification", () => {
  it("tasks and their children are wiped; staff files and their change log stay with users", () => {
    const wipe = new Set<string>(RESET_WIPE_TABLES);
    const keep = new Set<string>(RESET_KEEP_TABLES);
    for (const table of ["hr_task_events", "hr_task_comments", "hr_task_checklist", "hr_task_links", "hr_tasks"]) {
      expect(wipe.has(table)).toBe(true);
      expect(keep.has(table)).toBe(false);
    }
    for (const table of ["hr_staff", "hr_staff_changes"]) {
      expect(keep.has(table)).toBe(true);
      expect(wipe.has(table)).toBe(false);
    }
    // الأبناء قبل أبائهم في قائمة المسح (للقراءة؛ TRUNCATE واحد عمليًّا).
    const tables = [...RESET_WIPE_TABLES];
    for (const [child, parent] of [["hr_task_links", "hr_tasks"], ["hr_task_comments", "hr_tasks"]] as const) {
      expect(tables.indexOf(child)).toBeLessThan(tables.indexOf(parent));
    }
  });
});
