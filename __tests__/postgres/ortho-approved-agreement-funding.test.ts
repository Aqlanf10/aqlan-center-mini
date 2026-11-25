import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";

/**
 * FIN-INT-4: the invoice or approved agreement is the financial foundation of an
 * orthodontic case; installments are only a collection schedule. A case linked to
 * an approved full-principal agreement without a schedule must classify its
 * adjustments as included, exactly like the old installment package, and must not
 * create another invoice or due amount when the visit is signed.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_approved_funding_test");
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const { approveAgreement } = await import("../../lib/approved-agreements");
const { patientLegacyOnboarding } = await import("../../lib/legacy-onboarding-db");
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let session: SessionPayload;
let doctorId = 0;
let serial = 0;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-ortho-agreement");
  const [user] = await q<{ id: number }>(`INSERT INTO users(username, display_name, password_hash, role, is_active)
    VALUES ('ortho-agreement-admin', 'Synthetic approval', $1, 'admin', TRUE) RETURNING id`, [hash]);
  session = { userId: user.id, username: "ortho-agreement-admin", role: "admin",
    credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  [{ id: doctorId }] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic orthodontist') RETURNING id`);
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function plan(options: { approve: boolean; installments?: number }) {
  serial += 1;
  const name = `Synthetic ortho agreement ${serial}`;
  const [{ id: patientId }] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`ORTHO-AP-${serial}`, name]);
  const [{ id: planId }] = await q<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, consent_at, consent_by)
    VALUES ($1, 'Synthetic full orthodontic agreement', 900000, 'YER', NOW(), 'synthetic') RETURNING id`, [patientId]);
  for (let number = 1; number <= (options.installments ?? 0); number += 1) {
    await q(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, $2, $3::date, $4)`,
      [planId, number, today, 900000 / (options.installments ?? 1)]);
  }
  if (options.approve) {
    await approveAgreement({ planId, expectedTotalMinor: 900000, currency: "YER", source: { kind: "new" },
      reason: "Synthetic full orthodontic approval", idempotencyKey: `ortho-approve-${serial}`, session });
  }
  return { patientId, planId, name };
}

function openCase(patientId: number, planId: number | null) {
  return db.createOrthoCase({
    patientId, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
    startDate: today, plannedMonths: 18, planId, note: null, createdBy: "doctor",
  });
}

async function adjust(caseId: number) {
  const saved = await db.recordAdjustment({
    caseId, visitId: null, doneOn: today, phase: null, upperWire: "016 NiTi", lowerWire: null,
    elastics: "none", elasticNote: null, done: "Synthetic periodic adjustment", nextWeeks: 4, note: null,
    recordedBy: "doctor", actorRole: "doctor",
  });
  if (!saved.ok) throw new Error(saved.message);
  return saved;
}

const invoiceIds = async (patientId: number) =>
  (await q<{ id: number }>(`SELECT id FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId])).map((row) => row.id);

describe("FIN-INT-4 approved agreement funds the orthodontic case", () => {
  it("includes the adjustment of a case on an approved agreement without a schedule; signing adds no invoice or dues", async () => {
    const { patientId, planId, name } = await plan({ approve: true });
    const before = await invoiceIds(patientId);
    expect(before).toHaveLength(1);
    const opened = await openCase(patientId, planId);
    if (!opened.ok) throw new Error(opened.message);
    const visit = await db.addVisit({ patientName: name, patientPhone: null, note: null, patientId, doctorId });
    await adjust(opened.id);
    expect((await db.getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("INCLUDED");
    const signed = await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0, orthoBillingClass: "INCLUDED" });
    expect(await invoiceIds(patientId)).toEqual(before);
    const onboarding = await patientLegacyOnboarding(patientId, opened.id);
    expect(onboarding?.adjustmentClass).toBe("INCLUDED");
  });

  it("linking afterwards reports the approved agreement as funding", async () => {
    const { patientId, planId, name } = await plan({ approve: true });
    const opened = await openCase(patientId, null);
    if (!opened.ok) throw new Error(opened.message);
    const visit = await db.addVisit({ patientName: name, patientPhone: null, note: null, patientId, doctorId });
    await adjust(opened.id);
    expect((await db.getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("OUTSIDE_CONTRACT");
    expect(await db.linkOrthoCasePlan({ caseId: opened.id, planId, actor: "reception", actorRole: "reception" }))
      .toEqual({ ok: true, changed: true, funded: true });
    expect((await db.getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("INCLUDED");
  });

  it("controls: an unapproved plan without a schedule still does not fund; the installment package is unchanged", async () => {
    const proposal = await plan({ approve: false });
    const unfunded = await openCase(proposal.patientId, proposal.planId);
    if (!unfunded.ok) throw new Error(unfunded.message);
    expect(await db.linkOrthoCasePlan({ caseId: unfunded.id, planId: proposal.planId, actor: "doctor", actorRole: "doctor" }))
      .toEqual({ ok: true, changed: false, funded: false });
    const schedule = await plan({ approve: false, installments: 3 });
    const funded = await openCase(schedule.patientId, schedule.planId);
    if (!funded.ok) throw new Error(funded.message);
    expect(await db.linkOrthoCasePlan({ caseId: funded.id, planId: schedule.planId, actor: "doctor", actorRole: "doctor" }))
      .toEqual({ ok: true, changed: false, funded: true });
  });

  it("another patient's approved agreement cannot fund the case", async () => {
    const mine = await plan({ approve: false });
    const other = await plan({ approve: true });
    expect(await openCase(mine.patientId, other.planId)).toEqual({ ok: false, message: "الخطة المختارة ليست لهذا المريض." });
  });
});
