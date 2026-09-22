import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCTOR_COMMISSION_HISTORY_SQL } from "../lib/commission-history-schema";

/**
 * (P0-1) مسارا المخطط لا يفترقان: جسد الهجرة 0012 هو النص الذي ينفّذه
 * `ensureSchema()` حرفيًّا. افتراقهما يولّد فرقًا جديدًا في توصيف ملكية المخطط
 * (أجساد الدوال تُقارَن حرفيًّا) — فيُسقط البناء هنا قبل أن يصل إلى هناك.
 */
describe("سجل عمولات الأطباء — مصدرٌ واحد لمسارَي المخطط", () => {
  it("جسد migrations/0012 = DOCTOR_COMMISSION_HISTORY_SQL حرفيًّا (بعد ترويسة التعليقات)", () => {
    const migration = readFileSync("migrations/0012_doctor_commission_history.sql", "utf8");
    const lines = migration.split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    const body = `${lines.slice(index).join("\n").replace(/\n+$/, "")}\n`;
    expect(body).toBe(DOCTOR_COMMISSION_HISTORY_SQL);
  });

  it("السجل append-only والبذر حتمي ولا يختلق تاريخًا", () => {
    expect(DOCTOR_COMMISSION_HISTORY_SQL).toMatch(/BEFORE UPDATE ON doctor_commission_history/);
    expect(DOCTOR_COMMISSION_HISTORY_SQL).toMatch(/BEFORE DELETE ON doctor_commission_history/);
    expect(DOCTOR_COMMISSION_HISTORY_SQL).toMatch(/TIMESTAMPTZ '1970-01-01 00:00:00\+00', 'baseline'/);
    expect(DOCTOR_COMMISSION_HISTORY_SQL).toMatch(/ORDER BY u\.id DESC/);
    expect(DOCTOR_COMMISSION_HISTORY_SQL).toMatch(/NOT EXISTS \(SELECT 1 FROM doctor_commission_history h WHERE h\.party_id = p\.id\)/);
  });
});
