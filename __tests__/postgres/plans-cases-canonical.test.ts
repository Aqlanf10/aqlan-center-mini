/** Slice 32: Canonical Treatment Plans & Specialty Clinical Cases on real PostgreSQL 18. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-plans-cases-canonical-20261031");

const db = await import("../../lib/db");
const plansCases = await import("../../lib/canonical-plans-and-cases");
const approvedAgreements = await import("../../lib/approved-agreements");
const amendmentDb = await import("../../lib/agreement-amendment-db");
const reconcileDb = await import("../../lib/agreement-reconciliation-db");
const shifts = await import("../../lib/canonical-shifts");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");

const ACCOUNTS = {
  owner: { username: "SYN-PLAN-OWNER", role: "admin" },
  ownDoctor: {
    username: "SYN-PLAN-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.plans.view": true,
      "clinical.plans.edit": true,
      "appointments.create": true,
    },
  },
  ownDoctorWithDiscounts: {
    username: "SYN-PLAN-DOC-DISC",
    role: "doctor",
    doctor: true,
    patientScope: "all",
    appointmentScope: "all",
    grants: {
      "clinical.plans.view": true,
      "clinical.plans.edit": true,
      "finance.discounts.apply": true,
    },
  },
  otherDoctor: {
    username: "SYN-PLAN-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.plans.view": true,
      "clinical.plans.edit": true,
    },
  },
  templatesManager: {
    username: "SYN-PLAN-TMPL",
    role: "reception",
    patientScope: "all",
    grants: {
      "clinical.plans.view": true,
      "finance.service-prices.view": true,
      "settings.view": true,
      "settings.operational.edit": true,
    },
  },
  financeInvoicesOnly: {
    username: "SYN-PLAN-FIN-INV",
    role: "accountant",
    patientScope: "all",
    grants: {
      "finance.invoices.view": true,
    },
  },
  recordReaderOnly: {
    username: "SYN-PLAN-REC-ONLY",
    role: "reception",
    patientScope: "all",
    grants: {},
  },
  cashierCollector: {
    username: "SYN-PLAN-CASHIER",
    role: "cashier",
    patientScope: "all",
    grants: {
      "finance.payments.collect": true,
      "finance.invoices.create": true,
      "finance.shifts.view": true,
      "finance.shifts.operate": true,
    },
  },
  agreementsManager: {
    username: "SYN-PLAN-AGREE",
    role: "admin",
    patientScope: "all",
    grants: {
      "finance.patient-ledger.view": true,
      "finance.agreements.manage": true,
      "finance.invoices.create": true,
    },
  },
  noneScope: {
    username: "SYN-PLAN-NONE",
    role: "doctor",
    doctor: true,
    patientScope: "none",
    grants: {
      "clinical.plans.view": true,
      "clinical.plans.edit": true,
    },
  },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;

const ids = {
  ownPatient: 0,
  foreignPatient: 0,
  serviceBase: 0,
  serviceUpgrade: 0,
  serviceUsd: 0,
  ownPlanId: 0,
  foreignPlanId: 0,
};

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");

  ids.ownPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PLN-P1','SYN Plan Own',$1) RETURNING id",
    [fx.parties.ownDoctor!],
  )).rows[0].id;

  ids.foreignPatient = (await fx.pool.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PLN-P2','SYN Plan Foreign',$1) RETURNING id",
    [fx.parties.otherDoctor!],
  )).rows[0].id;

  ids.serviceBase = (await fx.pool.query<{ id: number }>(
    "INSERT INTO services(name,category,price_minor,is_active,sort_order) VALUES('SYN Crown Metal','prosthodontics',100000,TRUE,1) RETURNING id",
  )).rows[0].id;

  ids.serviceUpgrade = (await fx.pool.query<{ id: number }>(
    "INSERT INTO services(name,category,price_minor,is_active,sort_order) VALUES('SYN Crown Zirconia','prosthodontics',160000,TRUE,2) RETURNING id",
  )).rows[0].id;

  ids.serviceUsd = (await fx.pool.query<{ id: number }>(
    "INSERT INTO services(name,category,price_minor,price_usd_minor,is_active,sort_order) VALUES('SYN Implant USD','implantology',500000,50000,TRUE,3) RETURNING id",
  )).rows[0].id;

  await fx.pool.query(
    `INSERT INTO settings(key,value) VALUES
       ('fx.USD_to_YER','530'),
       ('fx.SAR_to_YER','140'),
       ('billing.max_discount_percent','20')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  await fx.pool.query(
    "INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source,reason,recorded_by) VALUES($1,30,NULL,'2025-01-01T00:00:00Z','baseline','Synthetic known policy','SYN')",
    [fx.parties.ownDoctor!],
  );

  ids.ownPlanId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO treatment_plans(patient_id,title,status,base_currency,total_minor,total_from_items,primary_doctor_id,created_by)
     VALUES($1,'SYN Own Treatment Plan','active','YER',0,TRUE,$2,'SYN') RETURNING id`,
    [ids.ownPatient, fx.parties.ownDoctor!],
  )).rows[0].id;

  ids.foreignPlanId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO treatment_plans(patient_id,title,status,base_currency,total_minor,total_from_items,primary_doctor_id,created_by)
     VALUES($1,'SYN Foreign Treatment Plan','active','YER',80000,FALSE,$2,'SYN') RETURNING id`,
    [ids.foreignPatient, fx.parties.otherDoctor!],
  )).rows[0].id;
}, 180_000);

afterAll(async () => {
  await fx?.close();
});

it("registers all five canonical plan record reads and projects /api/plan-templates by capability", async () => {
  expect(CANONICAL_RECORD_READS["read:patients.plans"]).toEqual({
    record: "patient",
    need: ["clinical.plans.view"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:plans"]).toEqual({
    record: "patient",
    need: [],
    anyOf: ["clinical.plans.view", "finance.invoices.view"],
  });
  expect(CANONICAL_RECORD_READS["read:plans.proposals"]).toEqual({
    record: "patient",
    need: ["clinical.plans.edit"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:plans.agreement-amendment"]).toEqual({
    record: "patient",
    need: ["finance.agreements.manage"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:plans.reconcile"]).toEqual({
    record: "patient",
    need: ["finance.agreements.manage"],
    anyOf: [],
  });

  await expect(plansCases.readCanonicalPlanTemplates(await fx.session("financeInvoicesOnly"))).rejects.toThrow(/CAPABILITY_DENIED/);

  const clinicalOnly = await plansCases.readCanonicalPlanTemplates(await fx.session("ownDoctor"));
  expect(clinicalOnly.showPrices).toBe(false);
  expect(clinicalOnly.canEdit).toBe(false);
  expect(clinicalOnly.services.every(s => s.priceMinor === null)).toBe(true);

  const managerView = await plansCases.readCanonicalPlanTemplates(await fx.session("templatesManager"));
  expect(managerView.showPrices).toBe(true);
  expect(managerView.canEdit).toBe(true);
  expect(managerView.services.find(s => s.id === ids.serviceBase)?.priceMinor).toBe(100000);
});

it("enforces patient scope, PLAN_CREATION_ENTRY_REQUIRED, and clinical vs financial projections on plan reads", async () => {
  // Foreign patient under own scope -> 404 (never 409 entry refusal that would leak existence)
  await expect(
    plansCases.commandCanonicalCreatePlanRefusal(await fx.session("ownDoctor"), { patientId: ids.foreignPatient }),
  ).rejects.toMatchObject({ code: "patient_not_found", status: 404 });

  // Own patient -> 409 PLAN_CREATION_ENTRY_REQUIRED
  await expect(
    plansCases.commandCanonicalCreatePlanRefusal(await fx.session("ownDoctor"), { patientId: ids.ownPatient }),
  ).rejects.toMatchObject({ code: "PLAN_CREATION_ENTRY_REQUIRED", status: 409 });

  // Patient plans read: foreign -> 404, own -> clinical without money fields
  await expect(
    plansCases.readCanonicalPatientPlans(await fx.session("ownDoctor"), ids.foreignPatient),
  ).rejects.toMatchObject({ code: "patient_not_found", status: 404 });

  const ownPatientPlans = await plansCases.readCanonicalPatientPlans(await fx.session("ownDoctor"), ids.ownPlanId ? ids.ownPatient : 0);
  expect(ownPatientPlans.canSeeFinancial).toBe(false);
  expect(ownPatientPlans.plans.map(p => p.id)).toContain(ids.ownPlanId);

  // Active plans directory: ownDoctor only sees own patient's plan
  const ownActive = await plansCases.readCanonicalPlans(await fx.session("ownDoctor"), null);
  expect(ownActive.canSeeFinancial).toBe(false);
  expect(ownActive.plans.map(p => p.id)).toContain(ids.ownPlanId);
  expect(ownActive.plans.map(p => p.id)).not.toContain(ids.foreignPlanId);

  // Finance-only reader sees clinical-redacted receivable summary across all scope
  const finOnly = await plansCases.readCanonicalPlans(await fx.session("financeInvoicesOnly"), null);
  expect(finOnly.canSeeFinancial).toBe(true);
  const finRow = finOnly.plans.find(p => p.id === ids.ownPlanId)!;
  expect(finRow).toBeDefined();
  expect(finRow.title).toBe(`خطة مالية #${ids.ownPlanId}`);
  expect("items" in finRow).toBe(false);
});

it("manages plan items, foreign-currency price authority, proposals, consent, installments, reminders, and status transitions", async () => {
  // Base-currency item add + update + delete
  const added1 = await plansCases.commandCanonicalAddPlanItem(await fx.session("ownDoctor"), ids.ownPlanId, {
    serviceId: ids.serviceBase,
    quantity: 1,
    toothCode: 16,
  });
  expect(added1.totalMinor).toBe(100000);

  const addedTemp = await plansCases.commandCanonicalAddPlanItem(await fx.session("ownDoctor"), ids.ownPlanId, {
    serviceId: ids.serviceUpgrade,
    quantity: 1,
    toothCode: 26,
  });
  expect(addedTemp.totalMinor).toBe(260000);

  const planAfterAdd = await db.getPlanWith(fx.pool, ids.ownPlanId, "2026-10-31");
  const tempItem = planAfterAdd!.items.find(i => i.toothCode === 26)!;

  await plansCases.commandCanonicalUpdatePlanItem(await fx.session("ownDoctor"), ids.ownPlanId, {
    itemId: tempItem.id,
    plannedVisitNumber: 2,
    billingRule: "per_session",
    sessionCount: 2,
    note: "تحضير وتثبيت",
  });

  await plansCases.commandCanonicalRemovePlanItem(await fx.session("ownDoctor"), ids.ownPlanId, tempItem.id);

  // Foreign-currency (USD) plan item price authority
  const usdPlanId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO treatment_plans(patient_id,title,status,base_currency,total_minor,total_from_items,primary_doctor_id,created_by)
     VALUES($1,'SYN USD Implant Plan','active','USD',0,TRUE,$2,'SYN') RETURNING id`,
    [ids.ownPatient, fx.parties.ownDoctor!],
  )).rows[0].id;

  // Discount without finance.discounts.apply -> 403
  await expect(
    plansCases.commandCanonicalAddPlanItem(await fx.session("ownDoctor"), usdPlanId, {
      serviceId: ids.serviceUsd,
      quantity: 1,
      price: "450",
      priceReason: "خصم متفق عليه",
    }),
  ).rejects.toMatchObject({ code: "plan_forbidden", status: 403 });

  // Discount with finance.discounts.apply within 20% -> succeeds and audits plan.price_override
  const usdAdded = await plansCases.commandCanonicalAddPlanItem(await fx.session("ownDoctorWithDiscounts"), usdPlanId, {
    serviceId: ids.serviceUsd,
    quantity: 1,
    price: "450",
    priceReason: "خصم ضمن الحد المسموح",
  });
  expect(usdAdded.totalMinor).toBe(45000);

  const overrideAudit = await fx.pool.query(
    "SELECT action, actor FROM audit_log WHERE entity='treatment_plan' AND entity_id=$1 AND action='plan.price_override'",
    [usdPlanId],
  );
  expect(overrideAudit.rowCount).toBe(1);

  // Pending proposals before consent (scoped to ownDoctor, without money)
  const proposalsOwn = await plansCases.readCanonicalPendingProposals(await fx.session("ownDoctor"));
  expect(proposalsOwn.proposals.some(p => p.planId === ids.ownPlanId)).toBe(true);
  expect(proposalsOwn.proposals.some(p => p.planId === ids.foreignPlanId)).toBe(false);
  expect(proposalsOwn.proposals.find(p => p.planId === ids.ownPlanId)?.totalMinor).toBeNull();

  await plansCases.commandCanonicalProposalContact(await fx.session("ownDoctor"), {
    planId: ids.ownPlanId,
    note: "تم التواصل مع المريض لتأكيد الخطة",
  });

  // Consent + 2 installments on ownPlanId
  const consented = await plansCases.commandCanonicalPlanConsent(await fx.session("ownDoctor"), ids.ownPlanId, {
    note: "موافقة المريض الخطية",
    count: 2,
    everyDays: 30,
    firstDueDate: "2026-11-01",
  });
  expect(consented).toEqual({ status: 201, body: { totalMinor: 100000, installments: 2 } });

  // Reminders: appointments.create + own scope updates own plan, 404s on foreign plan
  await expect(
    plansCases.commandCanonicalPlanReminders(await fx.session("ownDoctor"), { planId: ids.foreignPlanId }),
  ).rejects.toMatchObject({ code: "plan_not_found", status: 404 });

  const singleReminder = await plansCases.commandCanonicalPlanReminders(await fx.session("ownDoctor"), {
    planId: ids.ownPlanId,
    installmentNumber: 1,
  });
  expect(singleReminder.success).toBe(true);

  const bulkReminder = await plansCases.commandCanonicalPlanReminders(await fx.session("ownDoctor"), {
    planIds: [ids.ownPlanId, ids.foreignPlanId],
  });
  expect(bulkReminder).toMatchObject({ success: true, updatedCount: 1 });

  // Plan status change requires reason on cancel & reactivation
  await expect(
    plansCases.commandCanonicalSetPlanStatus(await fx.session("ownDoctor"), usdPlanId, { status: "cancelled" }),
  ).rejects.toMatchObject({ code: "invalid_plan_input", status: 400 });

  await plansCases.commandCanonicalSetPlanStatus(await fx.session("ownDoctor"), usdPlanId, {
    status: "cancelled",
    reason: "تأجيل الزراعة بطلب المريض",
  });
  await plansCases.commandCanonicalSetPlanStatus(await fx.session("ownDoctor"), usdPlanId, {
    status: "active",
    reason: "عودة المريض لاستكمال الخطة",
  });
});

it("manages clinical cases, own-scope responsibility boundaries, plan-item linking, and DAG dependency cycle prevention", async () => {
  // Add a second plan item on a dedicated case-graph plan so we test DAG dependencies cleanly
  const graphPlanId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO treatment_plans(patient_id,title,status,base_currency,total_minor,total_from_items,primary_doctor_id,created_by)
     VALUES($1,'SYN Case Graph Plan','active','YER',0,TRUE,$2,'SYN') RETURNING id`,
    [ids.ownPatient, fx.parties.ownDoctor!],
  )).rows[0].id;

  await plansCases.commandCanonicalAddPlanItem(await fx.session("ownDoctor"), graphPlanId, {
    serviceId: ids.serviceBase,
    quantity: 1,
    toothCode: 36,
  });
  await plansCases.commandCanonicalAddPlanItem(await fx.session("ownDoctor"), graphPlanId, {
    serviceId: ids.serviceUpgrade,
    quantity: 1,
    toothCode: 37,
  });
  const graphPlan = (await db.getPlanWith(fx.pool, graphPlanId, "2026-10-31"))!;
  const [itemA, itemB] = graphPlan.items;

  // Own-scope doctor cannot assign initial case responsibility to another doctor
  await expect(
    plansCases.commandCanonicalCreateCase(await fx.session("ownDoctor"), ids.ownPatient, {
      specialty: "prosthodontics",
      title: "تركيبات خلفية سفلى",
      responsiblePartyId: fx.parties.otherDoctor!,
    }),
  ).rejects.toMatchObject({ code: "plan_forbidden", status: 403 });

  const createdCase = await plansCases.commandCanonicalCreateCase(await fx.session("ownDoctor"), ids.ownPatient, {
    specialty: "prosthodontics",
    title: "تركيبات خلفية سفلى",
    site: "36, 37",
  });
  expect(createdCase.responsiblePartyId).toBe(fx.parties.ownDoctor!);

  await plansCases.commandCanonicalSetPlanItemCase(await fx.session("ownDoctor"), itemA.id, {
    caseId: createdCase.id,
    priority: 1,
  });
  await plansCases.commandCanonicalSetPlanItemCase(await fx.session("ownDoctor"), itemB.id, {
    caseId: createdCase.id,
    priority: 2,
  });

  // Add dependency itemB -> itemA, then verify cycle itemA -> itemB is rejected with 409
  await plansCases.commandCanonicalAddPlanItemDependency(await fx.session("ownDoctor"), itemB.id, {
    requiresItemId: itemA.id,
    requirement: "completed",
  });
  await expect(
    plansCases.commandCanonicalAddPlanItemDependency(await fx.session("ownDoctor"), itemA.id, {
      requiresItemId: itemB.id,
      requirement: "completed",
    }),
  ).rejects.toMatchObject({ code: "plan_conflict", status: 409 });

  // Projection on GET /api/patients/[id]/cases: recordReaderOnly sees cases without plan items/dependencies
  const recordOnlyCases = await plansCases.readCanonicalPatientCases(await fx.session("recordReaderOnly"), ids.ownPatient);
  expect(recordOnlyCases.planVisible).toBe(false);
  expect(recordOnlyCases.cases.some(c => c.id === createdCase.id)).toBe(true);
  expect(recordOnlyCases.items).toEqual([]);
  expect(recordOnlyCases.dependencies).toEqual([]);

  const clinicalCases = await plansCases.readCanonicalPatientCases(await fx.session("ownDoctor"), ids.ownPatient);
  expect(clinicalCases.planVisible).toBe(true);
  expect(clinicalCases.dependencies.some(d => d.itemId === itemB.id && d.requiresItemId === itemA.id)).toBe(true);

  await plansCases.commandCanonicalRemovePlanItemDependency(await fx.session("ownDoctor"), itemB.id, itemA.id);

  const movedCase = await plansCases.commandCanonicalChangeCaseStatus(await fx.session("ownDoctor"), createdCase.id, {
    status: "waiting",
    outcome: "بانتظار تجربة المعدن",
  });
  expect(movedCase.status).toBe("waiting");
});

it("approves agreements, collects on an open shift, and commits durable stale rejections on amendment and reconciliation", async () => {
  // 1. Financial approval of single-item consented ownPlanId (100,000 YER)
  const approval = await approvedAgreements.approveCanonicalAgreement(await fx.session("cashierCollector"), {
    planId: ids.ownPlanId,
    expectedTotalMinor: 100000,
    currency: "YER",
    source: { kind: "new" },
    reason: "اعتماد اتفاق التاج المعدني",
    idempotencyKey: "syn-approve-own-plan-001",
  });
  expect(approval.replayed).toBe(false);
  expect(approval.agreement.invoice_id).toBeGreaterThan(0);

  // 2. Collection by cashier (finance.payments.collect, NO clinical.plans.edit!): refuses without open shift, succeeds with shift + replays
  await expect(
    plansCases.commandCanonicalPlanCollect(
      await fx.session("cashierCollector"),
      ids.ownPlanId,
      { amount: "400", currency: "YER", method: "cash", note: "دفعة أولى" },
      "syn-collect-own-plan-001",
      "none",
    ),
  ).rejects.toThrow();

  await shifts.commandCanonicalShiftOpen(await fx.session("cashierCollector"), {
    opening: { YER: "1000", SAR: "0", USD: "0" },
  });

  const collected = await plansCases.commandCanonicalPlanCollect(
    await fx.session("cashierCollector"),
    ids.ownPlanId,
    { amount: "400", currency: "YER", method: "cash", note: "دفعة أولى" },
    "syn-collect-own-plan-001",
    "none",
  );
  expect(collected.status).toBe(201);

  const replayedCollect = await plansCases.commandCanonicalPlanCollect(
    await fx.session("cashierCollector"),
    ids.ownPlanId,
    { amount: "400", currency: "YER", method: "cash", note: "دفعة أولى" },
    "syn-collect-own-plan-001",
    "none",
  );
  expect(replayedCollect.status).toBe(200);

  // 3. Agreement Delta Amendment: stale hash commits durable rejection, fresh hash commits positive upgrade
  const amendSnapshot = await amendmentDb.readCanonicalAgreementAmendment(ids.ownPlanId, await fx.session("agreementsManager"));
  expect(amendSnapshot.previousAgreementMinor).toBe(100000);

  const staleAmendInput = {
    idempotencyKey: "syn-amend-stale-0001",
    expectedSourceHash: "0".repeat(64),
    newServiceId: ids.serviceUpgrade,
    newUnitMinor: 160000,
    reason: "ترقية إلى زركونيا",
  };
  await expect(
    amendmentDb.saveCanonicalAgreementAmendment(ids.ownPlanId, staleAmendInput, await fx.session("agreementsManager")),
  ).rejects.toMatchObject({ code: "stale" });

  const staleAmendStatus = await amendmentDb.readCanonicalAgreementAmendmentAttemptStatus(
    ids.ownPlanId,
    staleAmendInput,
    await fx.session("agreementsManager"),
  );
  expect(staleAmendStatus.state).toBe("rejected_stale");

  const validAmendInput = {
    idempotencyKey: "syn-amend-valid-0001",
    expectedSourceHash: amendSnapshot.sourceHash,
    newServiceId: ids.serviceUpgrade,
    newUnitMinor: 160000,
    reason: "ترقية إلى زركونيا معتمدة",
  };
  const committedAmend = await amendmentDb.saveCanonicalAgreementAmendment(
    ids.ownPlanId,
    validAmendInput,
    await fx.session("agreementsManager"),
  );
  expect(committedAmend.deltaMinor).toBe(60000);
  expect(committedAmend.revisedAgreementMinor).toBe(160000);

  const committedAmendStatus = await amendmentDb.readCanonicalAgreementAmendmentAttemptStatus(
    ids.ownPlanId,
    validAmendInput,
    await fx.session("agreementsManager"),
  );
  expect(committedAmendStatus.state).toBe("committed");

  // 4. Agreement Reconciliation on a classic fixed-total consented plan with partial billed history
  const classicPlanId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO treatment_plans(patient_id,title,status,base_currency,total_minor,total_from_items,consent_at,primary_doctor_id,created_by)
     VALUES($1,'SYN Classic Reconcile Plan','active','YER',100000,FALSE,NOW(),$2,'SYN') RETURNING id`,
    [ids.ownPatient, fx.parties.ownDoctor!],
  )).rows[0].id;
  await fx.pool.query(
    `INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES
       ($1,1,'2026-10-01',50000),
       ($1,2,'2026-12-01',50000)`,
    [classicPlanId],
  );
  const classicInvId = (await fx.pool.query<{ id: number }>(
    `INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,plan_id,created_by)
     VALUES('SYN-INV-REC-1',$1,40000,0,'YER','open',$2,'SYN') RETURNING id`,
    [ids.ownPatient, classicPlanId],
  )).rows[0].id;
  await fx.pool.query(
    `INSERT INTO invoice_items(invoice_id,doctor_id,description,quantity,unit_price_minor,total_minor)
     VALUES($1,$2,'قسط كلاسيكي أول',1,40000,40000)`,
    [classicInvId, fx.parties.ownDoctor!],
  );

  const recView = await reconcileDb.readCanonicalAgreementReconciliation(classicPlanId, await fx.session("agreementsManager"));
  expect(recView.canConfirm).toBe(true);
  expect(recView.amounts.unbilledPrincipalMinor).toBe(60000);

  const staleRecCmd = {
    operationKey: "syn-reconcile-stale-001",
    expectedSourceHash: "f".repeat(64),
    reason: "تسوية الاتفاق الكلاسيكي",
  };
  await expect(
    reconcileDb.saveCanonicalAgreementReconciliation(classicPlanId, staleRecCmd, await fx.session("agreementsManager")),
  ).rejects.toMatchObject({ code: "agreement_source_changed" });

  const staleRecStatus = await reconcileDb.readCanonicalAgreementReconciliationAttemptStatus(
    classicPlanId,
    staleRecCmd,
    await fx.session("agreementsManager"),
  );
  expect(staleRecStatus.state).toBe("rejected");

  const validRecCmd = {
    operationKey: "syn-reconcile-valid-001",
    expectedSourceHash: recView.sourceHash,
    reason: "تسوية الاتفاق الكلاسيكي المعتمدة",
  };
  const reconciled = await reconcileDb.saveCanonicalAgreementReconciliation(
    classicPlanId,
    validRecCmd,
    await fx.session("agreementsManager"),
  );
  expect(reconciled.status).toBe("reconciled");
  expect(reconciled.reconciliation.deltaInvoiceId).toBeGreaterThan(0);

  const committedRecStatus = await reconcileDb.readCanonicalAgreementReconciliationAttemptStatus(
    classicPlanId,
    validRecCmd,
    await fx.session("agreementsManager"),
  );
  expect(committedRecStatus.state).toBe("committed");
});
