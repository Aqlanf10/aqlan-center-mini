import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { loadDailyClinicReportSource } from "../../lib/daily-clinic-report";
import { buildDailyClinicReport } from "../../lib/daily-clinic-report-model";

// Synthetic, local PostgreSQL query contract. Every table is private to this connection.
const connectionString = assertRealPostgresUrl();
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)) {
  throw new Error("Daily-clinic source fixtures require an explicitly local PostgreSQL test target.");
}
const client = new Client({ connectionString, ssl: false });
beforeAll(async () => {
  await client.connect();
  await client.query(`
    CREATE TEMP TABLE patients (id integer PRIMARY KEY, full_name text, patient_number text);
    CREATE TEMP TABLE parties (id integer PRIMARY KEY, name text, kind text);
    CREATE TEMP TABLE planned_visits (id integer PRIMARY KEY, plan_id integer);
    CREATE TEMP TABLE visits (id integer PRIMARY KEY, patient_id integer, patient_name text,
      arrived_at timestamptz, signed_at timestamptz, billing_currency text, treatment_done text,
      doctor_id integer, planned_visit_id integer);
    CREATE TEMP TABLE services (id integer PRIMARY KEY, name text);
    CREATE TEMP TABLE treatment_plans (id integer PRIMARY KEY, patient_id integer, title text,
      status text, consent_at timestamptz, base_currency text, total_minor bigint);
    CREATE TEMP TABLE plan_installments (id integer PRIMARY KEY, plan_id integer);
    CREATE TEMP TABLE plan_items (id integer PRIMARY KEY, plan_id integer, service_name text,
      quantity integer, unit_price_minor bigint, status text, visit_id integer, done_at timestamptz,
      case_id integer, tooth_code integer);
    CREATE TEMP TABLE visit_procedures (id integer PRIMARY KEY, visit_id integer, service_id integer,
      quantity integer, tooth_code integer, doctor_id integer, plan_item_id integer, unit_price_minor bigint);
    CREATE TEMP TABLE ortho_cases (id integer PRIMARY KEY, patient_id integer, plan_id integer, responsible_doctor_id integer);
    CREATE TEMP TABLE ortho_adjustments (id integer PRIMARY KEY, case_id integer, visit_id integer, done text);
    CREATE TEMP TABLE endo_treatments (id integer PRIMARY KEY, patient_id integer, tooth_code integer);
    CREATE TEMP TABLE endo_visits (id integer PRIMARY KEY, treatment_id integer, visit_id integer, stage text, doctor_id integer);
    CREATE TEMP TABLE treatment_sessions (id integer PRIMARY KEY, visit_id integer, plan_item_id integer);
    CREATE TEMP TABLE invoices (id integer PRIMARY KEY, patient_id integer, base_currency text,
      total_minor bigint, discount_minor bigint, status text, plan_id integer,
      invoice_number text, created_at timestamptz DEFAULT '2020-09-01 08:00+00');
    CREATE TEMP TABLE invoice_items (id integer PRIMARY KEY, invoice_id integer, description text,
      total_minor bigint, plan_item_id integer);
    CREATE TEMP TABLE audit_log (id integer PRIMARY KEY, action text, entity text, entity_id text,
      details jsonb, actor text, created_at timestamptz);
    CREATE TEMP TABLE legacy_treatment_agreements (id integer PRIMARY KEY, patient_id integer, service_name text,
      specialty text, tooth_code integer, currency text, agreed_minor bigint, previously_paid_minor bigint,
      remaining_minor bigint, historical_as_of date, status text, void_reason text, plan_item_id integer, case_id integer);
    CREATE TEMP TABLE legacy_treatment_coverage_snapshots (agreement_id integer PRIMARY KEY,
      snapshot_tooth_codes smallint[], snapshot_scope text);
    CREATE TEMP TABLE payments (id integer PRIMARY KEY, patient_id integer, receipt_number text,
      invoice_id integer, plan_id integer, opening_currency text, currency text, amount_minor bigint,
      base_amount_minor bigint, exchange_rate numeric, kind text, method text, created_at timestamptz, reversal_of_id integer);
    CREATE TEMP TABLE patient_opening_balances (patient_id integer, currency text, amount_minor bigint);
    CREATE TEMP TABLE payables (id integer PRIMARY KEY, party_id integer, source_type text);
    CREATE TEMP TABLE expense_categories (id integer PRIMARY KEY, key text, name text);
    CREATE TEMP TABLE expenses (id integer PRIMARY KEY, voucher_number text, created_at timestamptz,
      shift_id integer, category text, party_id integer, payee_text text, amount_minor bigint, currency text,
      reversal_of_id integer, payable_id integer, note text, created_by text);
    CREATE TEMP TABLE expense_payable_allocations (id integer PRIMARY KEY, expense_id integer,
      payable_id integer, paid_minor bigint, payable_currency text, settled_minor bigint);
  `);
});
beforeEach(async () => {
  await client.query(`TRUNCATE pg_temp.patients,pg_temp.parties,pg_temp.planned_visits,pg_temp.visits,
    pg_temp.services,pg_temp.treatment_plans,pg_temp.plan_installments,pg_temp.plan_items,pg_temp.visit_procedures,
    pg_temp.ortho_cases,pg_temp.ortho_adjustments,pg_temp.endo_treatments,pg_temp.endo_visits,pg_temp.treatment_sessions,
    pg_temp.invoices,pg_temp.invoice_items,pg_temp.audit_log,pg_temp.legacy_treatment_agreements,
    pg_temp.legacy_treatment_coverage_snapshots,pg_temp.payments,pg_temp.patient_opening_balances,pg_temp.payables,pg_temp.expense_categories,
    pg_temp.expenses,pg_temp.expense_payable_allocations`);
});
afterAll(async () => { await client.end(); });

