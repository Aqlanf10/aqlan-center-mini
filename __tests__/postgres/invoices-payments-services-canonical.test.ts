/** Slice 37a: Canonical Invoices, Payments, Services, Service-Materials & Legacy Inventory Foundation on real PostgreSQL 18. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import {
  openCanonicalInventoryDatabase,
  type CanonicalInventoryDatabase,
} from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-slice37a-invoices-payments-services-20261031");

const db = await import("../../lib/db");
const slice37a = await import("../../lib/canonical-invoices-payments-services");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const { staffRuntimeActions } = await import("../../lib/staff-operation-runtime");
const { SIMILAR_COLLECTION_REVIEW_HEADER } = await import("../../lib/similar-collection");
const { INVENTORY_PURCHASE_KEY_HEADER, INVENTORY_PURCHASE_PROTOCOL } = await import(
  "../../lib/inventory-purchase-protocol"
);

const ACCOUNTS = {
  owner: { username: "SYN-S37A-OWNER", role: "admin" },
  serviceViewerOnly: {
    username: "SYN-S37A-SVC-VIEW",
    role: "accountant",
    patientScope: "all",
    grants: {
      "finance.service-prices.view": true,
    },
  },
  cashierCollectOnly: {
    username: "SYN-S37A-CASHIER",
    role: "cashier",
    patientScope: "all",
    grants: {
      "finance.invoices.view": true,
      "finance.invoices.create": true,
      "finance.payments.view": true,
      "finance.payments.collect": true,
      "finance.service-prices.view": true,
    },
  },
  voidOnlyNoCollect: {
    username: "SYN-S37A-VOID-ONLY",
    role: "admin",
    grants: {
      "finance.payments.view": true,
      "finance.payments.void": true,
    },
  },
  inventoryNoCost: {
    username: "SYN-S37A-INV-NOCOST",
    role: "reception",
    patientScope: "all",
    grants: {
      "inventory.references.view": true,
      "inventory.items.create": true,
      "inventory.reconcile": true,
    },
  },
  ownDoctor: {
    username: "SYN-S37A-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.visits.document": true,
      "finance.invoices.view": true,
      "finance.payments.view": true,
      "inventory.references.view": true,
      "inventory.costs.view": true,
      "finance.cost-prices.view": true,
    },
  },
  otherDoctor: {
    username: "SYN-S37A-DOC-OTHER",
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
  ownVisit: 0,
  supplierPartyId: 0,
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

const SIMILAR_NONE = {
  [SIMILAR_COLLECTION_REVIEW_HEADER]: "none",
};

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");

  ids.ownPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-S37A-P1','SYN Patient Own','777370001',$1) RETURNING id",
      [fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.foreignPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-S37A-P2','SYN Patient Foreign','777370002',$1) RETURNING id",
      [fx.parties.otherDoctor!],
    )
  ).rows[0].id;

  ids.ownVisit = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO visits(patient_id,patient_name,status,doctor_id) VALUES($1,'SYN Patient Own','completed',$2) RETURNING id",
      [ids.ownPatient, fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.supplierPartyId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO parties(kind,name,is_active) VALUES('supplier','SYN S37A Supplier',TRUE) RETURNING id",
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

it("registers all Slice 37a runtime actions and record reads", () => {
  expect(CANONICAL_RECORD_READS["read:invoices.clinical-preview"].need).toEqual([
    "finance.invoices.create",
  ]);
  expect(CANONICAL_RECORD_READS["read:inventory.patient-cost"].need).toEqual([
    "inventory.costs.view",
  ]);

  const actions = new Set(staffRuntimeActions());
  for (const action of [
    "finance.invoices.view",
    "finance.invoices.cancel",
    "finance.invoices.mark-paid",
    "finance.invoices.correct",
    "finance.payments.view",
    "finance.payments.refund",
    "finance.payments.void",
    "finance.service-prices.view",
    "finance.service-prices.edit",
    "finance.cost-prices.view",
    "settings.operational.edit",
  ]) {
    expect(actions.has(action)).toBe(true);
  }
});

it("governs services catalogue, pricing projections, batch/provisional pricing, and service-materials", async () => {
  const deniedCreate = await slice37a.servicesCreateCanonicalResponse(
    jsonReq("http://localhost/api/services", "POST", {
      name: "SYN Denied Service",
      category: "filling",
      price: "15000",
    }),
    await fx.session("serviceViewerOnly"),
  );
  expect(deniedCreate.status).toBe(403);

  const createdSvcRes = await slice37a.servicesCreateCanonicalResponse(
    jsonReq("http://localhost/api/services", "POST", {
      name: "SYN Composite Filling",
      category: "filling",
      price: "20000",
      priceSar: "150",
    }),
    await fx.session("owner"),
  );
  expect(createdSvcRes.status).toBe(201);
  const createdSvc = await createdSvcRes.json();
  expect(createdSvc.priceMinor).toBe(20000);

  // Unconfigured service for provisional fill test
  await fx.pool.query(
    "INSERT INTO services(name,category,price_minor,price_configured,price_provisional,is_active,sort_order) VALUES('SYN Unpriced Surgery','surgery',0,FALSE,FALSE,TRUE,99)",
  );
  const provRes = await slice37a.servicesProvisionalPriceCanonicalResponse(await fx.session("owner"));
  expect(provRes.status).toBe(200);
  const prov = await provRes.json();
  expect(prov.filled).toBeGreaterThanOrEqual(1);

  const patchRes = await slice37a.servicePatchCanonicalResponse(
    jsonReq(`http://localhost/api/services/${createdSvc.id}`, "PATCH", { price: "25000" }),
    String(createdSvc.id),
    await fx.session("owner"),
  );
  expect(patchRes.status).toBe(200);
  expect((await patchRes.json()).priceMinor).toBe(25000);

  const batchRes = await slice37a.servicesBatchPriceCanonicalResponse(
    jsonReq("http://localhost/api/services/prices", "POST", {
      entries: [{ id: createdSvc.id, price: "26000" }],
    }),
    await fx.session("owner"),
  );
  expect(batchRes.status).toBe(200);
  expect((await batchRes.json()).updated).toBe(1);

  // Projection check: serviceViewerOnly omits invoiceQuotes; cashierCollectOnly (has finance.invoices.create) includes invoiceQuotes
  const viewOnlyList = await (
    await slice37a.servicesListCanonicalResponse(
      new Request("http://localhost/api/services"),
      await fx.session("serviceViewerOnly"),
    )
  ).json();
  const targetViewOnly = viewOnlyList.find((s: { id: number }) => s.id === createdSvc.id);
  expect(targetViewOnly.invoiceQuotes).toBeUndefined();

  const cashierList = await (
    await slice37a.servicesListCanonicalResponse(
      new Request("http://localhost/api/services"),
      await fx.session("cashierCollectOnly"),
    )
  ).json();
  const targetCashier = cashierList.find((s: { id: number }) => s.id === createdSvc.id);
  expect(targetCashier.invoiceQuotes?.YER?.minor).toBe(26000);

  // Create inventory item and link via service-materials
  const itemRes = await slice37a.inventoryCreateCanonicalResponse(
    jsonReq("http://localhost/api/inventory", "POST", {
      name: "SYN Composite Syringe",
      category: "consumable",
      unit: "إبرة",
      minLevel: 2,
    }),
    await fx.session("inventoryNoCost"),
  );
  expect(itemRes.status).toBe(201);
  const item = await itemRes.json();

  const matCreateDenied = await slice37a.serviceMaterialsCreateCanonicalResponse(
    jsonReq("http://localhost/api/service-materials", "POST", {
      serviceId: createdSvc.id,
      itemId: item.id,
      qtyPerUnit: 0.5,
    }),
    await fx.session("inventoryNoCost"),
  );
  expect(matCreateDenied.status).toBe(403);

  const matCreateOk = await slice37a.serviceMaterialsCreateCanonicalResponse(
    jsonReq("http://localhost/api/service-materials", "POST", {
      serviceId: createdSvc.id,
      itemId: item.id,
      qtyPerUnit: 0.5,
      note: "نصف إبرة",
    }),
    await fx.session("owner"),
  );
  expect(matCreateOk.status).toBe(201);
  const mat = await matCreateOk.json();

  const matListRes = await slice37a.serviceMaterialsListCanonicalResponse(
    new Request(`http://localhost/api/service-materials?serviceId=${createdSvc.id}`),
    await fx.session("ownDoctor"),
  );
  expect(matListRes.status).toBe(200);
  expect((await matListRes.json()).length).toBe(1);

  const matDelRes = await slice37a.serviceMaterialsDeleteCanonicalResponse(
    new Request(`http://localhost/api/service-materials?id=${mat.id}`, { method: "DELETE" }),
    await fx.session("owner"),
  );
  expect(matDelRes.status).toBe(200);
});

it("enforces legacy inventory cost projections, keyed purchases, movements, valuation, and patient-cost scope", async () => {
  const itemRes = await slice37a.inventoryCreateCanonicalResponse(
    jsonReq("http://localhost/api/inventory", "POST", {
      name: "SYN Lidocaine Box",
      category: "anesthetic",
      unit: "علبة",
      minLevel: 1,
    }),
    await fx.session("inventoryNoCost"),
  );
  const item = await itemRes.json();

  // Keyed purchase with supplierPartyId by inventoryNoCost (lacks payables capability) -> 403
  const ownerRow = (
    await fx.pool.query<{ id: number }>("SELECT id FROM users WHERE username = $1", [
      ACCOUNTS.owner.username,
    ])
  ).rows[0];
  const noCostRow = (
    await fx.pool.query<{ id: number }>("SELECT id FROM users WHERE username = $1", [
      ACCOUNTS.inventoryNoCost.username,
    ])
  ).rows[0];

  const purchaseKeyDenied = "11111111-2222-4333-8444-555555555555";
  const deniedPayableMove = await slice37a.inventoryMovementsCreateCanonicalResponse(
    jsonReq(
      `http://localhost/api/inventory/${item.id}/movements`,
      "POST",
      {
        protocol: INVENTORY_PURCHASE_PROTOCOL,
        purchase: {
          kind: "in",
          qty: 10,
          unitCost: "5000",
          supplierPartyId: ids.supplierPartyId,
          reason: "شراء مخدر",
        },
      },
      {
        [INVENTORY_PURCHASE_KEY_HEADER]: purchaseKeyDenied,
        "X-Purchase-Actor": encodeURIComponent(ACCOUNTS.inventoryNoCost.username),
        "X-Purchase-Actor-Id": String(noCostRow.id),
      },
    ),
    String(item.id),
    await fx.session("inventoryNoCost"),
  );
  expect(deniedPayableMove.status).toBe(403);

  // Owner records keyed purchase with cost + supplier payable + exact idempotent replay
  const purchaseKeyOk = "22222222-3333-4444-8555-666666666666";
  const purchaseBody = {
    protocol: INVENTORY_PURCHASE_PROTOCOL,
    purchase: {
      kind: "in",
      qty: 10,
      unitCost: "5000",
      supplierPartyId: ids.supplierPartyId,
      reason: "شراء مخدر معتمد",
    },
  };
  const purchaseHeaders = {
    [INVENTORY_PURCHASE_KEY_HEADER]: purchaseKeyOk,
    "X-Purchase-Actor": encodeURIComponent(ACCOUNTS.owner.username),
    "X-Purchase-Actor-Id": String(ownerRow.id),
  };
  const purchaseRes1 = await slice37a.inventoryMovementsCreateCanonicalResponse(
    jsonReq(`http://localhost/api/inventory/${item.id}/movements`, "POST", purchaseBody, purchaseHeaders),
    String(item.id),
    await fx.session("owner"),
  );
  expect(purchaseRes1.status).toBe(201);
  const purchaseJson1 = await purchaseRes1.json();
  expect(purchaseJson1.replayed).toBe(false);
  expect(purchaseJson1.payableCreated).toBe(true);
  expect(purchaseJson1.result.movement.unitCostMinor).toBe(5000);

  const purchaseRes2 = await slice37a.inventoryMovementsCreateCanonicalResponse(
    jsonReq(`http://localhost/api/inventory/${item.id}/movements`, "POST", purchaseBody, purchaseHeaders),
    String(item.id),
    await fx.session("owner"),
  );
  expect(purchaseRes2.status).toBe(201);
  expect((await purchaseRes2.json()).replayed).toBe(true);

  // Issue 2 units to ownVisit / ownPatient
  const outRes = await slice37a.inventoryMovementsCreateCanonicalResponse(
    jsonReq(`http://localhost/api/inventory/${item.id}/movements`, "POST", {
      kind: "out",
      qty: 2,
      visitId: ids.ownVisit,
      patientId: ids.ownPatient,
      reason: "صرف للزيارة",
    }),
    String(item.id),
    await fx.session("inventoryNoCost"),
  );
  expect(outRes.status).toBe(201);

  // Detail read: inventoryNoCost has unitCostMinor omitted by allowlist; owner sees unitCostMinor
  const detailNoCost = await (
    await slice37a.inventoryDetailCanonicalResponse(String(item.id), await fx.session("inventoryNoCost"))
  ).json();
  expect(
    detailNoCost.movements.every((m: Record<string, unknown>) => !("unitCostMinor" in m)),
  ).toBe(true);

  const detailOwner = await (
    await slice37a.inventoryDetailCanonicalResponse(String(item.id), await fx.session("owner"))
  ).json();
  expect(detailOwner.movements.some((m: { unitCostMinor: number | null }) => m.unitCostMinor === 5000)).toBe(
    true,
  );

  // Valuation gated by inventory.costs.view
  expect(
    (await slice37a.inventoryValuationCanonicalResponse(await fx.session("inventoryNoCost"))).status,
  ).toBe(403);
  const valRes = await slice37a.inventoryValuationCanonicalResponse(await fx.session("owner"));
  expect(valRes.status).toBe(200);
  expect((await valRes.json()).baseCurrency).toBe("YER");

  // Patient cost: ownDoctor sees ownPatient (10000 minor), refused on foreignPatient (403)
  const ownCostRes = await slice37a.inventoryPatientCostCanonicalResponse(
    new Request(`http://localhost/api/inventory/patient-cost?patientId=${ids.ownPatient}`),
    await fx.session("ownDoctor"),
  );
  expect(ownCostRes.status).toBe(200);
  expect((await ownCostRes.json()).materialCostMinor).toBe(10000);

  const foreignCostRes = await slice37a.inventoryPatientCostCanonicalResponse(
    new Request(`http://localhost/api/inventory/patient-cost?patientId=${ids.foreignPatient}`),
    await fx.session("ownDoctor"),
  );
  expect(foreignCostRes.status).toBe(403);
});

it("governs invoices preview, creation + replay, add-service, revision, archive, status patch, and payments + corrections", async () => {
  const svcRes = await slice37a.servicesCreateCanonicalResponse(
    jsonReq("http://localhost/api/services", "POST", {
      name: "SYN Scaling Service",
      category: "cleaning",
      price: "30000",
    }),
    await fx.session("owner"),
  );
  const svc = await svcRes.json();

  // Clinical preview
  const previewRes = await slice37a.invoiceClinicalPreviewCanonicalResponse(
    jsonReq("http://localhost/api/invoices/clinical-preview", "POST", {
      patientId: ids.ownPatient,
      currency: "YER",
      items: [
        {
          serviceId: svc.id,
          description: svc.name,
          quantity: 1,
          price: "30000",
          scope: "full_mouth",
          catalogPriceMinor: 30000,
        },
      ],
    }),
    await fx.session("cashierCollectOnly"),
  );
  expect(previewRes.status).toBe(200);

  // Create invoice + idempotent replay
  const invPayload = {
    patientId: ids.ownPatient,
    currency: "YER",
    idempotencyKey: "syn-s37a-inv-create-0001",
    items: [
      {
        serviceId: svc.id,
        description: svc.name,
        quantity: 1,
        price: "30000",
        scope: "full_mouth",
        catalogPriceMinor: 30000,
      },
    ],
  };
  const invRes1 = await slice37a.invoicesCreateCanonicalResponse(
    jsonReq("http://localhost/api/invoices", "POST", invPayload),
    await fx.session("cashierCollectOnly"),
  );
  expect(invRes1.status).toBe(201);
  const inv1 = await invRes1.json();
  expect(inv1.replayed).toBe(false);

  const invRes2 = await slice37a.invoicesCreateCanonicalResponse(
    jsonReq("http://localhost/api/invoices", "POST", invPayload),
    await fx.session("cashierCollectOnly"),
  );
  expect(invRes2.status).toBe(200);
  expect((await invRes2.json()).replayed).toBe(true);

  // Scope isolation on GET /api/invoices/[id]: ownDoctor allowed on ownPatient, denied on foreignPatient invoice
  const foreignInvRes = await slice37a.invoicesCreateCanonicalResponse(
    jsonReq("http://localhost/api/invoices", "POST", {
      patientId: ids.foreignPatient,
      currency: "YER",
      idempotencyKey: "syn-s37a-inv-foreign-0001",
      items: [
        {
          serviceId: svc.id,
          doctorId: fx.parties.otherDoctor!,
          description: svc.name,
          quantity: 1,
          price: "30000",
          scope: "full_mouth",
          catalogPriceMinor: 30000,
        },
      ],
    }),
    await fx.session("cashierCollectOnly"),
  );
  const foreignInv = await foreignInvRes.json();

  expect(
    (await slice37a.invoiceGetCanonicalResponse(String(inv1.id), await fx.session("ownDoctor")))
      .status,
  ).toBe(200);
  expect(
    (await slice37a.invoiceGetCanonicalResponse(String(foreignInv.id), await fx.session("ownDoctor")))
      .status,
  ).toBe(403);

  // Add-service GET -> PUT (preview, zero audit rows) -> POST (supplemental invoice)
  const consultCreateRes = await slice37a.servicesCreateCanonicalResponse(
    jsonReq("http://localhost/api/services", "POST", {
      name: "SYN-S37A-استشارة-إضافية",
      category: "consultation",
      price: "15000",
      isActive: true,
    }),
    await fx.session("owner"),
  );
  expect(consultCreateRes.status).toBe(201);
  const consultSvc = await consultCreateRes.json();

  const addCtxRes = await slice37a.invoiceAddServiceGetCanonicalResponse(
    String(inv1.id),
    await fx.session("cashierCollectOnly"),
  );
  expect(addCtxRes.status).toBe(200);
  const addCtx = await addCtxRes.json();

  const auditBeforePut = Number(
    (await fx.pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM audit_log")).rows[0].c,
  );
  const addBody = {
    idempotencyKey: "syn-s37a-add-svc-0001",
    expectedSourceHash: addCtx.sourceHash,
    reason: "إضافة استشارة تكميلية",
    currency: "YER",
    serviceId: consultSvc.id,
    price: "15000",
    discount: "0",
  };
  const addPutRes = await slice37a.invoiceAddServicePreviewCanonicalResponse(
    jsonReq(`http://localhost/api/invoices/${inv1.id}/add-service`, "PUT", addBody),
    String(inv1.id),
    await fx.session("cashierCollectOnly"),
  );
  expect(addPutRes.status).toBe(200);
  const auditAfterPut = Number(
    (await fx.pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM audit_log")).rows[0].c,
  );
  expect(auditAfterPut).toBe(auditBeforePut);

  const addPostRes = await slice37a.invoiceAddServicePostCanonicalResponse(
    jsonReq(`http://localhost/api/invoices/${inv1.id}/add-service`, "POST", addBody),
    String(inv1.id),
    await fx.session("cashierCollectOnly"),
  );
  expect(addPostRes.status).toBe(201);
  const addReceipt = await addPostRes.json();
  expect(addReceipt.addedNetMinor).toBe(15000);

  // Payment without open shift -> 409 no_shift
  const noShiftPay = await slice37a.paymentsCreateCanonicalResponse(
    jsonReq(
      "http://localhost/api/payments",
      "POST",
      {
        patientId: ids.ownPatient,
        invoiceId: inv1.id,
        currency: "YER",
        amount: "10000",
        method: "cash",
      },
      { ...SIMILAR_NONE, "idempotency-key": "syn-s37a-pay-noshift-01" },
    ),
    await fx.session("cashierCollectOnly"),
  );
  expect(noShiftPay.status).toBe(409);

  // Open cashier shift and collect payment + replay
  await db.openShiftWith(fx.pool, { openedBy: ACCOUNTS.owner.username, opening: { YER: 0, SAR: 0, USD: 0 } });

  const payRes1 = await slice37a.paymentsCreateCanonicalResponse(
    jsonReq(
      "http://localhost/api/payments",
      "POST",
      {
        patientId: ids.ownPatient,
        invoiceId: inv1.id,
        currency: "YER",
        amount: "30000",
        method: "cash",
      },
      { ...SIMILAR_NONE, "idempotency-key": "syn-s37a-pay-ok-0001" },
    ),
    await fx.session("cashierCollectOnly"),
  );
  expect(payRes1.status).toBe(201);
  const pay1 = await payRes1.json();
  expect(pay1.amountMinor).toBe(30000);

  const payRes2 = await slice37a.paymentsCreateCanonicalResponse(
    jsonReq(
      "http://localhost/api/payments",
      "POST",
      {
        patientId: ids.ownPatient,
        invoiceId: inv1.id,
        currency: "YER",
        amount: "30000",
        method: "cash",
      },
      { ...SIMILAR_NONE, "idempotency-key": "syn-s37a-pay-ok-0001" },
    ),
    await fx.session("cashierCollectOnly"),
  );
  expect(payRes2.status).toBe(200);

  // Cashier without finance.payments.refund cannot refund
  const deniedRefund = await slice37a.paymentsCreateCanonicalResponse(
    jsonReq(
      "http://localhost/api/payments",
      "POST",
      {
        patientId: ids.ownPatient,
        kind: "refund",
        reversalOfId: pay1.id,
        currency: "YER",
        amount: "5000",
        method: "cash",
      },
      { ...SIMILAR_NONE, "idempotency-key": "syn-s37a-refund-denied-01" },
    ),
    await fx.session("cashierCollectOnly"),
  );
  expect(deniedRefund.status).toBe(403);

  // Payment correction: voidOnlyNoCollect refused on mode="correct", allowed on mode="void"
  const deniedCorrectMode = await slice37a.paymentCorrectCanonicalResponse(
    jsonReq(
      `http://localhost/api/payments/${pay1.id}/correct`,
      "POST",
      {
        mode: "correct",
        reason: "تعديل المبلغ",
        currency: "YER",
        amount: "25000",
        target: "original",
      },
      { "idempotency-key": "syn-s37a-corr-denied-01" },
    ),
    String(pay1.id),
    await fx.session("voidOnlyNoCollect"),
  );
  expect(deniedCorrectMode.status).toBe(403);

  // Owner corrects pay1 from 30000 -> 30000 (keeps inv1 settled so archive test succeeds!)
  const ownerCorrRes = await slice37a.paymentCorrectCanonicalResponse(
    jsonReq(
      `http://localhost/api/payments/${pay1.id}/correct`,
      "POST",
      {
        mode: "correct",
        reason: "تصحيح طريقة الدفع إلى تحويل",
        currency: "YER",
        amount: "30000",
        method: "transfer",
        target: "original",
      },
      { "idempotency-key": "syn-s37a-corr-owner-01" },
    ),
    String(pay1.id),
    await fx.session("owner"),
  );
  expect(ownerCorrRes.status).toBe(201);

  // Retire unused collection attempt key
  const retireBodyRaw = JSON.stringify({ patientId: ids.ownPatient, amount: "1000", currency: "YER" });
  const retireRes = await slice37a.paymentAttemptRetireCanonicalResponse(
    jsonReq("http://localhost/api/payments/attempts/retire", "POST", {
      idempotencyKey: "syn-s37a-retire-key-0001",
      patientId: ids.ownPatient,
      operation: "payment",
      requestBody: retireBodyRaw,
      originalActor: ACCOUNTS.cashierCollectOnly.username,
    }),
    await fx.session("cashierCollectOnly"),
  );
  expect(retireRes.status).toBe(200);
  expect((await retireRes.json()).state).toBe("retired");

  // Archive settled inv1 + list archive
  const archViewRes = await slice37a.invoiceArchiveGetCanonicalResponse(
    String(inv1.id),
    await fx.session("cashierCollectOnly"),
  );
  expect(archViewRes.status).toBe(200);
  const archView = await archViewRes.json();

  const archPostRes = await slice37a.invoiceArchivePostCanonicalResponse(
    jsonReq(`http://localhost/api/invoices/${inv1.id}/archive`, "POST", {
      action: "archive",
      expectedVersion: archView.version,
      reason: "أرشفة فاتورة مسددة بالكامل",
      idempotencyKey: "syn-s37a-arch-0001",
    }),
    String(inv1.id),
    await fx.session("owner"),
  );
  expect(archPostRes.status).toBe(201);

  const archListRes = await slice37a.invoiceArchiveListCanonicalResponse(
    new Request(`http://localhost/api/invoices/archive?patientId=${ids.ownPatient}`),
    await fx.session("cashierCollectOnly"),
  );
  expect(archListRes.status).toBe(200);
  expect((await archListRes.json()).archivedInvoices.length).toBe(1);

  // Invoice revision (correct) on foreignInv + status PATCH cancel on additionalInvoiceId
  const corrCtx = await (
    await slice37a.invoiceCorrectGetCanonicalResponse(String(foreignInv.id), await fx.session("owner"))
  ).json();
  const revRes = await slice37a.invoiceCorrectPostCanonicalResponse(
    jsonReq(`http://localhost/api/invoices/${foreignInv.id}/correct`, "POST", {
      idempotencyKey: "syn-s37a-inv-rev-0001",
      expectedSourceHash: corrCtx.sourceHash,
      reason: "تخفيض فاتورة تجريبية",
      lines: [
        {
          itemId: corrCtx.invoice.items[0].id,
          quantity: 1,
          unitPrice: "25000",
        },
      ],
      discount: "0",
      expectedRemainingMinor: 25000,
      repaymentTerms: { mode: "full", installments: [] },
    }),
    String(foreignInv.id),
    await fx.session("owner"),
  );
  expect(revRes.status).toBe(201);

  // Status PATCH branching: cashierCollectOnly refused on status="cancelled", owner allowed
  const deniedCancelPatch = await slice37a.invoicePatchCanonicalResponse(
    jsonReq(`http://localhost/api/invoices/${addReceipt.additionalInvoiceId}`, "PATCH", {
      status: "cancelled",
      reason: "إلغاء تجريبي",
    }),
    String(addReceipt.additionalInvoiceId),
    await fx.session("cashierCollectOnly"),
  );
  expect(deniedCancelPatch.status).toBe(403);

  const okCancelPatch = await slice37a.invoicePatchCanonicalResponse(
    jsonReq(`http://localhost/api/invoices/${addReceipt.additionalInvoiceId}`, "PATCH", {
      status: "cancelled",
      reason: "إلغاء تجريبي معتمد",
    }),
    String(addReceipt.additionalInvoiceId),
    await fx.session("owner"),
  );
  expect(okCancelPatch.status).toBe(200);
  expect((await okCancelPatch.json()).status).toBe("cancelled");
});
