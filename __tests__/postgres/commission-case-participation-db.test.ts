/** Owner decision 2026-11-11 (finance point 3, option 2, per case): the centre's decision on how
 * doctors share a case is stored append-only with its author, time, source and reason; an approved
 * split adds up to 100%; a pending case holds its commission; a later decision never rewrites an
 * approved payroll run — the next run settles the difference. Real PostgreSQL, synthetic data. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";

validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
process.env.SESSION_SECRET ??= "synthetic-case-participation-only";
const db = await import("../../lib/db");
const participation = await import("../../lib/commission-participation-db");
const payroll = await import("../../lib/hr-payroll");
const hr = await import("../../lib/hr");
const contracts = await import("../../lib/hr-contracts-attendance");
const { sessionCredentialVersion } = await import("../../lib/auth");
let seq = 0, service = 0;
let admin: SessionPayload;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
const id = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
const actor = () => ({ username: admin.username, userId: admin.userId ?? null, role: admin.role });
const OCT = "2026-10-05T07:00:00Z", OCT_PAID = "2026-10-10T07:00:00Z", NOV = "2026-11-05T07:00:00Z", FAR = "2099-12-31";

async function doctor(percent: number) {
  const party = await db.createParty({ name: `SYN share doctor ${++seq}`, kind: "doctor", phone: null, commissionPercent: percent, note: null });
  const staff = await hr.createStaff({ fullName: `SYN share staff ${seq}`, phone: null, department: "doctors", jobTitle: "SYN", hireDate: "2025-01-01",
    workStatus: "active", endDate: null, contractKind: "commission", payTerms: null, note: null }, admin);
  const contract = await contracts.createContract({ staffId: staff.id, templateKind: "doctor_percentage", title: "SYN commission agreement",
    startDate: "2025-01-01", compensationKind: "commission", doctorPartyId: party.id, commissionRatePercent: percent }, admin);
  await contracts.approveContract(contract.id, admin);
  await contracts.transitionContractStatus(contract.id, "active", "SYN activation", admin);
  return { partyId: party.id, staffId: staff.id };
}
/** A patient with a clinical case and one paid invoice line of that case, recorded on `lineDoctor`. */
async function sharedCase(lineDoctor: number, amount = 100_000, paid = amount) {
  const patientId = await id("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN share patient') RETURNING id", [`SYN-SHARE-${++seq}`]);
  const caseId = await id("INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'implants', 'SYN shared case', 'SYN') RETURNING id", [patientId]);
  const planId = await id("INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'SYN plan', $2) RETURNING id", [patientId, amount]);
  const planItemId = await id(`INSERT INTO plan_items (plan_id, service_id, service_name, quantity, unit_price_minor, case_id) VALUES ($1, $2, 'SYN work', 1, $3, $4) RETURNING id`,
    [planId, service, amount, caseId]);
  const invoiceId = await id(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
    VALUES($1,$2,$3,0,'YER',$4,$5) RETURNING id`, [`SYN-SHARE-I-${++seq}`, patientId, amount, admin.username, OCT]);
  await q(`INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id,service_id,plan_item_id) VALUES($1,'SYN work',1,$2,$2,$3,$4,$5)`,
    [invoiceId, amount, lineDoctor, service, planItemId]);
  if (paid > 0) await pay(patientId, invoiceId, paid, OCT_PAID);
  return { patientId, caseId, invoiceId };
}
async function pay(patientId: number, invoiceId: number, amount: number, at: string) {
  const result = await db.recordPayment({ patientId, invoiceId, kind: "payment", amountMinor: amount, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    method: "cash", createdBy: admin.username, note: "SYN share", reversalOfId: null });
  expect(result.reason).toBeNull();
  await q("UPDATE payments SET created_at=$2::timestamptz WHERE id=$1", [result.payment!.id, at]);
}
const decide = (caseId: number, status: "approved" | "pending" | "void", parts: [number, number][], expectedHeadId: number | null, source: "centre_decision" | "sessions_guided" | "equal" = "centre_decision") =>
  participation.decideCaseParticipation({ caseId, status, participants: parts.map(([doctorId, shareBp]) => ({ doctorId, shareBp })), source, reason: "SYN centre decision", expectedHeadId, actor: actor() });
/** Stable synthetic chronology: place a decision on a fixed day (the record is otherwise append-only). */
async function decidedAt(recordId: number, at: string) {
  await q("ALTER TABLE commission_case_participations DISABLE TRIGGER commission_case_participations_append_only");
  await q("UPDATE commission_case_participations SET decided_at=$2::timestamptz WHERE id=$1", [recordId, at]);
  await q("ALTER TABLE commission_case_participations ENABLE TRIGGER commission_case_participations_append_only");
}
const earned = async (doctorId: number, to = FAR) => (await db.commissionReport("1970-01-01", to)).find(row => row.doctorId === doctorId && row.currency === "YER")?.earnedMinor ?? 0;
const itemOf = async (runId: number, staffId: number) => (await payroll.listPayrollItems(runId)).find(item => item.staffId === staffId);
async function run(periodKey: string) {
  const period = await payroll.getOrCreatePayrollPeriod(periodKey, admin);
  return payroll.calculatePayrollRun(period.id, "YER", admin);
}

beforeEach(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  const actorId = await id(`INSERT INTO users(username,display_name,password_hash,role) VALUES('syn-share-admin','SYN actor','synthetic-share-hash','admin') RETURNING id`);
  admin = { userId: actorId, username: "syn-share-admin", role: "admin", expiresAt: Date.now() + 3_600_000, credentialVersion: sessionCredentialVersion("synthetic-share-hash") };
  await id("INSERT INTO cashier_shifts(opened_by) VALUES($1) RETURNING id", [admin.username]);
  service = await id("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('SYN share service','implants',100000,TRUE,TRUE) RETURNING id");
}, 120_000);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("the decision is stored once, complete, attributed and append-only", () => {
  it("records who approved what, when, from what source and why, with its audit row; a later decision supersedes it", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId);
    const first = await decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 4_000]], null, "sessions_guided");
    expect(first).toMatchObject({ ok: true, record: { caseId: c.caseId, status: "approved", source: "sessions_guided", reason: "SYN centre decision",
      decidedBy: "syn-share-admin", decidedByUserId: admin.userId, supersedesId: null, isHead: true,
      participants: [{ doctorId: a.partyId, shareBp: 6_000 }, { doctorId: b.partyId, shareBp: 4_000 }] } });
    if (!first.ok) throw new Error("fixture");
    const second = await decide(c.caseId, "approved", [[a.partyId, 5_000], [b.partyId, 5_000]], first.record.id, "equal");
    expect(second).toMatchObject({ ok: true, record: { supersedesId: first.record.id, source: "equal", isHead: true } });
    const history = await participation.listCaseParticipationHistory(c.caseId);
    expect(history.map(record => [record.status, record.isHead])).toEqual([["approved", false], ["approved", true]]);
    expect(await q("SELECT action, actor FROM audit_log WHERE action LIKE 'commission.case_participation.%' AND entity_id=$1::text ORDER BY id", [c.caseId]))
      .toEqual([{ action: "commission.case_participation.set", actor: "syn-share-admin" }, { action: "commission.case_participation.set", actor: "syn-share-admin" }]);
  });

  it("refuses incomplete, excessive or malformed splits and writes nothing", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId);
    const supplier = (await db.createParty({ name: "SYN not a doctor", kind: "supplier", phone: null, commissionPercent: 0, note: null })).id;
    expect(await decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 3_000]], null)).toEqual({ ok: false, reason: "shares_below_full" });
    expect(await decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 5_000]], null)).toEqual({ ok: false, reason: "shares_above_full" });
    expect(await decide(c.caseId, "approved", [[a.partyId, 5_000], [a.partyId, 5_000]], null)).toEqual({ ok: false, reason: "duplicate_doctor" });
    expect(await decide(c.caseId, "approved", [], null)).toEqual({ ok: false, reason: "no_participants" });
    expect(await decide(c.caseId, "approved", [[a.partyId, 6_000], [supplier, 4_000]], null)).toEqual({ ok: false, reason: "doctor_not_found" });
    expect(await decide(c.caseId, "pending", [[a.partyId, 10_000]], null)).toEqual({ ok: false, reason: "participants_not_allowed" });
    expect(await decide(c.caseId, "void", [], null)).toEqual({ ok: false, reason: "nothing_to_void" });
    expect(await decide(2_000_000_000, "pending", [], null)).toEqual({ ok: false, reason: "case_not_found" });
    expect(await decide(c.caseId, "approved", [[a.partyId, 10_000]], 999_999)).toEqual({ ok: false, reason: "stale_head" });
    expect(await q("SELECT count(*)::int AS n FROM commission_case_participations")).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'commission.case_participation.%'")).toEqual([{ n: 0 }]);
  });

  it("the database itself refuses a split that does not add up, and any update or delete", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId);
    const insert = (participants: unknown, status = "approved") => q(`INSERT INTO commission_case_participations (case_id,status,participants,source,reason,decided_by)
      VALUES ($1,$2,$3::jsonb,'centre_decision','SYN raw','SYN')`, [c.caseId, status, JSON.stringify(participants)]);
    await expect(insert([{ doctorId: a.partyId, shareBp: 6_000 }, { doctorId: b.partyId, shareBp: 3_000 }])).rejects.toThrow(/shares_check/);
    await expect(insert([{ doctorId: a.partyId, shareBp: 5_000 }, { doctorId: a.partyId, shareBp: 5_000 }])).rejects.toThrow(/shares_check/);
    await expect(insert([{ doctorId: a.partyId, shareBp: 10_000, extra: 1 }])).rejects.toThrow(/shares_check/);
    await expect(insert([{ doctorId: a.partyId, shareBp: 10_000 }], "pending")).rejects.toThrow(/shares_check/);
    const made = await decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 4_000]], null);
    if (!made.ok) throw new Error("fixture");
    await expect(q("UPDATE commission_case_participations SET reason='changed' WHERE id=$1", [made.record.id])).rejects.toThrow();
    await expect(q("DELETE FROM commission_case_participations WHERE id=$1", [made.record.id])).rejects.toThrow();
  });

  it("two decisions on the same head at once: exactly one is recorded", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId);
    const results = await Promise.all([decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 4_000]], null), decide(c.caseId, "approved", [[a.partyId, 5_000], [b.partyId, 5_000]], null)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toEqual({ ok: false, reason: "stale_head" });
    expect(await q("SELECT count(*)::int AS n FROM commission_case_participations WHERE case_id=$1", [c.caseId])).toEqual([{ n: 1 }]);
  });
});

describe("the commission report follows the decision in force", () => {
  it("option 2 on real rows: A 40% with 60% of the work, B 30% with 40% — 24,000 and 12,000; a case that is not shared is untouched", async () => {
    const a = await doctor(40), b = await doctor(30), shared = await sharedCase(a.partyId), plain = await sharedCase(a.partyId);
    expect(await earned(a.partyId)).toBe(80_000); // both cases on A alone: 2 × 40,000
    const made = await decide(shared.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 4_000]], null);
    if (!made.ok) throw new Error("fixture");
    expect([await earned(a.partyId), await earned(b.partyId)]).toEqual([24_000 + 40_000, 12_000]);
    expect(plain.caseId).not.toBe(shared.caseId);
  });

  it("a pending case holds its commission; approving releases it; voiding returns the line to its doctor", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId);
    const pending = await decide(c.caseId, "pending", [], null);
    if (!pending.ok) throw new Error("fixture");
    expect([await earned(a.partyId), await earned(b.partyId)]).toEqual([0, 0]);
    const approved = await decide(c.caseId, "approved", [[a.partyId, 5_000], [b.partyId, 5_000]], pending.record.id, "equal");
    if (!approved.ok) throw new Error("fixture");
    expect([await earned(a.partyId), await earned(b.partyId)]).toEqual([20_000, 15_000]);
    const voided = await decide(c.caseId, "void", [], approved.record.id);
    expect(voided.ok).toBe(true);
    expect([await earned(a.partyId), await earned(b.partyId)]).toEqual([40_000, 0]);
  });

  it("a report for an earlier period keeps the split that was in force then", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId);
    const made = await decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 4_000]], null);
    if (!made.ok) throw new Error("fixture");
    await decidedAt(made.record.id, NOV);
    expect([await earned(a.partyId, "2026-10-31"), await earned(b.partyId, "2026-10-31")]).toEqual([40_000, 0]);
    expect([await earned(a.partyId, "2026-11-30"), await earned(b.partyId, "2026-11-30")]).toEqual([24_000, 12_000]);
  });

  it("a part collection and a later collection earn each participant in proportion", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId, 100_000, 50_000);
    const made = await decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 4_000]], null);
    if (!made.ok) throw new Error("fixture");
    expect([await earned(a.partyId), await earned(b.partyId)]).toEqual([12_000, 6_000]);
    await pay(c.patientId, c.invoiceId, 50_000, NOV);
    expect([await earned(a.partyId), await earned(b.partyId)]).toEqual([24_000, 12_000]);
  });
});

describe("a decision after an approved payroll run", () => {
  it("never rewrites the run; the next run pays the participant who gains and carries the other's overpayment", async () => {
    const a = await doctor(40), b = await doctor(30), c = await sharedCase(a.partyId);
    const october = await run("2026-10");
    expect((await itemOf(october.id, a.staffId))?.commissionsMinor).toBe(40_000);
    await payroll.approvePayrollRun(october.id, admin);
    const item = (await itemOf(october.id, a.staffId))!;
    await payroll.disbursePayrollItem(item.id, { components: { commissionMinor: 40_000 }, clientRequestId: "syn-share-oct" }, admin);
    // In November the centre approves that B did 40% of the case.
    const made = await decide(c.caseId, "approved", [[a.partyId, 6_000], [b.partyId, 4_000]], null);
    if (!made.ok) throw new Error("fixture");
    await decidedAt(made.record.id, NOV);
    expect(await itemOf(october.id, a.staffId)).toMatchObject({ commissionsMinor: 40_000, paidMinor: 40_000 });
    await expect(run("2026-10")).rejects.toThrow();
    const november = await run("2026-11");
    expect((await itemOf(november.id, a.staffId))?.commissionsMinor ?? 0).toBe(0); // A was paid 40,000 and is now due 24,000
    expect((await itemOf(november.id, b.staffId))?.commissionsMinor).toBe(12_000);
    const balance = async (doctorId: number) => (await db.commissionReport("1970-01-01", "2026-11-30")).find(row => row.doctorId === doctorId && row.currency === "YER");
    expect(await balance(a.partyId)).toMatchObject({ earnedMinor: 24_000, paidMinor: 40_000, dueMinor: -16_000 });
    // Recalculating November gives the same figures: nothing is paid twice.
    const again = await run("2026-11");
    expect([(await itemOf(again.id, a.staffId))?.commissionsMinor ?? 0, (await itemOf(again.id, b.staffId))?.commissionsMinor]).toEqual([0, 12_000]);
  });
});
