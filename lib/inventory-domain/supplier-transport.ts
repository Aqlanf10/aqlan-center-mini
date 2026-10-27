import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getPool, payableAmountSql, payableSettledTotalSql } from "../db";
import type { SessionPayload } from "../auth";
import { withTransaction } from "../transactions";
import { validStaffIdentity } from "../staff-authenticated-identity";
import {
  SUPPLIER_PROTOCOL,
  type SupplierIntent,
  type SupplierEnvelope,
  type SupplierAdmission,
  type SupplierAcknowledgement,
  type SupplierAdmissionResult,
  type SupplierRejectedIntent,
} from "../inventory-supplier-protocol";
import { inventoryRecoveryIdentity } from "../inventory-command-recovery";
import { authenticateSupplierSession } from "./authenticated-session";
import {
  createSupplierInvoiceFinanceService,
  supplierFinanceCommandScope,
  supplierInvoiceDigest,
} from "./supplier-finance";
import { createInventoryCommandLifecycle } from "./command-lifecycle";
import { writeInventoryAudit } from "./procurement-store";
import { invariant } from "./quantities";
import type { SupplierInvoiceRevision, InvoiceMatchPlan } from "./procurement";
const digest = (v: unknown) =>
  createHash("sha256").update(inventoryRecoveryIdentity(v)).digest("hex");
function snapshot<T>(value: T): T {
  const copied = JSON.parse(inventoryRecoveryIdentity(value)) as T;
  const freeze = (v: unknown) => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
  };
  freeze(copied);
  return copied;
}
const uuid = (v: unknown) =>
  typeof v === "string" &&
  v === v.toLowerCase() &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