async function read(date = "2020-10-07", zone = "Asia/Aden") {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    return buildDailyClinicReport(await loadDailyClinicReportSource(client, date, zone));
  } finally { await client.query("ROLLBACK"); }
}

describe("daily clinic bulk source on PostgreSQL", () => {
  it("uses arrival-day cohort, includes zero-money visits, and never multiplies one patient's money", async () => {
    await client.query(`
      INSERT INTO pg_temp.patients VALUES (1,'synthetic attendee','P1'),(2,'synthetic payment only','P2');
      INSERT INTO pg_temp.parties VALUES (7,'synthetic doctor','doctor');
      INSERT INTO pg_temp.treatment_plans VALUES (10,1,'documented agreement','active','2020-10-01','SAR',5000);
      INSERT INTO pg_temp.plan_installments VALUES (1,10);
      INSERT INTO pg_temp.planned_visits VALUES (100,10);
      INSERT INTO pg_temp.visits VALUES
        (1,1,'attendee','2020-10-06 21:00+00','2020-10-07 09:00+00','YER','documented',7,100),
        (2,1,'attendee','2020-10-07 20:00+00',NULL,'YER',NULL,7,100),
        (3,NULL,'walk-in without file','2020-10-07 08:00+00',NULL,NULL,NULL,NULL,NULL),
        (4,1,'outside day','2020-10-07 21:00+00',NULL,'YER',NULL,7,NULL);
      INSERT INTO pg_temp.payments VALUES
        (1,1,'R1',NULL,10,NULL,'SAR',1000,12000,120,'payment','cash','2020-10-07 10:00+00',NULL),
        (2,2,'R2',NULL,NULL,NULL,'YER',300,300,1,'payment','transfer','2020-10-07 11:00+00',NULL);
      INSERT INTO pg_temp.patient_opening_balances VALUES (1,'YER',700);
      INSERT INTO pg_temp.expenses VALUES (1,'EX1','2020-10-07 10:00+00',9,'supplies',NULL,'synthetic payee',20,'USD',NULL,NULL,NULL,'synthetic');
    `);
    const report = await read();
    expect(report.totals.visitsCount).toBe(3);
    expect(report.attendees).toHaveLength(2);
    expect(report.totals.agreement).toEqual({ YER: 0, SAR: 5000, USD: 0 });
    expect(report.totals.explicitlySettled.SAR).toBe(1000);
    expect(report.currentAccounts).toHaveLength(1);
    expect(report.totals.currentReceivable.YER).toBe(700);
    expect(report.receipts.find((row) => row.patientId === 2)?.attendee).toBe(false);
    expect(report.expenses.totals.netOutflowMinor.USD).toBe(20);
    expect(report.basis.account).toBe("current_at_generation");
  });

  it("reads included, narrative, orthodontic and endodontic work without requiring invoices", async () => {
    await client.query(`
      INSERT INTO pg_temp.patients VALUES (1,'synthetic attendee','P1');
      INSERT INTO pg_temp.parties VALUES (7,'doctor','doctor');
      INSERT INTO pg_temp.visits VALUES (1,1,'attendee','2020-10-07 08:00+00','2020-10-07 09:00+00','YER','done',7,NULL);
      INSERT INTO pg_temp.services VALUES (3,'procedure');
      INSERT INTO pg_temp.treatment_plans VALUES (10,1,'documented','active','2020-10-01','YER',1000);
      INSERT INTO pg_temp.plan_installments VALUES (1,10);
      INSERT INTO pg_temp.plan_items VALUES (5,10,'recorded item',1,1000,'in_progress',NULL,NULL);
      INSERT INTO pg_temp.visit_procedures VALUES (2,1,3,1,16,7,5,0);
      INSERT INTO pg_temp.treatment_sessions VALUES (6,1,5);
      INSERT INTO pg_temp.ortho_cases VALUES (8,1,10,7);
      INSERT INTO pg_temp.ortho_adjustments VALUES (9,8,1,'documented orthodontic work');
      INSERT INTO pg_temp.endo_treatments VALUES (11,1,16);
      INSERT INTO pg_temp.endo_visits VALUES (12,11,1,'instrumentation',7);
    `);
    const report = await read();
    expect(report.work.map((row) => row.sourceType)).toEqual(["procedure", "ortho_adjustment", "endo_visit"]);
    expect(report.work.every((row) => row.valueMinor === null)).toBe(true);
    expect(report.work.find((row) => row.sourceType === "ortho_adjustment")?.doctorName).toBeNull();
    expect(report.work.find((row) => row.sourceType === "endo_visit")?.doctorName).toBe("doctor");
    expect(report.totals.agreement.YER).toBe(1000);
    expect(report.agreements[0].linkedVisitIds).toEqual([1]);
  });

  it("has no visit row cap and uses exact timezone day even when midnight repeats", async () => {
    await client.query(`INSERT INTO pg_temp.visits (id,patient_name,arrived_at)
      SELECT i,'synthetic ' || i,'2020-10-07 08:00+00'::timestamptz FROM generate_series(1,1005) i`);
    expect((await read()).attendees).toHaveLength(1005);
    await client.query("TRUNCATE pg_temp.visits");
    await client.query(`INSERT INTO pg_temp.visits (id,patient_name,arrived_at)
      SELECT row_number() OVER ()::int,'DST synthetic',instant
        FROM generate_series('2020-11-01 03:00+00'::timestamptz,'2020-11-02 07:00+00'::timestamptz,interval '30 minute') instant`);
    const expected = (await client.query("SELECT id FROM pg_temp.visits WHERE (arrived_at AT TIME ZONE 'America/Havana')::date = '2020-11-01' ORDER BY arrived_at,id")).rows;
    const report = await read("2020-11-01", "America/Havana");
    expect(report.attendees.flatMap((row) => row.visitIds)).toEqual(expected.map((row) => row.id));
    expect(report.totals.visitsCount).toBe(50);
  });
});
