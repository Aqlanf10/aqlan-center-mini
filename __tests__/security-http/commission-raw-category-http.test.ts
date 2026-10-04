import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import type { CommissionDetailLine } from "../../lib/commission";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const stamp = Date.now();
let seq = 0;
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
}, 240_000);
afterAll(async () => { await db?.end(); });

describe("authorized raw service category creation to actual commission report", () => {
  it.each([
    { category: "constructor", rates: "{}", percent: 17, rule: "default" },
    { category: "toString", rates: "{}", percent: 17, rule: "default" },
    { category: "__proto__", rates: "{}", percent: 17, rule: "default" },
    { category: "constructor", rates: '{"constructor":0}', percent: 0, rule: "category" },
    { category: "__proto__", rates: '{"__proto__":42}', percent: 42, rule: "category" },
    { category: "endo", rates: '{"endo":72}', percent: 72, rule: "category" },
    { category: "rct", rates: '{"endo":72}', percent: 17, rule: "default" },
    { category: "custom_raw", rates: '{"custom_raw":41}', percent: 41, rule: "category" },
    { category: "constructor", rates: '{"constructor":0}', percent: 83, rule: "custom_service" },
    { category: "constructor", rates: "{}", percent: 17, rule: "default", basis: "collected_cash" as const },
  ])("$category with $rates produces finite $percent% ($rule) without changing historical facts", async ({ category, rates, percent, rule, basis = "invoiced" }) => {
    const suffix = `${stamp}-${++seq}`;
    const created = await authedMutation("/api/services", h.sessions.admin, "POST", JSON.stringify({ name: `خدمة فئة خام ${suffix}`, category, price: "10000" }));
    expect(created.status).toBe(201);
    const service = await created.json() as { id: number; category: string; name: string };
    expect(service.category).toBe(category);
    try {
      const storedConfig = JSON.stringify({ calculationMode: "by_category", defaultPercent: 17, categoryRates: JSON.parse(rates),
        deductLabCost: false, deductMaterialCost: false, basis,
        customServiceRates: rule === "custom_service" ? [{ id: "specific", serviceId: service.id, serviceName: service.name, percent: 83 }] : [] });
      const { rows: [party] } = await db.query<{ id: number }>(`INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', 20) RETURNING id`, [`طبيب فئة خام ${suffix}`]);
      const { rows: [user] } = await db.query<{ id: number }>(`INSERT INTO users (username, display_name, password_hash, role, party_id, commission_config)
        VALUES ($1, $1, 'unused-synthetic-hash', 'doctor', $2, $3) RETURNING id`, [`raw-${suffix}`, party.id, storedConfig]);
      await db.query(`INSERT INTO doctor_commission_history (party_id, percent, config, effective_from, source, reason, recorded_by)
        VALUES ($1, 20, $2::jsonb, '1970-01-01', 'baseline', 'synthetic existing history', 'test')`, [party.id, storedConfig]);
      const { rows: [patient] } = await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض فئة خام') RETURNING id`, [`RAW-${suffix}`]);
      const { rows: [invoice] } = await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
        VALUES ($1, $2, 10000, 0, 'YER', 'test', '2024-06-10 09:00+03') RETURNING id`, [`RAW-I-${suffix}`, patient.id]);
      const { rows: [visit] } = await db.query<{ id: number }>(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
        VALUES ('مريض فئة خام', $1, $2, 'done', $3, '2024-06-10 09:00+03', '2024-06-10 09:00+03', 'test') RETURNING id`, [patient.id, party.id, invoice.id]);
      const { rows: [procedure] } = await db.query<{ id: number }>(`INSERT INTO visit_procedures (visit_id, service_id, doctor_id, quantity, unit_price_minor)
        VALUES ($1, $2, $3, 1, 10000) RETURNING id`, [visit.id, service.id, party.id]);
      await db.query(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id, source_type, source_id)
        VALUES ($1, $2, 'عمل فئة خام', 1, 10000, 10000, $3, 'visit_procedure', $4)`, [invoice.id, service.id, party.id, procedure.id]);
      const { rows: [shift] } = await db.query<{ id: number }>(`INSERT INTO cashier_shifts (opened_by, status, opened_at, closed_at, closed_by)
        VALUES ('test', 'closed', '2024-06-10 08:00+03', '2024-06-10 10:00+03', 'test') RETURNING id`);
      await db.query(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
        exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
        VALUES ($1, $2, $3, $4, 'payment', 5000, 'YER', 1, 5000, 'YER', 'cash', 'test', '2024-06-10 09:00+03')`, [`RAW-P-${suffix}`, patient.id, invoice.id, shift.id]);
      const snapshot = async () => (await db.query(`SELECT jsonb_build_object(
        'config_text', (SELECT commission_config FROM users WHERE id=$1),
        'history', (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM doctor_commission_history h WHERE party_id=$2),
        'invoice', (SELECT to_jsonb(i) FROM invoices i WHERE id=$3),
        'items', (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i WHERE invoice_id=$3),
        'visit', (SELECT to_jsonb(v) FROM visits v WHERE id=$4),
        'procedures', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM visit_procedures p WHERE visit_id=$4),
        'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id), '[]') FROM payments p WHERE patient_id=$5)
      ) AS facts`, [user.id, party.id, invoice.id, visit.id, patient.id])).rows;
      const before = await snapshot();
      const response = await authedGet(`/api/finance/commissions?detail=1&from=2024-01-01&to=2024-12-31&doctorId=${party.id}`, h.sessions.admin);
      expect(response.status).toBe(200);
      const body = await response.json() as { lines: CommissionDetailLine[]; rows: Array<{ doctorId: number; accruedMinor: number; earnedMinor: number }> };
      const lines = body.lines.filter(line => line.invoiceId === invoice.id);
      expect(lines).toHaveLength(1);
      const earnedMinor = basis === "collected_cash" ? percent * 50 : percent * 100;
      expect(lines[0]).toMatchObject({ category, percent, ruleSource: rule, basis, accruedMinor: percent * 100, earnedMinor });
      for (const field of [lines[0].percent, lines[0].accruedMinor, lines[0].earnedMinor]) expect(Number.isFinite(field)).toBe(true);
      const doctorRows = body.rows.filter(row => row.doctorId === party.id);
      // The existing summary omits all-zero currencies; detail still records
      // the explicit zero policy and its exact finite amounts above.
      if (percent === 0) expect(doctorRows).toEqual([]);
      else expect(doctorRows).toHaveLength(1);
      expect(doctorRows.reduce((total, row) => total + row.accruedMinor, 0)).toBe(percent * 100);
      expect(doctorRows.reduce((total, row) => total + row.earnedMinor, 0)).toBe(earnedMinor);
      expect(await snapshot()).toEqual(before);
      expect(before[0].facts.config_text).toBe(storedConfig);
    } finally {
      // Retain every synthetic historical fact and its raw category. Retire only
      // this owned catalogue fixture so later patient selectors are unaffected.
      await db.query(`UPDATE services SET is_active = false WHERE id = $1`, [service.id]);
    }
  });
});
