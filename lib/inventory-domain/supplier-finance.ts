import { createHash } from "node:crypto";
import {
  createPayableInTransaction,
  payableAmountSql,
  payableSettledTotalSql,
  type DbClient,
} from "../db";
import { toBaseAmount } from "../money";
import { decimalRatio, invariant } from "./quantities";
import {
  matchSupplierInvoice,
  payloadIdentity,
  supplierInvoiceDuplicateKey,
  valuationSnapshot,
  type SupplierInvoiceRevision,
  type InspectedReceiptLine,
  type InvoiceMatchPlan,
} from "./procurement";
import {
  inventoryOperationInTransaction,
  lockedOrder,
  readEffectiveInvoiceAllocations,
  writeInventoryAudit,
  type InventoryActor,
} from "./procurement-store";
import { requireInventoryIntegration } from "./rollout";

/** The canonical identity adapter must supply this from authenticated server
 * context. No request field, clinic label or environment flag is a realm. */
export interface SupplierFinancePrincipal {
  realmId: string;
  subjectId: string;
  actorUserId: number;
  username: string;
}
export interface SupplierFinanceDependencies {
  resolvePrincipal: (
    actor: InventoryActor,
  ) => Promise<SupplierFinancePrincipal | null>;
}
export const supplierInvoiceDigest = (document: SupplierInvoiceRevision) =>
  createHash("sha256").update(payloadIdentity(document)).digest("hex");
function reason(value: string) {
  invariant(
    typeof value === "string" &&
      value.trim().length >= 3 &&
      value.length <= 2000,
    "reason_required",
    "A bounded reason is required",
  );
}
function uuid(value: string) {
  invariant(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
    "invalid_document_id",
    "Invoice ID must be a UUID",
  );
}
export interface InvoiceVersionExpectation {
  invoiceId: string;
  expectedVersion: number;
  expectedDigest: string;
  reason: string;
}
function expected(input: InvoiceVersionExpectation) {
  uuid(input.invoiceId);
  reason(input.reason);
  invariant(
    Number.isSafeInteger(input.expectedVersion) && input.expectedVersion > 0,
    "stale_version",
    "An exact invoice version is required",
  );
  invariant(
    typeof input.expectedDigest === "string" &&
      /^[0-9a-f]{64}$/.test(input.expectedDigest),
    "stale_version",
    "An exact invoice digest is required",
  );
}

/** Refuse precision loss before the legacy number-based canonical writer. */
export function canonicalInvoiceRate(invoice: SupplierInvoiceRevision): number {
  const value = invoice.valuation;
  invariant(
    value !== null,
    "missing_valuation",
    "A frozen invoice valuation is required",
  );
  invariant(
    payloadIdentity(valuationSnapshot(value)) === payloadIdentity(value),
    "valuation_mismatch",
    "Invoice valuation is not canonical",
  );
  const ratio = decimalRatio(value.rateToBase);
  invariant(
    (ratio.numerator * 1000000n) % ratio.denominator === 0n &&
      (ratio.numerator * 1000000n) / ratio.denominator < 10n ** 18n,
    "rate_precision_unsupported",
    "Canonical payable FX must fit numeric(18,6) exactly",
  );
  const rate = Number(value.rateToBase);
  const encoded = decimalRatio(String(rate));
  invariant(
    encoded.numerator * ratio.denominator ===
      ratio.numerator * encoded.denominator,
    "rate_precision_unsupported",
    "Canonical payable FX cannot represent this quote exactly",
  );
  invariant(
    toBaseAmount(
      value.amountMinor,
      value.currency,
      value.baseCurrency,
      rate,
    ) === value.baseAmountMinor,
    "valuation_mismatch",
    "Canonical payable conversion must equal the frozen valuation",
  );
  return rate;
}

