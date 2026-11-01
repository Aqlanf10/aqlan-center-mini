/** Slice 31: Canonical Orthodontics operations & documentation on real PostgreSQL 18. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ortho-canonical-20261031-secret");

const db = await import("../../lib/db");
const orthoOps = await import("../../lib/canonical-ortho-operations");
const orthoReads = await import("../../lib/canonical-ortho-reads");
const orthoAssessment = await import("../../lib/canonical-ortho-assessment");
const strategyStore = await import("../../lib/ortho-treatment-strategy-store");
const coverageStore = await import("../../lib/canonical-ortho-followup-coverage");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");

const ORTHO_VIEW = { "clinical.ortho.view": true } as const;
const ORTHO_EDIT_ONLY = {
  "clinical.ortho.view": true,
  "clinical.ortho.edit": true,
} as const;
const ORTHO_EDIT_WITH_PLANS_AND_XRAYS = {
  "clinical.ortho.view": true,
  "clinical.ortho.edit": true,
  "clinical.plans.view": true,
  "clinical.plans.edit": true,
  "clinical.xrays.view": true,
} as const;
const AGREEMENTS_ADMIN = {
  "finance.patient-ledger.view": true,
  "finance.agreements.manage": true,
} as const;
const BILLING_DESK = {
  "clinical.ortho.view": true,
  "finance.invoices.create": true,
} as const;

const ACCOUNTS = {
  owner: { username: "SYN-ORTHO-OWNER", role: "admin" },
  ownClinician: {
    username: "SYN-ORTHO-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    grants: ORTHO_EDIT_WITH_PLANS_AND_XRAYS,
  },
  otherClinician: {
    username: "SYN-ORTHO-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    grants: ORTHO_EDIT_ONLY,
  },
  viewOnlyAll: {
    username: "SYN-ORTHO-VIEW-ALL",
    role: "reception",
    patientScope: "all",
    grants: ORTHO_VIEW,
  },
  agreementsAll: {
    username: "SYN-ORTHO-AGREE-ALL",
    role: "admin",
    patientScope: "all",
    grants: AGREEMENTS_ADMIN,
  },
  billingAll: {
    username: "SYN-ORTHO-BILL-ALL",
    role: "reception",
    patientScope: "all",
    grants: BILLING_DESK,
  },
  noneScope: {
    username: "SYN-ORTHO-NONE",
    role: "doctor",
    doctor: true,
    patientScope: "none",
    grants: ORTHO_EDIT_WITH_PLANS_AND_XRAYS,
  },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;
let side: Pool;

const ids = {
  ownPatient: 0,
  baselinePatient: 0,
  foreignPatient: 0,
  foreignCaseId: 0,
  ownPlanId: 0,
};

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });

  ids.ownPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-ORT-P1','SYN Ortho Own',$1) RETURNING id",
    [fx.parties.ownClinician!],
  )).rows[0].id;

  ids.baselinePatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-ORT-P2','SYN Ortho Baseline',$1) RETURNING id",
    [fx.parties.ownClinician!],
  )).rows[0].id;

  ids.foreignPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-ORT-P3','SYN Ortho Foreign',$1) RETURNING id",
    [fx.parties.otherClinician!],
  )).rows[0].id;

  ids.ownPlanId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO treatment_plans(patient_id,title,status,base_currency,total_minor,created_by)
     VALUES($1,'SYN Ortho Plan','accepted','YER',500000,'SYN') RETURNING id`,
    [ids.ownPatient],
  )).rows[0].id;

  const foreignCreated = await orthoOps.commandCanonicalOrthoCreate(await fx.session("owner"), {
    patientId: ids.foreignPatient,
    appliance: "fixed_metal",
    arches: "both",
    slot: "022",
    plannedMonths: 24,
    startDate: "2026-01-10",
  });
  ids.foreignCaseId = foreignCreated.id;
}, 180_000);

afterAll(async () => {
  await side?.end();
  await fx?.close();
});

it("registers all five orthodontic canonical record reads on patient scope", () => {
  expect(CANONICAL_RECORD_READS["read:ortho.assessment"]).toEqual({
    record: "patient",
    need: ["clinical.ortho.view"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:ortho.case"]).toEqual({
    record: "patient",
    need: ["clinical.ortho.view"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:ortho.followups"]).toEqual({
    record: "patient",
    need: ["clinical.ortho.view"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:ortho.billing-decisions"]).toEqual({
    record: "patient",
    need: ["clinical.ortho.view"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:ortho.followup-coverage"]).toEqual({
    record: "patient",
    need: ["finance.agreements.manage"],
    anyOf: [],
  });
});

it("creates, reads with capability-projected photos/planId, adjusts, links plan, updates phase/retainer, and closes with atomic audit", async () => {
  // View-only cannot create
  await expect(
    orthoOps.commandCanonicalOrthoCreate(await fx.session("viewOnlyAll"), { patientId: ids.ownPatient }),
  ).rejects.toThrow(/CAPABILITY_DENIED/);

  // None scope cannot create or read
  await expect(
    orthoOps.commandCanonicalOrthoCreate(await fx.session("noneScope"), { patientId: ids.ownPatient }),
  ).rejects.toMatchObject({ code: "ortho_forbidden", status: 403 });

  // Own clinician cannot create on foreign patient (non-disclosing 404)
  await expect(
    orthoOps.commandCanonicalOrthoCreate(await fx.session("ownClinician"), { patientId: ids.foreignPatient }),
  ).rejects.toMatchObject({ code: "patient_not_found", status: 404 });

  // Own clinician creates case on own patient
  const created = await orthoOps.commandCanonicalOrthoCreate(await fx.session("ownClinician"), {
    patientId: ids.ownPatient,
    appliance: "fixed_metal",
    arches: "both",
    slot: "022",
    plannedMonths: 18,
    startDate: "2026-02-01",
    planId: ids.ownPlanId,
  });
  expect(created.id).toBeGreaterThan(0);

  // Record adjustment + attach a synthetic photo document to verify projection redaction
  const adj = await orthoOps.commandCanonicalOrthoRecordAdjustment(await fx.session("ownClinician"), created.id, {
    doneOn: "2026-03-01",
    phase: "aligning",
    upperWire: "014 NiTi",
    lowerWire: "014 NiTi",
    elastics: "none",
    nextWeeks: 4,
    done: "SYN initial archwire",
  });
  expect(adj.created).toBe(true);

  await fx.pool.query(
    `INSERT INTO patient_documents(patient_id,ortho_case_id,adjustment_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
     VALUES($1,$2,$3,'photo','SYN Intraoral','image/jpeg',100,repeat('a',64),'synthetic/ortho-photo.jpg','SYN')`,
    [ids.ownPatient, created.id, adj.id],
  );

  // Native clinical detail omits photos & planId even for clinicians/owners
  const fullDetail = await orthoReads.readCanonicalOrthoCase(await fx.session("ownClinician"), created.id);
  expect(fullDetail.projection).toBe("case-clinical");
  expect("planId" in fullDetail.case).toBe(false);
  expect("photos" in fullDetail.adjustments[0]).toBe(false);

  // Reception with clinical.ortho.view gets the same native clinical projection
  const redactedDetail = await orthoReads.readCanonicalOrthoCase(await fx.session("viewOnlyAll"), created.id);
  expect(redactedDetail.projection).toBe("case-clinical");
  expect("planId" in redactedDetail.case).toBe(false);

  // Own clinician reading foreign case gets non-disclosing 404
  await expect(
    orthoReads.readCanonicalOrthoCase(await fx.session("ownClinician"), ids.foreignCaseId),
  ).rejects.toMatchObject({ code: "patient_not_found" });

  // Clinician without clinical.plans.edit cannot PATCH planId even on own patient
  await fx.pool.query("UPDATE patients SET primary_doctor_id = $2 WHERE id = $1", [
    ids.foreignPatient,
    fx.parties.otherClinician!,
  ]);
  await expect(
    orthoOps.commandCanonicalOrthoPatch(await fx.session("otherClinician"), ids.foreignCaseId, { planId: null }),
  ).rejects.toMatchObject({ code: "ortho_forbidden", status: 403 });

  // Phase -> Retainer -> Close lifecycle on own case
  await orthoOps.commandCanonicalOrthoPatch(await fx.session("ownClinician"), created.id, { phase: "finishing" });
  await orthoOps.commandCanonicalOrthoPatch(await fx.session("ownClinician"), created.id, {
    retainer: "essix",
    retainerOn: "2026-06-01",
  });

  // Followups board includes open foreign case for all-scope viewer, but excludes it for ownClinician
  const ownFollowups = await orthoOps.readCanonicalOrthoFollowups(await fx.session("ownClinician"));
  const allFollowups = await orthoOps.readCanonicalOrthoFollowups(await fx.session("viewOnlyAll"));
  const ownCaseIds = ownFollowups.buckets.flatMap(b => b.rows.map(r => r.caseId));
  const allCaseIds = allFollowups.buckets.flatMap(b => b.rows.map(r => r.caseId));
  expect(ownCaseIds).toContain(created.id);
  expect(ownCaseIds).not.toContain(ids.foreignCaseId);
  expect(allCaseIds).toContain(ids.foreignCaseId);

  await orthoOps.commandCanonicalOrthoPatch(await fx.session("ownClinician"), created.id, {
    status: "completed",
    note: "SYN completed cleanly",
  });

  const audits = await side.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('ortho.case_create','ortho.phase_change','ortho.retainer','ortho.case_close')",
    [String(created.id)],
  );
  expect(audits.rows.map(r => r.action).sort()).toEqual([
    "ortho.case_close",
    "ortho.case_create",
    "ortho.phase_change",
    "ortho.retainer",
  ]);
});

it("enforces baseline responsibility boundaries and SAVEPOINT uniqueness", async () => {
  // Own clinician cannot assign another doctor as initial responsibleDoctorId
  await expect(
    orthoOps.commandCanonicalOrthoBaseline(await fx.session("ownClinician"), {
      patientId: ids.baselinePatient,
      appliance: "fixed_metal",
      arches: "both",
      slot: "022",
      phase: "working",
      startDate: "2025-01-15",
      monthsElapsed: 6,
      monthsRemaining: 12,
      financialMode: "opening_balance",
      responsibleDoctorId: fx.parties.otherClinician!,
    }),
  ).rejects.toMatchObject({ code: "ortho_forbidden", status: 403 });

  // Defaults responsibleDoctorId to actor's clinicianPartyId
  const baseline = await orthoOps.commandCanonicalOrthoBaseline(await fx.session("ownClinician"), {
    patientId: ids.baselinePatient,
    appliance: "fixed_metal",
    arches: "both",
    slot: "022",
    phase: "working",
    startDate: "2025-01-15",
    monthsElapsed: 6,
    monthsRemaining: 12,
    financialMode: "opening_balance",
  });
  expect(baseline.id).toBeGreaterThan(0);

  const row = (await side.query<{ responsible_doctor_id: number }>(
    "SELECT responsible_doctor_id FROM ortho_cases WHERE id = $1",
    [baseline.id],
  )).rows[0];
  expect(row.responsible_doctor_id).toBe(fx.parties.ownClinician!);

  // Duplicate open case on same patient returns 409 ortho_conflict cleanly via SAVEPOINT
  await expect(
    orthoOps.commandCanonicalOrthoBaseline(await fx.session("ownClinician"), {
      patientId: ids.baselinePatient,
      appliance: "fixed_metal",
      arches: "both",
      slot: "022",
      phase: "working",
      startDate: "2025-01-15",
      monthsElapsed: 6,
      monthsRemaining: 12,
      financialMode: "opening_balance",
    }),
  ).rejects.toMatchObject({ code: "ortho_conflict", status: 409 });
});

it("runs canonical assessment, treatment strategy, followup coverage (including durable rejection commit), and billing decisions", async () => {
  // Open an active bridged case + problem + billed ortho plan item for coverage/strategy/assessment
  const pId = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-ORT-P4','SYN Ortho Bridged',$1) RETURNING id",
    [fx.parties.ownClinician!],
  )).rows[0].id;

  const createdCase = await orthoOps.commandCanonicalOrthoCreate(await fx.session("ownClinician"), {
    patientId: pId,
    appliance: "fixed_metal",
    arches: "both",
    slot: "022",
    plannedMonths: 20,
    startDate: "2026-04-01",
  });

  const clinicalCaseId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO clinical_cases(patient_id,ortho_case_id,specialty,title,site,status,origin,created_by)
     VALUES($1,$2,'orthodontics','تقويم الأسنان','الفكّان','active','clinical','SYN') RETURNING id`,
    [pId, createdCase.id],
  )).rows[0].id;

  const problemId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO patient_problems(patient_id,case_id,label,site,status,noted_by)
     VALUES($1,$2,'SYN Class II crowding','الفكّان','active','SYN') RETURNING id`,
    [pId, clinicalCaseId],
  )).rows[0].id;

  // 1. Canonical Assessment V2 read is strictly immutable read-only (clinicalWritable: false)
  const initialAssessment = await orthoAssessment.readCanonicalOrthoAssessment(
    await fx.session("ownClinician"),
    createdCase.id,
  );
  expect(initialAssessment).toMatchObject({
    ok: true,
    state: "ready",
    revision: null,
    clinicalWritable: false,
    sources: { items: [], truncated: true, imaging: "allowed" },
  });

  // 2. Canonical Treatment Strategy read + append + replay
  const initialStrategy = await strategyStore.getCanonicalOrthoTreatmentStrategy(
    await fx.session("ownClinician"),
    createdCase.id,
  );
  expect(initialStrategy).toMatchObject({ ok: true, state: "ready", revision: null });

  const strategyCmd = {
    schemaVersion: 1,
    commandId: "syn_strategy_cmd_00001",
    expectedRevisionId: null,
    reason: "SYN initial treatment strategy",
    rows: [
      {
        problemId,
        objective: "Relieve crowding",
        strategy: "Arch expansion and sequential NiTi alignment",
        planItemIds: [],
        rationale: "Non-extraction profile preservation",
      },
    ],
  };

  const appendedStrategy = await strategyStore.appendCanonicalOrthoTreatmentStrategy(
    await fx.session("ownClinician"),
    createdCase.id,
    strategyCmd,
  );
  expect(appendedStrategy).toMatchObject({ ok: true, replayed: false });
  const replayedStrategy = await strategyStore.appendCanonicalOrthoTreatmentStrategy(
    await fx.session("ownClinician"),
    createdCase.id,
    strategyCmd,
  );
  expect(replayedStrategy).toMatchObject({ ok: true, replayed: true });

  // 3. Canonical Followup Coverage: read + durable stale_coverage rejection commit + PUT status check
  const covRead = await coverageStore.readCanonicalFollowupCoverage(
    await fx.session("agreementsAll"),
    pId,
    createdCase.id,
  );
  expect(covRead.patientId).toBe(pId);
  expect(covRead.enabled).toBe(true);

  const staleCommandId = "11111111-2222-4333-8444-555555555555";
  const staleCmd = {
    schemaVersion: 1,
    commandId: staleCommandId,
    expectedRevisionId: "999999", // stale on purpose so durable rejection receipt is committed!
    source: {
      patientId: pId,
      orthoCaseId: createdCase.id,
      clinicalCaseId,
      planId: ids.ownPlanId,
      planItemId: 1,
      invoiceId: 1,
    },
    expectedSourceFingerprint: "a".repeat(64),
    scope: "routine_adjustments",
    decision: "included",
    reason: "SYN stale head rejection test",
  };

  await expect(
    coverageStore.appendCanonicalFollowupCoverage(await fx.session("agreementsAll"), pId, createdCase.id, staleCmd),
  ).rejects.toMatchObject({ status: 409, code: "stale_coverage" });

  // Verify the rejection receipt was COMMITTED durably despite throwing 409 FollowupCoverageError!
  const statusAfterReject = await coverageStore.readCanonicalFollowupCoverageCommandStatus(
    await fx.session("agreementsAll"),
    pId,
    createdCase.id,
    staleCmd,
  );
  expect(statusAfterReject.state).toBe("rejected");

  // 4. Canonical Billing Decisions: branch capability enforcement (no_charge vs billed)
  const outsideAdj1 = (await fx.pool.query<{ id: number }>(
    `INSERT INTO ortho_adjustments(case_id,done_on,elastics,next_weeks,recorded_by,billing_class)
     VALUES($1,'2026-04-15','none',4,'SYN','OUTSIDE_CONTRACT') RETURNING id`,
    [createdCase.id],
  )).rows[0].id;
  const outsideAdj2 = (await fx.pool.query<{ id: number }>(
    `INSERT INTO ortho_adjustments(case_id,done_on,elastics,next_weeks,recorded_by,billing_class)
     VALUES($1,'2026-04-20','none',4,'SYN','OUTSIDE_CONTRACT') RETURNING id`,
    [createdCase.id],
  )).rows[0].id;

  const pendingOwn = await orthoOps.readCanonicalOrthoBillingDecisions(await fx.session("ownClinician"));
  expect(pendingOwn.pending.map(p => p.adjustmentId)).toEqual(expect.arrayContaining([outsideAdj1, outsideAdj2]));

  // Billing desk WITHOUT clinical.ortho.edit cannot decide no_charge
  await expect(
    orthoOps.commandCanonicalOrthoBillingDecision(await fx.session("billingAll"), outsideAdj1, {
      decision: "no_charge",
      reason: "SYN attempt without ortho.edit",
    }),
  ).rejects.toThrow(/CAPABILITY_DENIED/);

  // Clinician WITHOUT finance.invoices.create cannot decide billed
  await expect(
    orthoOps.commandCanonicalOrthoBillingDecision(await fx.session("ownClinician"), outsideAdj2, {
      decision: "billed",
      invoiceNumber: "SYN-INV-ORTHO-1",
    }),
  ).rejects.toThrow(/CAPABILITY_DENIED/);

  // Clinician WITH clinical.ortho.edit decides no_charge
  const noChargeRes = await orthoOps.commandCanonicalOrthoBillingDecision(
    await fx.session("ownClinician"),
    outsideAdj1,
    { decision: "no_charge", reason: "SYN warranty adjustment" },
  );
  expect(noChargeRes).toEqual({ ok: true, decision: "no_charge" });

  // Billing desk WITH finance.invoices.create decides billed against live patient invoice
  await fx.pool.query(
    `INSERT INTO invoices(invoice_number,patient_id,status,base_currency,discount_minor,total_minor,created_by)
     VALUES('SYN-INV-ORTHO-1',$1,'open','YER',0,15000,'SYN')`,
    [pId],
  );
  const billedRes = await orthoOps.commandCanonicalOrthoBillingDecision(
    await fx.session("billingAll"),
    outsideAdj2,
    { decision: "billed", invoiceNumber: "SYN-INV-ORTHO-1" },
  );
  expect(billedRes).toEqual({ ok: true, decision: "billed" });
});
