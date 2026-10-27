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
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { createPatientConsumptionCostReader } from "../../lib/inventory-domain/patient-consumption-cost";
const custody = await import("../../lib/inventory-domain/custody-store");
let doctorParty: number;
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
  await db.getPool().query(INVENTORY_CUSTODY_SQL);
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
  doctorParty = (
    await db
      .getPool()
      .query(
        "INSERT INTO parties(name,kind) VALUES('SYN-COST-DOCTOR','doctor') RETURNING id",
      )
  ).rows[0].id;
  await db
    .getPool()
    .query("UPDATE users SET party_id=$1 WHERE id=$2", [
      doctorParty,
      doctor.userId,
    ]);
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
async function fixture(
  currency: Currency = "SAR",
  missingValuation = false,
  amountMinor = 20000,
  quantity = "2",
  rateOverride?: string,
  approvalAmount = amountMinor,
  approvedQuantity = quantity,
  receiptQuantities = [quantity],
) {
  const supplierId = (
    await db
      .getPool()
      .query(
        "INSERT INTO parties(name,kind) VALUES($1,'supplier') RETURNING id",
        [`SYN-SFIN-${key()}`],
      )
  ).rows[0].id;
  const rate = rateOverride ?? (currency === "YER" ? "1" : "123.456789"),
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
    value: { currency, amountMinor: approvalAmount },
    lines: [{ id: key(), itemId, quantity: approvedQuantity, conversion }],
  };
  await store.submitPurchaseRequest(doctor, key(), r);
  await store.approvePurchaseRequest(admin, key(), {
    requestId: r.id,
    version: 1,
    decisions: [
      {
        lineId: r.lines[0].id,
        quantity: approvedQuantity,
        reason: "Synthetic approval",
      },
    ],
    valuation: valuationSnapshot({
      purpose: "approval_estimate",
      currency,
      amountMinor: approvalAmount,
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
        quantity,
        conversion,
        price: {
          state: "known",
          currency,
          unitPriceMinor: amountMinor / Number(quantity),
          reason: "Synthetic quote",
        },
        trackLot: true,
        requiresExpiry: true,
        minimumShelfLifeDays: 0,
        sources: [
          {
            id: key(),
            requestId: r.id,
            requestLineId: r.lines[0].id,
            baseQuantity: quantity,
          },
        ],
      },
    ],
  };
  await store.issuePurchaseOrder(admin, key(), o);
  const receiptLines = receiptQuantities.map((quantity) => ({
    id: key(),
    quantity,
  }));
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
        arrivedQuantity: quantity,
        portions: receiptLines.map((portion) => ({
          ...portion,
          disposition: "accepted" as const,
          lotCode: "SYN-COST",
          expiryDate: "2027-11-01",
          locationId: location,
          damaged: false,
          reason: "Synthetic inspection",
        })),
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
          amountMinor,
          rateToBase: rate,
          capturedAt: "2026-10-26T01:00:00Z",
          sourceRef: "Synthetic invoice FX",
        }),
    lines: [
      {
        id: lineId,
        orderLineId: o.lines[0].id,
        quantity,
        price: o.lines[0].price,
        receiptAllocations: receiptLines.map((portion) => ({
          id: key(),
          invoiceLineId: lineId,
          receiptLineId: portion.id,
          baseQuantity: portion.quantity,
        })),
      },
    ],
  };
  await store.recordSupplierInvoiceMatch(admin, key(), invoice);
  return invoice;
}
async function counts() {
  const result: Record<string, string> = {};
  for (const table of [
    "payables",
    "payable_adjustments",
    "expenses",
    "inventory_movements",
    "inventory_movement_allocations",
    "custody_usage_events",
    "inventory_operations",
    "audit_log",
  ]) {
    result[table] = (
      await db
        .getPool()
        .query(
          `SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash FROM ${table} t`,
        )
    ).rows[0].hash;
  }
  return result;
}