async function currentInvoice(
  client: DbClient,
  actor: InventoryActor,
  principal: SupplierFinancePrincipal,
  input: InvoiceVersionExpectation,
) {
  expected(input);
  const head = (
    await client.query<{ order_id: string }>(
      "SELECT order_id FROM supplier_invoices WHERE id=$1",
      [input.invoiceId],
    )
  ).rows[0];
  invariant(head, "not_found", "Supplier invoice was not found");
  const order = await lockedOrder(client, head.order_id);
  const original = (
    await client.query<{
      document: SupplierInvoiceRevision;
      match_plan: InvoiceMatchPlan;
    }>(
      "SELECT document,match_plan FROM supplier_invoices WHERE id=$1 FOR UPDATE",
      [input.invoiceId],
    )
  ).rows[0];
  await client.query(
    "INSERT INTO supplier_invoice_finance_roots(invoice_id,realm_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [input.invoiceId, principal.realmId],
  );
  const root = (
    await client.query<{ realm_id: string }>(
      "SELECT realm_id FROM supplier_invoice_finance_roots WHERE invoice_id=$1",
      [input.invoiceId],
    )
  ).rows[0];
  invariant(
    root.realm_id === principal.realmId,
    "principal_realm_mismatch",
    "Invoice belongs to another authoritative realm",
  );
  let saved = (
    await client.query<{
      document: SupplierInvoiceRevision;
      match_plan: InvoiceMatchPlan;
    }>(
      "SELECT document,match_plan FROM supplier_invoice_revisions WHERE invoice_id=$1 ORDER BY version DESC LIMIT 1",
      [input.invoiceId],
    )
  ).rows[0];
  if (!saved) {
    invariant(
      original.document.version === 1,
      "stale_version",
      "Legacy invoice must have an explicit initial version",
    );
    await client.query(
      "INSERT INTO supplier_invoice_revisions(invoice_id,version,document,match_plan,reason,created_by) VALUES($1,1,$2::jsonb,$3::jsonb,'Adopt immutable original invoice',$4)",
      [
        input.invoiceId,
        JSON.stringify(original.document),
        JSON.stringify(original.match_plan),
        actor.userId,
      ],
    );
    saved = original;
  }
  invariant(
    saved.document.version === input.expectedVersion &&
      supplierInvoiceDigest(saved.document) === input.expectedDigest,
    "stale_version",
    "Invoice changed; review its current immutable revision",
  );
  const posting = (
    await client.query<{ payable_id: number; version: number; digest: string }>(
      "SELECT l.payable_id,s.version,s.digest FROM supplier_invoice_payable_links l LEFT JOIN supplier_invoice_postings s ON s.invoice_id=l.invoice_id WHERE l.invoice_id=$1",
      [input.invoiceId],
    )
  ).rows[0];
  const cancelled = (
    await client.query<{ adjustment_id: number }>(
      "SELECT adjustment_id FROM supplier_invoice_cancellations WHERE invoice_id=$1",
      [input.invoiceId],
    )
  ).rows[0];
  return { order, original: original.document, ...saved, posting, cancelled };
}
async function rematch(
  client: DbClient,
  order: Awaited<ReturnType<typeof lockedOrder>>,
  invoice: SupplierInvoiceRevision,
) {
  const receipts = await client.query<{
    document: InspectedReceiptLine;
    released_qty: string;
  }>(
    `SELECT r.document,
 COALESCE((SELECT SUM(q.base_qty) FROM quarantine_dispositions q WHERE q.receipt_line_id=r.id AND q.action='release'),0)::text AS released_qty
 FROM goods_receipt_lines r WHERE r.order_id=$1 ORDER BY r.id`,
    [order.id],
  );
  const effective = receipts.rows.map((row) =>
    row.document.disposition === "quarantined" &&
    decimalRatio(row.released_qty).numerator > 0n
      ? {
          ...row.document,
          disposition: "accepted" as const,
          baseQuantity: row.released_qty,
        }
      : row.document,
  );
  return matchSupplierInvoice(
    order,
    invoice,
    effective,
    await readEffectiveInvoiceAllocations(client, [order.id], invoice.id),
  );
}

/** Prepared core only: caller owns BEGIN/ROLLBACK/COMMIT and supplies a trusted
 * resolver at composition. Default construction refuses all financial work.
 * No HTTP dispatch or runtime schema installation is provided. */
