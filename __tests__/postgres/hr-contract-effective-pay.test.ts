import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { dropPublicSchema } from "./_setup";

// This file owns UUID-named disposable PostgreSQL databases. No supplied database
// is reset, no history trigger is disabled, and every case uses the real HR writers.
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import("../../lib/db"), hr: typeof import("../../lib/hr");
let contracts: typeof import("../../lib/hr-contracts-attendance"), payroll: typeof import("../../lib/hr-payroll");
let admin: SessionPayload;
let serial = 0;
const saved = { url: process.env.DATABASE_URL, seed: process.env.SKIP_SEED, max: process.env.DB_POOL_MAX };

beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = "false"; process.env.DB_POOL_MAX = "6";
  db = await import("../../lib/db"); hr = await import("../../lib/hr");
  contracts = await import("../../lib/hr-contracts-attendance"); payroll = await import("../../lib/hr-payroll");
});
beforeEach(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(fixture.source.options.connectionString!);
  await db.ensureSchema();
  const actor = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES ('effective-admin','Synthetic manager','synthetic-hash','admin') RETURNING id,password_hash")).rows[0];
  admin = { userId: actor.id, username: "effective-admin", role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion(actor.password_hash) };
});
afterAll(async () => {
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally { process.env.DATABASE_URL = saved.url; process.env.SKIP_SEED = saved.seed; process.env.DB_POOL_MAX = saved.max; }
});
async function staff(kind: "salary" | "commission" = "salary") {
  const s = await hr.createStaff({ fullName: `Synthetic effective ${++serial}`, department: kind === "salary" ? "secretariat" : "doctors", jobTitle: "Synthetic", hireDate: "2026-01-01", workStatus: "active", contractKind: kind, endDate: null, phone: null, note: null,
    payTerms: kind === "salary" ? { amountMinor: 100000, currency: "YER", period: "monthly", effectiveOn: "2026-01-01" } : null }, admin);
  return s;
}
async function salaryContract(staffId: number, startDate = "2026-01-01", salary = 120000, approve = true) {
  const c = await contracts.createContract({ staffId, templateKind: "support_staff", title: "Synthetic salary agreement", startDate, compensationKind: "salary", baseSalaryMinor: salary, salaryCurrency: "YER", salaryPeriod: "monthly" }, admin);
  if (approve) await contracts.approveContract(c.id, admin);
  return c;
}
async function prepare(month = "2026-08") {
  const period = await payroll.getOrCreatePayrollPeriod(month, admin);
  const run = await payroll.calculatePayrollRun(period.id, "YER", admin);
  return { period, run, items: await payroll.listPayrollItems(run.id) };
}
async function financialState() {
  const result: Record<string, unknown> = {};
  for (const table of ["hr_payroll_runs", "hr_payroll_items", "hr_payroll_periods", "payables", "expenses", "audit_log"]) {
    result[table] = (await fixture.source.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function doctor() {
  const s = await staff("commission");
  const party = await db.createParty({ name: `Synthetic doctor ${++serial}`, kind: "doctor", commissionPercent: 30, phone: null, note: null });
  const user = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES ($1,$1,'synthetic','doctor',$2) RETURNING id", [`effective-doctor-${serial}`, party.id])).rows[0];
  await fixture.source.query("UPDATE hr_staff SET user_id=$1 WHERE id=$2", [user.id, s.id]);
  const c = await contracts.createContract({ staffId: s.id, templateKind: "doctor_percentage", title: "Synthetic commission agreement", startDate: "2026-01-01", compensationKind: "commission", commissionRatePercent: 30, doctorPartyId: party.id }, admin);
  await contracts.approveContract(c.id, admin);
  return { s, party, c };
}
async function earnCommission(partyId: number) {
  const shift = (await fixture.source.query("INSERT INTO cashier_shifts(opened_by) VALUES ('synthetic') RETURNING id")).rows[0];
  const patient = (await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic patient') RETURNING id", [`E-P-${++serial}`])).rows[0];
  const invoice = (await fixture.source.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at) VALUES ($1,$2,40000,0,'YER','synthetic','2026-08-20 10:00+03') RETURNING id", [`E-I-${serial}`, patient.id])).rows[0];
  await fixture.source.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id) VALUES ($1,'Synthetic item',1,40000,40000,$2)", [invoice.id, partyId]);
  await fixture.source.query("INSERT INTO visits(patient_name,patient_id,doctor_id,status,invoice_id,arrived_at,signed_at,signed_by) VALUES ('Synthetic patient',$1,$2,'done',$3,'2026-08-20 10:00+03','2026-08-20 10:00+03','synthetic')", [patient.id, partyId, invoice.id]);
  await fixture.source.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,created_at) VALUES ($1,$2,$3,$4,'payment',40000,'YER',1,40000,'YER','cash','synthetic','2026-08-20 10:00+03')", [`E-R-${serial}`, patient.id, invoice.id, shift.id]);
}
async function commissionAddendum(contractId: number) {
  const c = await contracts.createContractAddendum(contractId, { title: "Synthetic dated percentage change", startDate: "2026-08-15", addendumReason: "Explicit synthetic agreement", commissionRatePercent: 40 }, admin);
  await contracts.approveContract(c.id, admin);
  return c;
}

it("future approved salary governs its full effective month without overwriting today's older profile", async () => {
  const s = await staff(), c = await salaryContract(s.id, "2099-02-01", 150000);
  const profile = (await fixture.source.query("SELECT to_jsonb(s)::text AS value FROM hr_staff s WHERE id=$1", [s.id])).rows;
  const { run, items } = await prepare("2099-02");
  expect(items[0].blockerCodes).toEqual([]);
  expect(items[0].baseSalaryMinor).toBe(150000);
  expect(items[0].payTermsSnapshot).toMatchObject({ source: "contract", contractId: c.id, baseSalaryMinor: 150000 });
  await payroll.approvePayrollRun(run.id, admin);
  expect((await fixture.source.query("SELECT amount_minor::int AS amount FROM payables")).rows).toEqual([{ amount: 150000 }]);
  expect((await fixture.source.query("SELECT to_jsonb(s)::text AS value FROM hr_staff s WHERE id=$1", [s.id])).rows).toEqual(profile);
});
it("future midmonth salary change remains blocked without inventing proration", async () => {
  const s = await staff(); await salaryContract(s.id, "2099-02-15", 150000);
  const { run, items } = await prepare("2099-02");
  expect(items[0].blockerCodes).toContain("terms_changed_in_period");
  expect(items[0].baseSalaryMinor).toBe(0);
  await expect(payroll.approvePayrollRun(run.id, admin)).rejects.toMatchObject({ code: "pay_terms_blocked" });
});
it("an equal-effective-date profile contradiction remains blocked", async () => {
  const s = await staff(); await salaryContract(s.id);
  await fixture.source.query("UPDATE hr_staff SET salary_amount_minor=99000 WHERE id=$1", [s.id]);
  expect((await prepare()).items[0].blockerCodes).toContain("terms_conflict");
});
it("independent overlapping contracts cannot gain payroll priority from their version or ID", async () => {
  const s = await staff();
  const first = await salaryContract(s.id), second = await salaryContract(s.id);
  const { run, items } = await prepare();
  expect(items[0].blockerCodes).toContain("contract_priority_unresolved");
  expect(items[0].baseSalaryMinor).toBe(0);
  expect(items[0].payTermsSnapshot.reviewContractIds).toEqual([first.id, second.id]);
  const before = await financialState();
  await expect(payroll.approvePayrollRun(run.id, admin)).rejects.toMatchObject({ code: "pay_terms_blocked" });
  expect(await financialState()).toEqual(before);
});
it("post-contract payroll cannot silently substitute today's profile after coverage ends", async () => {
  const s = await staff();
  const c = await contracts.createContract({ staffId: s.id, templateKind: "support_staff", title: "Synthetic finite agreement", startDate: "2026-01-01", endDate: "2026-07-31", compensationKind: "salary", baseSalaryMinor: 120000, salaryCurrency: "YER", salaryPeriod: "monthly" }, admin);
  await contracts.approveContract(c.id, admin);
  const { run, items } = await prepare();
  expect(items[0].blockerCodes).toContain("contract_coverage_unresolved");
  expect(items[0].netDueMinor).toBe(0);
  const before = await financialState();
  await expect(payroll.approvePayrollRun(run.id, admin)).rejects.toMatchObject({ code: "pay_terms_blocked" });
  expect(await financialState()).toEqual(before);
});
for (const status of ["expired", "terminated"] as const) it(`${status} approved contract cannot silently fall back to a rewritten profile for historical payroll`, async () => {
  const s = await staff(), c = await salaryContract(s.id);
  await contracts.transitionContractStatus(c.id, "active", "Synthetic activation", admin);
  await contracts.transitionContractStatus(c.id, status, "Status reason carries no effective wage cessation date", admin);
  expect((await hr.updateStaff(s.id, { payTerms: { amountMinor: 150000, currency: "YER", period: "monthly", effectiveOn: "2026-01-01" }, reason: "Synthetic later profile correction" }, admin)).ok).toBe(true);
  const contractBefore = (await fixture.source.query("SELECT to_jsonb(c)::text AS value FROM hr_contracts c WHERE id=$1", [c.id])).rows;
  const { run, items } = await prepare();
  expect(items[0].blockerCodes).toContain("contract_lifecycle_unresolved");
  expect(items[0].baseSalaryMinor).toBe(0);
  expect(items[0].payTermsSnapshot).toMatchObject({ source: "contract", contractId: c.id, contractStatus: status, baseSalaryMinor: 120000 });
  const before = await financialState();
  await expect(payroll.approvePayrollRun(run.id, admin)).rejects.toMatchObject({ code: "pay_terms_blocked" });
  expect(await financialState()).toEqual(before);
  expect((await fixture.source.query("SELECT to_jsonb(c)::text AS value FROM hr_contracts c WHERE id=$1", [c.id])).rows).toEqual(contractBefore);
});
it("terminal lifecycle preserves all previously approved items, snapshots and liabilities byte for byte", async () => {
  const s = await staff(), c = await salaryContract(s.id);
  const { run } = await prepare(); await payroll.approvePayrollRun(run.id, admin);
  const before = await financialState();
  await contracts.transitionContractStatus(c.id, "active", "Synthetic activation", admin);
  await contracts.transitionContractStatus(c.id, "terminated", "Synthetic terminal decision", admin);
  const after = await financialState();
  for (const table of ["hr_payroll_runs", "hr_payroll_items", "hr_payroll_periods", "payables", "expenses"]) expect(after[table]).toEqual(before[table]);
  await expect(payroll.calculatePayrollRun(run.periodId, "YER", admin)).rejects.toMatchObject({ code: "approved" });
});
it("terminal decision after preparation blocks approval without any financial or audit writes", async () => {
  const s = await staff(), c = await salaryContract(s.id), { run } = await prepare();
  await contracts.transitionContractStatus(c.id, "terminated", "No dated wage cessation decision", admin);
  const before = await financialState();
  await expect(payroll.approvePayrollRun(run.id, admin)).rejects.toMatchObject({ code: "pay_terms_blocked" });
  expect(await financialState()).toEqual(before);
});
it("legacy expired contract without approval markers remains unresolved rather than trusted or ignored", async () => {
  const s = await staff(), c = await salaryContract(s.id, "2026-01-01", 170000, false);
  await fixture.source.query("UPDATE hr_contracts SET status='expired' WHERE id=$1", [c.id]);
  const { items } = await prepare();
  expect(items[0].blockerCodes).toContain("contract_lifecycle_unresolved"); expect(items[0].baseSalaryMinor).toBe(0);
  expect(items[0].payTermsSnapshot).toMatchObject({ contractId: c.id, contractStatus: "expired" });
});
it("legacy approval witnesses survive a corrupted draft status and prevent profile fallback", async () => {
  const s = await staff(), c = await salaryContract(s.id);
  await fixture.source.query("UPDATE hr_contracts SET status='draft' WHERE id=$1", [c.id]);
  const { items } = await prepare();
  expect(items[0].blockerCodes).toContain("contract_lifecycle_unresolved");
  expect(items[0].payTermsSnapshot).toMatchObject({ contractId: c.id, contractStatus: "draft" });
});
it("never approved terminated draft does not replace the documented profile", async () => {
  const s = await staff(), c = await salaryContract(s.id, "2026-01-01", 170000, false);
  await contracts.transitionContractStatus(c.id, "terminated", "Abandoned unsigned draft", admin);
  const { run, items } = await prepare();
  expect(items[0].blockerCodes).toEqual([]); expect(items[0].baseSalaryMinor).toBe(100000);
  expect(items[0].payTermsSnapshot).toMatchObject({ source: "staff_profile", contractId: null });
  await payroll.approvePayrollRun(run.id, admin);
});
it("explicit approved higher-version addendum can govern beyond an unresolved terminal parent", async () => {
  const s = await staff(), c = await salaryContract(s.id);
  await contracts.transitionContractStatus(c.id, "terminated", "Synthetic terminal decision", admin);
  const next = await contracts.createContractAddendum(c.id, { title: "Explicit approved replacement terms", startDate: "2099-02-01", addendumReason: "Synthetic documented new agreement", baseSalaryMinor: 150000 }, admin);
  await contracts.approveContract(next.id, admin);
  const { run, items } = await prepare("2099-02");
  expect(items[0].blockerCodes).toEqual([]); expect(items[0].baseSalaryMinor).toBe(150000);
  expect(items[0].payTermsSnapshot).toMatchObject({ contractId: next.id });
  await payroll.approvePayrollRun(run.id, admin);
});
it("midperiod contract commission change blocks calculation even when the engine stays at the first rate", async () => {
  const { party, c } = await doctor(); await earnCommission(party.id); await commissionAddendum(c.id);
  const { run, items } = await prepare();
  expect(items[0].blockerCodes).toContain("terms_changed_in_period"); expect(items[0].commissionsMinor).toBe(0);
  await expect(payroll.approvePayrollRun(run.id, admin)).rejects.toMatchObject({ code: "pay_terms_blocked" });
  expect((await fixture.source.query("SELECT id FROM payables")).rows).toEqual([]);
});
it("midperiod contract commission change after preparation blocks approval and rolls back all financial writes", async () => {
  const { party, c } = await doctor(); await earnCommission(party.id);
  const { run, items } = await prepare(); expect(items[0].commissionsMinor).toBe(12000); expect(items[0].blockerCodes).toEqual([]);
  await commissionAddendum(c.id); const before = await financialState();
  await expect(payroll.approvePayrollRun(run.id, admin)).rejects.toMatchObject({ code: "pay_terms_blocked" });
  expect(await financialState()).toEqual(before);
});
it("midperiod contract doctor identity change is blocked even when percentage and salary do not change", async () => {
  const { c } = await doctor();
  const party = await db.createParty({ name: "Synthetic replacement earning identity", kind: "doctor", commissionPercent: 30, phone: null, note: null });
  const next = await contracts.createContractAddendum(c.id, { title: "Explicit identity amendment", startDate: "2026-08-15", addendumReason: "Synthetic identity agreement" }, admin);
  await contracts.updateContract(next.id, { doctorPartyId: party.id }, admin);
  await contracts.approveContract(next.id, admin);
  expect((await prepare()).items[0].blockerCodes).toContain("terms_changed_in_period");
});
it("policy change committed while approval waits for the doctor party lock cannot approve stale contract commission", async () => {
  const { party } = await doctor(); await earnCommission(party.id);
  const { run, items } = await prepare(); expect(items[0].commissionsMinor).toBe(12000);
  const before = await financialState(), blocker = await fixture.source.connect();
  let outcome: Promise<{ ok: boolean; error?: unknown }> | undefined;
  try {
    // Same lock-before-history order as withDoctorCommissionChange. The fixture
    // supplies an explicit historical date so this race is clock-independent.
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM parties WHERE id=$1 FOR UPDATE", [party.id]);
    await blocker.query("UPDATE parties SET commission_percent=40 WHERE id=$1", [party.id]);
    await blocker.query("INSERT INTO doctor_commission_history(party_id,percent,effective_from,source,reason,recorded_by) VALUES ($1,40,'2026-08-15 00:00+03','party','Synthetic pending policy','effective-admin')", [party.id]);
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    outcome = payroll.approvePayrollRun(run.id, admin).then(() => ({ ok: true }), error => ({ ok: false, error }));
    let observed = false;
    for (let n = 0; n < 200; n += 1) {
      await blocker.query("SELECT pg_stat_clear_snapshot()");
      observed = (await blocker.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='aqlan-center-mini' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query=$2) AS blocked", [pid, "SELECT id FROM parties WHERE id = $1 AND kind = 'doctor' FOR UPDATE"])).rows[0].blocked;
      if (observed) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observed).toBe(true);
    await blocker.query("COMMIT");
    expect(await outcome).toMatchObject({ ok: false, error: { code: "pay_terms_blocked" } });
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await outcome; }
  expect(await financialState()).toEqual(before);
  expect((await db.commissionReport("2026-08-01", "2026-08-31")).find(row => row.doctorId === party.id && row.currency === "YER")?.earnedMinor).toBe(16000);
});
