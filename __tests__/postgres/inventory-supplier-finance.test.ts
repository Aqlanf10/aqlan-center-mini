vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { withTransaction } from "../../lib/transactions";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import {
  createSupplierInvoiceFinanceService,
  supplierInvoiceDigest,
  canonicalInvoiceRate,
} from "../../lib/inventory-domain/supplier-finance";
import {
  valuationSnapshot,
  type SupplierInvoiceRevision,
  type RequestRevision,
  type PurchaseOrder,
} from "../../lib/inventory-domain/procurement";
import type { InventoryActor } from "../../lib/inventory-domain/procurement-store";
import type { DbClient } from "../../lib/db";
import type { Currency } from "../../lib/money";
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db"),
  store = await import("../../lib/inventory-domain/procurement-store");
let admin: InventoryActor,
  doctor: InventoryActor,
  itemId: number,
  location: string;
const key = () => randomUUID();
const service = createSupplierInvoiceFinanceService({
  resolvePrincipal: async (actor) => ({
    realmId: "synthetic-supplier-realm",
    subjectId: `synthetic:${actor.userId}`,
    actorUserId: actor.userId,
    username: actor.username,
  }),
});
const tx = <T>(work: (client: DbClient) => Promise<T>) =>
  withTransaction(db.getPool(), work);
const expectation = (invoice: SupplierInvoiceRevision) => ({
  invoiceId: invoice.id,
  expectedVersion: invoice.version,
  expectedDigest: supplierInvoiceDigest(invoice),
  reason: "Synthetic reviewed supplier source",
});
const post = (invoice: SupplierInvoiceRevision, k = key()) =>
  tx((c) => service.post(c, admin, k, expectation(invoice)));
const cancel = (invoice: SupplierInvoiceRevision, k = key()) =>
  tx((c) => service.cancel(c, admin, k, expectation(invoice)));
beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  await db.ensureSchema();
  await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
  await db.getPool().query(INVENTORY_SUPPLIER_FINANCE_SQL);
  for (const role of ["admin", "doctor"]) {
    const username = `SYN-SFIN-${key()}`,
      id = (
        await db
          .getPool()
          .query(
            "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled',$2) RETURNING id",
            [username, role],
          )
      ).rows[0].id;
    const actor = { userId: id, username, role };
    if (role === "admin") admin = actor;
    else doctor = actor;
  }
  itemId = (
    await db.createInventoryItem({
      name: `SYN-SFIN-${key()}`,
      category: "other",
      unit: "piece",
      minLevel: 0,
      note: null,
      createdBy: admin.username,
    })
  ).id;
  await db
    .getPool()
    .query(
      "INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'piece','piece',1,0,0)",
      [itemId],
    );
  location = `SYN-${key()}`;
  await db
    .getPool()
    .query(
      "INSERT INTO inventory_locations(id,branch_key,label,kind) VALUES($1,'clinic','Synthetic store','store')",
      [location],
    );
  await db
    .getPool()
    .query(
      "INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) SELECT $1,'clinic',COALESCE(MAX(version),0)+1,'YER',1000000000,FALSE,$2 FROM inventory_approval_policies WHERE branch_key='clinic'",
      [key(), admin.userId],
    );
  await db.openShift({
    openedBy: admin.username,
    opening: { YER: 0, SAR: 0, USD: 0 },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.resetPoolForTesting();
});
async function fixture(currency: Currency = "SAR", missingValuation = false) {
  const supplierId = (
    await db
      .getPool()
      .query(
        "INSERT INTO parties(name,kind) VALUES($1,'supplier') RETURNING id",
        [`SYN-SFIN-${key()}`],
      )
  ).rows[0].id;
  const rate = currency === "YER" ? "1" : "123.456789",
    conversion = {
      itemId,
      version: 1,
      baseUnit: "piece",
      enteredUnit: "piece",
      baseUnitsPerEnteredUnit: "1",
      enteredPrecision: 0,
      basePrecision: 0,
    };
  const r: RequestRevision = {
    id: key(),
    version: 1,
    branchId: "clinic",
    requestedBy: doctor.userId,
    reason: "Synthetic needed supplies",
    proposedSupplierPartyId: supplierId,
    value: { currency, amountMinor: 20000 },
    lines: [{ id: key(), itemId, quantity: "2", conversion }],
  };
  await store.submitPurchaseRequest(doctor, key(), r);
  await store.approvePurchaseRequest(admin, key(), {
    requestId: r.id,
    version: 1,
    decisions: [
      { lineId: r.lines[0].id, quantity: "2", reason: "Synthetic approval" },
    ],
    valuation: valuationSnapshot({
      purpose: "approval_estimate",
      currency,
      amountMinor: 20000,
      rateToBase: rate,
      capturedAt: "2026-10-26T01:00:00Z",
      sourceRef: "synthetic frozen quote",
    }),
  });
  const o: PurchaseOrder = {
    id: key(),
    version: 1,
    branchId: "clinic",
    supplierPartyId: supplierId,
    currency,
    shippingMinor: 0,
    discountMinor: 0,
    lines: [
      {
        id: key(),
        itemId,
        kind: "stock",
        quantity: "2",
        conversion,
        price: {
          state: "known",
          currency,
          unitPriceMinor: 10000,
          reason: "Synthetic quote",
        },
        trackLot: true,
        requiresExpiry: false,
        minimumShelfLifeDays: 0,
        sources: [
          {
            id: key(),
            requestId: r.id,
            requestLineId: r.lines[0].id,
            baseQuantity: "2",
          },
        ],
      },
    ],
  };
  await store.issuePurchaseOrder(admin, key(), o);
  const receiptLine = key();
  await store.postInspectedReceipt(admin, key(), {
    id: key(),
    version: 1,
    orderId: o.id,
    orderVersion: 1,
    branchId: "clinic",
    supplierPartyId: supplierId,
    actualArrivalDate: "2026-10-26",
    lines: [
      {
        orderLineId: o.lines[0].id,
        arrivedQuantity: "2",
        portions: [
          {
            id: receiptLine,
            quantity: "2",
            disposition: "accepted",
            lotCode: "SYN-SFIN",
            expiryDate: null,
            locationId: location,
            damaged: false,
            reason: "Synthetic inspection",
          },
        ],
      },
    ],
  });
  const lineId = key();
  const invoice: SupplierInvoiceRevision = {
    id: key(),
    version: 1,
    orderId: o.id,
    orderVersion: 1,
    branchId: "clinic",
    supplierPartyId: supplierId,
    currency,
    invoiceNumber: `SYN-${key()}`,
    invoiceDate: "2026-10-26",
    missingNumberReason: null,
    shippingMinor: 0,
    discountMinor: 0,
    valuation: missingValuation
      ? null
      : valuationSnapshot({
          purpose: "invoice_valuation",
          currency,
          amountMinor: 20000,
          rateToBase: rate,
          capturedAt: "2026-10-26T01:00:00Z",
          sourceRef: "Synthetic invoice FX",
        }),
    lines: [
      {
        id: lineId,
        orderLineId: o.lines[0].id,
        quantity: "2",
        price: o.lines[0].price,
        receiptAllocations: [
          {
            id: key(),
            invoiceLineId: lineId,
            receiptLineId: receiptLine,
            baseQuantity: "2",
          },
        ],
      },
    ],
  };
  await store.recordSupplierInvoiceMatch(admin, key(), invoice);
  return invoice;
}
async function counts() {
  return (
    await db
      .getPool()
      .query(
        "SELECT (SELECT count(*)::int FROM payables) AS debt,(SELECT count(*)::int FROM payable_adjustments) AS adjustments,(SELECT count(*)::int FROM expenses) AS cash,(SELECT count(*)::int FROM inventory_movements) AS stock",
      )
  ).rows[0];
}
async function payment(invoice: SupplierInvoiceRevision, payableId: number) {
  return tx((c) =>
    db.recordExpenseInTx(
      c,
      {
        category: "supplier",
        partyId: invoice.supplierPartyId,
        payeeText: null,
        amountMinor: 100,
        currency: invoice.currency,
        baseCurrency: "YER",
        exchangeRate: Number(invoice.valuation!.rateToBase),
        payableId,
        note: "Synthetic payment",
        createdBy: admin.username,
        actorRole: "admin",
      },
      { YER: 1, SAR: 123.456789, USD: 123.456789 },
    ),
  );
}

