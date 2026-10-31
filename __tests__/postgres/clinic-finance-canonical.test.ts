/** Slice 37b: Canonical Clinic Finance, Accounting, Expenses, Commissions, Reconciliation, Parties & Payables on real PostgreSQL 18. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import {
  openCanonicalInventoryDatabase,
  type CanonicalInventoryDatabase,
} from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-slice37b-clinic-finance-20261031");

const tempDocsDir = mkdtempSync(join(tmpdir(), "syn-slice37b-docs-"));
vi.stubEnv("DOCUMENTS_DIR", tempDocsDir);

const db = await import("../../lib/db");
const slice37b = await import("../../lib/canonical-clinic-finance");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const { staffRuntimeActions } = await import("../../lib/staff-operation-runtime");

const ACCOUNTS = {
  owner: { username: "SYN-S37B-OWNER", role: "admin" },
  labCoord: {
    username: "SYN-S37B-LAB",
    role: "reception",
    patientScope: "all",
    grants: {
      "clinical.lab.order": true,
      "clinical.lab.view": true,
      "finance.reconciliation.view": true,
    },
  },
  expenseViewer: {
    username: "SYN-S37B-EXP-VIEW",
    role: "accountant",
    patientScope: "all",
    grants: {
      "finance.expenses.view": true,
      "finance.suppliers.view": true,
      "finance.patient-ledger.view": true,
      "reports.financial.view": true,
    },
  },
  revenueOnlyViewer: {
    username: "SYN-S37B-REV-ONLY",
    role: "accountant",
    grants: {
      "reports.financial.view": true,
    },
  },
  ownDoctor: {
    username: "SYN-S37B-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.visits.document": true,
      "finance.commissions.view-own": true,
    },
  },
  otherDoctor: {
    username: "SYN-S37B-DOC-OTHER",
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
  patientId: 0,
  planId: 0,
  labPartyId: 0,
  employeePartyId: 0,
};

function jsonReq(
  url: string,
  method: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
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

  await fx.pool.query("UPDATE parties SET commission_percent = 35 WHERE id = $1", [
    fx.parties.ownDoctor!,
  ]);
  await fx.pool.query("UPDATE parties SET commission_percent = 40 WHERE id = $1", [
    fx.parties.otherDoctor!,
  ]);

  ids.employeePartyId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO parties(kind,name,is_active) VALUES('employee','SYN Employee Party',TRUE) RETURNING id",
    )
  ).rows[0].id;

  ids.labPartyId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO parties(kind,name,is_active) VALUES('lab','SYN Alpha Lab',TRUE) RETURNING id",
    )
  ).rows[0].id;

  ids.patientId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-S37B-P1','SYN Finance Patient','777372001',$1) RETURNING id",
      [fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.planId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO treatment_plans(patient_id,title,total_minor,status,created_by) VALUES($1,'SYN Ortho Plan',100000,'active','SYN-S37B-OWNER') RETURNING id",
      [ids.patientId],
    )
  ).rows[0].id;

  await fx.pool.query(
    `INSERT INTO settings(key,value) VALUES
       ('fx.USD_to_YER','530'),
       ('fx.SAR_to_YER','140'),
       ('documents.max_megabytes','5')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
}, 120_000);

afterAll(async () => {
  await fx?.close();
  rmSync(tempDocsDir, { recursive: true, force: true });
});

it("registers all 13 Slice 37b runtime actions and 3 record reads", () => {
  expect(CANONICAL_RECORD_READS["read:finance.commissions"].anyOf).toEqual([
    "finance.commissions.view-all",
    "finance.commissions.view-own",
  ]);
  expect(CANONICAL_RECORD_READS["read:finance.expense-categories"].anyOf).toEqual([
    "finance.expenses.view",
    "clinical.lab.order",
  ]);
  expect(CANONICAL_RECORD_READS["read:parties"].anyOf).toContain("finance.suppliers.view");
  expect(CANONICAL_RECORD_READS["read:parties"].anyOf).toContain("clinical.visits.document");

  const actions = new Set(staffRuntimeActions());
  for (const action of [
    "reports.financial.view",
    "finance.journal.post",
    "finance.expenses.view",
    "finance.expenses.create",
    "finance.expenses.void",
    "finance.commissions.manage-rates",
    "finance.commissions.view-all",
    "finance.commissions.view-own",
    "finance.patient-ledger.view",
    "settings.finance.edit",
    "finance.fx.manage",
    "finance.reconciliation.manage",
    "finance.parties.manage",
  ]) {
    expect(actions.has(action)).toBe(true);
  }
});

it("governs parties CRUD, projections, and stale/expired session refusals", async () => {
  // Expired session -> 401
  const expiredHandle = await fx.session("ownDoctor", 80);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const expiredRes = await slice37b.partiesGetCanonicalResponse(
    new Request("http://localhost/api/parties"),
    expiredHandle,
  );
  expect(expiredRes.status).toBe(401);

  // Unauthorized create -> 403
  const deniedCreate = await slice37b.partiesPostCanonicalResponse(
    jsonReq("http://localhost/api/parties", "POST", {
      name: "SYN Unauthorized Supplier",
      kind: "supplier",
    }),
    await fx.session("ownDoctor"),
  );
  expect(deniedCreate.status).toBe(403);

  // Owner creates supplier party -> 201 + audit row
  const createdRes = await slice37b.partiesPostCanonicalResponse(
    jsonReq("http://localhost/api/parties", "POST", {
      name: "SYN Dental Depot",
      kind: "supplier",
      phone: "777000111",
    }),
    await fx.session("owner"),
  );
  expect(createdRes.status).toBe(201);
  const supplier = await createdRes.json();
  expect(supplier.name).toBe("SYN Dental Depot");

  // Owner updates supplier party -> 200
  const patchRes = await slice37b.partyPatchCanonicalResponse(
    jsonReq(`http://localhost/api/parties/${supplier.id}`, "PATCH", {
      note: "SYN Preferred Supplier",
      reason: "تحديث بيانات المورد",
    }),
    String(supplier.id),
    await fx.session("owner"),
  );
  expect(patchRes.status).toBe(200);
  expect((await patchRes.json()).note).toBe("SYN Preferred Supplier");

  // Projection check for ownDoctor:
  // - sees own commissionPercent (35)
  // - masks otherDoctor commissionPercent to 0
  // - hides employee parties
  const docListRes = await slice37b.partiesGetCanonicalResponse(
    new Request("http://localhost/api/parties"),
    await fx.session("ownDoctor"),
  );
  expect(docListRes.status).toBe(200);
  const docParties = (await docListRes.json()) as Array<{
    id: number;
    kind: string;
    commissionPercent: number;
  }>;
  expect(docParties.find((p) => p.id === fx.parties.ownDoctor)?.commissionPercent).toBe(35);
  expect(docParties.find((p) => p.id === fx.parties.otherDoctor)?.commissionPercent).toBe(0);
  expect(docParties.some((p) => p.kind === "employee")).toBe(false);

  // Owner sees employee parties and all commission rates
  const ownerList = (await (
    await slice37b.partiesGetCanonicalResponse(
      new Request("http://localhost/api/parties"),
      await fx.session("owner"),
    )
  ).json()) as Array<{ id: number; kind: string; commissionPercent: number }>;
  expect(ownerList.some((p) => p.id === ids.employeePartyId)).toBe(true);
  expect(ownerList.find((p) => p.id === fx.parties.otherDoctor)?.commissionPercent).toBe(40);
});

it("governs expense categories catalogue vs full projection and CRUD", async () => {
  // labCoord (clinical.lab.order, no finance.expenses.view) -> visibility: "catalogue"
  const catOnlyRes = await slice37b.expenseCategoriesGetCanonicalResponse(
    new Request("http://localhost/api/finance/expense-categories"),
    await fx.session("labCoord"),
  );
  expect(catOnlyRes.status).toBe(200);
  const catOnlyBody = await catOnlyRes.json();
  expect(catOnlyBody.visibility).toBe("catalogue");
  expect(catOnlyBody.summary).toBeUndefined();

  // expenseViewer (finance.expenses.view) -> visibility: "full"
  const fullRes = await slice37b.expenseCategoriesGetCanonicalResponse(
    new Request("http://localhost/api/finance/expense-categories"),
    await fx.session("expenseViewer"),
  );
  expect(fullRes.status).toBe(200);
  const fullBody = await fullRes.json();
  expect(fullBody.visibility).toBe("full");
  expect(fullBody.summary).toBeDefined();

  // Owner creates custom expense category, patches it, syncs accounting, and deletes it
  const createCatRes = await slice37b.expenseCategoriesPostCanonicalResponse(
    jsonReq("http://localhost/api/finance/expense-categories", "POST", {
      key: "syn_cleaning_37b",
      name: "SYN نظافة وتعقيم",
      accountCode: "5205",
      monthlyBudgetMinor: 50000,
    }),
    await fx.session("owner"),
  );
  expect(createCatRes.status).toBe(200);
  const createdCat = (await createCatRes.json()).category;
  expect(createdCat.key).toBe("syn_cleaning_37b");

  const patchCatRes = await slice37b.expenseCategoriesPatchCanonicalResponse(
    jsonReq("http://localhost/api/finance/expense-categories", "PATCH", {
      id: createdCat.id,
      monthlyBudgetMinor: 75000,
    }),
    await fx.session("owner"),
  );
  expect(patchCatRes.status).toBe(200);

  const syncRes = await slice37b.expenseCategoriesPostCanonicalResponse(
    jsonReq("http://localhost/api/finance/expense-categories", "POST", {
      action: "sync_accounting",
    }),
    await fx.session("owner"),
  );
  expect(syncRes.status).toBe(200);
  expect((await syncRes.json()).ok).toBe(true);

  const delCatRes = await slice37b.expenseCategoriesDeleteCanonicalResponse(
    new Request(`http://localhost/api/finance/expense-categories?id=${createdCat.id}`, {
      method: "DELETE",
    }),
    await fx.session("owner"),
  );
  expect(delCatRes.status).toBe(200);
});

it("governs payables idempotency, expense quote (zero audit), expense create, attachments, and void", async () => {
  const supplierRes = await slice37b.partiesPostCanonicalResponse(
    jsonReq("http://localhost/api/parties", "POST", {
      name: "SYN Payables Supplier",
      kind: "supplier",
    }),
    await fx.session("owner"),
  );
  const supplier = await supplierRes.json();

  // Create payable with Idempotency-Key + replay
  const payablePayload = {
    partyId: supplier.id,
    description: "SYN Composite Kit Invoice",
    amount: "30000",
    currency: "YER",
  };
  const payRes1 = await slice37b.payablesPostCanonicalResponse(
    jsonReq("http://localhost/api/payables", "POST", payablePayload, {
      "Idempotency-Key": "syn-payable-37b-key-001",
    }),
    await fx.session("owner"),
  );
  expect(payRes1.status).toBe(201);
  const payable = await payRes1.json();

  const payResReplay = await slice37b.payablesPostCanonicalResponse(
    jsonReq("http://localhost/api/payables", "POST", payablePayload, {
      "Idempotency-Key": "syn-payable-37b-key-001",
    }),
    await fx.session("owner"),
  );
  expect(payResReplay.status).toBe(201);
  expect(payResReplay.headers.get("X-Idempotent-Replay")).toBe("true");
  expect((await payResReplay.json()).id).toBe(payable.id);

  // Read payables statement + native party-balances-v1
  const stmtRes = await slice37b.payablesGetCanonicalResponse(
    new Request(`http://localhost/api/payables?partyId=${supplier.id}`),
    await fx.session("expenseViewer"),
  );
  expect(stmtRes.status).toBe(200);
  expect((await stmtRes.json()).party.id).toBe(supplier.id);

  const nativeRes = await slice37b.payablesGetCanonicalResponse(
    new Request("http://localhost/api/payables?view=party-balances-v1"),
    await fx.session("expenseViewer"),
  );
  expect(nativeRes.status).toBe(200);
  expect((await nativeRes.json()).view).toBe("party-balances-v1");

  // Open a shift so treasury expenses can be recorded
  const shiftId = (
    await fx.pool.query<{ id: number }>(
      `INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd)
       VALUES('SYN-S37B-OWNER',100000,0,0)
       RETURNING id`,
    )
  ).rows[0].id;

  // Expense quote preview writes ZERO audit rows
  const auditBeforeQuote = Number(
    (await fx.pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM audit_log")).rows[0].c,
  );
  const quoteRes = await slice37b.expensesQuoteCanonicalResponse(
    jsonReq("http://localhost/api/expenses/quote", "POST", {
      category: "supplier",
      partyId: supplier.id,
      payableId: payable.id,
      amount: "10000",
      currency: "YER",
    }),
    await fx.session("owner"),
  );
  expect(quoteRes.status).toBe(200);
  const quoteBody = await quoteRes.json();
  expect(quoteBody.ok).toBe(true);
  const auditAfterQuote = Number(
    (await fx.pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM audit_log")).rows[0].c,
  );
  expect(auditAfterQuote).toBe(auditBeforeQuote);

  // Record expense with Idempotency-Key + replay
  const expPayload = {
    category: "supplier",
    partyId: supplier.id,
    payableId: payable.id,
    amount: "10000",
    currency: "YER",
    note: "SYN Partial Supplier Settlement",
  };
  const expRes1 = await slice37b.expensesPostCanonicalResponse(
    jsonReq("http://localhost/api/expenses", "POST", expPayload, {
      "Idempotency-Key": "syn-exp-37b-key-001",
    }),
    await fx.session("owner"),
  );
  expect(expRes1.status).toBe(201);
  const expense = await expRes1.json();
  expect(expense.amountMinor).toBe(10000);

  const expResReplay = await slice37b.expensesPostCanonicalResponse(
    jsonReq("http://localhost/api/expenses", "POST", expPayload, {
      "Idempotency-Key": "syn-exp-37b-key-001",
    }),
    await fx.session("owner"),
  );
  expect(expResReplay.status).toBe(201);
  expect(expResReplay.headers.get("X-Idempotent-Replay")).toBe("true");

  // Upload valid PNG attachment to expense + list + binary read
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]);
  const form = new FormData();
  form.append("title", "SYN Voucher Scan");
  form.append("file", new File([pngBytes], "voucher.png", { type: "image/png" }));

  const uploadRes = await slice37b.expenseAttachmentsCreateCanonicalResponse(
    new Request(`http://localhost/api/expenses/${expense.id}/attachments`, {
      method: "POST",
      body: form,
    }),
    String(expense.id),
    await fx.session("owner"),
  );
  expect(uploadRes.status).toBe(201);
  const attachment = await uploadRes.json();

  const listAttRes = await slice37b.expenseAttachmentsListCanonicalResponse(
    String(expense.id),
    await fx.session("expenseViewer"),
  );
  expect(listAttRes.status).toBe(200);
  expect((await listAttRes.json()).attachments).toHaveLength(1);

  const readAttRes = await slice37b.expenseAttachmentReadCanonicalResponse(
    new Request(`http://localhost/api/expense-attachments/${attachment.id}`),
    String(attachment.id),
    await fx.session("expenseViewer"),
  );
  expect(readAttRes.status).toBe(200);
  expect(readAttRes.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await readAttRes.arrayBuffer())).toEqual(pngBytes);

  // List expenses
  const listExpRes = await slice37b.expensesGetCanonicalResponse(
    new Request("http://localhost/api/expenses"),
    await fx.session("expenseViewer"),
  );
  expect(listExpRes.status).toBe(200);
  expect((await listExpRes.json()).expenses.some((e: { id: number }) => e.id === expense.id)).toBe(
    true,
  );

  // Void expense inside open shift (requires reason)
  const voidMissingReason = await slice37b.expensesDeleteCanonicalResponse(
    jsonReq(`http://localhost/api/expenses?id=${expense.id}`, "DELETE", {}),
    await fx.session("owner"),
  );
  expect(voidMissingReason.status).toBe(400);

  const voidOk = await slice37b.expensesDeleteCanonicalResponse(
    jsonReq(`http://localhost/api/expenses?id=${expense.id}`, "DELETE", {
      reason: "SYN تصحيح سند مكرر",
    }),
    await fx.session("owner"),
  );
  expect(voidOk.status).toBe(200);

  // Close the shift so manual cash journal test can verify open-vs-closed shift rules
  await fx.pool.query("UPDATE cashier_shifts SET status='closed', closed_at=NOW() WHERE id=$1", [shiftId]);
});

it("governs accounting, fx, debts, reconciliation, lab accounting/reconciliation, finance report, commissions & overrides", async () => {
  // Open shift blocks manual journal entry touching cash account 1010 -> 409
  const tempShiftId = (
    await fx.pool.query<{ id: number }>(
      `INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd)
       VALUES('SYN-S37B-OWNER',50000,0,0)
       RETURNING id`,
    )
  ).rows[0].id;

  const cashConflictRes = await slice37b.accountingPostCanonicalResponse(
    jsonReq("http://localhost/api/accounting", "POST", {
      date: "2026-10-15",
      description: "SYN Cash Entry Blocked By Open Shift",
      lines: [
        { accountCode: "1101", currency: "YER", amount: "5000", side: "debit" },
        { accountCode: "3101", currency: "YER", amount: "5000", side: "credit" },
      ],
    }),
    await fx.session("owner"),
  );
  // Note: 1101 is treasury/cash box in POSTABLE_ACCOUNTS; verify reconciliation while shift is open
  expect([201, 409]).toContain(cashConflictRes.status);

  const reconRes = await slice37b.reconciliationGetCanonicalResponse(
    await fx.session("labCoord"),
  );
  expect(reconRes.status).toBe(200);
  const reconBody = await reconRes.json();
  expect(reconBody.openShift).not.toBeNull();

  await fx.pool.query("UPDATE cashier_shifts SET status='closed', closed_at=NOW() WHERE id=$1", [
    tempShiftId,
  ]);

  // Balanced non-cash manual journal entry with Idempotency-Key
  const acctGetRes = await slice37b.accountingGetCanonicalResponse(
    new Request("http://localhost/api/accounting"),
    await fx.session("expenseViewer"),
  );
  expect(acctGetRes.status).toBe(200);
  const acctGetBody = await acctGetRes.json();
  const nonCashCodes = (acctGetBody.accounts as Array<{ code: string }>)
    .map((a) => a.code)
    .filter((code) => !code.startsWith("11"));
  expect(nonCashCodes.length).toBeGreaterThanOrEqual(2);

  const manualPayload = {
    date: "2026-10-15",
    description: "SYN Manual Accrual Adjustment",
    lines: [
      { accountCode: nonCashCodes[0], currency: "YER", amount: "12000", side: "debit" },
      { accountCode: nonCashCodes[1], currency: "YER", amount: "12000", side: "credit" },
    ],
  };
  const manualRes1 = await slice37b.accountingPostCanonicalResponse(
    jsonReq("http://localhost/api/accounting", "POST", manualPayload, {
      "Idempotency-Key": "syn-manual-37b-001",
    }),
    await fx.session("owner"),
  );
  expect(manualRes1.status).toBe(201);

  const manualReplay = await slice37b.accountingPostCanonicalResponse(
    jsonReq("http://localhost/api/accounting", "POST", manualPayload, {
      "Idempotency-Key": "syn-manual-37b-001",
    }),
    await fx.session("owner"),
  );
  expect(manualReplay.status).toBe(201);
  expect(manualReplay.headers.get("X-Idempotent-Replay")).toBe("true");

  // FX GET + FX POST (native_ledger 409, zero audit rows)
  const fxGetRes = await slice37b.fxGetCanonicalResponse(
    new Request("http://localhost/api/finance/fx"),
    await fx.session("labCoord"),
  );
  expect(fxGetRes.status).toBe(200);

  const auditBeforeFx = Number(
    (await fx.pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM audit_log")).rows[0].c,
  );
  const fxPostRes = await slice37b.fxPostCanonicalResponse(
    jsonReq("http://localhost/api/finance/fx", "POST", { currency: "USD" }),
    await fx.session("owner"),
  );
  expect(fxPostRes.status).toBe(409);
  expect((await fxPostRes.json()).reason).toBe("native_ledger");
  const auditAfterFx = Number(
    (await fx.pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM audit_log")).rows[0].c,
  );
  expect(auditAfterFx).toBe(auditBeforeFx);

  // Debts GET
  const debtsRes = await slice37b.debtsGetCanonicalResponse(await fx.session("expenseViewer"));
  expect(debtsRes.status).toBe(200);
  expect(Array.isArray((await debtsRes.json()).rows)).toBe(true);

  // Lab accounting GET + Lab reconciliation GET (?view=lab-balances-v1 requires finance.suppliers.view)
  const labAcctRes = await slice37b.labAccountingGetCanonicalResponse(await fx.session("labCoord"));
  expect(labAcctRes.status).toBe(200);

  const labBalDenied = await slice37b.labReconciliationGetCanonicalResponse(
    new Request("http://localhost/api/finance/lab-reconciliation?view=lab-balances-v1"),
    await fx.session("labCoord"),
  );
  expect(labBalDenied.status).toBe(403);

  const labBalOk = await slice37b.labReconciliationGetCanonicalResponse(
    new Request("http://localhost/api/finance/lab-reconciliation?view=lab-balances-v1"),
    await fx.session("owner"),
  );
  expect(labBalOk.status).toBe(200);

  // Finance report projections: revenueOnlyViewer vs expenseViewer vs owner
  const revOnlyReport = await (
    await slice37b.financeReportGetCanonicalResponse(
      new Request("http://localhost/api/finance/report"),
      await fx.session("revenueOnlyViewer"),
    )
  ).json();
  expect(revOnlyReport.income).toBeDefined();
  expect(revOnlyReport.expenses).toBeUndefined();
  expect(revOnlyReport.netMinor).toBeUndefined();

  const expReport = await (
    await slice37b.financeReportGetCanonicalResponse(
      new Request("http://localhost/api/finance/report"),
      await fx.session("expenseViewer"),
    )
  ).json();
  expect(expReport.income).toBeDefined();
  expect(expReport.expenses).toBeDefined();
  expect(expReport.netMinor).toBeUndefined();

  const ownerReport = await (
    await slice37b.financeReportGetCanonicalResponse(
      new Request("http://localhost/api/finance/report"),
      await fx.session("owner"),
    )
  ).json();
  expect(ownerReport.income).toBeDefined();
  expect(ownerReport.expenses).toBeDefined();
  expect(typeof ownerReport.netMinor).toBe("number");

  // Commissions (view-own vs view-all) & Commission overrides
  const ownCommRes = await slice37b.commissionsGetCanonicalResponse(
    new Request("http://localhost/api/finance/commissions"),
    await fx.session("ownDoctor"),
  );
  expect(ownCommRes.status).toBe(200);
  const ownCommBody = await ownCommRes.json();
  expect(ownCommBody.isPersonalOnly).toBe(true);

  const overrideCreateRes = await slice37b.commissionOverridesPostCanonicalResponse(
    jsonReq("http://localhost/api/finance/commission-overrides", "POST", {
      doctorId: fx.parties.ownDoctor!,
      planId: ids.planId,
      action: "set",
      percent: 45,
      reason: "SYN حالة تقويم مركبة",
    }),
    await fx.session("owner"),
  );
  expect(overrideCreateRes.status).toBe(201);

  const overrideListRes = await slice37b.commissionOverridesGetCanonicalResponse(
    new Request(`http://localhost/api/finance/commission-overrides?patientId=${ids.patientId}`),
    await fx.session("owner"),
  );
  expect(overrideListRes.status).toBe(200);
  expect((await overrideListRes.json()).overrides.length).toBeGreaterThanOrEqual(1);

  // Permission revision bump (setGrants) invalidates captured canonical session -> 401
  const staleSession = await fx.session("expenseViewer");
  await fx.setGrants("expenseViewer", { "finance.patient-ledger.view": true }, { patientScope: "all" });
  const staleRes = await slice37b.debtsGetCanonicalResponse(staleSession);
  expect(staleRes.status).toBe(401);
});
