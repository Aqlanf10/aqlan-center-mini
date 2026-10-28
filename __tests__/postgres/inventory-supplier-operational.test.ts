import { INVENTORY_SUPPLIER_NUMBER_SQL } from "../../lib/inventory-domain/supplier-number-schema-proposal";
vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
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
  supplierInvoiceDuplicateKey,
  payloadIdentity,
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
// This suite installs the obsolete parallel authority proposal (STAFF_AUTHORITY_SQL).
// It runs on its own owned database so that footprint never reaches the shared test
// database, where it would hold every later suite's ensureSchema (canonical footprint
// ⇒ no request-time DDL). It stays red until M3a moves supplier admission to the
// canonical runtime (M1_ENTRY_SLICE_DESIGN.md §7).
let owned: Awaited<ReturnType<typeof openBackupTimestampFixture>> | undefined;
beforeAll(async () => {
  owned = await openBackupTimestampFixture({ ...process.env });
  vi.stubEnv("DATABASE_URL", owned.source.options.connectionString!);
  await db.resetPoolForTesting();
  vi.stubEnv(
    "SESSION_SECRET",
    "synthetic-inventory-operational-test-secret-2026",
  );
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  await db.ensureSchema();
  await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
  await db.getPool().query(INVENTORY_SUPPLIER_FINANCE_SQL);
  await db.getPool().query(INVENTORY_SUPPLIER_NUMBER_SQL);
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
  await db.resetPoolForTesting();
  vi.unstubAllEnvs();
  await owned?.close();
});
async function fixture(
  currency: Currency = "SAR",
  missingValuation = false,
  options: {
    missingNumber?: boolean;
    supplierId?: number;
    number?: string;
    skipMatch?: boolean;
  } = {},
) {
  const supplierId =
    options.supplierId ??
    (
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
    invoiceNumber: options.missingNumber
      ? null
      : (options.number ?? `SYN-${key()}`),
    invoiceDate: "2026-10-26",
    missingNumberReason: options.missingNumber
      ? "Synthetic official number unavailable"
      : null,
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
  if (!options.skipMatch)
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
  it("completes an originally missing official number with immutable lineage and exact replay", async () => {
    const original = await fixture("SAR", false, { missingNumber: true }),
      before = await counts();
    const next = {
      ...original,
      version: 2,
      invoiceNumber: "  ａｂＣ　12  ",
      missingNumberReason: null,
    };
    const intent = intentFor(original, "revise");
    intent.input.document = next;
    const a = await admitSupplierIntent(signed, intent);
    const result = await executeSupplierIntent(signed, a);
    expect(result.result).toMatchObject({
      version: 2,
      status: "matched",
      payableEffects: 0,
    });
    expect(await executeSupplierIntent(signed, a)).toMatchObject({
      status: "committed",
      result: { replayed: true, version: 2 },
    });
    expect(
      (
        await db
          .getPool()
          .query("SELECT document FROM supplier_invoices WHERE id=$1", [
            original.id,
          ])
      ).rows[0].document,
    ).toEqual(original);
    const claim = (
      await db
        .getPool()
        .query(
          "SELECT c.*,c.created_at=r.created_at AS exact_time,c.document=r.document AS exact_document FROM supplier_invoice_number_claims c JOIN supplier_invoice_revisions r ON r.invoice_id=c.invoice_id AND r.version=c.first_version WHERE c.invoice_id=$1",
          [original.id],
        )
    ).rows[0];
    expect(claim).toMatchObject({
      first_version: 2,
      exact_time: true,
      exact_document: true,
    });
    expect(claim.duplicate_key).toContain("ABC 12");
    expect(await counts()).toEqual(before);
    const dated = {
      ...next,
      version: 3,
      invoiceDate: "2026-11-02",
      invoiceNumber: "ABC 12",
    };
    const revision = intentFor(next, "revise");
    revision.input.document = dated;
    await executeSupplierIntent(
      signed,
      await admitSupplierIntent(signed, revision),
    );
    await executeSupplierIntent(
      signed,
      await admitSupplierIntent(signed, intentFor(dated)),
    );
    expect((await counts()).debt).toBe(before.debt + 1);
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT first_version,document FROM supplier_invoice_number_claims WHERE invoice_id=$1",
            [original.id],
          )
      ).rows[0],
    ).toMatchObject({ first_version: 2, document: next });
  });
  it("known numbers cannot be removed, renamed or moved to another supplier year/currency", async () => {
    const original = await fixture();
    for (const patch of [
      {
        invoiceNumber: null,
        missingNumberReason: "Cannot erase official number",
      },
      { invoiceNumber: "DIFFERENT" },
      { invoiceDate: "2027-10-26" },
      { currency: "USD" as const },
      { supplierPartyId: original.supplierPartyId + 1 },
    ]) {
      await expect(
        reviseNumber(original, { ...original, version: 2, ...patch }),
      ).rejects.toMatchObject({ code: "invoice_identity_mismatch" });
    }
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT COUNT(*)::int AS n FROM supplier_invoice_number_claims WHERE invoice_id=$1",
            [original.id],
          )
      ).rows[0].n,
    ).toBe(1);
  });
  it("legacy match and official-number revision race on the same Unicode-normalized source claim", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }),
      number = `ＲＡＣＥ　 ${key()}`;
    const g = await fixture("SAR", false, {
      supplierId: f.supplierPartyId,
      number: number
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase(),
      skipMatch: true,
    });
    const next = {
        ...f,
        version: 2,
        invoiceNumber: number,
        missingNumberReason: null,
      },
      before = await counts();
    const outcomes = await Promise.allSettled([
      reviseNumber(f, next),
      store.recordSupplierInvoiceMatch(admin, key(), g),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const claims = (
      await db
        .getPool()
        .query(
          "SELECT invoice_id FROM supplier_invoice_number_claims WHERE invoice_id=ANY($1::uuid[])",
          [[f.id, g.id]],
        )
    ).rows;
    expect(claims).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });
  it("two actors completing the same supplier number on different orders produce one claim", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }),
      g = await fixture("SAR", false, {
        missingNumber: true,
        supplierId: f.supplierPartyId,
      });
    const username = `SYN-NUMBER-${key()}`,
      userId = (
        await db
          .getPool()
          .query(
            "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled','admin') RETURNING id",
            [username],
          )
      ).rows[0].id;
    const other = { userId, username, role: "admin" },
      number = `SOURCE-${key()}`;
    const results = await Promise.allSettled([
      reviseNumber(f, {
        ...f,
        version: 2,
        invoiceNumber: number,
        missingNumberReason: null,
      }),
      reviseNumber(
        g,
        {
          ...g,
          version: 2,
          invoiceNumber: number.toLowerCase(),
          missingNumberReason: null,
        },
        other,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT COUNT(*)::int AS n FROM supplier_invoice_number_claims WHERE invoice_id=ANY($1::uuid[])",
            [[f.id, g.id]],
          )
      ).rows[0].n,
    ).toBe(1);
  });
  it("number-completion audit failure rolls back its claim and permits exact retry", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }),
      next = {
        ...f,
        version: 2,
        invoiceNumber: `AUDIT-${key()}`,
        missingNumberReason: null,
      },
      intent = intentFor(f, "revise");
    intent.input.document = next;
    const a = await admitSupplierIntent(signed, intent);
    await db
      .getPool()
      .query(
        "CREATE FUNCTION synthetic_number_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='supplier_invoice' THEN RAISE EXCEPTION 'synthetic number audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_number_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_number_audit()",
      );
    try {
      await expect(executeSupplierIntent(signed, a)).rejects.toThrow(
        "synthetic number audit refusal",
      );
      expect(
        (
          await db
            .getPool()
            .query(
              "SELECT 1 FROM supplier_invoice_number_claims WHERE invoice_id=$1",
              [f.id],
            )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db
        .getPool()
        .query(
          "DROP TRIGGER synthetic_number_audit ON audit_log; DROP FUNCTION synthetic_number_audit()",
        );
    }
    expect(await executeSupplierIntent(signed, a)).toMatchObject({
      status: "committed",
      result: { version: 2 },
    });
  });
  it("completion remains closed without the explicit number-claim proposal", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }),
      service = await numberService(admin),
      c = await db.getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("DROP TABLE supplier_invoice_number_claims CASCADE");
      await expect(
        service.revise(c, admin, key(), {
          ...expectation(f),
          document: {
            ...f,
            version: 2,
            invoiceNumber: "UNINSTALLED",
            missingNumberReason: null,
          },
        }),
      ).rejects.toMatchObject({ code: "schema_not_ready" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("conflicting historical number backfill aborts without a partial registry or altered source", async () => {
    const f = await fixture("SAR", false, { missingNumber: true }),
      g = await fixture("SAR", false, {
        missingNumber: true,
        supplierId: f.supplierPartyId,
      });
    const before = (
      await db
        .getPool()
        .query("SELECT count(*)::int AS n FROM supplier_invoice_number_claims")
    ).rows[0].n;
    const c = await db.getPool().connect(),
      number = `BACKFILL-${key()}`;
    try {
      await c.query("BEGIN");
      await c.query(
        "DROP TRIGGER inventory_supplier_number_claim ON supplier_invoice_revisions; DROP TABLE supplier_invoice_number_claims CASCADE",
      );
      for (const original of [f, g]) {
        const plan = (
          await c.query(
            "SELECT match_plan FROM supplier_invoices WHERE id=$1",
            [original.id],
          )
        ).rows[0].match_plan;
        await c.query(
          "INSERT INTO supplier_invoice_finance_roots(invoice_id,realm_id) VALUES($1,$2)",
          [original.id, signed.authority!.realmId],
        );
        await c.query(
          "INSERT INTO supplier_invoice_revisions(invoice_id,version,document,match_plan,reason,created_by) VALUES($1,1,$2::jsonb,$3::jsonb,'Synthetic original',$4)",
          [
            original.id,
            JSON.stringify(original),
            JSON.stringify(plan),
            admin.userId,
          ],
        );
        const next = {
          ...original,
          version: 2,
          invoiceNumber: number,
          missingNumberReason: null,
        };
        const matched = {
          ...plan,
          invoiceVersion: 2,
          identity: payloadIdentity(next),
          duplicateKey: supplierInvoiceDuplicateKey(
            original.supplierPartyId,
            number,
            original.invoiceDate,
            null,
          ),
          status: "matched",
          issues: [],
        };
        await c.query(
          "INSERT INTO supplier_invoice_revisions(invoice_id,version,document,match_plan,reason,created_by) VALUES($1,2,$2::jsonb,$3::jsonb,'Synthetic historical conflict',$4)",
          [
            original.id,
            JSON.stringify(next),
            JSON.stringify(matched),
            admin.userId,
          ],
        );
      }
      await expect(
        c.query(INVENTORY_SUPPLIER_NUMBER_SQL),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT count(*)::int AS n FROM supplier_invoice_number_claims",
          )
      ).rows[0].n,
    ).toBe(before);
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT 1 FROM supplier_invoice_revisions WHERE invoice_id=ANY($1::uuid[])",
            [[f.id, g.id]],
          )
      ).rowCount,
    ).toBe(0);
  });
 it("preserves a legacy positive initial version in deterministic number-source reconstruction",async()=>{
  const f=await fixture("SAR",false,{skipMatch:true}),legacy={...f,version:2};
  await store.recordSupplierInvoiceMatch(admin,key(),legacy);
  const claim=(await db.getPool().query("SELECT * FROM supplier_invoice_number_claims WHERE invoice_id=$1",[legacy.id])).rows[0];expect(claim.first_version).toBe(2);
  await db.getPool().query(INVENTORY_SUPPLIER_NUMBER_SQL);
  expect((await db.getPool().query("SELECT * FROM supplier_invoice_number_claims WHERE invoice_id=$1",[legacy.id])).rows[0]).toEqual(claim);
  expect((await db.getPool().query("SELECT * FROM inventory_supplier_number_sources WHERE invoice_id=$1",[legacy.id])).rows[0]).toEqual(claim);
 });

});

async function numberService(actor: InventoryActor) {
  const identity = await readStaffIdentityClaims(actor.userId);
  if (!identity) throw new Error("Missing synthetic principal");
  return createSupplierInvoiceFinanceService({
    resolvePrincipal: async () => ({
      realmId: identity.realmId,
      subjectId: identity.subjectId,
      actorUserId: actor.userId,
      username: actor.username,
    }),
  });
}
async function reviseNumber(
  original: SupplierInvoiceRevision,
  next: SupplierInvoiceRevision,
  actor: InventoryActor = admin,
) {
  const service = await numberService(actor);
  return tx((c) =>
    service.revise(c, actor, key(), {
      ...expectation(original),
      document: next,
    }),
  );
}
