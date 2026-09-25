import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P2-7) دمج ملفٍّ مكرَّر على PostgreSQL 18 الحقيقي.
 *
 * العيب (تدقيق الجاهزية): التكرار تحذيرٌ فقط ولا أداة دمج — فيبقى تاريخ المريض نصفين.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, mergeDuplicatePatient } = await import("../../lib/db");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function patient(number: string, extra: { phone?: string | null; alert?: string | null; birthYear?: number | null } = {}) {
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone, medical_alert, birth_year)
     VALUES ($1, 'محمد أحمد', $2, $3, $4) RETURNING id`,
    [number, extra.phone ?? null, extra.alert ?? null, extra.birthYear ?? null],
  );
  return row.id;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("mergeDuplicatePatient", () => {
  it("moves visits and appointments, keeps both medical alerts and the other phone, deletes the duplicate", async () => {
    const target = await patient("M-001", { phone: "967777000001", alert: "حساسية بنسلين" });
    const source = await patient("M-002", { phone: "967777000002", alert: "سكري", birthYear: 1990 });
    await q(`INSERT INTO visits (patient_id, patient_name, status) VALUES ($1, 'محمد', 'done')`, [source]);
    await q(`INSERT INTO appointments (patient_id, scheduled_date, scheduled_time) VALUES ($1, CURRENT_DATE + 7, '10:00')`, [source]);

    const result = await mergeDuplicatePatient(source, target, { actor: "admin", reason: "تكرار" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.moved["visits.patient_id"]).toBe(1);
    expect(result.moved["appointments.patient_id"]).toBe(1);
    expect(result.target.medicalAlert).toBe("حساسية بنسلين؛ سكري");
    expect(result.target.altPhone).toBe("967777000002");
    expect(result.target.birthYear).toBe(1990);

    expect(await q(`SELECT id FROM patients WHERE id = $1`, [source])).toHaveLength(0);
    expect(await q(`SELECT id FROM visits WHERE patient_id = $1`, [target])).toHaveLength(1);
    expect(await q(`SELECT id FROM appointments WHERE patient_id = $1`, [target])).toHaveLength(1);
    const [audit] = await q<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_log WHERE action = 'patient.merge' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit?.details["السبب"]).toBe("تكرار");
  });

  it("P2-8 fields of the duplicate fill the original's gaps", async () => {
    const target = await patient("M-031", { birthYear: 2014 });
    const source = await patient("M-032");
    await q(
      `UPDATE patients SET birth_date = '2014-03-02', guardian_name = 'علي', guardian_phone = '967777000009', national_id = 'A1'
        WHERE id = $1`, [source],
    );
    const result = await mergeDuplicatePatient(source, target, { actor: "admin" });
    expect(result.ok && result.target).toMatchObject({
      birthDate: "2014-03-02", guardianName: "علي", guardianPhone: "967777000009", nationalId: "A1",
    });
  });

  it("a duplicate with payments is refused and nothing moves", async () => {
    const target = await patient("M-011");
    const source = await patient("M-012");
    await q(`INSERT INTO visits (patient_id, patient_name, status) VALUES ($1, 'محمد', 'done')`, [source]);
    const [shift] = await q<{ id: number }>(`INSERT INTO cashier_shifts (opened_by) VALUES ('merge') RETURNING id`);
    await q(
      `INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method)
       VALUES ('R-MERGE-1', $1, $2, 'payment', 1000, 'YER', 1, 1000, 'YER', 'cash')`,
      [source, shift.id],
    );
    const result = await mergeDuplicatePatient(source, target, { actor: "admin" });
    expect(result).toMatchObject({ ok: false, reason: "source_has_financial_history" });
    expect(await q(`SELECT id FROM patients WHERE id = $1`, [source])).toHaveLength(1);
    expect(await q(`SELECT id FROM visits WHERE patient_id = $1`, [source])).toHaveLength(1);
  });

  it("refuses merging a file into itself or into a missing file", async () => {
    const one = await patient("M-021");
    expect(await mergeDuplicatePatient(one, one, { actor: "admin" })).toMatchObject({ ok: false, reason: "same_patient" });
    expect(await mergeDuplicatePatient(999_999, one, { actor: "admin" })).toMatchObject({ ok: false, reason: "not_found" });
  });
});
