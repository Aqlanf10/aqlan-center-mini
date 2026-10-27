vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { withTransaction } from "../../lib/transactions";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import {
  supplierInvoiceDigest,
  createSupplierInvoiceFinanceService,
  supplierFinanceCommandScope,
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
async function admitSupplierIntent(
  ...args: Parameters<typeof attemptSupplierIntent>
) {
  const result = await attemptSupplierIntent(...args);
  if ("status" in result)
    throw new Error(`Unexpected admission rejection: ${result.code}`);
  return result;
}
const key = () => randomUUID();
const tx = <T>(work: (client: DbClient) => Promise<T>) =>
  withTransaction(db.getPool(), work);
const expectation = (invoice: SupplierInvoiceRevision) => ({
  invoiceId: invoice.id,
  expectedVersion: invoice.version,
  expectedDigest: supplierInvoiceDigest(invoice),
  reason: "Synthetic reviewed supplier source",
});
import { STAFF_AUTHORITY_SQL } from "../../lib/staff-authority-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { INVENTORY_SUPPLIER_TRANSPORT_SQL } from "../../lib/inventory-domain/supplier-transport-schema-proposal";
import {
  bootstrapStaffIdentityInTransaction,
  rotateStaffExecutionEpochInTransaction,
  readStaffIdentityClaims,
} from "../../lib/staff-authenticated-identity";
import {
  admitSupplierIntent as attemptSupplierIntent,
  executeSupplierIntent,
  readSupplierFinance,
} from "../../lib/inventory-domain/supplier-transport";
import {
  sessionCredentialVersion,
  createSessionToken,
  readSessionToken,
  type SessionPayload,
} from "../../lib/auth";
import {
  SUPPLIER_PROTOCOL,
  type SupplierIntent,
  type SupplierAction,
} from "../../lib/inventory-supplier-protocol";
let signed: SessionPayload;
beforeAll(async () => {
  vi.stubEnv(
    "SESSION_SECRET",
    "synthetic-inventory-operational-test-secret-2026",
  );
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  await db.ensureSchema();
  await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
  await db.getPool().query(INVENTORY_SUPPLIER_FINANCE_SQL);
  await db.getPool().query(INVENTORY_COMMAND_LIFECYCLE_SQL);
  await db.getPool().query(STAFF_AUTHORITY_SQL);
  await db.getPool().query(INVENTORY_SUPPLIER_TRANSPORT_SQL);
  await tx((c) =>
    bootstrapStaffIdentityInTransaction(
      c,
      "Synthetic operational supplier bootstrap",
    ),
  );
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
  signed = await signedSession(admin);
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
async function signedSession(actor: InventoryActor) {
  const row = (
    await db
      .getPool()
      .query("SELECT password_hash FROM users WHERE id=$1", [actor.userId])
  ).rows[0];
  return readSessionToken(
    createSessionToken({
      ...actor,
      expiresAt: Date.now() + 3600000,
      credentialVersion: sessionCredentialVersion(row.password_hash),
      authority: await readStaffIdentityClaims(actor.userId),
    }),
  )!;
}
const intentFor = (
  invoice: SupplierInvoiceRevision,
  action: SupplierAction = "post",
  session = signed,
): SupplierIntent => ({
  protocol: SUPPLIER_PROTOCOL,
  authority: session.authority!,
  nonce: key(),
  action,
  input: expectation(invoice),
});
describe("authenticated operational supplier transport", () => {
  it("signed current admin reads source status and posts/cancels canonical debt without duplicate stock", async () => {
    const i = await fixture(),
      before = await counts(),
      intent = intentFor(i);
    const a = await admitSupplierIntent(signed, intent);
    expect(await counts()).toEqual(before);
    const result = await executeSupplierIntent(signed, a);
    expect(result).toMatchObject({
      status: "committed",
      result: { status: "posted", replayed: false },
    });
    expect(await executeSupplierIntent(signed, a)).toMatchObject({
      status: "committed",
      result: { replayed: true },
    });
    const view = await readSupplierFinance(signed, i.orderId);
    expect(view.invoices[0]).toMatchObject({
      status: "posted",
      canPost: false,
      canCancel: true,
      settledMinor: 0,
    });
    expect(view.invoices[0].payableId).toBe(result.result?.payableId);
    const cancellation = await admitSupplierIntent(
      signed,
      intentFor(i, "cancel"),
    );
    await executeSupplierIntent(signed, cancellation);
    expect(
      (await readSupplierFinance(signed, i.orderId)).invoices[0],
    ).toMatchObject({
      status: "cancelled",
      effectiveMinor: 0,
      canCancel: false,
    });
    const after = await counts();
    expect(after.stock).toBe(before.stock);
    expect(after.cash).toBe(before.cash);
    expect(after.debt).toBe(before.debt + 1);
    expect(after.adjustments).toBe(before.adjustments + 1);
  });
  it("lost admission reply returns the exact server key; concurrent nonce replay creates one admission", async () => {
    const i = await fixture(),
      intent = intentFor(i);
    const [a, b] = await Promise.all([
      admitSupplierIntent(signed, intent),
      admitSupplierIntent(signed, intent),
    ]);
    expect(b).toEqual(a);
    expect(a.envelope.operationKey).not.toBe(intent.nonce);
    await expect(
      admitSupplierIntent(signed, {
        ...intent,
        input: { ...intent.input, reason: "Different payload" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const before = await counts();
    await Promise.all([
      executeSupplierIntent(signed, a),
      executeSupplierIntent(signed, b),
    ]);
    expect((await counts()).debt).toBe(before.debt + 1);
  });
  it("revocation is rechecked before committed replay as well as mutation", async () => {
    const i = await fixture(),
      a = await admitSupplierIntent(signed, intentFor(i));
    await executeSupplierIntent(signed, a);
    await db
      .getPool()
      .query("UPDATE users SET is_active=FALSE WHERE id=$1", [admin.userId]);
    try {
      await expect(executeSupplierIntent(signed, a)).rejects.toMatchObject({
        code: "supplier_reauthentication_required",
      });
    } finally {
      await db
        .getPool()
        .query("UPDATE users SET is_active=TRUE WHERE id=$1", [admin.userId]);
    }
  });
  it("legacy sessions cannot be silently adopted; doctors and malformed/canonical profiles never gain supplier management", async () => {
    const i = await fixture();
    await expect(
      admitSupplierIntent({ ...signed, authority: undefined }, intentFor(i)),
    ).rejects.toMatchObject({ code: "supplier_reauthentication_required" });
    const doctorSession = await signedSession(doctor);
    await expect(
      admitSupplierIntent(doctorSession, intentFor(i, "post", doctorSession)),
    ).rejects.toMatchObject({ code: "operation_forbidden" });
    await db
      .getPool()
      .query("UPDATE users SET permissions=$1 WHERE id=$2", [
        JSON.stringify({ schemaVersion: 1 }),
        admin.userId,
      ]);
    try {
      await expect(
        admitSupplierIntent(signed, intentFor(i)),
      ).rejects.toMatchObject({ code: "operation_forbidden" });
    } finally {
      await db
        .getPool()
        .query("UPDATE users SET permissions=NULL WHERE id=$1", [admin.userId]);
    }
  });
  it("stale epoch remains held after reauthentication and does not manufacture a new key", async () => {
    const i = await fixture(),
      intent = intentFor(i),
      a = await admitSupplierIntent(signed, intent);
    await tx((c) =>
      rotateStaffExecutionEpochInTransaction(
        c,
        "Synthetic restore epoch rotation",
      ),
    );
    await expect(executeSupplierIntent(signed, a)).rejects.toMatchObject({
      code: "supplier_reauthentication_required",
    });
    signed = await signedSession(admin);
    await expect(executeSupplierIntent(signed, a)).rejects.toMatchObject({
      code: "supplier_saved_authority_mismatch",
    });
    expect(await admitSupplierIntent(signed, intent)).toEqual(a);
    await expect(
      admitSupplierIntent(signed, { ...intent, nonce: randomUUID() }),
    ).rejects.toMatchObject({ code: "supplier_saved_authority_mismatch" });
    expect(
      (await readSupplierFinance(signed, i.orderId)).invoices[0].status,
    ).toBe("unposted");
  });
  it("audit failure rolls back financial effects while durable admission survives", async () => {
    const i = await fixture(),
      a = await admitSupplierIntent(signed, intentFor(i)),
      before = await counts();
    await db
      .getPool()
      .query(
        "CREATE FUNCTION synthetic_supplier_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_invoice' THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_supplier_audit_refusal BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_supplier_audit_refusal()",
      );
    try {
      await expect(executeSupplierIntent(signed, a)).rejects.toThrow();
      expect(await counts()).toEqual(before);
    } finally {
      await db
        .getPool()
        .query(
          "DROP TRIGGER synthetic_supplier_audit_refusal ON audit_log; DROP FUNCTION synthetic_supplier_audit_refusal()",
        );
    }
    expect(await attemptSupplierIntent(signed, intentFor(i))).toMatchObject({
      status: "rejected",
    });
    await executeSupplierIntent(signed, a);
    expect((await counts()).debt).toBe(before.debt + 1);
  });
  it("retirement cannot cancel committed success; unexecuted retired commands are fenced", async () => {
    const i = await fixture(),
      a = await admitSupplierIntent(signed, intentFor(i));
    const stopped = await executeSupplierIntent(
      signed,
      a,
      "Synthetic explicit stop before execution",
    );
    expect(stopped.status).toBe("retired");
    expect(await executeSupplierIntent(signed, a)).toMatchObject({
      status: "retired",
      digest: a.digest,
    });
    const b = await admitSupplierIntent(signed, intentFor(i));
    await executeSupplierIntent(signed, b);
    expect(
      await executeSupplierIntent(
        signed,
        b,
        "Synthetic lost reply stop request",
      ),
    ).toMatchObject({ status: "committed", result: { replayed: true } });
  });
  it("preposting revision is visible and its exact digest is required for posting", async () => {
    const i = await fixture(),
      revision = { ...i, version: 2 };
    const intent = intentFor(i, "revise");
    intent.input.document = revision;
    await executeSupplierIntent(
      signed,
      await admitSupplierIntent(signed, intent),
    );
    const view = await readSupplierFinance(signed, i.orderId);
    expect(view.invoices[0].version).toBe(2);
    const stale = await admitSupplierIntent(signed, intentFor(i));
    await expect(executeSupplierIntent(signed, stale)).rejects.toMatchObject({
      code: "stale_version",
    });
    await executeSupplierIntent(
      signed,
      stale,
      "Explicitly retire stale preview before revised intent",
    );
    await executeSupplierIntent(
      signed,
      await admitSupplierIntent(signed, intentFor(revision)),
    );
  });
  it("admission envelope edits and cross-actor use cannot replay or mutate", async () => {
    const i = await fixture(),
      a = await admitSupplierIntent(signed, intentFor(i)),
      before = await counts();
    await expect(
      executeSupplierIntent(signed, {
        ...a,
        envelope: {
          ...a.envelope,
          input: { ...a.envelope.input, reason: "Tampered reason" },
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const username = `SYN-OTHER-${key()}`,
      id = (
        await db
          .getPool()
          .query(
            "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled','admin') RETURNING id",
            [username],
          )
      ).rows[0].id;
    const other = await signedSession({ userId: id, username, role: "admin" });
    await expect(executeSupplierIntent(other, a)).rejects.toMatchObject({
      code: "supplier_saved_authority_mismatch",
    });
    expect(await counts()).toEqual(before);
  });
  it("fresh session recovers old-epoch committed and retired acknowledgements without executing pending intent", async () => {
    const committed = await admitSupplierIntent(
      signed,
      intentFor(await fixture()),
    );
    const result = await executeSupplierIntent(signed, committed);
    const retired = await admitSupplierIntent(
      signed,
      intentFor(await fixture()),
    );
    await executeSupplierIntent(signed, retired, "Explicit synthetic stop");
    await tx((c) =>
      rotateStaffExecutionEpochInTransaction(
        c,
        "Synthetic historical recovery",
      ),
    );
    signed = await signedSession(admin);
    const recovered = await admitSupplierIntent(
      signed,
      (() => {
        const { operationKey, actorUserId, username, ...intent } =
          committed.envelope;
        return intent;
      })(),
    );
    expect(recovered).toEqual(committed);
    const replay = await executeSupplierIntent(signed, recovered);
    expect(replay.status).toBe("committed");
    expect(replay.result).toMatchObject({ ...result.result!, replayed: true });
    expect(await executeSupplierIntent(signed, retired)).toMatchObject({
      status: "retired",
      reason: "Explicit synthetic stop",
      digest: retired.digest,
    });
  });
  it("permission revocation committed ahead of the live user lock refuses pending execution", async () => {
    const f = await fixture(),
      a = await admitSupplierIntent(signed, intentFor(f)),
      c = await db.getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE users SET is_active=FALSE WHERE id=$1", [
        admin.userId,
      ]);
      const result = executeSupplierIntent(signed, a).then(
        () => ({ code: "unexpected_success" }),
        (e) => e,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      await c.query("COMMIT");
      expect(await result).toMatchObject({
        code: "supplier_reauthentication_required",
      });
      expect(
        (
          await db
            .getPool()
            .query(
              "SELECT 1 FROM supplier_invoice_payable_links WHERE invoice_id=$1",
              [f.id],
            )
        ).rowCount,
      ).toBe(0);
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await db
        .getPool()
        .query("UPDATE users SET is_active=TRUE WHERE id=$1", [admin.userId]);
    }
  });
  it("subject UUID and realm identity cannot mutate", async () => {
    await expect(
      db
        .getPool()
        .query(
          "UPDATE users SET staff_subject_id=gen_random_uuid() WHERE id=$1",
          [admin.userId],
        ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db
        .getPool()
        .query(
          "UPDATE staff_authority_identity SET realm_id=gen_random_uuid() WHERE singleton",
        ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.getPool().query("DELETE FROM staff_execution_epochs"),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("durably rejects another nonce for a pending invoice and recovers a lost refusal unchanged", async () => {
    const f = await fixture(),
      a = await admitSupplierIntent(signed, intentFor(f)),
      other = intentFor(f),
      before = await counts();
    const refused = await attemptSupplierIntent(signed, other);
    expect(refused).toMatchObject({
      status: "rejected",
      intent: other,
      code: "supplier_invoice_intent_pending",
    });
    expect(await attemptSupplierIntent(signed, other)).toEqual(refused);
    expect(await counts()).toEqual(before);
    await expect(
      attemptSupplierIntent(signed, {
        ...other,
        input: { ...other.input, reason: "Changed rejected reason" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await executeSupplierIntent(signed, a);
    expect(await attemptSupplierIntent(signed, other)).toEqual(refused);
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT 1 FROM inventory_supplier_intents WHERE intent_nonce=$1",
            [other.nonce],
          )
      ).rowCount,
    ).toBe(0);
    await expect(
      db
        .getPool()
        .query(
          "UPDATE inventory_supplier_intent_rejections SET reason='changed' WHERE intent_nonce=$1",
          [other.nonce],
        ),
    ).rejects.toMatchObject({ code: "P0001" });
  });
  it("simultaneous different actors receive only one pending admission for the same invoice", async () => {
    const f = await fixture(),
      username = `SYN-OTHER-${key()}`,
      userId = (
        await db
          .getPool()
          .query(
            "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled','admin') RETURNING id",
            [username],
          )
      ).rows[0].id;
    const other = await signedSession({ userId, username, role: "admin" });
    const outcomes = await Promise.all([
      attemptSupplierIntent(signed, intentFor(f)),
      attemptSupplierIntent(other, intentFor(f, "post", other)),
    ]);
    expect(outcomes.filter((x) => "status" in x)).toHaveLength(1);
    expect(outcomes.filter((x) => !("status" in x))).toHaveLength(1);
  });
  it("old-epoch pending invoice blocks a new nonce but permits an independent invoice", async () => {
    const f = await fixture(),
      old = await admitSupplierIntent(signed, intentFor(f));
    await tx((c) =>
      rotateStaffExecutionEpochInTransaction(
        c,
        "Synthetic pending invoice fence",
      ),
    );
    signed = await signedSession(admin);
    expect(await attemptSupplierIntent(signed, intentFor(f))).toMatchObject({
      status: "rejected",
      code: "supplier_invoice_intent_pending",
    });
    await expect(executeSupplierIntent(signed, old)).rejects.toMatchObject({
      code: "supplier_saved_authority_mismatch",
    });
    expect(
      await admitSupplierIntent(signed, intentFor(await fixture())),
    ).toHaveProperty("envelope.operationKey");
  });
  it("admission waits for exact in-flight original lock before deciding absence", async () => {
    const f = await fixture(),
      a = await admitSupplierIntent(signed, intentFor(f)),
      c = await db.getPool().connect();
    const principal = {
      realmId: a.envelope.authority.realmId,
      subjectId: a.envelope.authority.subjectId,
      actorUserId: admin.userId,
      username: admin.username,
    };
    const scope = supplierFinanceCommandScope(principal, "post");
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('inventory-purchase-reset-v1',0))",
      );
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([scope, admin.userId, a.envelope.operationKey]),
      ]);
      let finished = false;
      const pending = attemptSupplierIntent(signed, intentFor(f)).finally(
        () => {
          finished = true;
        },
      );
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        waiting = (
          await db
            .getPool()
            .query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%') AS waiting",
            )
        ).rows[0].waiting;
        if (waiting) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      expect(finished).toBe(false);
      await createSupplierInvoiceFinanceService({
        resolvePrincipal: async () => principal,
        admitted: true,
      }).post(c, admin, a.envelope.operationKey, a.envelope.input);
      await c.query("COMMIT");
      expect(await pending).toHaveProperty("envelope.operationKey");
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
  it("failed rejection audit leaves no terminal proof and retries safely", async () => {
    const f = await fixture();
    await admitSupplierIntent(signed, intentFor(f));
    const other = intentFor(f);
    await db
      .getPool()
      .query(
        "CREATE FUNCTION synthetic_supplier_rejection_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_intent' THEN RAISE EXCEPTION 'synthetic rejection audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_supplier_rejection_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_supplier_rejection_audit()",
      );
    try {
      await expect(attemptSupplierIntent(signed, other)).rejects.toThrow(
        "synthetic rejection audit refusal",
      );
      expect(
        (
          await db
            .getPool()
            .query(
              "SELECT 1 FROM inventory_supplier_intent_rejections WHERE intent_nonce=$1",
              [other.nonce],
            )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db
        .getPool()
        .query(
          "DROP TRIGGER synthetic_supplier_rejection_audit ON audit_log; DROP FUNCTION synthetic_supplier_rejection_audit()",
        );
    }
    expect(await attemptSupplierIntent(signed, other)).toMatchObject({
      status: "rejected",
    });
  });
  it("rejects uppercase UUID lock aliases without rewriting original nonce or invoice identity", async () => {
    const f = await fixture(),
      intent = intentFor(f);
    await expect(
      attemptSupplierIntent(signed, {
        ...intent,
        nonce: intent.nonce.toUpperCase(),
      }),
    ).rejects.toMatchObject({ code: "invalid_document" });
    await expect(
      attemptSupplierIntent(signed, {
        ...intent,
        input: { ...intent.input, invoiceId: f.id.toUpperCase() },
      }),
    ).rejects.toMatchObject({ code: "invalid_document" });
    const admitted = await admitSupplierIntent(signed, intent);
    expect(admitted.envelope.nonce).toBe(intent.nonce);
    expect(await admitSupplierIntent(signed, intent)).toEqual(admitted);
  });
});
