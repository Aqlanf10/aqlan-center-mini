/** Slice 36: Canonical Patient Finance, Responsibility, Families, Debt Repayments, Historical Documents, Legacy Treatments & Clinic Opening Balances on real PostgreSQL 18. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-patient-finance-slice36-20261031");

const db = await import("../../lib/db");
const slice36 = await import("../../lib/canonical-patient-finance-history");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const { staffRuntimeActions } = await import("../../lib/staff-operation-runtime");

const ACCOUNTS = {
  owner: { username: "SYN-FIN36-OWNER", role: "admin" },
  ledgerViewer: {
    username: "SYN-FIN36-LEDGER-VIEW",
    role: "accountant",
    patientScope: "all",
    grants: {
      "finance.patient-ledger.view": true,
      "finance.invoices.view": true,
      "finance.reconciliation.view": true,
    },
  },
  ledgerVoidViewer: {
    username: "SYN-FIN36-VOID-VIEW",
    role: "admin",
    patientScope: "all",
    grants: {
      "finance.patient-ledger.view": true,
      "finance.payments.view": true,
      "finance.payments.void": true,
    },
  },
  financeOperator: {
    username: "SYN-FIN36-OPERATOR",
    role: "admin",
    patientScope: "all",
    grants: {
      "patients.edit": true,
      "finance.patient-ledger.view": true,
      "finance.patient-ledger.manage": true,
      "finance.opening-balances.manage": true,
      "finance.reconciliation.view": true,
      "finance.payments.collect": true,
      "finance.legacy.record": true,
      "finance.legacy.void": true,
      "patients.history.record": true,
      "patients.history.correct": true,
      "finance.discounts.apply": true,
      "finance.discounts.override": true,
      "finance.price-increases.apply": true,
    },
  },
  ownDoctorNoMoney: {
    username: "SYN-FIN36-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.visits.document": true,
      "finance.invoices.view": true,
    },
  },
  otherDoctor: {
    username: "SYN-FIN36-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.visits.document": true,
    },
  },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;

const ids = {
  ownPatient: 0,
  foreignPatient: 0,
  debtPatient: 0,
  legacyPatient: 0,
  histDocPatient: 0,
  ownVisit: 0,
  foreignVisit: 0,
  clinicalCaseId: 0,
  orthoCaseId: 0,
  endoServiceId: 0,
  crownServiceId: 0,
  supplierPartyId: 0,
};

function jsonReq(url: string, method: string, body?: unknown, extraHeaders?: Record<string, string>): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(extraHeaders ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");

  ids.ownPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-F36-P1','SYN Patient Own','777000111',$1) RETURNING id",
      [fx.parties.ownDoctorNoMoney!],
    )
  ).rows[0].id;

  ids.foreignPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-F36-P2','SYN Patient Foreign','777000222',$1) RETURNING id",
      [fx.parties.otherDoctor!],
    )
  ).rows[0].id;

  ids.debtPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-F36-P3','SYN Debt Patient','777000333',$1) RETURNING id",
      [fx.parties.ownDoctorNoMoney!],
    )
  ).rows[0].id;

  ids.legacyPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-F36-P4','SYN Legacy Patient','777000444',$1) RETURNING id",
      [fx.parties.ownDoctorNoMoney!],
    )
  ).rows[0].id;

  ids.histDocPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-F36-P5','SYN HistDoc Patient','777000555',$1) RETURNING id",
      [fx.parties.ownDoctorNoMoney!],
    )
  ).rows[0].id;

  ids.ownVisit = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO visits(patient_id,patient_name,status,doctor_id) VALUES($1,'SYN Patient Own','completed',$2) RETURNING id",
      [ids.ownPatient, fx.parties.ownDoctorNoMoney!],
    )
  ).rows[0].id;

  ids.foreignVisit = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO visits(patient_id,patient_name,status,doctor_id) VALUES($1,'SYN Patient Foreign','completed',$2) RETURNING id",
      [ids.foreignPatient, fx.parties.otherDoctor!],
    )
  ).rows[0].id;

  ids.clinicalCaseId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO clinical_cases(patient_id,specialty,title,status,created_by) VALUES($1,'endodontics','SYN Endo Case','active','SYN-FIN36-OWNER') RETURNING id",
      [ids.ownPatient],
    )
  ).rows[0].id;

  ids.orthoCaseId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO ortho_cases(patient_id,status,baseline_kind,legacy_financial_mode,arches,created_by) VALUES($1,'active','legacy','opening_balance','both','SYN-FIN36-OWNER') RETURNING id",
      [ids.ownPatient],
    )
  ).rows[0].id;

  ids.endoServiceId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO services(name,category,price_minor,price_configured,price_provisional,is_active,sort_order) VALUES('SYN Endo Root Canal','rct',40000,TRUE,FALSE,TRUE,1) RETURNING id",
    )
  ).rows[0].id;

  ids.crownServiceId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO services(name,category,price_minor,price_configured,price_provisional,is_active,sort_order) VALUES('SYN Zirconia Crown','crown',60000,TRUE,FALSE,TRUE,2) RETURNING id",
    )
  ).rows[0].id;

  ids.supplierPartyId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO parties(kind,name,is_active) VALUES('supplier','SYN Dental Supplier',TRUE) RETURNING id",
    )
  ).rows[0].id;

  await fx.pool.query(
    `INSERT INTO settings(key,value) VALUES
       ('fx.USD_to_YER','530'),
       ('fx.SAR_to_YER','140'),
       ('billing.max_discount_percent','15')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

it("registers all Slice 36 record reads and clinic runtime actions", () => {
  expect(CANONICAL_RECORD_READS["read:patients.ledger"].need).toEqual(["finance.patient-ledger.view"]);
  expect(CANONICAL_RECORD_READS["read:patients.responsibility"].need).toEqual(["finance.patient-ledger.manage"]);
  expect(CANONICAL_RECORD_READS["read:patients.history-preview"].need).toEqual(["patients.history.record"]);
  expect(CANONICAL_RECORD_READS["read:patients.legacy-preview"].need).toEqual(["finance.legacy.record"]);
  expect(CANONICAL_RECORD_READS["read:patients.legacy-void"].need).toEqual(["finance.legacy.void"]);
  expect(CANONICAL_RECORD_READS["read:visits.invoices"].need).toEqual(["finance.invoices.view"]);

  const actions = new Set(staffRuntimeActions());
  for (const action of [
    "finance.reconciliation.view",
    "finance.opening-balances.manage",
    "finance.patient-ledger.manage",
    "patients.history.record",
    "patients.history.correct",
    "finance.legacy.record",
    "finance.legacy.void",
  ]) {
    expect(actions.has(action)).toBe(true);
  }
});

it("governs clinic opening balances and supplier/lab party openings atomically", async () => {
  // Viewer without finance.opening-balances.manage cannot write opening balances or read party openings
  const deniedSet = await slice36.setOpeningBalanceCanonicalResponse(
    await fx.session("ledgerViewer"),
    jsonReq("http://localhost/api/opening-balances", "POST", {
      patientId: ids.ownPatient,
      currency: "YER",
      amount: "25000",
      asOfDate: "2026-01-15",
      note: "رصيد افتتاحي تجريبي",
    }),
  );
  expect(deniedSet.status).toBe(403);

  const deniedPartyGet = await slice36.listPartyOpeningsCanonicalResponse(await fx.session("ledgerViewer"));
  expect(deniedPartyGet.status).toBe(403);

  // Authorized operator creates, previews, updates (with mandatory reason), reads history, and deletes
  const createdRes = await slice36.setOpeningBalanceCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/opening-balances", "POST", {
      patientId: ids.ownPatient,
      currency: "SAR",
      amount: "300",
      asOfDate: "2026-01-15",
      note: "رصيد افتتاحي سعودي",
    }),
  );
  expect(createdRes.status).toBe(201);
  const created = await createdRes.json();
  expect(created.currency).toBe("SAR");
  expect(created.amountMinor).toBe(30000);

  // Updating an existing opening balance without a reason refuses with 400
  const missingReasonRes = await slice36.setOpeningBalanceCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/opening-balances", "POST", {
      patientId: ids.ownPatient,
      currency: "SAR",
      amount: "250",
      asOfDate: "2026-01-15",
    }),
  );
  expect(missingReasonRes.status).toBe(400);

  // Dry-run correction preview via reconciliation viewer
  const previewRes = await slice36.listOpeningBalancesCanonicalResponse(
    await fx.session("ledgerViewer"),
    new Request(`http://localhost/api/opening-balances?preview=1&patientId=${ids.ownPatient}&currency=SAR&amount=250`),
  );
  expect(previewRes.status).toBe(200);
  const previewJson = await previewRes.json();
  expect(previewJson.preview.allowed).toBe(true);
  expect(previewJson.preview.afterAmountMinor).toBe(25000);

  // Update with reason succeeds
  const updatedRes = await slice36.setOpeningBalanceCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/opening-balances", "POST", {
      patientId: ids.ownPatient,
      currency: "SAR",
      amount: "250",
      asOfDate: "2026-01-15",
      reason: "تصحيح مطابقة كشف ورقي",
    }),
  );
  expect(updatedRes.status).toBe(201);

  const historyRes = await slice36.listOpeningBalancesCanonicalResponse(
    await fx.session("ledgerViewer"),
    new Request(`http://localhost/api/opening-balances?history=${ids.ownPatient}`),
  );
  expect(historyRes.status).toBe(200);
  expect((await historyRes.json()).history.length).toBeGreaterThanOrEqual(2);

  // Delete opening balance with reason
  const clearRes = await slice36.clearOpeningBalanceCanonicalResponse(
    await fx.session("financeOperator"),
    new Request(`http://localhost/api/opening-balances?patientId=${ids.ownPatient}&currency=SAR&reason=${encodeURIComponent("إلغاء رصيد تجريبي")}`, { method: "DELETE" }),
  );
  expect(clearRes.status).toBe(200);

  // Party openings: create payable + advance, adjust payable, void advance, list
  const partyPayableRes = await slice36.createPartyOpeningCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/party-openings", "POST", {
      kind: "payable",
      partyId: ids.supplierPartyId,
      currency: "YER",
      amount: "50000",
      asOfDate: "2026-01-10",
      reason: "كشف حساب مورد سابق للنظام",
    }),
  );
  expect(partyPayableRes.status).toBe(201);
  const partyPayable = await partyPayableRes.json();

  const adjustRes = await slice36.updatePartyOpeningCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/party-openings", "PATCH", {
      action: "adjust",
      payableId: partyPayable.id,
      currency: "YER",
      amount: "45000",
      reason: "خصم فاتورة مرتجعة في الكشف الورقي",
    }),
  );
  expect(adjustRes.status).toBe(200);

  const advanceRes = await slice36.createPartyOpeningCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/party-openings", "POST", {
      kind: "advance",
      partyId: ids.supplierPartyId,
      currency: "YER",
      amount: "15000",
      asOfDate: "2026-01-10",
      reason: "دفعة مقدمة قبل النظام",
    }),
  );
  expect(advanceRes.status).toBe(201);
  const advance = await advanceRes.json();

  const voidAdvRes = await slice36.updatePartyOpeningCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/party-openings", "PATCH", {
      action: "void_advance",
      id: advance.id,
      reason: "إلغاء دفعة مقدمة مسجلة بالخطأ",
    }),
  );
  expect(voidAdvRes.status).toBe(200);

  const listPartyRes = await slice36.listPartyOpeningsCanonicalResponse(await fx.session("financeOperator"));
  expect(listPartyRes.status).toBe(200);
  const listPartyJson = await listPartyRes.json();
  expect(listPartyJson.canEdit).toBe(true);
  expect(listPartyJson.payables.some((p: { id: number }) => p.id === partyPayable.id)).toBe(true);
});

it("enforces family scope isolation, guarantor privacy, and money balance redaction", async () => {
  // Create a family containing both ownPatient and foreignPatient, with foreignPatient as guarantor
  const createFamRes = await slice36.createFamilyCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/families", "POST", {
      name: "عائلة الاختبار الموحد SYN",
      note: "ملاحظة عائلية",
      guarantor: { kind: "patient", patientId: ids.foreignPatient },
      members: [
        { patientId: ids.ownPatient, role: "son" },
        { patientId: ids.foreignPatient, role: "father" },
      ],
    }),
  );
  expect(createFamRes.status).toBe(201);
  const createdFamily = await createFamRes.json();
  expect(createdFamily.canSeeMoney).toBe(true);
  expect(createdFamily.members).toHaveLength(2);
  expect(createdFamily.totals).toBeDefined();

  // ownDoctorNoMoney reads the family: sees ONLY ownPatient, hides foreign guarantor identity, and omits balances/totals
  const docFamRes = await slice36.getFamilyCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(createdFamily.id),
  );
  expect(docFamRes.status).toBe(200);
  const docFam = await docFamRes.json();
  expect(docFam.canSeeMoney).toBe(false);
  expect(docFam.canEdit).toBe(false);
  expect(docFam.totals).toBeUndefined();
  expect(docFam.members.map((m: { id: number }) => m.id)).toEqual([ids.ownPatient]);
  expect(docFam.members[0].balances).toBeUndefined();
  expect(docFam.guarantor.hidden).toBe(true);
  expect(docFam.guarantor.name).toBeNull();

  // Patient family panel read: 404 on foreign patient for ownDoctorNoMoney, 200 on ownPatient
  const foreignPatFam = await slice36.patientFamilyCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.foreignPatient),
  );
  expect(foreignPatFam.status).toBe(404);

  const ownPatFam = await slice36.patientFamilyCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.ownPatient),
  );
  expect(ownPatFam.status).toBe(200);
  expect((await ownPatFam.json()).family.id).toBe(createdFamily.id);

  // Search families, update details, link/unlink member, update guarantor
  const searchRes = await slice36.familiesSearchCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    new Request("http://localhost/api/families?q=SYN"),
  );
  expect(searchRes.status).toBe(200);
  expect((await searchRes.json()).families.some((f: { id: number }) => f.id === createdFamily.id)).toBe(true);

  const patchFamRes = await slice36.updateFamilyCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/families/${createdFamily.id}`, "PATCH", { note: "ملاحظة محدّثة" }),
    String(createdFamily.id),
  );
  expect(patchFamRes.status).toBe(200);
  expect((await patchFamRes.json()).note).toBe("ملاحظة محدّثة");

  const putGuarantorRes = await slice36.setFamilyGuarantorCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/families/${createdFamily.id}/guarantor`, "PUT", {
      guarantor: { kind: "none" },
    }),
    String(createdFamily.id),
  );
  expect(putGuarantorRes.status).toBe(200);

  const linkRes = await slice36.linkFamilyMemberCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/families/${createdFamily.id}/members`, "POST", {
      patientId: ids.debtPatient,
      role: "daughter",
    }),
    String(createdFamily.id),
  );
  expect(linkRes.status).toBe(200);

  const unlinkRes = await slice36.unlinkFamilyMemberCanonicalResponse(
    await fx.session("financeOperator"),
    String(createdFamily.id),
    String(ids.debtPatient),
  );
  expect(unlinkRes.status).toBe(200);
});

it("projects patient ledger, statement, treatment financial context, responsibility, and visit financial reads", async () => {
  // Seed an opening balance on ownPatient so ledger & statement have live balances
  const setOpen = await slice36.setOpeningBalanceCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/opening-balances", "POST", {
      patientId: ids.ownPatient,
      currency: "YER",
      amount: "30000",
      asOfDate: "2026-01-20",
      note: "رصيد افتتاحي يمني",
    }),
  );
  expect(setOpen.status).toBe(201);

  // Ledger projection: ledgerViewer omits receiptRemaining; ledgerVoidViewer projects receiptRemaining
  const viewerLedgerRes = await slice36.ledgerCanonicalResponse(
    await fx.session("ledgerViewer"),
    String(ids.ownPatient),
  );
  expect(viewerLedgerRes.status).toBe(200);
  const viewerLedger = await viewerLedgerRes.json();
  expect(viewerLedger.balance.dueMinor).toBe(30000);
  expect(viewerLedger.receiptRemaining).toBeUndefined();
  expect(viewerLedger.openingAccess).toEqual({ add: false, edit: false });

  const voidLedgerRes = await slice36.ledgerCanonicalResponse(
    await fx.session("ledgerVoidViewer"),
    String(ids.ownPatient),
  );
  expect(voidLedgerRes.status).toBe(200);
  const voidLedger = await voidLedgerRes.json();
  expect(voidLedger.receiptRemaining).toBeDefined();

  // Statement & treatment-financial-context reads
  const stmtRes = await slice36.statementCanonicalResponse(
    await fx.session("ledgerViewer"),
    new Request(`http://localhost/api/patients/${ids.ownPatient}/statement?type=summary`),
    String(ids.ownPatient),
  );
  expect(stmtRes.status).toBe(200);
  const stmtJson = await stmtRes.json();
  expect(Array.isArray(stmtJson.sections)).toBe(true);

  const finCtxRes = await slice36.treatmentFinancialContextCanonicalResponse(
    await fx.session("ledgerViewer"),
    String(ids.ownPatient),
  );
  expect(finCtxRes.status).toBe(200);

  // Responsibility GET & PATCH with optimistic fingerprint check
  const respGetRes = await slice36.responsibilityCanonicalResponse(
    await fx.session("financeOperator"),
    new Request(`http://localhost/api/patients/${ids.ownPatient}/responsibility?kind=clinical&sourceId=${ids.clinicalCaseId}`),
    String(ids.ownPatient),
    false,
  );
  expect(respGetRes.status).toBe(200);
  const respBefore = await respGetRes.json();
  expect(respBefore.canConfirm).toBe(true);

  const respPatchRes = await slice36.responsibilityCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.ownPatient}/responsibility`, "PATCH", {
      kind: "clinical",
      sourceId: ids.clinicalCaseId,
      expectedSourceFingerprint: respBefore.sourceFingerprint,
      doctorId: fx.parties.ownDoctorNoMoney!,
      reason: "اعتماد الطبيب المسؤول عن حالة العصب",
    }),
    String(ids.ownPatient),
    true,
  );
  expect(respPatchRes.status).toBe(200);
  expect((await respPatchRes.json()).doctorId).toBe(fx.parties.ownDoctorNoMoney!);

  // Visit reads: ownDoctorNoMoney sees ownVisit (200) and gets 404 on foreignVisit
  const ownWalkout = await slice36.visitWalkoutCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.ownVisit),
  );
  expect(ownWalkout.status).toBe(200);

  const foreignWalkout = await slice36.visitWalkoutCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.foreignVisit),
  );
  expect(foreignWalkout.status).toBe(404);

  const ownBillingPreview = await slice36.visitBillingPreviewCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.ownVisit),
  );
  expect(ownBillingPreview.status).toBe(200);

  const ownVisitFinCtx = await slice36.visitFinancialContextCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.ownVisit),
  );
  expect(ownVisitFinCtx.status).toBe(200);

  // Legacy archive & legacy onboarding projections
  const docLegacyDenied = await slice36.patientLegacyArchiveCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.ownPatient),
  );
  expect(docLegacyDenied.status).toBe(403);

  const viewerLegacyOk = await slice36.patientLegacyArchiveCanonicalResponse(
    await fx.session("ledgerViewer"),
    String(ids.ownPatient),
  );
  expect(viewerLegacyOk.status).toBe(200);

  const docOnboardingRes = await slice36.patientLegacyOnboardingCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    new Request(`http://localhost/api/patients/${ids.ownPatient}/legacy-onboarding?caseId=${ids.orthoCaseId}`),
    String(ids.ownPatient),
  );
  expect(docOnboardingRes.status).toBe(200);
  expect((await docOnboardingRes.json()).onboarding.financialReference.state).toBe("restricted");

  const viewerOnboardingRes = await slice36.patientLegacyOnboardingCanonicalResponse(
    await fx.session("ledgerViewer"),
    new Request(`http://localhost/api/patients/${ids.ownPatient}/legacy-onboarding?caseId=${ids.orthoCaseId}`),
    String(ids.ownPatient),
  );
  expect(viewerOnboardingRes.status).toBe(200);
  expect((await viewerOnboardingRes.json()).onboarding.financialReference.state).not.toBe("restricted");
});

it("manages legacy balance arrangements and standalone legacy treatment create/preview/void", async () => {
  // Create legacy balance arrangement on ownPatient's YER opening balance, then cancel it
  const createArrRes = await slice36.createLegacyBalanceArrangementCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.ownPatient}/legacy-balance-arrangement`, "POST", {
      currency: "YER",
      cadence: "per_visit",
      installmentAmount: "10000",
      note: "قسط مع كل زيارة",
    }),
    String(ids.ownPatient),
  );
  expect(createArrRes.status).toBe(201);
  const createdArr = await createArrRes.json();

  const listArrRes = await slice36.listLegacyBalanceArrangementCanonicalResponse(
    await fx.session("ledgerViewer"),
    String(ids.ownPatient),
  );
  expect(listArrRes.status).toBe(200);
  const listArr = await listArrRes.json();
  expect(listArr.canManage).toBe(false);
  expect(listArr.arrangements.some((a: { id: number }) => a.id === createdArr.id)).toBe(true);

  const cancelArrRes = await slice36.cancelLegacyBalanceArrangementCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.ownPatient}/legacy-balance-arrangement`, "PATCH", {
      arrangementId: createdArr.id,
      reason: "تحويل المريض إلى جدولة موحدة",
    }),
    String(ids.ownPatient),
  );
  expect(cancelArrRes.status).toBe(200);

  // Preview + create standalone legacy treatment on legacyPatient, then preview void + void it
  const legacyPayload = {
    serviceId: ids.endoServiceId,
    toothCode: 16,
    currency: "YER",
    agreedAmount: "40000",
    previouslyPaidAmount: "15000",
    historicalAsOf: "2026-01-12",
    sessions: 2,
    note: "علاج عصب بدأ قبل النظام",
    idempotencyKey: "syn-legacy-tx-36-001",
  };

  const prevRes = await slice36.previewLegacyTreatmentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.legacyPatient}/legacy-treatments/preview`, "POST", legacyPayload),
    String(ids.legacyPatient),
  );
  expect(prevRes.status).toBe(200);
  const prevJson = await prevRes.json();
  expect(prevJson.refusal).toBeNull();
  expect(prevJson.preview.opening.effect).toBe("created");

  const createLegRes = await slice36.createLegacyTreatmentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.legacyPatient}/legacy-treatments`, "POST", legacyPayload),
    String(ids.legacyPatient),
  );
  expect(createLegRes.status).toBe(201);
  const createdLeg = await createLegRes.json();
  const agreementId = createdLeg.agreement.id as number;
  expect(createdLeg.agreement.remainingMinor).toBe(25000);

  // Clinical-only viewer gets projected empty agreements: []
  const docLegList = await slice36.listLegacyTreatmentsCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.legacyPatient),
  );
  expect(docLegList.status).toBe(200);
  expect((await docLegList.json()).agreements).toEqual([]);

  const opLegList = await slice36.listLegacyTreatmentsCanonicalResponse(
    await fx.session("financeOperator"),
    String(ids.legacyPatient),
  );
  expect(opLegList.status).toBe(200);
  expect((await opLegList.json()).agreements.some((a: { id: number }) => a.id === agreementId)).toBe(true);

  // Void preview & void execution
  const voidPrevRes = await slice36.previewLegacyVoidCanonicalResponse(
    await fx.session("financeOperator"),
    new Request(`http://localhost/api/patients/${ids.legacyPatient}/legacy-treatments/${agreementId}/void?mode=ordinary`),
    String(ids.legacyPatient),
    String(agreementId),
  );
  expect(voidPrevRes.status).toBe(200);
  const voidPrev = (await voidPrevRes.json()).preview;
  expect(voidPrev.canVoid).toBe(true);

  const voidExecRes = await slice36.voidLegacyTreatmentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.legacyPatient}/legacy-treatments/${agreementId}/void`, "POST", {
      reason: "تصحيح إدخال اتفاق سابق مكرر",
      mode: "ordinary",
      previewToken: voidPrev.previewToken,
    }),
    String(ids.legacyPatient),
    String(agreementId),
  );
  expect(voidExecRes.status).toBe(200);
  expect((await voidExecRes.json()).agreement.status).toBe("void");
});

it("enforces open cashier shift on debt-repayment collection and governs historical document create/correct", async () => {
  // 1. Seed opening balance on debtPatient, schedule debt repayment, refuse collection without shift, then collect with open shift
  await slice36.setOpeningBalanceCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq("http://localhost/api/opening-balances", "POST", {
      patientId: ids.debtPatient,
      currency: "YER",
      amount: "20000",
      asOfDate: "2026-01-18",
      note: "رصيد للجدولة والتحصيل",
    }),
  );

  const wsRes = await slice36.getDebtRepaymentsCanonicalResponse(
    await fx.session("financeOperator"),
    String(ids.debtPatient),
  );
  expect(wsRes.status).toBe(200);
  const ws = await wsRes.json();
  const openingTarget = ws.targets.find((t: { target: { openingCurrency: string | null } }) => t.target.openingCurrency === "YER");
  expect(openingTarget).toBeDefined();

  const saveSchedRes = await slice36.saveDebtRepaymentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.debtPatient}/debt-repayments`, "POST", {
      invoiceId: null,
      openingCurrency: "YER",
      currency: "YER",
      terms: {
        mode: "installments",
        installments: [
          { dueDate: "2026-11-01", amountMinor: 10000, kind: "installment" },
          { dueDate: "2026-12-01", amountMinor: 10000, kind: "installment" },
        ],
      },
      expectedVersion: openingTarget.version,
      expectedRemainingMinor: 20000,
      expectedSourceHash: openingTarget.sourceHash,
      reason: "جدولة رصيد سابق على قسطين",
      idempotencyKey: "syn-debt-sched-36-001",
    }),
    String(ids.debtPatient),
  );
  expect(saveSchedRes.status).toBe(201);
  const savedSched = await saveSchedRes.json();

  // Ensure no open cashier shift exists -> collection MUST refuse with 409 ("stale")
  await fx.pool.query("UPDATE cashier_shifts SET status = 'closed', closed_at = NOW() WHERE status = 'open'");
  const closedShiftCollect = await slice36.collectDebtInstallmentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(
      `http://localhost/api/patients/${ids.debtPatient}/debt-repayments/${savedSched.arrangementId}/collect`,
      "POST",
      { amount: "10000", currency: "YER", method: "cash", note: "القسط الأول", expectedVersion: savedSched.version },
      { "idempotency-key": "syn-debt-collect-36-closed", "x-collection-similarity-review": "none" },
    ),
    String(ids.debtPatient),
    String(savedSched.arrangementId),
  );
  expect(closedShiftCollect.status).toBe(409);

  // Open cashier shift -> collection succeeds (201), and replay returns 200 with replayed: true
  const openedShift = await db.openShiftWith(fx.pool, {
    openedBy: "SYN-FIN36-OPERATOR",
    opening: { YER: 0, SAR: 0, USD: 0 },
  });
  expect(openedShift).not.toBeNull();
  const shiftId = openedShift!.id;
  try {
    const openCollect = await slice36.collectDebtInstallmentCanonicalResponse(
      await fx.session("financeOperator"),
      jsonReq(
        `http://localhost/api/patients/${ids.debtPatient}/debt-repayments/${savedSched.arrangementId}/collect`,
        "POST",
        { amount: "10000", currency: "YER", method: "cash", note: "القسط الأول", expectedVersion: savedSched.version },
        { "idempotency-key": "syn-debt-collect-36-open", "x-collection-similarity-review": "none" },
      ),
      String(ids.debtPatient),
      String(savedSched.arrangementId),
    );
    expect(openCollect.status).toBe(201);
    const collectedBody = await openCollect.json();
    expect(collectedBody.replayed).toBe(false);
    expect(collectedBody.payment.amountMinor).toBe(10000);

    const replayCollect = await slice36.collectDebtInstallmentCanonicalResponse(
      await fx.session("financeOperator"),
      jsonReq(
        `http://localhost/api/patients/${ids.debtPatient}/debt-repayments/${savedSched.arrangementId}/collect`,
        "POST",
        { amount: "10000", currency: "YER", method: "cash", note: "القسط الأول", expectedVersion: savedSched.version },
        { "idempotency-key": "syn-debt-collect-36-open", "x-collection-similarity-review": "none" },
      ),
      String(ids.debtPatient),
      String(savedSched.arrangementId),
    );
    expect(replayCollect.status).toBe(200);
    expect((await replayCollect.json()).replayed).toBe(true);
  } finally {
    await fx.pool.query("UPDATE cashier_shifts SET status = 'closed', closed_at = NOW() WHERE id = $1", [shiftId]);
  }

  // 2. Historical multi-line document: preview -> create -> projection redaction -> financial correction
  const docDraftBase = {
    patientId: ids.histDocPatient,
    currency: "YER",
    items: [
      { serviceId: ids.endoServiceId, description: "SYN Endo Root Canal", quantity: 1, unitPrice: "40000", toothCode: 26 },
      { serviceId: ids.crownServiceId, description: "SYN Zirconia Crown", quantity: 1, unitPrice: "60000", toothCode: 26 },
    ],
    discount: "10000",
    discountReason: "خصم باقة علاجية سابقة",
    previouslyPaidAmount: "30000",
    historicalAsOf: "2026-01-05",
    note: "اتفاق تاريخي متعدد البنود",
    idempotencyKey: "syn-histdoc-create-36-001",
    repaymentTerms: {
      mode: "installments",
      installments: [{ dueDate: "2026-11-15", amountMinor: 60000, kind: "installment" }],
    },
    repaymentRemainingMinor: 60000,
    repaymentVersion: 0,
    repaymentSourceHash: null as string | null,
  };

  const docPreviewRes = await slice36.previewHistoricalDocumentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.histDocPatient}/historical-documents/preview`, "POST", docDraftBase),
    String(ids.histDocPatient),
  );
  expect(docPreviewRes.status).toBe(200);
  const docPreview = await docPreviewRes.json();
  expect(docPreview.remainingMinor).toBe(60000);

  const docCreateRes = await slice36.createHistoricalDocumentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(`http://localhost/api/patients/${ids.histDocPatient}/historical-documents`, "POST", {
      ...docDraftBase,
      repaymentSourceHash: docPreview.sourceHash,
      repaymentVersion: docPreview.scheduleVersion,
    }),
    String(ids.histDocPatient),
  );
  expect(docCreateRes.status).toBe(201);
  const createdDoc = (await docCreateRes.json()).document;
  expect(createdDoc.version).toBe(1);
  expect(createdDoc.remainingMinor).toBe(60000);

  // Clinical-only viewer gets projected empty documents: []
  const redactedListRes = await slice36.listHistoricalDocumentsCanonicalResponse(
    await fx.session("ownDoctorNoMoney"),
    String(ids.histDocPatient),
  );
  expect(redactedListRes.status).toBe(200);
  expect((await redactedListRes.json()).documents).toEqual([]);

  // Operator lists documents and sees correctionAvailable: true, then corrects financial amounts
  const opDocListRes = await slice36.listHistoricalDocumentsCanonicalResponse(
    await fx.session("financeOperator"),
    String(ids.histDocPatient),
  );
  expect(opDocListRes.status).toBe(200);
  const listedDoc = (await opDocListRes.json()).documents[0];
  expect(listedDoc.correctionAvailable).toBe(true);

  const correctRes = await slice36.correctHistoricalDocumentCanonicalResponse(
    await fx.session("financeOperator"),
    jsonReq(
      `http://localhost/api/patients/${ids.histDocPatient}/historical-documents/${createdDoc.id}/correct`,
      "POST",
      {
        idempotencyKey: "syn-histdoc-correct-36-001",
        expectedVersion: 1,
        expectedSourceHash: listedDoc.sourceHash,
        prices: ["40000", "60000"],
        discount: "15000",
        discountReason: "تصحيح الخصم المثبت في العقد الورقي",
        previouslyPaidAmount: "35000",
        historicalAsOf: "2026-01-05",
        note: "بعد مراجعة العقد الورقي",
        reason: "مطابقة إيصال دفعة سابقة من السجل الورقي",
        repaymentTerms: {
          mode: "installments",
          installments: [{ dueDate: "2026-11-15", amountMinor: 50000, kind: "installment" }],
        },
        repaymentRemainingMinor: 50000,
        repaymentVersion: listedDoc.scheduleVersion,
      },
    ),
    String(ids.histDocPatient),
    String(createdDoc.id),
  );
  expect(correctRes.status).toBe(200);
  const correctedDoc = (await correctRes.json()).document;
  expect(correctedDoc.version).toBe(2);
  expect(correctedDoc.remainingMinor).toBe(50000);
});
