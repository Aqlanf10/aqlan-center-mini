/** M2 slice 86: canonical visit signing on real PostgreSQL, synthetic data only, with the
 * owner's decisions 6629149113:
 *  - "no charge" for an outside-contract ortho adjustment: the owner, or the case's
 *    responsible doctor with clinical.ortho.edit while the owner-only setting
 *    ortho.case_doctor_no_charge is on; finance grants never substitute; the reason, the
 *    decider and the basis are audited in the sign transaction;
 *  - the cockpit's amounts only with finance.invoices.view, separate from
 *    finance.patient-ledger.view; revocation hides them on the next read.
 * Also: the sign grant, the finisher rule (no clinician link: today only, no ortho data),
 * an unlinked visit, and the sign summary's money only with the invoice view. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-sign-secret-86");
const db = await import("../../lib/db");
const doc = await import("../../lib/canonical-visit-documentation");
const cockpit = await import("../../lib/canonical-visit-clinical");
const reads = await import("../../lib/canonical-patient-reads");
const decisions = await import("../../lib/canonical-ortho-decisions");
const { clinicDateString } = await import("../../lib/schedule");

const SIGN = { "clinical.visits.document": true, "clinical.visits.sign": true };
const ORTHO = { "clinical.ortho.view": true, "clinical.ortho.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-VS-OWNER", role: "admin" },
  doctor: { username: "SYN-VS-DR", role: "doctor", doctor: true, patientScope: "all", grants: SIGN },
  caseDoctor: { username: "SYN-VS-CASE", role: "doctor", doctor: true, patientScope: "all", grants: { ...SIGN, ...ORTHO } },
  otherOrtho: { username: "SYN-VS-OTHER", role: "doctor", doctor: true, patientScope: "all", grants: { ...SIGN, ...ORTHO } },
  invoicer: { username: "SYN-VS-INV", role: "doctor", doctor: true, patientScope: "all",
    grants: { ...SIGN, ...ORTHO, "finance.invoices.view": true, "finance.invoices.create": true, "finance.patient-ledger.view": true, "finance.agreements.manage": true } },
  biller: { username: "SYN-VS-BILL", role: "doctor", doctor: true, patientScope: "all", grants: { ...SIGN, "finance.invoices.view": true } },
  finisher: { username: "SYN-VS-FIN", role: "assistant", patientScope: "all", grants: SIGN },
  ledger: { username: "SYN-VS-LEDGER", role: "reception", patientScope: "all", grants: { "clinical.visits.document": true, "finance.patient-ledger.view": true } },
  documenter: { username: "SYN-VS-DOC", role: "doctor", doctor: true, patientScope: "all", grants: { "clinical.visits.document": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const act = async (key: Key, visitId: number, body: Record<string, unknown>) => doc.commandCanonicalVisitDocument(await fx.session(key), String(visitId), body, fx.pool);
const setting = (value: "true" | "false") => q("INSERT INTO settings(key,value) VALUES('ortho.case_doctor_no_charge',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [value]);
const PRICE = 23450;
let service = 0, seq = 0;
const today = () => clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function pricedVisit(doctorKey: Key = "doctor", arrived: string | null = null) {
  seq += 1;
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,$2) RETURNING id", [`SYN-VS-${seq}`, `SYN VS ${seq}`]))[0].id as number;
  const visitId = (await q(`INSERT INTO visits (patient_name, patient_id, doctor_id${arrived ? ", arrived_at" : ""}) VALUES ($1,$2,$3${arrived ? `, ${arrived}` : ""}) RETURNING id`,
    [`SYN VS ${seq}`, patientId, fx.parties[doctorKey] ?? null]))[0].id as number;
  await q("INSERT INTO visit_procedures (visit_id, service_id, quantity, unit_price_minor, tooth_code, doctor_id) VALUES ($1,$2,1,$3,36,$4)", [visitId, service, PRICE, fx.parties[doctorKey] ?? null]);
  return { patientId, visitId };
}
/** An adjustment outside a per-session agreement (OUTSIDE_CONTRACT), responsible = the case doctor. */
async function orthoVisit(responsible: Key = "caseDoctor") {
  seq += 1;
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,$2) RETURNING id", [`SYN-VSO-${seq}`, `SYN VSO ${seq}`]))[0].id as number;
  const caseId = (await q(`INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode, responsible_doctor_id)
    VALUES ($1, 'migration', 'legacy', NOW(), 'per_session', $2) RETURNING id`, [patientId, fx.parties[responsible]]))[0].id as number;
  const visitId = (await q("INSERT INTO visits (patient_name, patient_id, doctor_id, diagnosis) VALUES ($1,$2,$3,'متابعة تقويم') RETURNING id", [`SYN VSO ${seq}`, patientId, fx.parties[responsible]]))[0].id as number;
  const saved = await db.recordAdjustment({ caseId, visitId, doneOn: today(), phase: null, upperWire: "016 NiTi", lowerWire: null,
    elastics: "none", elasticNote: null, done: "شدّة", nextWeeks: 4, note: null, recordedBy: "SYN", actorRole: "doctor" });
  if (!saved.ok) throw new Error(saved.message);
  return { patientId, visitId, caseId, adjustmentId: saved.id };
}
const signedAt = async (visitId: number) => (await q("SELECT signed_at FROM visits WHERE id=$1", [visitId]))[0].signed_at;
const signAudit = async (visitId: number) => (await q("SELECT actor, details FROM audit_log WHERE action='visit.sign' AND entity_id=$1::text", [visitId]));
const noCharge = (reason = "متابعة مجانية بعد كسر سلك") => ({ action: "sign", outsideContractDecision: { decision: "no_charge", reason } });

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  service = (await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('SYN VS crown prep',$1,TRUE,TRUE,'restorative') RETURNING id", [PRICE]))[0].id;
  await q("INSERT INTO services (name, category, price_minor, price_configured) VALUES ('شدّة تقويم (زيارة)', 'ortho', 10000, TRUE)");
  await setting("false");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("signing", () => {
  it("a clinician with the sign grant signs: invoice, signed stamp and audit in one transaction; no money in the reply", async () => {
    const { visitId, patientId } = await pricedVisit();
    const result = await act("doctor", visitId, { action: "sign" }) as Record<string, unknown>;
    expect(result).toMatchObject({ id: visitId, status: "signed", signResult: { sessionsCompleted: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/invoiceId|duesMinor|unitPriceMinor|totalMinor|invoiceCurrency|23450/);
    expect(await signedAt(visitId)).not.toBeNull();
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1", [patientId]))[0].n).toBe(1);
    expect((await signAudit(visitId)).map(row => row.actor)).toEqual(["SYN-VS-DR"]);
    expect(await refusal(act("doctor", visitId, { action: "sign" }))).toMatchObject({ code: "already_signed", status: 409 });
  });

  it("the invoice view brings the sign summary's amounts", async () => {
    const { visitId } = await pricedVisit("biller");
    const result = await act("biller", visitId, { action: "sign" }) as { signResult: Record<string, unknown> };
    expect(result.signResult).toMatchObject({ duesMinor: PRICE, invoiceId: expect.any(Number), invoiceCurrency: "YER" });
  });

  it("refusals: no sign grant, an unlinked visit; nothing is signed", async () => {
    const { visitId } = await pricedVisit();
    expect(await refusal(act("documenter", visitId, { action: "sign" }))).toMatchObject({ code: "visit_sign_not_granted", status: 403 });
    const walkIn = (await q("INSERT INTO visits (patient_name, doctor_id, diagnosis) VALUES ('SYN VS walk-in',$1,'x') RETURNING id", [fx.parties.doctor]))[0].id as number;
    expect(await refusal(act("doctor", walkIn, { action: "sign" }))).toMatchObject({ code: "visit_unlinked", status: 409 });
    expect(await signedAt(visitId)).toBeNull();
    expect(await signedAt(walkIn)).toBeNull();
  });

  it("the finisher without a clinician link: today's visit only, no ortho data, and never the default treating doctor", async () => {
    const { visitId } = await pricedVisit();
    await act("finisher", visitId, { action: "sign" });
    expect((await signAudit(visitId))[0]).toMatchObject({ actor: "SYN-VS-FIN", details: { المنهي: "SYN-VS-FIN", الطبيب_المعالج: fx.parties.doctor } });
    const old = await pricedVisit("doctor", "now() - interval '3 days'");
    expect(await refusal(act("finisher", old.visitId, { action: "sign" }))).toMatchObject({ code: "visit_today_only", status: 403 });
    const ortho = await orthoVisit();
    expect(await refusal(act("finisher", ortho.visitId, { action: "sign", orthoSession: { caseId: ortho.caseId } }))).toMatchObject({ code: "ortho_session_not_granted", status: 403 });
    expect(await refusal(act("doctor", ortho.visitId, { action: "sign", orthoSession: { caseId: ortho.caseId } }))).toMatchObject({ code: "ortho_session_not_granted", status: 403 });
  });
});

describe("\"no charge\" (owner decision 6629149113)", () => {
  it("setting off: the case doctor is refused, nothing signed; the owner decides with an audited reason and basis", async () => {
    await setting("false");
    const one = await orthoVisit();
    expect(await refusal(act("caseDoctor", one.visitId, noCharge()))).toMatchObject({ code: "no_charge_not_granted", status: 403 });
    expect(await signedAt(one.visitId)).toBeNull();
    const result = await act("owner", one.visitId, noCharge("قرار المالك الاصطناعي"));
    expect(result).toMatchObject({ status: "signed" });
    expect((await signAudit(one.visitId))[0].details).toMatchObject({ قرار_الشدّة: "بلا رسوم", سبب_القرار: "قرار المالك الاصطناعي", متخذ_القرار: "SYN-VS-OWNER", أساس_القرار: "المالك" });
  });

  it("setting on: only the responsible case doctor with clinical.ortho.edit; finance grants never substitute", async () => {
    await setting("true");
    const one = await orthoVisit();
    expect(await refusal(act("otherOrtho", one.visitId, noCharge()))).toMatchObject({ code: "no_charge_not_case_doctor", status: 403 });
    expect(await refusal(act("invoicer", one.visitId, noCharge()))).toMatchObject({ code: "no_charge_not_case_doctor", status: 403 });
    expect(await refusal(act("doctor", one.visitId, noCharge()))).toMatchObject({ code: "no_charge_not_granted", status: 403 });
    expect(await signedAt(one.visitId)).toBeNull();
    expect(await refusal(act("caseDoctor", one.visitId, noCharge("x")))).toMatchObject({ code: "invalid_decision_reason", status: 400 });
    expect(await refusal(act("caseDoctor", one.visitId, { action: "sign", outsideContractDecision: { decision: "free" } }))).toMatchObject({ code: "invalid_decision", status: 400 });
    expect(await act("caseDoctor", one.visitId, noCharge())).toMatchObject({ status: "signed" });
    expect((await signAudit(one.visitId))[0]).toMatchObject({ actor: "SYN-VS-CASE",
      details: { قرار_الشدّة: "بلا رسوم", سبب_القرار: "متابعة مجانية بعد كسر سلك", متخذ_القرار: "SYN-VS-CASE", أساس_القرار: "طبيب الحالة (إعداد المالك مفعّل)" } });
    expect((await q("SELECT billing_decision FROM ortho_adjustments WHERE id=$1", [one.adjustmentId]))[0].billing_decision).toBe("no_charge");
  });

  it("revoking the setting or the grant refuses the case doctor again; the post-sign decision read follows the same rule", async () => {
    await setting("true");
    const one = await orthoVisit();
    const choices = async (key: Key) => (await decisions.readCanonicalOrthoDecisions(await fx.session(key))).pending.find(row => row.adjustmentId === one.adjustmentId)?.decisionContext?.choices ?? [];
    await act("caseDoctor", one.visitId, { action: "sign" }); // pending: signed without a decision
    expect(await choices("caseDoctor")).toContain("no_charge");
    await setting("false");
    expect(await choices("caseDoctor")).not.toContain("no_charge");
    expect(await choices("owner")).toContain("no_charge");
    const two = await orthoVisit();
    expect(await refusal(act("caseDoctor", two.visitId, noCharge()))).toMatchObject({ code: "no_charge_not_granted" });
    await setting("true");
    await fx.setGrants("caseDoctor", { ...SIGN, "clinical.ortho.view": true }, { patientScope: "all" });
    try {
      expect(await refusal(act("caseDoctor", two.visitId, noCharge()))).toMatchObject({ code: "no_charge_not_granted" });
    } finally { await fx.setGrants("caseDoctor", { ...SIGN, ...ORTHO }, { patientScope: "all" }); }
    expect(await signedAt(two.visitId)).toBeNull();
  });
});

describe("the owner's setting (owner decision 6629149113, item 3)", () => {
  it("ortho.case_doctor_no_charge is an owner-only authority key: listed, off by default, writable by the owner only", async () => {
    const settings = await import("../../lib/canonical-settings");
    const { SETTING_DEFAULTS } = await import("../../lib/settings");
    expect(SETTING_DEFAULTS["ortho.case_doctor_no_charge"]).toBe("false");
    await fx.setGrants("ledger", { "clinical.visits.document": true, "finance.patient-ledger.view": true, "settings.view": true, "settings.operational.edit": true, "settings.finance.edit": true }, { patientScope: "all" });
    try {
      expect((await settings.readCanonicalSettings(await fx.session("ledger"))).__canWrite).not.toContain("ortho.case_doctor_no_charge");
      expect((await settings.readCanonicalSettings(await fx.session("owner"))).__canWrite).toContain("ortho.case_doctor_no_charge");
      const write = settings.parseCanonicalSettingsUpdate({ "ortho.case_doctor_no_charge": "true", __versions: { "ortho.case_doctor_no_charge": null }, __reason: "محاولة مفوَّض" });
      await expect(settings.commandCanonicalSettingsWrite(await fx.session("ledger"), write, fx.pool)).rejects.toMatchObject({ code: "setting_not_granted" });
    } finally { await fx.setGrants("ledger", { "clinical.visits.document": true, "finance.patient-ledger.view": true }, { patientScope: "all" }); }
  });
});

describe("the visit's amounts (owner decision 6629149113, item 2)", () => {
  it("finance.invoices.view shows them, finance.patient-ledger.view does not; neither grants the other; revocation hides them", async () => {
    const { visitId, patientId } = await pricedVisit("biller");
    const money = /unitPriceMinor|totalMinor|23450/;
    expect(JSON.stringify(await cockpit.readCanonicalVisitClinical(await fx.session("biller"), visitId))).toMatch(money);
    expect(JSON.stringify(await cockpit.readCanonicalVisitClinical(await fx.session("ledger"), visitId))).not.toMatch(money);
    expect((await reads.readCanonicalTimeline(await fx.session("ledger"), patientId, 50)).canSeeFinancial).toBe(true);
    expect((await reads.readCanonicalTimeline(await fx.session("biller"), patientId, 50)).canSeeFinancial).toBe(false);
    await fx.setGrants("biller", SIGN, { patientScope: "all" });
    try {
      expect(JSON.stringify(await cockpit.readCanonicalVisitClinical(await fx.session("biller"), visitId))).not.toMatch(money);
    } finally { await fx.setGrants("biller", { ...SIGN, "finance.invoices.view": true }, { patientScope: "all" }); }
  });
});
