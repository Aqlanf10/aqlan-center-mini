import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { parseInvoiceCommand, invoiceCommandFingerprint, invoiceCatalogRequestFingerprint } from "../../lib/invoice-template";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import type { LabWorkDraft } from "../../lib/lab-work-intent-contract";
const target = validatePostgresTestTarget(process.env); stubPostgresEnv();
const db = await import("../../lib/db");
const invoiceWriter = await import("../../lib/invoice-linkage-db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actor: SessionPayload;
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const username = `synthetic-shared-lab-${randomUUID()}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic lab commission','synthetic-password-hash','admin') RETURNING id", [username]);
  actor = { userId: user.id, username, role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-password-hash") };
  await db.openShift({ openedBy: username, opening: { YER: 100000, SAR: 0, USD: 0 } });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(grouped = false, withCost = true, deductLabCost: boolean | null = null) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic lab cost patient') RETURNING id", [`LCC-${randomUUID()}`]);
  const [doctor] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic lab cost doctor','doctor',30) RETURNING id");
  if (deductLabCost !== null) {
    // The policy is the doctor's own dated commission configuration; effective from a fixed synthetic date.
    const config = { calculationMode: "percentage", defaultPercent: 30, categoryRates: {}, fixedAmountPerVisitMinor: 0,
      deductLabCost, deductMaterialCost: false, basis: "invoiced", effectiveDate: "2020-01-01", rateHistory: [] };
    await q("INSERT INTO users(username,display_name,password_hash,role,party_id,commission_config) VALUES($1,'Synthetic policy doctor','synthetic-password-hash','doctor',$2,$3)",
      [`synthetic-policy-doctor-${randomUUID()}`, doctor.id, JSON.stringify(config)]);
  }
  const [service] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,$2,1000,TRUE,TRUE) RETURNING id", [`Synthetic cost service ${randomUUID()}`, grouped ? "bridge" : "crown"]);
  const [lab] = await q("INSERT INTO parties(name,kind,currency) VALUES('Synthetic commission lab','lab','YER') RETURNING id");
  const intentId = randomUUID();
  const items = (grouped ? [27, 28] : [27]).map(tooth => {
    const labWork: LabWorkDraft = { intentId, memberId: randomUUID(), expectedRevision: 0, groupKind: grouped ? "bridge" : "single", prescription: { partyId: lab.id, shade: "", stumpShade: "", toothNumbers: "", dueDate: "2026-11-01", impressionType: "physical", priority: "normal" } };
    return { serviceId: service.id, doctorId: doctor.id, quantity: 1, price: "1000", sessions: 1, toothCode: tooth, episodeTeeth: [tooth], labWork };
  });
  const source = { patientId: patient.id, currency: "YER", idempotencyKey: `lcc-${randomUUID()}`, items };
  const parsed = parseInvoiceCommand(source, new Map((await db.listServices()).map(s => [s.id, s])), new Set([doctor.id]), await db.getSettings(), true);
  if (!parsed.ok) throw Error(parsed.message);
  const result = await invoiceWriter.createLinkedInvoice({ patientId: patient.id, baseCurrency: parsed.baseCurrency, discountMinor: parsed.discountMinor, note: parsed.note, existingPlanId: parsed.existingPlanId, items: parsed.items, createdBy: actor.username, actorRole: actor.role, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: source.idempotencyKey, requestHash: invoiceCatalogRequestFingerprint(source, actor), catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session: actor }, auditDetails: {} });
  if (!result.ok) throw Error(result.reason);
  const orderId = result.labWork![0].orderId;
  if (withCost) await db.updateLabOrderAccounting(orderId, { costMinor: 200, costCurrency: "YER", exchangeRate: 1, actor: actor.username, actorRole: actor.role });
  return { patientId: patient.id as number, doctorId: doctor.id as number, invoice: result.invoice, orderId, intentId };
}
const participation = await import("../../lib/commission-participation-db");
const BY_WORK = "commission.shared_lab_cost.by_work_shares", ADMIN = "commission.shared_lab_cost.admin_allocation";
const settings = (values: Record<string, string>) => db.saveSettings(values as never);
const report = async (doctorId: number) => (await db.commissionReport("2020-01-01", "2999-12-31")).find(row => row.doctorId === doctorId && row.currency === "YER")!;
const accrued = async (...doctors: number[]) => Promise.all(doctors.map(async doctor => (await report(doctor))?.accruedMinor ?? 0));
const basisOf = async (doctorId: number) => (await db.commissionDetailReport("2020-01-01", "2999-12-31", { doctorId, currency: null, category: null })).lines.map(line => line.labCostBasis);
const payables = (orderId: number) => q("SELECT amount_minor::int AS amount, currency FROM payables WHERE lab_order_id=$1", [orderId]);
const decisions = async (caseId: number) => Number((await q("SELECT count(*)::int AS n FROM commission_case_participations WHERE case_id=$1", [caseId]))[0].n);
type Part = { doctorId: number; shareBp: number; labCostBp?: number };
/** A crown of 1000 with a lab cost of 200 on doctor A (30%), in a clinical case shared with doctor B (40%). */
async function shared() {
  const f = await fixture();
  const [second] = await q("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic second doctor','doctor',40) RETURNING id");
  const [clinicalCase] = await q("INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'prostho', 'Synthetic shared crown', 'synthetic') RETURNING id", [f.patientId]);
  await q("UPDATE plan_items SET case_id=$1 WHERE id=$2", [clinicalCase.id, f.invoice.items[0].planItemId]);
  const decide = (participants: Part[], expectedHeadId: number | null = null) => participation.decideCaseParticipation({ caseId: clinicalCase.id, status: "approved", participants,
    source: "centre_decision", reason: "Synthetic centre decision", expectedHeadId, actor: { userId: actor.userId ?? null, username: actor.username, role: actor.role } });
  return { ...f, a: f.doctorId, b: second.id as number, caseId: clinicalCase.id as number, decide };
}
beforeEach(async () => { await settings({ [BY_WORK]: "on", [ADMIN]: "off" }); });

/** Contract docs/finance/SHARED_LAB_COST_ALLOCATION_0134.md; owner #483 6902952517 and 6904933217. Synthetic data. */
describe("the lab cost of a shared case follows the basis the owner enabled", () => {
  it("defaults: the cost follows the work shares (60/40 → 120/80) and each line names that basis", async () => {
    const c = await shared();
    expect((await c.decide([{ doctorId: c.a, shareBp: 6_000 }, { doctorId: c.b, shareBp: 4_000 }])).ok).toBe(true);
    expect(await accrued(c.a, c.b)).toEqual([144, 128]);
    expect([await basisOf(c.a), await basisOf(c.b)]).toEqual([["work_shares"], ["work_shares"]]);
    expect(await payables(c.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
  it("an unshared line names the line doctor as the basis", async () => {
    const f = await fixture();
    expect(await basisOf(f.doctorId)).toEqual(["line_doctor"]);
  });
  it("administrative allocation on: a decision that puts the whole cost on A is used — (600−200)×30% and 400×40%", async () => {
    const c = await shared();
    await settings({ [ADMIN]: "on" });
    const made = await c.decide([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 0 }]);
    expect(made.ok).toBe(true);
    expect(await accrued(c.a, c.b)).toEqual([120, 160]);
    expect([await basisOf(c.a), await basisOf(c.b)]).toEqual([["admin_allocation"], ["admin_allocation"]]);
    expect((await report(c.a)).labCostMinor + (await report(c.b)).labCostMinor).toBe(200);
    expect(await payables(c.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
    expect((await q("SELECT details FROM audit_log WHERE action LIKE 'commission%' ORDER BY id DESC LIMIT 1"))[0].details.participants)
      .toEqual([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 0 }]);
  });
  it("administrative allocation on but the decision carries none: the work shares apply", async () => {
    const c = await shared();
    await settings({ [ADMIN]: "on" });
    expect((await c.decide([{ doctorId: c.a, shareBp: 6_000 }, { doctorId: c.b, shareBp: 4_000 }])).ok).toBe(true);
    expect(await accrued(c.a, c.b)).toEqual([144, 128]);
    expect(await basisOf(c.a)).toEqual(["work_shares"]);
  });
  it("switching the administrative allocation off later returns to the work shares and leaves the record as written", async () => {
    const c = await shared();
    await settings({ [ADMIN]: "on" });
    expect((await c.decide([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 0 }])).ok).toBe(true);
    const before = await q("SELECT * FROM commission_case_participations WHERE case_id=$1", [c.caseId]);
    await settings({ [ADMIN]: "off" });
    expect(await accrued(c.a, c.b)).toEqual([144, 128]);
    expect(await basisOf(c.a)).toEqual(["work_shares"]);
    expect(await q("SELECT * FROM commission_case_participations WHERE case_id=$1", [c.caseId])).toEqual(before);
  });
  // The fallback below is a proposal awaiting the owner's confirmation (#483 6905003552); defaults never reach it.
  it("both switched off: the whole cost stays with the invoice-line doctor and the lines say so", async () => {
    const c = await shared();
    expect((await c.decide([{ doctorId: c.a, shareBp: 6_000 }, { doctorId: c.b, shareBp: 4_000 }])).ok).toBe(true);
    await settings({ [BY_WORK]: "off", [ADMIN]: "off" });
    expect(await accrued(c.a, c.b)).toEqual([120, 160]);
    expect([await basisOf(c.a), await basisOf(c.b)]).toEqual([["line_doctor"], ["line_doctor"]]);
    expect(await payables(c.orderId)).toEqual([{ amount: 200, currency: "YER" }]);
  });
  it("a later decision supersedes the allocation; nothing is updated in place", async () => {
    const c = await shared();
    await settings({ [ADMIN]: "on" });
    const first = await c.decide([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 0 }]);
    if (!first.ok) throw new Error("fixture");
    expect((await c.decide([{ doctorId: c.a, shareBp: 6_000, labCostBp: 5_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 5_000 }], first.record.id)).ok).toBe(true);
    expect(await accrued(c.a, c.b)).toEqual([150, 120]); // (600−100)×30% and (400−100)×40%
    expect(await decisions(c.caseId)).toBe(2);
  });
});

describe("the writer and the database refuse an allocation that is not allowed or not complete", () => {
  it("refuses a lab-cost allocation while the setting is off and writes nothing", async () => {
    const c = await shared();
    const refused = await c.decide([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 0 }]);
    expect(refused).toMatchObject({ ok: false, reason: "lab_cost_allocation_disabled" });
    expect(await decisions(c.caseId)).toBe(0);
  });
  it("refuses a partial allocation and one that does not add up to 100%", async () => {
    const c = await shared();
    await settings({ [ADMIN]: "on" });
    expect(await c.decide([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000 }])).toMatchObject({ ok: false, reason: "lab_cost_allocation_incomplete" });
    expect(await c.decide([{ doctorId: c.a, shareBp: 6_000, labCostBp: 7_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 2_000 }])).toMatchObject({ ok: false, reason: "lab_cost_allocation_incomplete" });
    expect(await decisions(c.caseId)).toBe(0);
  });
  it("the database itself refuses a malformed allocation; update and delete stay refused", async () => {
    const c = await shared();
    const insert = (participants: unknown) => q(`INSERT INTO commission_case_participations (case_id, status, participants, source, reason, decided_by)
      VALUES ($1, 'approved', $2::jsonb, 'centre_decision', 'Synthetic direct insert', 'synthetic')`, [c.caseId, JSON.stringify(participants)]);
    await expect(insert([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000 }])).rejects.toThrow();
    await expect(insert([{ doctorId: c.a, shareBp: 6_000, labCostBp: 9_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 500 }])).rejects.toThrow();
    await expect(insert([{ doctorId: c.a, shareBp: 6_000, labCostBp: -1 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 10_001 }])).rejects.toThrow();
    await insert([{ doctorId: c.a, shareBp: 6_000, labCostBp: 10_000 }, { doctorId: c.b, shareBp: 4_000, labCostBp: 0 }]);
    await expect(q("UPDATE commission_case_participations SET reason='changed' WHERE case_id=$1", [c.caseId])).rejects.toThrow();
    await expect(q("DELETE FROM commission_case_participations WHERE case_id=$1", [c.caseId])).rejects.toThrow();
  });
});