function intent(value: SupplierIntent) {
  invariant(
    value &&
      value.protocol === SUPPLIER_PROTOCOL &&
      validStaffIdentity(value.authority) &&
      uuid(value.nonce) &&
      ["revise", "post", "cancel"].includes(value.action),
    "invalid_document",
    "Invalid supplier intent",
  );
  const input = value.input;
  invariant(
    input &&
      uuid(input.invoiceId) &&
      Number.isSafeInteger(input.expectedVersion) &&
      input.expectedVersion > 0 &&
      /^[0-9a-f]{64}$/.test(input.expectedDigest) &&
      typeof input.reason === "string" &&
      input.reason.trim().length >= 3 &&
      input.reason.length <= 2000,
    "invalid_document",
    "Use an exact invoice revision and reason",
  );
  invariant(
    value.action !== "revise" ||
      (input.document &&
        Array.isArray(input.document.lines) &&
        input.document.lines.length > 0 &&
        input.document.lines.length <= 100),
    "invalid_document",
    "Invoice revision lines are required",
  );
}
function sameAuthority(
  a: SupplierIntent["authority"],
  b: SupplierIntent["authority"],
) {
  return (
    a.realmId === b.realmId &&
    a.subjectId === b.subjectId &&
    a.executionEpochId === b.executionEpochId
  );
}
export async function admitSupplierIntent(
  signed: SessionPayload,
  input: SupplierIntent,
): Promise<SupplierAdmissionResult> {
  input = snapshot(input);
  intent(input);
  return withTransaction(getPool(), async (c) => {
    const context = await authenticateSupplierSession(c, signed);
    invariant(
      input.authority.realmId === context.authority.realmId &&
        input.authority.subjectId === context.authority.subjectId,
      "supplier_saved_authority_mismatch",
      "Saved intent belongs to a different authority epoch; retain it for reconciliation",
    );
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(["supplier.invoice.admission", input.input.invoiceId]),
    ]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([
        "supplier.intent",
        context.authority.realmId,
        context.authority.subjectId,
        input.nonce,
      ]),
    ]);
    const previous = (
      await c.query<{
        request_digest: string;
        envelope: SupplierEnvelope;
        envelope_digest: string;
      }>(
        "SELECT request_digest,envelope,envelope_digest FROM inventory_supplier_intents WHERE realm_id=$1 AND subject_id=$2 AND intent_nonce=$3",
        [input.authority.realmId, input.authority.subjectId, input.nonce],
      )
    ).rows[0];
    if (previous) {
      invariant(
        previous.request_digest === digest(input),
        "idempotency_conflict",
        "Saved intent content changed",
      );
      return { envelope: previous.envelope, digest: previous.envelope_digest };
    }
    const rejected = (
      await c.query<{
        intent: SupplierIntent;
        request_digest: string;
        reason: string;
      }>(
        "SELECT intent,request_digest,reason FROM inventory_supplier_intent_rejections WHERE realm_id=$1 AND subject_id=$2 AND intent_nonce=$3",
        [input.authority.realmId, input.authority.subjectId, input.nonce],
      )
    ).rows[0];
    if (rejected) {
      invariant(
        rejected.request_digest === digest(input),
        "idempotency_conflict",
        "Rejected intent content changed",
      );
      return {
        status: "rejected",
        intent: rejected.intent,
        digest: rejected.request_digest,
        code: "supplier_invoice_intent_pending",
        reason: rejected.reason,
      };
    }
    invariant(
      sameAuthority(input.authority, context.authority),
      "supplier_saved_authority_mismatch",
      "Earlier-epoch absent intent remains held; no new admission is permitted",
    );
    // An absent result is ambiguous until the exact original operation lock is held.
    // This also fences other actors/epochs; independent invoices remain available.
    const unresolved = await c.query<{
      scope: string;
      actor_id: number;
      operation_key: string;
    }>(
      `SELECT i.scope,i.actor_id,i.operation_key FROM inventory_supplier_intents i
       WHERE i.envelope->'input'->>'invoiceId'=$1
       AND NOT EXISTS(SELECT 1 FROM inventory_operations o WHERE o.scope=i.scope AND o.actor_id=i.actor_id AND o.operation_key=i.operation_key)
       AND NOT EXISTS(SELECT 1 FROM inventory_command_retirements r WHERE r.scope=i.scope AND r.actor_id=i.actor_id AND r.operation_key=i.operation_key)
       ORDER BY i.scope,i.actor_id,i.operation_key LIMIT 101`,
      [input.input.invoiceId],
    );
    invariant(
      unresolved.rows.length <= 100,
      "source_evidence_too_large",
      "Too many unresolved source intents; review required",
    );
    for (const other of unresolved.rows) {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([other.scope, other.actor_id, other.operation_key]),
      ]);
      const terminal = (
        await c.query<{ resolved: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM inventory_operations WHERE scope=$1 AND actor_id=$2 AND operation_key=$3) OR EXISTS(SELECT 1 FROM inventory_command_retirements WHERE scope=$1 AND actor_id=$2 AND operation_key=$3) AS resolved`,
          [other.scope, other.actor_id, other.operation_key],
        )
      ).rows[0];
      if (!terminal?.resolved) {
        const rejection: SupplierRejectedIntent = {
          status: "rejected",
          intent: input,
          digest: digest(input),
          code: "supplier_invoice_intent_pending",
          reason:
            "An earlier unresolved invoice intent requires recovery before a new intent",
        };
        await c.query(
          "INSERT INTO inventory_supplier_intent_rejections(realm_id,subject_id,intent_nonce,execution_epoch_id,actor_id,intent,request_digest,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
          [
            input.authority.realmId,
            input.authority.subjectId,
            input.nonce,
            input.authority.executionEpochId,
            context.session.userId,
            JSON.stringify(input),
            rejection.digest,
            rejection.reason,
          ],
        );
        await writeInventoryAudit(
          c,
          context.session,
          "supplier_intent",
          input.nonce,
          "reject_admission",
          {
            invoiceId: input.input.invoiceId,
            digest: rejection.digest,
            code: rejection.code,
          },
        );
        return rejection;
      }
    }
    const operationKey = randomUUID(),
      scope = supplierFinanceCommandScope(context.principal, input.action);
    const lifecycle = createInventoryCommandLifecycle(
      { scope, management: true },
      { resolvePrincipal: async () => context.principal },
    );
    await lifecycle.admit(c, context.session, operationKey, {
      principal: context.principal,
      input: input.input,
    });
    const envelope: SupplierEnvelope = {
        ...input,
        operationKey,
        actorUserId: context.session.userId,
        username: context.session.username,
      },
      envelopeDigest = digest(envelope);
    await c.query(
      "INSERT INTO inventory_supplier_intents(realm_id,subject_id,intent_nonce,execution_epoch_id,actor_id,operation_key,scope,request_digest,envelope,envelope_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
      [
        input.authority.realmId,
        input.authority.subjectId,
        input.nonce,
        input.authority.executionEpochId,
        context.session.userId,
        operationKey,
        scope,
        digest(input),
        JSON.stringify(envelope),
        envelopeDigest,
      ],
    );
    return { envelope, digest: envelopeDigest };
  });
}
export async function executeSupplierIntent(
  signed: SessionPayload,
  admission: SupplierAdmission,
  retireReason?: string,
): Promise<SupplierAcknowledgement> {
  admission = snapshot(admission);
  intent(admission?.envelope);
  invariant(
    typeof admission.digest === "string" &&
      admission.digest === digest(admission.envelope),
    "idempotency_conflict",
    "Saved envelope digest changed",
  );
  return withTransaction(getPool(), async (c) => {
    const context = await authenticateSupplierSession(c, signed),
      e = admission.envelope;
    invariant(
      e.authority.realmId === context.authority.realmId &&
        e.authority.subjectId === context.authority.subjectId &&
        e.actorUserId === context.session.userId &&
        e.username === context.session.username,
      "supplier_saved_authority_mismatch",
      "Saved operation belongs to a different authority; preserve it for reconciliation",
    );
    const saved = (
      await c.query<{ envelope_digest: string; scope: string }>(
        "SELECT envelope_digest,scope FROM inventory_supplier_intents WHERE realm_id=$1 AND subject_id=$2 AND intent_nonce=$3 AND operation_key=$4",
        [e.authority.realmId, e.authority.subjectId, e.nonce, e.operationKey],
      )
    ).rows[0];
    invariant(
      saved && saved.envelope_digest === admission.digest,
      "command_provenance_required",
      "Server admission is required",
    );
    const previous = await createInventoryCommandLifecycle(
      { scope: saved.scope, management: true },
      { resolvePrincipal: async () => context.principal },
    ).lookup(c, context.session, e.operationKey, {
      principal: context.principal,
      input: e.input,
    });
    if (previous.status !== "pending")
      return {
        ...admission,
        status: previous.status,
        ...(previous.status === "committed"
          ? { result: previous.result }
          : { reason: previous.reason }),
      };
    invariant(
      e.authority.executionEpochId === context.authority.executionEpochId,
      "supplier_saved_authority_mismatch",
      "Earlier-epoch pending intent remains held; no new work or retirement is permitted",
    );
    if (retireReason !== undefined) {
      const outcome = await createInventoryCommandLifecycle(
        { scope: saved.scope, management: true },
        { resolvePrincipal: async () => context.principal },
      ).retire(
        c,
        context.session,
        e.operationKey,
        { principal: context.principal, input: e.input },
        retireReason,
      );
      return {
        ...admission,
        status: outcome.status,
        ...(outcome.status === "committed"
          ? { result: outcome.result }
          : { reason: outcome.reason }),
      };
    }
    const service = createSupplierInvoiceFinanceService({
      resolvePrincipal: async () => context.principal,
      admitted: true,
    });
    const result =
      e.action === "revise"
        ? await service.revise(c, context.session, e.operationKey, {
            ...e.input,
            document: e.input.document!,
          })
        : await service[e.action](c, context.session, e.operationKey, e.input);
    return { ...admission, status: "committed", result };
  });
}
export async function readSupplierFinance(
  signed: SessionPayload,
  orderId: string,
) {
  invariant(uuid(orderId), "invalid_document_id", "An exact order is required");
  return withTransaction(getPool(), async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const context = await authenticateSupplierSession(c, signed);
    const rows = await c.query<{
      id: string;
      document: SupplierInvoiceRevision;
      match_plan: InvoiceMatchPlan;
      payable_id: number | null;
      cancelled: boolean;
      settled: string | null;
      effective: string | null;
      posted_realm: string | null;
    }>(
      `SELECT i.id,i.document,i.match_plan,l.payable_id,s.realm_id AS posted_realm,c.invoice_id IS NOT NULL AS cancelled,CASE WHEN p.id IS NOT NULL THEN ${payableSettledTotalSql("p")}::text END AS settled,CASE WHEN p.id IS NOT NULL THEN ${payableAmountSql("p")}::text END AS effective FROM inventory_effective_supplier_invoices i LEFT JOIN supplier_invoice_payable_links l ON l.invoice_id=i.id LEFT JOIN supplier_invoice_postings s ON s.invoice_id=i.id LEFT JOIN supplier_invoice_cancellations c ON c.invoice_id=i.id LEFT JOIN payables p ON p.id=l.payable_id WHERE i.order_id=$1 ORDER BY i.created_at,i.id LIMIT 101`,
      [orderId],
    );
    invariant(
      rows.rows.length <= 100,
      "source_evidence_too_large",
      "Page supplier invoices before continuing",
    );
    return {
      authority: context.authority,
      invoices: rows.rows.map((r) => {
        const state = r.cancelled
          ? "cancelled"
          : r.payable_id
            ? "posted"
            : "unposted";
        const realmValid =
          r.payable_id === null || r.posted_realm === context.authority.realmId;
        return {
          invoiceId: r.id,
          document: r.document,
          version: r.document.version,
          digest: supplierInvoiceDigest(r.document),
          match: r.match_plan,
          status: state,
          payableId: r.payable_id,
          settledMinor: r.settled === null ? null : Number(r.settled),
          effectiveMinor: r.effective === null ? null : Number(r.effective),
          native: r.match_plan.total,
          frozenValuation: r.document.valuation,
          canRevise: realmValid && state === "unposted",
          canPost:
            realmValid &&
            state === "unposted" &&
            r.match_plan.status === "matched",
          canCancel: realmValid && state === "posted" && r.settled === "0",
          blockedReason: !realmValid
            ? "supplier_saved_authority_mismatch"
            : state === "posted" && r.settled !== "0"
              ? "invoice_payment_reversal_required"
              : null,
        };
      }),
    };
  });
}
export type SupplierFinanceView = Awaited<
  ReturnType<typeof readSupplierFinance>
>;