const principal = async (actor: InventoryActor) => ({
  realmId: "synthetic-supplier-realm",
  subjectId: `synthetic:${actor.userId}`,
  actorUserId: actor.userId,
  username: actor.username,
});
const reader = createPatientConsumptionCostReader({
  resolvePrincipal: principal,
  authorizeRead: async (_c, p, _a, patientId) => ({
    patientId,
    realmId: p.realmId,
    subjectId: p.subjectId,
  }),
});
async function patient() {
  return String(
    (
      await db
        .getPool()
        .query(
          "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-COST-' || nextval('patient_number_seq'),'SYN-COST-PATIENT',$1) RETURNING id",
          [doctorParty],
        )
    ).rows[0].id,
  );
}
async function read(patientId: string, impl = reader, actor = doctor) {
  const c = await db.getPool().connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await impl(c, actor, patientId);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function consume(
  invoice: SupplierInvoiceRevision,
  quantities = ["1"],
  patientId?: string,
  allocationIndex = 0,
) {
  const pid = patientId ?? (await patient()),
    receipt =
      invoice.lines[0].receiptAllocations[allocationIndex].receiptLineId;
  const lot = (
    await db
      .getPool()
      .query("SELECT id FROM stock_lots WHERE receipt_line_id=$1", [receipt])
  ).rows[0].id as string;
  const destination = key(),
    transit = key();
  await db
    .getPool()
    .query(
      "INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,'clinic','Synthetic custody','custody',$3),($2,'clinic','Synthetic transit','transit',NULL)",
      [destination, transit, doctorParty],
    );
  const t = {
    id: key(),
    fromLocationId: location,
    toLocationId: destination,
    transitLocationId: transit,
    reason: "Synthetic consumption provenance",
    lines: [
      {
        id: key(),
        lotId: lot,
        quantity:
          invoice.lines[0].receiptAllocations[allocationIndex].baseQuantity,
      },
    ],
  };
  await custody.dispatchCustodyTransfer(admin, key(), t);
  await custody.acknowledgeCustodyTransfer(doctor, key(), {
    id: key(),
    transferId: t.id,
    reason: "Synthetic custody count",
    lines: [
      {
        lineId: t.lines[0].id,
        acceptedQuantity: t.lines[0].quantity,
        returnedQuantity: "0",
      },
    ],
  });
  const ids: string[] = [];
  for (const quantity of quantities) {
    const id = key();
    await custody.recordCustodyUsage(doctor, key(), {
      id,
      usageKey: id,
      kind: "consumed",
      locationId: destination,
      lotId: lot,
      quantity,
      quantityState: "confirmed",
      patientId: pid,
      reason: "Synthetic evidenced patient consumption",
    });
    ids.push(id);
  }
  return { patientId: pid, lot, ids, destination };
}
describe("prepared patient consumption costs", () => {
  it("reads evidenced patient-only consumption without writes or invented doctor/visit/completeness", async () => {
    const invoice = await fixture();
    await post(invoice);
    const f = await consume(invoice);
    const before = await counts();
    const result = await read(f.patientId);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      clinicalAttribution: "verified",
      visitId: null,
      doctorId: null,
      doctorAttribution: "missing",
      native: {
        state: "known",
        currency: "SAR",
        amountMinor: 20000,
        pricedQuantityAtoms: 2000,
      },
      roundedNativeMinor: 10000,
      invoiceIds: [invoice.id],
    });
    expect(result.base).toMatchObject({
      knownMinor: 12346,
      totalMinor: null,
      completeness: "missing",
    });
    expect(result.registration.state).toBe("unproven");
    expect(await counts()).toEqual(before);
  });
  it("rounds the scope once, conserves the frozen base and keeps native currencies separate", async () => {
    const a = await fixture("SAR", false, 3, "3", "133.333333");
    await post(a);
    const f = await consume(a, ["1", "1", "1"]);
    const b = await fixture("USD", false, 10, "2", "200");
    await post(b);
    await consume(b, ["1"], f.patientId);
    const r = await read(f.patientId);
    expect(r.native.map((x) => [x.currency, x.knownMinor])).toEqual([
      ["SAR", 3],
      ["USD", 5],
    ]);
    expect(r.base.knownMinor).toBe(14);
    expect(
      r.rows
        .filter((x) => x.native?.currency === "SAR")
        .reduce((n, x) => n + x.roundedBaseMinor!, 0),
    ).toBe(3);
  });
  it("cancelled invoices invalidate final valuation without removing consumption or manufacturing zero cost", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i);
    await cancel(i);
    const before = await counts();
    const r = await read(f.patientId);
    expect(r.rows[0]).toMatchObject({
      clinicalAttribution: "verified",
      base: { state: "missing" },
      reason: "invoice_cancelled",
      roundedBaseMinor: null,
    });
    expect(r.base.totalMinor).toBeNull();
    expect(await counts()).toEqual(before);
  });
  it("unposted matching evidence is missing final cost", async () => {
    const i = await fixture();
    const f = await consume(i);
    expect((await read(f.patientId)).rows[0]).toMatchObject({
      base: { state: "missing" },
      reason: "invoice_unposted",
    });
  });
  it("an explicit approved quote stays an estimate when no final allocation exists", async () => {
    const i = await fixture("SAR", true);
    const f = await consume(i);
    const r = await read(f.patientId);
    expect(r.rows[0]).toMatchObject({
      native: { state: "estimated", currency: "SAR" },
      base: { state: "missing" },
      roundedNativeMinor: 10000,
    });
    expect(r.native[0]).toMatchObject({
      knownMinor: 0,
      estimatedMinor: 10000,
      totalMinor: null,
    });
  });
  it("partial billing cannot value the full lot", async () => {
    const i = await fixture();
    const f = await consume(i);
    const revision = {
      ...i,
      version: 2,
      lines: i.lines.map((l) => ({
        ...l,
        quantity: "1",
        receiptAllocations: l.receiptAllocations.map((a) => ({
          ...a,
          baseQuantity: "1",
        })),
      })),
      valuation: valuationSnapshot({
        purpose: "invoice_valuation",
        currency: i.currency,
        amountMinor: 10000,
        rateToBase: "123.456789",
        capturedAt: "2026-10-26T01:00:00Z",
        sourceRef: "Synthetic partial bill",
      }),
    };
    await tx((c) =>
      service.revise(c, admin, key(), {
        ...expectation(i),
        document: revision,
      }),
    );
    await post(revision);
    expect((await read(f.patientId)).rows[0]).toMatchObject({
      base: { state: "missing" },
      reason: "partial_or_excess_billing",
    });
  });
  it("empty registered patient remains unproven rather than complete zero", async () => {
    const r = await read(await patient());
    expect(r.rows).toEqual([]);
    expect(r.base).toMatchObject({
      knownMinor: 0,
      totalMinor: null,
      completeness: "missing",
    });
  });
  it("requires canonical read grants and the production principal resolver remains closed", async () => {
    const p = await patient();
    await expect(
      read(p, createPatientConsumptionCostReader()),
    ).rejects.toMatchObject({ code: "principal_realm_unavailable" });
    await expect(
      read(
        p,
        createPatientConsumptionCostReader({
          resolvePrincipal: principal,
          authorizeRead: async () => null,
        }),
        admin,
      ),
    ).rejects.toMatchObject({ code: "cost_read_forbidden" });
    await expect(
      read(
        p,
        createPatientConsumptionCostReader({
          resolvePrincipal: principal,
          authorizeRead: async () => ({
            patientId: p,
            realmId: "wrong",
            subjectId: "wrong",
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "cost_read_forbidden" });
  });
  it("refuses autocommit, weak snapshots, writable transactions and inactive actors", async () => {
    const p = await patient(),
      c = await db.getPool().connect();
    try {
      await expect(reader(c, doctor, p)).rejects.toMatchObject({
        code: "transaction_required",
      });
      for (const begin of [
        "BEGIN READ ONLY",
        "BEGIN ISOLATION LEVEL REPEATABLE READ",
      ]) {
        await c.query(begin);
        await expect(reader(c, doctor, p)).rejects.toMatchObject({
          code: "read_snapshot_required",
        });
        await c.query("ROLLBACK");
      }
      await db
        .getPool()
        .query("UPDATE users SET is_active=FALSE WHERE id=$1", [doctor.userId]);
      await expect(read(p)).rejects.toMatchObject({ code: "actor_forbidden" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await db
        .getPool()
        .query("UPDATE users SET is_active=TRUE WHERE id=$1", [doctor.userId]);
    }
  });
  it("keeps an established snapshot coherent across a concurrent cancellation", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i),
      c = await db.getPool().connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const before = await reader(c, doctor, f.patientId);
      await cancel(i);
      expect(await reader(c, doctor, f.patientId)).toEqual(before);
      await c.query("COMMIT");
      expect((await read(f.patientId)).rows[0].base.state).toBe("missing");
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
  it("current expiry does not erase valid historical consumption", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i);
    const before = await read(f.patientId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2028-01-01T00:00:00Z"));
    try {
      const after = await read(f.patientId);
      expect(after.rows).toEqual(before.rows);
      expect(after.base).toEqual(before.base);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a valid later order amendment cannot reprice the historic posted invoice", async () => {
    const i = await fixture("SAR", false, 20000, "2", undefined, 60000, "3");
    await post(i);
    const f = await consume(i);
    const before = await read(f.patientId);
    const order = (
      await db
        .getPool()
        .query("SELECT document FROM purchase_orders WHERE id=$1", [i.orderId])
    ).rows[0].document;
    await store.amendPurchaseOrder(admin, key(), {
      order: {
        ...order,
        version: 2,
        lines: order.lines.map((l: PurchaseOrder["lines"][number]) => ({
          ...l,
          quantity: "3",
          sources: [
            ...l.sources,
            {
              id: key(),
              requestId: l.sources[0].requestId,
              requestLineId: l.sources[0].requestLineId,
              baseQuantity: "1",
            },
          ],
          price: { ...l.price, unitPriceMinor: 15000 },
        })),
      },
      reason: "Synthetic later negotiated price",
    });
    expect((await read(f.patientId)).rows).toEqual(before.rows);
  });
  it("current item unit labels cannot relabel immutable consumed quantities", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i);
    const before = await read(f.patientId);
    await db
      .getPool()
      .query("UPDATE inventory_items SET unit='later label' WHERE id=$1", [
        itemId,
      ]);
    try {
      expect((await read(f.patientId)).rows).toEqual(before.rows);
    } finally {
      await db
        .getPool()
        .query("UPDATE inventory_items SET unit='piece' WHERE id=$1", [itemId]);
    }
  });

  it("duplicate consumption movement evidence cannot be counted twice", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i);
    const r = await corruptedRead(f.patientId, (c) => cloneUsage(c, f.ids[0]));
    expect(r.rows).toHaveLength(2);
    expect(
      r.rows.every((x) => x.reason === "duplicate_consumption_movement"),
    ).toBe(true);
    expect(r.base.knownMinor).toBe(0);
    expect(r.base.totalMinor).toBeNull();
  });
  it("column/document patient disagreement is redacted, including other clinical references", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i),
      other = await patient();
    const r = await corruptedRead(other, (c) =>
      cloneUsage(c, f.ids[0], {
        patient_id: other,
        document: { patientId: f.patientId, visitId: "987654321" },
      }),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      patientId: other,
      visitId: null,
      caseId: null,
      procedureId: null,
      lotId: null,
      movementId: null,
      clinicalAttribution: "missing",
      reason: "clinical_evidence_mismatch",
    });
    expect(JSON.stringify(r)).not.toContain("987654321");
    expect(r.base.knownMinor).toBe(0);
  });
  it("a usage document with a mismatched quantity cannot create a known subtotal", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i),
      other = await patient();
    const r = await corruptedRead(other, (c) =>
      cloneUsage(c, f.ids[0], {
        patient_id: other,
        newMovement: true,
        document: { patientId: other, baseQuantity: "2" },
      }),
    );
    expect(r.rows[0].reason).toBe("consumption_document_mismatch");
    expect(r.rows[0].base.state).toBe("missing");
    expect(r.base.knownMinor).toBe(0);
  });
  it("a consumed event cannot exceed the original received lot", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i),
      other = await patient();
    const r = await corruptedRead(other, (c) =>
      cloneUsage(c, f.ids[0], {
        patient_id: other,
        newMovement: true,
        quantity: "3",
        document: { patientId: other, baseQuantity: "3" },
      }),
    );
    expect(r.rows[0].reason).toBe("consumption_exceeds_receipt");
    expect(r.base.knownMinor).toBe(0);
  });
  it("missing coordinated schema and disabled gate fail closed", async () => {
    const p = await patient();
    const absent = createPatientConsumptionCostReader({
      resolvePrincipal: principal,
      authorizeRead: async (c, principal, _a, patientId) => {
        await c.query("SET LOCAL search_path=pg_catalog");
        return {
          patientId,
          realmId: principal.realmId,
          subjectId: principal.subjectId,
        };
      },
    });
    await expect(read(p, absent)).rejects.toMatchObject({
      code: "schema_not_ready",
    });
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "false");
    try {
      await expect(read(p)).rejects.toMatchObject({
        code: "inventory_integration_disabled",
      });
    } finally {
      vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    }
  });

  it("bounded results fail instead of truncating patient totals", async () => {
    const i = await fixture();
    const f = await consume(i);
    await expect(
      corruptedRead(f.patientId, (c) =>
        c.query(
          "INSERT INTO custody_usage_events(id,usage_key,location_id,lot_id,movement_id,kind,qty,quantity_state,patient_id,reason,cost_snapshot,document,created_by) SELECT gen_random_uuid(),gen_random_uuid()::text,location_id,lot_id,movement_id,kind,qty,quantity_state,patient_id,reason,cost_snapshot,document,created_by FROM custody_usage_events CROSS JOIN generate_series(1,1000) WHERE id=$1",
          [f.ids[0]],
        ),
      ),
    ).rejects.toMatchObject({ code: "cost_report_too_large" });
  });

  it("conserves one frozen invoice across two accepted receipt lots", async () => {
    const i = await fixture("SAR", false, 3, "3", "133.333333", 3, "3", [
      "1",
      "2",
    ]);
    await post(i);
    const f = await consume(i, ["1"]);
    await consume(i, ["2"], f.patientId, 1);
    const r = await read(f.patientId);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => x.native?.state)).toEqual(["known", "known"]);
    expect(r.native[0].knownMinor).toBe(3);
    expect(r.base.knownMinor).toBe(4);
    expect(r.rows.reduce((n, x) => n + x.roundedBaseMinor!, 0)).toBe(4);
    expect(new Set(r.rows.map((x) => x.base.recordedAt)).size).toBe(1);
  });
  it("purchase, custody transfer, unused return and approved waste create no patient material cost", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i, []);
    await custody.recordCustodyUsage(doctor, key(), {
      id: key(),
      kind: "returned_to_store",
      locationId: f.destination,
      storeLocationId: location,
      lotId: f.lot,
      quantity: "1",
      reason: "Synthetic unused return",
    });
    const approvalId = key();
    await custody.approveCustodyWaste(admin, key(), {
      id: approvalId,
      locationId: f.destination,
      lotId: f.lot,
      maxQuantity: "1",
      reason: "Synthetic authorized waste",
    });
    await custody.recordCustodyUsage(doctor, key(), {
      id: key(),
      kind: "approved_waste",
      locationId: f.destination,
      lotId: f.lot,
      quantity: "1",
      wasteApprovalId: approvalId,
      reason: "Synthetic waste",
    });
    const r = await read(f.patientId);
    expect(r.rows).toEqual([]);
    expect(r.base).toMatchObject({ knownMinor: 0, totalMinor: null });
  });
  it("verified visit relation is checked and historical doctor is never inferred", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i, []);
    const visit = String(
      (
        await db
          .getPool()
          .query(
            "INSERT INTO visits(patient_name,patient_id,doctor_id) VALUES('SYN-COST',$1,$2) RETURNING id",
            [f.patientId, doctorParty],
          )
      ).rows[0].id,
    );
    await custody.recordCustodyUsage(doctor, key(), {
      id: key(),
      kind: "consumed",
      locationId: f.destination,
      lotId: f.lot,
      quantity: "1",
      patientId: f.patientId,
      visitId: visit,
      reason: "Synthetic linked actual usage",
    });
    const r = await read(f.patientId);
    expect(r.rows[0]).toMatchObject({
      visitId: visit,
      clinicalAttribution: "verified",
      doctorId: null,
      native: { state: "known" },
    });
  });
  it("invoice realm provenance is required even with a valid patient read grant", async () => {
    const i = await fixture();
    await post(i);
    const f = await consume(i);
    const alternate = createPatientConsumptionCostReader({
      resolvePrincipal: async (a) => ({
        ...(await principal(a)),
        realmId: "other-trusted-test-realm",
      }),
      authorizeRead: async (_c, p, _a, patientId) => ({
        patientId,
        realmId: p.realmId,
        subjectId: p.subjectId,
      }),
    });
    const r = await read(f.patientId, alternate);
    expect(r.rows[0]).toMatchObject({
      base: { state: "missing" },
      reason: "invoice_realm_unproven",
    });
    expect(r.base.knownMinor).toBe(0);
  });
});