export function createSupplierInvoiceFinanceService(
  dependencies: SupplierFinanceDependencies = {
    resolvePrincipal: async () => null,
  },
) {
  async function run<T extends object>(
    client: DbClient,
    actor: InventoryActor,
    key: string,
    name: string,
    input: InvoiceVersionExpectation,
    work: (principal: SupplierFinancePrincipal) => Promise<T>,
  ) {
    requireInventoryIntegration();
    const principal = await dependencies.resolvePrincipal(actor);
    invariant(
      principal &&
        typeof principal.realmId === "string" &&
        principal.realmId.trim() === principal.realmId &&
        principal.realmId.length > 0 &&
        principal.realmId.length <= 240 &&
        typeof principal.subjectId === "string" &&
        principal.subjectId.trim().length > 0 &&
        principal.subjectId.length <= 240 &&
        principal.actorUserId === actor.userId &&
        principal.username === actor.username,
      "principal_realm_unavailable",
      "An authoritative realm and authenticated subject binding are required",
    );
    const scope = `supplier.invoice.${name}:${createHash("sha256")
      .update(
        payloadIdentity({
          realmId: principal.realmId,
          subjectId: principal.subjectId,
        }),
      )
      .digest("hex")}`;
    return inventoryOperationInTransaction(
      client,
      actor,
      key,
      scope,
      { principal, input },
      true,
      async () => {
        const ready = (
          await client.query<{ present: boolean }>(
            "SELECT to_regclass('supplier_invoice_cancellations') IS NOT NULL AND to_regclass('inventory_effective_invoice_allocations') IS NOT NULL AS present",
          )
        ).rows[0];
        invariant(
          ready?.present,
          "schema_not_ready",
          "Supplier finance awaits its coordinated additive proposal",
        );
        return work(principal);
      },
    );
  }
  return {
    revise(
      client: DbClient,
      actor: InventoryActor,
      key: string,
      input: InvoiceVersionExpectation & { document: SupplierInvoiceRevision },
    ) {
      return run(client, actor, key, "revise", input, async (principal) => {
        const saved = await currentInvoice(client, actor, principal, input),
          next = input.document,
          prior = saved.original;
        invariant(
          !saved.posting,
          "invoice_already_posted",
          "Posted invoices cannot be revised",
        );
        invariant(
          next.id === prior.id &&
            next.orderId === prior.orderId &&
            next.supplierPartyId === prior.supplierPartyId &&
            next.currency === prior.currency &&
            next.branchId === prior.branchId &&
            supplierInvoiceDuplicateKey(
              next.supplierPartyId,
              next.invoiceNumber,
              next.invoiceDate,
              next.missingNumberReason,
            ) ===
              supplierInvoiceDuplicateKey(
                prior.supplierPartyId,
                prior.invoiceNumber,
                prior.invoiceDate,
                prior.missingNumberReason,
              ),
          "invoice_identity_mismatch",
          "Revision must retain the immutable supplier invoice identity",
        );
        invariant(
          next.version === input.expectedVersion + 1,
          "stale_version",
          "Revision must advance exactly one version",
        );
        const match = await rematch(client, saved.order, next);
        await client.query(
          "INSERT INTO supplier_invoice_revisions(invoice_id,version,document,match_plan,reason,created_by) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)",
          [
            next.id,
            next.version,
            JSON.stringify(next),
            JSON.stringify(match),
            input.reason,
            actor.userId,
          ],
        );
        await writeInventoryAudit(
          client,
          actor,
          "supplier_invoice",
          next.id,
          "revise",
          {
            version: next.version,
            digest: supplierInvoiceDigest(next),
            reason: input.reason,
            status: match.status,
          },
        );
        return {
          invoiceId: next.id,
          version: next.version,
          digest: supplierInvoiceDigest(next),
          status: match.status,
          payableEffects: 0,
          stockEffects: 0,
          cashEffects: 0,
        };
      });
    },
    post(
      client: DbClient,
      actor: InventoryActor,
      key: string,
      input: InvoiceVersionExpectation,
    ) {
      return run(client, actor, key, "post", input, async (principal) => {
        const saved = await currentInvoice(client, actor, principal, input);
        invariant(
          !saved.cancelled,
          "invoice_cancelled",
          "Cancelled invoices cannot be reposted",
        );
        if (saved.posting) {
          invariant(
            saved.posting.version === input.expectedVersion &&
              saved.posting.digest === input.expectedDigest,
            "invoice_already_posted",
            "Existing payable has another approved source",
          );
          return {
            invoiceId: input.invoiceId,
            payableId: saved.posting.payable_id,
            status: "posted",
            payableEffects: 0,
            stockEffects: 0,
            cashEffects: 0,
          };
        }
        invariant(
          saved.match_plan.status === "matched",
          "invoice_not_matched",
          "An unresolved invoice requires an explicit matched revision",
        );
        const match = await rematch(client, saved.order, saved.document);
        invariant(
          match.status === "matched" &&
            match.total &&
            match.total.amountMinor > 0,
          "invoice_not_matched",
          "Only a fully matched positive invoice may post",
        );
        const rate = canonicalInvoiceRate(saved.document),
          valuation = saved.document.valuation!;
        const party = (
          await client.query<{ kind: string; is_active: boolean }>(
            "SELECT kind,is_active FROM parties WHERE id=$1 FOR UPDATE",
            [saved.document.supplierPartyId],
          )
        ).rows[0];
        invariant(
          party?.kind === "supplier" && party.is_active,
          "supplier_unavailable",
          "An active supplier is required",
        );
        const payable = await createPayableInTransaction(client, {
          partyId: saved.document.supplierPartyId,
          category: "supplier",
          description: `Supplier invoice ${saved.document.invoiceNumber}`,
          amountMinor: match.total.amountMinor,
          currency: saved.document.currency,
          baseCurrency: valuation.baseCurrency,
          exchangeRate: rate,
          labOrderId: null,
          dueDate: null,
          createdBy: actor.username,
        });
        invariant(
          payable && payable.baseAmountMinor === valuation.baseAmountMinor,
          "valuation_mismatch",
          "Canonical payable must preserve the approved snapshot",
        );
        await client.query(
          "INSERT INTO supplier_invoice_payable_links(invoice_id,payable_id,approved_by) VALUES($1,$2,$3)",
          [input.invoiceId, payable.id, actor.userId],
        );
        await client.query(
          "INSERT INTO supplier_invoice_postings(invoice_id,version,digest,realm_id,subject_id) VALUES($1,$2,$3,$4,$5)",
          [
            input.invoiceId,
            input.expectedVersion,
            input.expectedDigest,
            principal.realmId,
            principal.subjectId,
          ],
        );
        await writeInventoryAudit(
          client,
          actor,
          "supplier_invoice",
          input.invoiceId,
          "post_payable",
          {
            payableId: payable.id,
            version: input.expectedVersion,
            digest: input.expectedDigest,
            reason: input.reason,
            currency: payable.currency,
            amountMinor: payable.amountMinor,
            valuation,
          },
        );
        return {
          invoiceId: input.invoiceId,
          payableId: payable.id,
          status: "posted",
          payableEffects: 1,
          stockEffects: 0,
          cashEffects: 0,
        };
      });
    },
    cancel(
      client: DbClient,
      actor: InventoryActor,
      key: string,
      input: InvoiceVersionExpectation,
    ) {
      return run(client, actor, key, "cancel", input, async (principal) => {
        const saved = await currentInvoice(client, actor, principal, input);
        invariant(
          saved.posting &&
            saved.posting.version === input.expectedVersion &&
            saved.posting.digest === input.expectedDigest,
          "invoice_not_posted",
          "An exact posted source is required",
        );
        if (saved.cancelled)
          return {
            invoiceId: input.invoiceId,
            payableId: saved.posting.payable_id,
            adjustmentId: saved.cancelled.adjustment_id,
            status: "cancelled",
            adjustmentEffects: 0,
            stockEffects: 0,
            cashEffects: 0,
          };
        // Match the existing payment writer's party → payable lock order.
        await client.query("SELECT id FROM parties WHERE id=$1 FOR UPDATE", [
          saved.document.supplierPartyId,
        ]);
        const payable = (
          await client.query<{
            id: number;
            party_id: number;
            source_type: string;
            lab_order_id: number | null;
            amount_minor: string;
            currency: string;
            exchange_rate: string;
            base_amount_minor: string;
            effective: string;
            settled: string;
          }>(
            `SELECT p.*,${payableAmountSql("p")}::text AS effective,${payableSettledTotalSql("p")}::text AS settled FROM payables p WHERE p.id=$1 FOR UPDATE OF p`,
            [saved.posting.payable_id],
          )
        ).rows[0];
        invariant(
          payable &&
            payable.source_type === "operational" &&
            payable.lab_order_id === null &&
            payable.party_id === saved.document.supplierPartyId &&
            payable.currency === saved.document.currency &&
            payable.effective === payable.amount_minor,
          "invoice_source_mismatch",
          "Cancellation requires the unchanged canonical source payable",
        );
        invariant(
          BigInt(payable.settled) === 0n,
          "invoice_payment_reversal_required",
          "Reverse existing payments through the authorized payment void flow before cancelling",
        );
        const adjustment = (
          await client.query<{ id: number }>(
            "INSERT INTO payable_adjustments(payable_id,delta_minor,reason,created_by) VALUES($1,-$2::bigint,$3,$4) RETURNING id",
            [payable.id, payable.amount_minor, input.reason, actor.username],
          )
        ).rows[0];
        await client.query(
          "INSERT INTO supplier_invoice_cancellations(invoice_id,payable_id,adjustment_id,currency,amount_minor,exchange_rate,base_amount_minor,reason,created_by) VALUES($1,$2,$3,$4,$5::bigint,$6::numeric,$7::bigint,$8,$9)",
          [
            input.invoiceId,
            payable.id,
            adjustment.id,
            payable.currency,
            payable.amount_minor,
            payable.exchange_rate,
            payable.base_amount_minor,
            input.reason,
            actor.userId,
          ],
        );
        await writeInventoryAudit(
          client,
          actor,
          "supplier_invoice",
          input.invoiceId,
          "cancel_payable",
          {
            payableId: payable.id,
            adjustmentId: adjustment.id,
            reason: input.reason,
            currency: payable.currency,
            amountMinor: payable.amount_minor,
            version: input.expectedVersion,
          },
        );
        return {
          invoiceId: input.invoiceId,
          payableId: payable.id,
          adjustmentId: adjustment.id,
          status: "cancelled",
          adjustmentEffects: 1,
          stockEffects: 0,
          cashEffects: 0,
        };
      });
    },
  };
}