describe("prepared supplier invoice finance core", () => {
  it("rechecks the current order revision and accepted receipt reservation before posting", async () => {
    const stale = await fixture();
    const order = (
      await db.getPool().query<{
        document: PurchaseOrder;
      }>("SELECT document FROM purchase_orders WHERE id=$1", [stale.orderId])
    ).rows[0].document;
    const supplemental: RequestRevision = {
      id: key(),
      version: 1,
      branchId: "clinic",
      requestedBy: doctor.userId,
      reason: "Synthetic supplemental approved need",
      proposedSupplierPartyId: stale.supplierPartyId,
      value: { currency: "SAR", amountMinor: 10000 },
      lines: [
        {
          id: key(),
          itemId,
          quantity: "1",
          conversion: order.lines[0].conversion,
        },
      ],
    };
    await store.submitPurchaseRequest(doctor, key(), supplemental);
    await store.approvePurchaseRequest(admin, key(), {
      requestId: supplemental.id,
      version: 1,
      decisions: [
        {
          lineId: supplemental.lines[0].id,
          quantity: "1",
          reason: "Synthetic supplementary approval",
        },
      ],
      valuation: valuationSnapshot({
        purpose: "approval_estimate",
        currency: "SAR",
        amountMinor: 10000,
        rateToBase: "123.456789",
        capturedAt: "2026-10-26T01:00:00Z",
        sourceRef: "Synthetic supplement",
      }),
    });
    await store.amendPurchaseOrder(admin, key(), {
      order: {
        ...order,
        version: 2,
        lines: [
          {
            ...order.lines[0],
            quantity: "3",
            sources: [
              ...order.lines[0].sources,
              {
                id: key(),
                requestId: supplemental.id,
                requestLineId: supplemental.lines[0].id,
                baseQuantity: "1",
              },
            ],
          },
        ],
      },
      reason: "Synthetic renewed order revision",
    });
    const before = await counts();
    await expect(post(stale)).rejects.toMatchObject({ code: "stale_order" });
    expect(await counts()).toEqual(before);
    const invoice = await fixture(),
      competing = key();
    // A deliberately inconsistent historical fixture: another immutable source
    // reserves the receipt after the candidate preview. Posting must re-read it.
    await db
      .getPool()
      .query(
        "INSERT INTO supplier_invoices(id,order_id,supplier_party_id,duplicate_key,document,match_plan,created_by) SELECT $1,order_id,supplier_party_id,NULL,document,match_plan,created_by FROM supplier_invoices WHERE id=$2",
        [competing, invoice.id],
      );
    await db
      .getPool()
      .query(
        "INSERT INTO supplier_invoice_receipt_allocations(id,invoice_id,invoice_line_id,receipt_line_id,base_qty) VALUES($1,$2,$3,$4,1)",
        [
          key(),
          competing,
          key(),
          invoice.lines[0].receiptAllocations[0].receiptLineId,
        ],
      );
    const unchanged = await counts();
    await expect(post(invoice)).rejects.toMatchObject({
      code: "receipt_already_invoiced",
    });
    expect(await counts()).toEqual(unchanged);
  });
  it.each(["YER", "SAR", "USD"] as const)(
    "posts and cancels %s once through canonical debt without stock/cash changes",
    async (currency) => {
      const invoice = await fixture(currency),
        before = await counts(),
        k = key();
      const [a, b] = await Promise.all([post(invoice, k), post(invoice, k)]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(a.payableId).toBe(b.payableId);
      expect((await post(invoice)).payableEffects).toBe(0);
      const raw = (
        await db
          .getPool()
          .query(
            "SELECT amount_minor,currency,exchange_rate,base_amount_minor FROM payables WHERE id=$1",
            [a.payableId],
          )
      ).rows[0];
      expect(raw.currency).toBe(currency);
      expect(Number(raw.base_amount_minor)).toBe(
        invoice.valuation!.baseAmountMinor,
      );
      const ck = key(),
        results = await Promise.all([cancel(invoice, ck), cancel(invoice, ck)]);
      expect(results[0].adjustmentId).toBe(results[1].adjustmentId);
      expect((await cancel(invoice)).adjustmentEffects).toBe(0);
      // Original command acknowledgements retain historical results after a
      // later cancellation; they never execute another posting or adjustment.
      expect(await post(invoice, k)).toEqual({ ...a, replayed: true });
      expect(await cancel(invoice, ck)).toEqual({ ...results[0], replayed: true });
      expect(await counts()).toEqual({
        ...before,
        debt: before.debt + 1,
        adjustments: before.adjustments + 1,
      });
      expect(
        (await db.partyDueByCurrency()).find(
          (row) => row.partyId === invoice.supplierPartyId,
        )?.dueMinor ?? 0,
      ).toBe(0);
      expect(
        (await db.partyBalances()).find(
          (row) => row.partyId === invoice.supplierPartyId,
        )?.owedMinor,
      ).toBe(0);
      expect(
        (await db.listPartyOpenings()).adjustments.some(
          (row) => row.id === results[0].adjustmentId,
        ),
      ).toBe(false);
      expect(
        (
          await db
            .getPool()
            .query(
              "SELECT amount_minor,currency,exchange_rate,base_amount_minor FROM payables WHERE id=$1",
              [a.payableId],
            )
        ).rows[0],
      ).toEqual(raw);
      await expect(post(invoice)).rejects.toMatchObject({
        code: "invoice_cancelled",
      });
      expect(
        (
          await tx((c) =>
            store.readEffectiveInvoiceAllocations(c, [invoice.orderId]),
          )
        )[0].baseQuantity,
      ).toBe("2");
    },
  );
  it("revises unresolved valuation immutably, uses current allocations for legacy matching, and rejects stale posting", async () => {
    const original = await fixture("SAR", true);
    await expect(post(original)).rejects.toMatchObject({
      code: "invoice_not_matched",
    });
    const revised = {
      ...original,
      version: 2,
      valuation: valuationSnapshot({
        purpose: "invoice_valuation",
        currency: "SAR",
        amountMinor: 10000,
        rateToBase: "123.456789",
        capturedAt: "2026-10-26T01:00:00Z",
        sourceRef: "Reviewed invoice",
      }),
      lines: [
        {
          ...original.lines[0],
          quantity: "1",
          receiptAllocations: [
            { ...original.lines[0].receiptAllocations[0], baseQuantity: "1" },
          ],
        },
      ],
    };
    await tx((c) =>
      service.revise(c, admin, key(), {
        ...expectation(original),
        document: revised,
      }),
    );
    await expect(post(original)).rejects.toMatchObject({
      code: "stale_version",
    });
    await post(revised);
    const second = {
      ...revised,
      id: key(),
      version: 1,
      invoiceNumber: `SYN-${key()}`,
      lines: [
        {
          ...revised.lines[0],
          id: key(),
          receiptAllocations:
            [] as SupplierInvoiceRevision["lines"][number]["receiptAllocations"],
        },
      ],
    };
    second.lines[0].receiptAllocations = [
      {
        ...revised.lines[0].receiptAllocations[0],
        id: key(),
        invoiceLineId: second.lines[0].id,
      },
    ];
    expect(
      (await store.recordSupplierInvoiceMatch(admin, key(), second)).status,
    ).toBe("matched");
    const view = await store.readProcurementWorkbench(admin);
    expect(
      view.invoices.find((row) => row.id === original.id)?.document.version,
    ).toBe(2);
    expect(
      (
        await db
          .getPool()
          .query("SELECT document FROM supplier_invoices WHERE id=$1", [
            original.id,
          ])
      ).rows[0].document,
    ).toEqual(original);
    await expect(
      tx((c) =>
        service.revise(c, admin, key(), {
          ...expectation(revised),
          document: { ...revised, version: 3 },
        }),
      ),
    ).rejects.toMatchObject({ code: "invoice_already_posted" });
  });
  it("refuses missing/mismatched realm, gate-off, non-admin and changed-key content without effects", async () => {
    const invoice = await fixture(),
      before = await counts();
    await expect(
      tx((c) =>
        createSupplierInvoiceFinanceService().post(
          c,
          admin,
          key(),
          expectation(invoice),
        ),
      ),
    ).rejects.toMatchObject({ code: "principal_realm_unavailable" });
    const wrong = createSupplierInvoiceFinanceService({
      resolvePrincipal: async () => ({
        realmId: "x",
        subjectId: "x",
        actorUserId: doctor.userId,
        username: doctor.username,
      }),
    });
    await expect(
      tx((c) => wrong.post(c, admin, key(), expectation(invoice))),
    ).rejects.toMatchObject({ code: "principal_realm_unavailable" });
    await expect(
      tx((c) => service.post(c, doctor, key(), expectation(invoice))),
    ).rejects.toMatchObject({ code: "operation_forbidden" });
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "false");
    try {
      await expect(post(invoice)).rejects.toMatchObject({
        code: "inventory_integration_disabled",
      });
    } finally {
      vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    }
    expect(await counts()).toEqual(before);
    const k = key();
    await post(invoice, k);
    await expect(
      tx((c) =>
        service.post(c, admin, k, {
          ...expectation(invoice),
          reason: "Changed content",
        }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("rejects precision loss and changed invoice identity", async () => {
    const invoice = await fixture();
    expect(() =>
      canonicalInvoiceRate({
        ...invoice,
        valuation: valuationSnapshot({
          ...invoice.valuation!,
          rateToBase: "123.4567891",
        }),
      }),
    ).toThrow();
    await expect(
      tx((c) =>
        service.revise(c, admin, key(), {
          ...expectation(invoice),
          document: { ...invoice, version: 2, invoiceNumber: "different" },
        }),
      ),
    ).rejects.toMatchObject({ code: "invoice_identity_mismatch" });
  });
  it("requires explicit payment void, then cancels without inventing cash", async () => {
    const invoice = await fixture(),
      posted = await post(invoice),
      paid = await payment(invoice, posted.payableId);
    expect(paid.id).not.toBeNull();
    await expect(cancel(invoice)).rejects.toMatchObject({
      code: "invoice_payment_reversal_required",
    });
    expect(
      (
        await tx((c) =>
          db.voidExpenseInTx(c, paid.id!, {
            actor: admin.username,
            actorRole: "admin",
            reason: "Synthetic authorized payment reversal",
          }),
        )
      ).ok,
    ).toBe(true);
    const before = await counts();
    await cancel(invoice);
    expect((await counts()).cash).toBe(before.cash);
    expect((await payment(invoice, posted.payableId)).reason).toBe(
      "exceeds_payable",
    );
  });
  it("serializes payment and cancellation with one valid result", async () => {
    const invoice = await fixture(),
      posted = await post(invoice);
    const results = await Promise.allSettled([
      payment(invoice, posted.payableId),
      cancel(invoice),
    ]);
    const p = results[0],
      c = results[1];
    expect(p.status).toBe("fulfilled");
    if (p.status === "fulfilled" && p.value.id !== null)
      expect(c.status).toBe("rejected");
    else expect(c.status).toBe("fulfilled");
  });
  it("rejects unlinked adjustment at commit and linked payable mutation", async () => {
    const invoice = await fixture(),
      posted = await post(invoice),
      before = await counts();
    await expect(
      db
        .getPool()
        .query(
          "INSERT INTO payable_adjustments(payable_id,delta_minor,reason,created_by) VALUES($1,-1,'Synthetic invalid source',$2)",
          [posted.payableId, admin.username],
        ),
    ).rejects.toThrow("exact immutable invoice");
    await expect(
      db
        .getPool()
        .query("UPDATE payables SET amount_minor=1 WHERE id=$1", [
          posted.payableId,
        ]),
    ).rejects.toThrow("Inventory-linked payable");
    expect(await counts()).toEqual(before);
  });
  it("mandatory audit failure rolls back payable, linkage, revision adoption and operation result", async () => {
    const invoice = await fixture(),
      before = await counts();
    await db
      .getPool()
      .query(
        `CREATE OR REPLACE FUNCTION synthetic_supplier_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_invoice' AND NEW.entity_id='${invoice.id}' THEN RAISE EXCEPTION 'synthetic supplier audit failure'; END IF; RETURN NEW; END $$`,
      );
    await db
      .getPool()
      .query(
        "CREATE TRIGGER synthetic_supplier_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_supplier_audit_fail()",
      );
    try {
      await expect(post(invoice)).rejects.toThrow(
        "synthetic supplier audit failure",
      );
      expect(await counts()).toEqual(before);
      expect(
        (
          await db
            .getPool()
            .query(
              "SELECT * FROM supplier_invoice_finance_roots WHERE invoice_id=$1",
              [invoice.id],
            )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await db
        .getPool()
        .query("DROP TRIGGER synthetic_supplier_audit_fail ON audit_log");
    }
  });
  it("refuses missing proposal and autocommit without provisioning or business writes", async () => {
    const invoice = await fixture(),
      before = await counts(),
      client = await db.getPool().connect();
    try {
      await expect(
        service.post(client, admin, key(), expectation(invoice)),
      ).rejects.toMatchObject({ code: "transaction_required" });
    } finally {
      client.release();
    }
    await expect(
      tx(async (c) => {
        await c.query(
          "ALTER TABLE supplier_invoice_cancellations RENAME TO synthetic_hidden_cancellations",
        );
        return service.post(c, admin, key(), expectation(invoice));
      }),
    ).rejects.toMatchObject({ code: "schema_not_ready" });
    expect(await counts()).toEqual(before);
  });
  it("refuses deactivated actor and inactive supplier but permits authorized cancellation after supplier deactivation", async () => {
    const invoice = await fixture(),
      before = await counts();
    await db
      .getPool()
      .query("UPDATE users SET is_active=FALSE WHERE id=$1", [admin.userId]);
    try {
      await expect(post(invoice)).rejects.toMatchObject({
        code: "actor_forbidden",
      });
    } finally {
      await db
        .getPool()
        .query("UPDATE users SET is_active=TRUE WHERE id=$1", [admin.userId]);
    }
    await db
      .getPool()
      .query("UPDATE parties SET is_active=FALSE WHERE id=$1", [
        invoice.supplierPartyId,
      ]);
    try {
      await expect(post(invoice)).rejects.toMatchObject({
        code: "supplier_unavailable",
      });
      expect(await counts()).toEqual(before);
    } finally {
      await db
        .getPool()
        .query("UPDATE parties SET is_active=TRUE WHERE id=$1", [
          invoice.supplierPartyId,
        ]);
    }
    await post(invoice);
    await db
      .getPool()
      .query("UPDATE parties SET is_active=FALSE WHERE id=$1", [
        invoice.supplierPartyId,
      ]);
    expect((await cancel(invoice)).status).toBe("cancelled");
  });
  it("binds persisted invoice ownership to realm and prevents cross-actor duplicate debt", async () => {
    const invoice = await fixture(),
      before = await counts(),
      name = `SYN-SFIN-${key()}`;
    const other = {
      username: name,
      role: "admin",
      userId: (
        await db
          .getPool()
          .query(
            "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled','admin') RETURNING id",
            [name],
          )
      ).rows[0].id,
    };
    const results = await Promise.all([
      post(invoice),
      tx((c) => service.post(c, other, key(), expectation(invoice))),
    ]);
    expect(results[0].payableId).toBe(results[1].payableId);
    expect((await counts()).debt).toBe(before.debt + 1);
    const otherRealm = createSupplierInvoiceFinanceService({
      resolvePrincipal: async (actor) => ({
        realmId: "different-authoritative-realm",
        subjectId: `synthetic:${actor.userId}`,
        actorUserId: actor.userId,
        username: actor.username,
      }),
    });
    await expect(
      tx((c) => otherRealm.cancel(c, admin, key(), expectation(invoice))),
    ).rejects.toMatchObject({ code: "principal_realm_mismatch" });
  });
  it("serializes revision against posting without posting a stale source", async () => {
    const invoice = await fixture(),
      revised = { ...invoice, version: 2 };
    const results = await Promise.allSettled([
      post(invoice),
      tx((c) =>
        service.revise(c, admin, key(), {
          ...expectation(invoice),
          document: revised,
        }),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(["stale_version", "invoice_already_posted"]).toContain(
      rejected.reason.code,
    );
  });
  it("includes allocated payment settlement and explicit allocation reversal", async () => {
    const invoice = await fixture(),
      posted = await post(invoice);
    const paid = await tx(async (c) => {
      const result = await db.recordExpenseInTx(
        c,
        {
          category: "supplier",
          partyId: invoice.supplierPartyId,
          payeeText: null,
          amountMinor: 100,
          currency: "SAR",
          baseCurrency: "YER",
          exchangeRate: 123.456789,
          payableId: null,
          note: "Synthetic allocated payment",
          createdBy: admin.username,
        },
        { YER: 1, SAR: 123.456789 },
      );
      expect(result.id).not.toBeNull();
      await c.query("SELECT id FROM payables WHERE id=$1 FOR UPDATE", [
        posted.payableId,
      ]);
      await c.query(
        "INSERT INTO expense_payable_allocations(expense_id,payable_id,paid_minor,payable_currency,payable_exchange_rate,settled_minor) VALUES($1,$2,100,'SAR',123.456789,100)",
        [result.id, posted.payableId],
      );
      return result;
    });
    await expect(cancel(invoice)).rejects.toMatchObject({
      code: "invoice_payment_reversal_required",
    });
    expect(
      (
        await tx((c) =>
          db.voidExpenseInTx(c, paid.id!, {
            actor: admin.username,
            reason: "Synthetic allocated reversal",
          }),
        )
      ).ok,
    ).toBe(true);
    await cancel(invoice);
    expect(
      (await db.partyDueByCurrency()).find(
        (row) => row.partyId === invoice.supplierPartyId,
      )?.dueMinor ?? 0,
    ).toBe(0);
  });
  it("waits for an overlapping payment void and then cancels its net-zero payable", async () => {
    const invoice = await fixture(),
      posted = await post(invoice),
      paid = await payment(invoice, posted.payableId),
      client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      expect(
        (
          await db.voidExpenseInTx(client, paid.id!, {
            actor: admin.username,
            reason: "Synthetic overlapping reversal",
          })
        ).ok,
      ).toBe(true);
      let reached!: () => void;
      const barrier = new Promise<void>((resolve) => {
        reached = resolve;
      });
      // The reversal's foreign-key locks can fence the party even though the
      // unchanged void writer does not explicitly request a party FOR UPDATE.
      const pending = tx((c) =>
        service.cancel(
          {
            async query<T>(
              sql: string,
              values?: Parameters<DbClient["query"]>[1],
            ) {
              if (sql === "SELECT id FROM parties WHERE id=$1 FOR UPDATE")
                reached();
              return c.query<T>(sql, values);
            },
            release() {
              throw new Error("Caller-owned connection");
            },
          },
          admin,
          key(),
          expectation(invoice),
        ),
      );
      await barrier;
      await client.query("COMMIT");
      expect((await pending).status).toBe("cancelled");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await cancel(invoice);
  });
  it("cancellation audit failure rolls back the adjustment and terminal state", async () => {
    const invoice = await fixture();
    await post(invoice);
    const before = await counts();
    await db
      .getPool()
      .query(
        `CREATE OR REPLACE FUNCTION synthetic_supplier_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_invoice' AND NEW.entity_id='${invoice.id}' THEN RAISE EXCEPTION 'synthetic supplier audit failure'; END IF; RETURN NEW; END $$`,
      );
    await db
      .getPool()
      .query(
        "CREATE TRIGGER synthetic_supplier_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_supplier_audit_fail()",
      );
    try {
      await expect(cancel(invoice)).rejects.toThrow(
        "synthetic supplier audit failure",
      );
      expect(await counts()).toEqual(before);
      expect(
        (
          await db
            .getPool()
            .query(
              "SELECT * FROM supplier_invoice_cancellations WHERE invoice_id=$1",
              [invoice.id],
            )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await db
        .getPool()
        .query("DROP TRIGGER synthetic_supplier_audit_fail ON audit_log");
    }
    await cancel(invoice);
  });
});