// Legacy/corrupt evidence is rolled back. The reader starts only after the transaction is read-only.
async function corruptedRead(
  patientId: string,
  seed: (c: DbClient) => Promise<unknown>,
) {
  const c = await db.getPool().connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await seed(c);
    await c.query("SET TRANSACTION READ ONLY");
    return await reader(c, doctor, patientId);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
async function cloneUsage(
  c: DbClient,
  id: string,
  overrides: {
    patient_id?: string;
    document?: Record<string, unknown>;
    newMovement?: boolean;
    quantity?: string;
  } = {},
) {
  const source = (
      await c.query("SELECT * FROM custody_usage_events WHERE id=$1", [id])
    ).rows[0],
    next = key();
  if (overrides.newMovement) {
    source.movement_id = (
      await c.query(
        "INSERT INTO inventory_movements(item_id,kind,qty,created_by,is_return) VALUES($1,'out',$2,$3,FALSE) RETURNING id",
        [itemId, overrides.quantity ?? source.qty, doctor.username],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,$5)",
      [
        key(),
        source.movement_id,
        source.lot_id,
        source.location_id,
        overrides.quantity ?? source.qty,
      ],
    );
  }
  source.qty = overrides.quantity ?? source.qty;
  const document = {
    ...source.document,
    id: next,
    usageKey: next,
    ...overrides.document,
  };
  await c.query(
    "INSERT INTO custody_usage_events(id,usage_key,location_id,lot_id,movement_id,kind,qty,quantity_state,patient_id,reason,cost_snapshot,document,created_by) VALUES($1::uuid,$1::text,$2,$3,$4,'consumed',$5,'confirmed',$6,'Synthetic inconsistent legacy evidence',$7,$8,$9)",
    [
      next,
      source.location_id,
      source.lot_id,
      source.movement_id,
      source.qty,
      overrides.patient_id ?? source.patient_id,
      source.cost_snapshot,
      document,
      doctor.userId,
    ],
  );
  return next;
}
