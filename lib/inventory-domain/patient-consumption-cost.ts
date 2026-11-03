import type { DbClient } from "../db";
import { type Currency } from "../money";
import type { InventoryActor } from "./procurement-store";
import {
  closedInventoryPrincipalResolver,
  resolveInventoryPrincipal,
  type InventoryPrincipal,
  type InventoryPrincipalDependencies,
} from "./principal";
import { requireInventoryIntegration } from "./rollout";
import {
  invariant,
  InventoryDomainError,
  quantityAtoms,
  unitConversionSnapshot,
} from "./quantities";
import {
  allocateMinor,
  matchSupplierInvoice,
  payloadIdentity,
  type InspectedReceiptLine,
  type IssuedPurchaseOrder,
  type SupplierInvoiceRevision,
  type InvoiceMatchPlan,
} from "./procurement";
import {
  canonicalInvoiceRate,
  supplierInvoiceDigest,
} from "./supplier-finance";
import {
  proportionalCostMinor,
  summarizeTreatmentCost,
  type CostSnapshot,
  type TreatmentIssue,
} from "./treatment-cost";

export interface PatientCostReadGrant {
  patientId: string;
  realmId: string;
  subjectId: string;
}
export interface PatientCostReadDependencies
  extends InventoryPrincipalDependencies {
  /** Canonical financial + patient read policy, not an admin-role fallback. */
  authorizeRead: (
    client: DbClient,
    principal: InventoryPrincipal,
    actor: InventoryActor,
    patientId: string,
  ) => Promise<PatientCostReadGrant | null>;
}
type Usage = {
  id: string;
  usage_key: string;
  location_id: string;
  lot_id: string;
  movement_id: number;
  qty: string;
  quantity_state: "confirmed" | "estimated";
  patient_id: string | null;
  visit_id: string | null;
  case_id: string | null;
  procedure_id: string | null;
  document: Record<string, unknown>;
  created_at: Date;
};
type Lot = {
  id: string;
  receipt_line_id: string | null;
  item_id: number;
  location_id: string;
  movement_id: number;
  cost_snapshot: Record<string, unknown>;
  created_at: Date;
  receipt_qty: string | null;
  receipt_document: InspectedReceiptLine | null;
  order_id: string | null;
  order_line_id: string | null;
};
type Valuation = {
  native: CostSnapshot | null;
  base: CostSnapshot;
  invoiceIds: string[];
  reason: string | null;
};
export interface PatientConsumptionCostRow {
  usageId: string;
  movementId: string | null;
  patientId: string;
  visitId: string | null;
  caseId: string | null;
  procedureId: string | null;
  clinicalAttribution: "verified" | "missing";
  doctorAttribution: "missing";
  doctorId: null;
  quantityAtoms: number | null;
  quantityState: "confirmed" | "estimated";
  lotId: string | null;
  native: CostSnapshot | null;
  base: CostSnapshot;
  invoiceIds: string[];
  reason: string | null;
  /** Display only; summaries retain fractions and round once, not row sums. */
  roundedNativeMinor: number | null;
  roundedBaseMinor: number | null;
}
const LIMIT = 1000;
function safe(n: bigint) {
  const v = Number(n);
  invariant(
    Number.isSafeInteger(v),
    "cost_overflow",
    "Cost evidence exceeds safe integer bounds",
  );
  return v;
}
function validId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[1-9]\d*$/.test(id) &&
    Number.isSafeInteger(Number(id))
  );
}
function missing(
  currency: Currency,
  sourceId: string,
  at: string,
  reason: string,
): CostSnapshot {
  return { state: "missing", currency, sourceId, recordedAt: at, reason };
}
function failed(
  sourceId: string,
  at: string,
  reason: string,
  currency: Currency | null = null,
): Valuation {
  return {
    native: currency ? missing(currency, sourceId, at, reason) : null,
    base: missing("YER", sourceId, at, reason),
    invoiceIds: [],
    reason,
  };
}
function evidence(condition: unknown, reason: string): asserts condition {
  invariant(condition, "cost_evidence_missing", reason);
}

async function historicalOrder(
  client: DbClient,
  id: string,
  version: number,
): Promise<IssuedPurchaseOrder> {
  const rows = await client.query<{ document: IssuedPurchaseOrder }>(
    `SELECT document FROM purchase_orders WHERE id=$1 AND (document->>'version')::integer=$2
    UNION ALL SELECT result->'order' AS document FROM inventory_operations WHERE scope='order.amend' AND result->>'id'=$1::text AND (result->>'version')::integer=$2`,
    [id, version],
  );
  evidence(rows.rows.length === 1, "historical_order_unproven");
  return rows.rows[0].document;
}
async function invoicePortions(
  client: DbClient,
  invoiceId: string,
  principal: InventoryPrincipal,
) {
  const rows = await client.query<{
    document: SupplierInvoiceRevision;
    match_plan: InvoiceMatchPlan;
    digest: string;
    realm_id: string;
    version: number;
    payable_id: number;
    amount_minor: string;
    currency: string;
    exchange_rate: string;
    base_amount_minor: string;
    base_currency: string;
    source_type: string;
    lab_order_id: number | null;
    party_id: number;
    posted_at: Date;
    cancelled: boolean;
  }>(
    `SELECT r.document,r.match_plan,s.digest,s.realm_id,s.version,l.payable_id,p.amount_minor::text,p.currency,p.exchange_rate::text,p.base_amount_minor::text,p.base_currency,p.source_type,p.lab_order_id,p.party_id,l.created_at AS posted_at,
    EXISTS(SELECT 1 FROM supplier_invoice_cancellations c WHERE c.invoice_id=s.invoice_id) AS cancelled
    FROM supplier_invoice_postings s JOIN supplier_invoice_revisions r ON r.invoice_id=s.invoice_id AND r.version=s.version
    JOIN supplier_invoice_finance_roots root ON root.invoice_id=s.invoice_id AND root.realm_id=s.realm_id
    JOIN supplier_invoice_payable_links l ON l.invoice_id=s.invoice_id JOIN payables p ON p.id=l.payable_id WHERE s.invoice_id=$1`,
    [invoiceId],
  );
  const saved = rows.rows[0];
  evidence(saved, "invoice_unposted");
  evidence(!saved.cancelled, "invoice_cancelled");
  const doc = saved.document;
  evidence(saved.realm_id === principal.realmId, "invoice_realm_unproven");
  evidence(
    doc.id === invoiceId &&
      doc.version === saved.version &&
      supplierInvoiceDigest(doc) === saved.digest,
    "invoice_source_mismatch",
  );
  evidence(
    saved.match_plan.status === "matched" &&
      saved.match_plan.identity === payloadIdentity(doc),
    "invoice_match_unproven",
  );
  const rate = canonicalInvoiceRate(doc),
    value = doc.valuation!;
  evidence(
    saved.source_type === "operational" &&
      saved.lab_order_id === null &&
      saved.party_id === doc.supplierPartyId &&
      saved.currency === doc.currency &&
      saved.base_currency === "YER" &&
      BigInt(saved.amount_minor) === BigInt(value.amountMinor) &&
      BigInt(saved.base_amount_minor) === BigInt(value.baseAmountMinor) &&
      Number(saved.exchange_rate) === rate,
    "payable_snapshot_mismatch",
  );
  evidence(
    (
      await client.query(
        "SELECT id FROM payable_adjustments WHERE payable_id=$1 LIMIT 1",
        [saved.payable_id],
      )
    ).rows.length === 0,
    "payable_adjusted",
  );
  const order = await historicalOrder(client, doc.orderId, doc.orderVersion);
  const receipts = await client.query<{
    document: InspectedReceiptLine;
    released: string;
  }>(
    `SELECT g.document,COALESCE((SELECT SUM(q.base_qty) FROM quarantine_dispositions q WHERE q.receipt_line_id=g.id AND q.action='release' AND q.created_at<=$2),0)::text AS released FROM goods_receipt_lines g WHERE g.order_id=$1 LIMIT 1001`,
    [doc.orderId, saved.posted_at],
  );
  evidence(receipts.rows.length <= LIMIT, "source_evidence_too_large");
  const accepted = receipts.rows.map((r) =>
    r.document.disposition === "quarantined" &&
    quantityAtoms(r.released, 3, true) > 0n
      ? {
          ...r.document,
          disposition: "accepted" as const,
          baseQuantity: r.released,
        }
      : r.document,
  );
  // Revalidate the approved historical document, not today's amended order or FX.
  const checked = matchSupplierInvoice(order, doc, accepted, []);
  evidence(
    payloadIdentity(checked) === payloadIdentity(saved.match_plan),
    "saved_match_mismatch",
  );
  const nativeLines = checked.lines.map((line) => ({
    id: line.invoiceLineId,
    amountMinor:
      line.lineTotalMinor! +
      checked.charges.find((c) => c.invoiceLineId === line.invoiceLineId)!
        .shippingMinor -
      checked.charges.find((c) => c.invoiceLineId === line.invoiceLineId)!
        .discountMinor,
  }));
  evidence(
    nativeLines.reduce((n, l) => n + BigInt(l.amountMinor), 0n) ===
      BigInt(value.amountMinor),
    "invoice_total_mismatch",
  );
  const baseLines = new Map(
    allocateMinor(
      value.baseAmountMinor,
      nativeLines.map((l) => ({ id: l.id, weight: String(l.amountMinor) })),
    ).map((l) => [l.id, l.amountMinor]),
  );
  const portions = new Map<
    string,
    {
      receiptId: string;
      quantity: bigint;
      nativeMinor: number;
      baseMinor: number;
    }
  >();
  for (const line of doc.lines) {
    const weights = line.receiptAllocations.map((a) => ({
      id: a.id,
      weight: String(quantityAtoms(a.baseQuantity)),
    }));
    const native = new Map(
      allocateMinor(
        nativeLines.find((l) => l.id === line.id)!.amountMinor,
        weights,
      ).map((a) => [a.id, a.amountMinor]),
    );
    const base = new Map(
      allocateMinor(baseLines.get(line.id)!, weights).map((a) => [
        a.id,
        a.amountMinor,
      ]),
    );
    for (const a of line.receiptAllocations) {
      evidence(!portions.has(a.id), "duplicate_invoice_allocation");
      portions.set(a.id, {
        receiptId: a.receiptLineId,
        quantity: quantityAtoms(a.baseQuantity),
        nativeMinor: native.get(a.id)!,
        baseMinor: base.get(a.id)!,
      });
    }
  }
  evidence(
    [...portions.values()].reduce((n, p) => n + BigInt(p.nativeMinor), 0n) ===
      BigInt(value.amountMinor) &&
      [...portions.values()].reduce((n, p) => n + BigInt(p.baseMinor), 0n) ===
        BigInt(value.baseAmountMinor),
    "valuation_conservation_mismatch",
  );
  return {
    currency: doc.currency,
    portions,
    recordedAt: saved.posted_at.toISOString(),
  };
}

async function valueLot(
  client: DbClient,
  lot: Lot,
  principal: InventoryPrincipal,
  at: string,
  invoiceCache: Map<string, Awaited<ReturnType<typeof invoicePortions>>>,
): Promise<Valuation> {
  let currency: Currency | null = null;
  try {
    evidence(
      lot.receipt_line_id &&
        lot.receipt_document &&
        lot.receipt_qty &&
        lot.order_id &&
        lot.order_line_id,
      "receipt_lineage_missing",
    );
    const receipt = lot.receipt_document,
      quantity = quantityAtoms(lot.receipt_qty);
    const incoming = (
      await client.query<{ item_id: number; kind: string; qty: string }>(
        "SELECT item_id,kind,qty::text FROM inventory_movements WHERE id=$1",
        [lot.movement_id],
      )
    ).rows[0];
    evidence(
      incoming &&
        incoming.kind === "in" &&
        incoming.item_id === lot.item_id &&
        quantityAtoms(incoming.qty) === quantity &&
        receipt.itemId === lot.item_id &&
        quantityAtoms(receipt.baseQuantity) === quantity &&
        receipt.id === lot.receipt_line_id &&
        receipt.orderId === lot.order_id &&
        receipt.orderLineId === lot.order_line_id,
      "receipt_lineage_mismatch",
    );
    const inbound = await client.query<{
      lot_id: string;
      location_id: string;
      qty: string;
    }>(
      "SELECT lot_id::text,location_id,qty::text FROM inventory_movement_allocations WHERE movement_id=$1",
      [lot.movement_id],
    );
    evidence(
      inbound.rows.length === 1 &&
        inbound.rows[0].lot_id === lot.id &&
        inbound.rows[0].location_id === lot.location_id &&
        quantityAtoms(inbound.rows[0].qty) === quantity,
      "receipt_allocation_mismatch",
    );
    const order = await historicalOrder(
      client,
      lot.order_id,
      receipt.orderVersion,
    );
    currency = order.currency;
    const source = order.lines.find((line) => line.id === lot.order_line_id);
    evidence(source?.itemId === lot.item_id, "receipt_order_mismatch");
    evidence(
      payloadIdentity(lot.cost_snapshot.conversion) ===
        payloadIdentity(source.conversion),
      "historical_conversion_mismatch",
    );
    const allocations = await client.query<{
      id: string;
      invoice_id: string;
      base_qty: string;
    }>(
      "SELECT id,invoice_id::text,base_qty::text FROM inventory_effective_invoice_allocations WHERE receipt_line_id=$1 LIMIT 1001",
      [lot.receipt_line_id],
    );
    evidence(allocations.rows.length <= LIMIT, "source_evidence_too_large");
    if (allocations.rows.length === 0) {
      const quote = lot.cost_snapshot;
      evidence(
        quote.source === "approved_order_quote" &&
          quote.currency === currency &&
          payloadIdentity(quote.price) === payloadIdentity(source.price) &&
          payloadIdentity(quote.conversion) ===
            payloadIdentity(source.conversion),
        "quote_source_unproven",
      );
      const conversion = unitConversionSnapshot(source.conversion);
      evidence(source.price.state !== "missing", "quote_missing");
      return {
        native: {
          state: "estimated",
          currency,
          sourceId: `order:${order.id}:${order.version}:${source.id}`,
          recordedAt: lot.created_at.toISOString(),
          amountMinor: source.price.unitPriceMinor,
          pricedQuantityAtoms: safe(
            quantityAtoms(conversion.baseUnitsPerEnteredUnit),
          ),
        },
        base: missing("YER", lot.id, at, "final_invoice_valuation_missing"),
        invoiceIds: [],
        reason: "final_invoice_valuation_missing",
      };
    }
    evidence(
      new Set(allocations.rows.map((a) => a.id)).size ===
        allocations.rows.length,
      "duplicate_invoice_allocation",
    );
    evidence(
      allocations.rows.reduce((n, a) => n + quantityAtoms(a.base_qty), 0n) ===
        quantity,
      "partial_or_excess_billing",
    );
    const invoices = new Map<
      string,
      Awaited<ReturnType<typeof invoicePortions>>
    >();
    let native = 0n,
      base = 0n;
    for (const a of allocations.rows) {
      let invoice = invoiceCache.get(a.invoice_id);
      if (!invoice) {
        invoice = await invoicePortions(client, a.invoice_id, principal);
        invoiceCache.set(a.invoice_id, invoice);
      }
      invoices.set(a.invoice_id, invoice);
      evidence(invoice.currency === currency, "lot_currency_mismatch");
      const portion = invoice.portions.get(a.id);
      evidence(
        portion &&
          portion.receiptId === lot.receipt_line_id &&
          portion.quantity === quantityAtoms(a.base_qty),
        "invoice_receipt_mismatch",
      );
      native += BigInt(portion.nativeMinor);
      base += BigInt(portion.baseMinor);
    }
    const recordedAt = [...invoices.values()]
      .map((i) => i.recordedAt)
      .sort()
      .at(-1)!;
    return {
      native: {
        state: "known",
        currency,
        sourceId: lot.id,
        recordedAt,
        amountMinor: safe(native),
        pricedQuantityAtoms: safe(quantity),
      },
      base: {
        state: "known",
        currency: "YER",
        sourceId: lot.id,
        recordedAt,
        amountMinor: safe(base),
        pricedQuantityAtoms: safe(quantity),
      },
      invoiceIds: [...invoices.keys()].sort(),
      reason: null,
    };
  } catch (error) {
    if (error instanceof InventoryDomainError)
      return failed(
        lot.id,
        at,
        error.code === "cost_evidence_missing" ? error.message : error.code,
        currency,
      );
    throw error;
  }
}

async function clinical(client: DbClient, u: Usage, patientId: string) {
  const d = u.document;
  evidence(
    u.patient_id === patientId &&
      d.patientId === patientId &&
      d.clinicalAttributionStatus === "verified" &&
      d.id === u.id &&
      d.usageKey === u.usage_key &&
      d.kind === "consumed",
    "clinical_evidence_mismatch",
  );
  for (const [column, field] of [
    [u.visit_id, "visitId"],
    [u.case_id, "caseId"],
    [u.procedure_id, "procedureId"],
  ] as const)
    evidence((d[field] ?? null) === column, "clinical_evidence_mismatch");
  if (u.visit_id !== null) {
    evidence(validId(u.visit_id), "clinical_evidence_mismatch");
    const v = (
      await client.query<{ patient_id: number | null }>(
        "SELECT patient_id FROM visits WHERE id=$1",
        [u.visit_id],
      )
    ).rows[0];
    evidence(
      v && String(v.patient_id) === patientId,
      "clinical_evidence_mismatch",
    );
  }
  if (u.case_id !== null) {
    evidence(validId(u.case_id), "clinical_evidence_mismatch");
    const c = (
      await client.query<{ patient_id: number }>(
        "SELECT patient_id FROM treatment_plans WHERE id=$1",
        [u.case_id],
      )
    ).rows[0];
    evidence(
      c && String(c.patient_id) === patientId,
      "clinical_evidence_mismatch",
    );
  }
  if (u.procedure_id !== null) {
    evidence(validId(u.procedure_id), "clinical_evidence_mismatch");
    const p = (
      await client.query<{
        patient_id: number;
        visit_id: number | null;
        plan_id: number | null;
      }>("SELECT patient_id,visit_id,plan_id FROM planned_visits WHERE id=$1", [
        u.procedure_id,
      ])
    ).rows[0];
    evidence(
      p &&
        String(p.patient_id) === patientId &&
        (p.visit_id === null ? null : String(p.visit_id)) === u.visit_id &&
        (p.plan_id === null ? null : String(p.plan_id)) === u.case_id,
      "clinical_evidence_mismatch",
    );
  }
}

/** No endpoint. Authorization is evaluated in the caller's coherent read snapshot. */
export function createPatientConsumptionCostReader(
  dependencies: PatientCostReadDependencies = {
    ...closedInventoryPrincipalResolver,
    authorizeRead: async () => null,
  },
) {
  return async function read(
    client: DbClient,
    actor: InventoryActor,
    patientId: string,
  ) {
    requireInventoryIntegration();
    invariant(
      validId(patientId),
      "invalid_patient_id",
      "An exact patient ID is required",
    );
    const principal = await resolveInventoryPrincipal(dependencies, actor);
    try {
      await client.query("SAVEPOINT patient_cost_read_probe");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "25P01"
      )
        throw new InventoryDomainError(
          "transaction_required",
          "A caller-owned read transaction is required",
        );
      throw error;
    }
    await client.query("RELEASE SAVEPOINT patient_cost_read_probe");
    const snapshot = (
      await client.query<{ isolation: string; read_only: string; at: Date }>(
        "SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,transaction_timestamp() AS at",
      )
    ).rows[0];
    invariant(
      snapshot.read_only === "on" &&
        ["repeatable read", "serializable"].includes(snapshot.isolation),
      "read_snapshot_required",
      "Use a repeatable-read read-only transaction",
    );
    const who = (
      await client.query<{
        username: string;
        role: string;
        is_active: boolean;
      }>("SELECT username,role,is_active FROM users WHERE id=$1", [
        actor.userId,
      ])
    ).rows[0];
    invariant(
      who?.is_active &&
        who.username === actor.username &&
        who.role === actor.role,
      "actor_forbidden",
      "Authenticated actor is not active in this snapshot",
    );
    const grant = await dependencies.authorizeRead(
      client,
      principal,
      actor,
      patientId,
    );
    invariant(
      grant?.patientId === patientId &&
        grant.realmId === principal.realmId &&
        grant.subjectId === principal.subjectId,
      "cost_read_forbidden",
      "Canonical patient cost read authorization is required",
    );
    const ready = (
      await client.query<{ ready: boolean }>(
        "SELECT to_regclass('custody_usage_events') IS NOT NULL AND to_regclass('supplier_invoice_postings') IS NOT NULL AND to_regclass('inventory_effective_invoice_allocations') IS NOT NULL AS ready",
      )
    ).rows[0];
    invariant(
      ready.ready,
      "schema_not_ready",
      "Source schemas await coordinated integration",
    );
    invariant(
      (await client.query("SELECT id FROM patients WHERE id=$1", [patientId]))
        .rows.length === 1,
      "patient_not_found",
      "Patient was not found",
    );
    const usages = await client.query<Usage>(
      "SELECT id::text,usage_key,location_id,lot_id::text,movement_id,qty::text,quantity_state,patient_id,visit_id,case_id,procedure_id,document,created_at FROM custody_usage_events WHERE kind='consumed' AND (patient_id=$1 OR document->>'patientId'=$1) ORDER BY created_at,id LIMIT 1001",
      [patientId],
    );
    invariant(
      usages.rows.length <= LIMIT,
      "cost_report_too_large",
      "Patient evidence exceeds the bounded report size",
    );
    const at = snapshot.at.toISOString(),
      rows: PatientConsumptionCostRow[] = [],
      baseIssues: TreatmentIssue[] = [],
      nativeIssues: TreatmentIssue[] = [];
    const lotValues = new Map<string, Valuation>();
    const invoiceCache = new Map<
      string,
      Awaited<ReturnType<typeof invoicePortions>>
    >();
    for (const u of usages.rows) {
      const row: PatientConsumptionCostRow = {
        usageId: u.id,
        movementId: null,
        patientId,
        visitId: null,
        caseId: null,
        procedureId: null,
        clinicalAttribution: "missing",
        doctorAttribution: "missing",
        doctorId: null,
        quantityAtoms: null,
        quantityState: u.quantity_state,
        lotId: null,
        ...failed(u.id, at, "clinical_evidence_mismatch"),
        roundedNativeMinor: null,
        roundedBaseMinor: null,
      };
      try {
        await clinical(client, u, patientId);
        const lot = (
          await client.query<Lot>(
            `SELECT l.id::text,l.receipt_line_id,l.item_id,l.location_id,l.movement_id,l.cost_snapshot,gr.created_at,g.base_qty::text AS receipt_qty,g.document AS receipt_document,g.order_id::text,g.order_line_id FROM stock_lots l LEFT JOIN goods_receipt_lines g ON g.id=l.receipt_line_id LEFT JOIN goods_receipts gr ON gr.id=g.receipt_id WHERE l.id=$1`,
            [u.lot_id],
          )
        ).rows[0];
        evidence(lot, "lot_evidence_missing");
        evidence(
          lot.cost_snapshot.conversion &&
            typeof lot.cost_snapshot.conversion === "object",
          "historical_conversion_missing",
        );
        const conversion = unitConversionSnapshot(
          lot.cost_snapshot.conversion as Parameters<
            typeof unitConversionSnapshot
          >[0],
        );
        const qty = quantityAtoms(u.qty, conversion.basePrecision);
        evidence(
          lot.receipt_qty && qty <= quantityAtoms(lot.receipt_qty),
          "consumption_exceeds_receipt",
        );
        const movement = (
          await client.query<{
            kind: string;
            item_id: number;
            qty: string;
            is_return: boolean;
          }>(
            "SELECT kind,item_id,qty::text,is_return FROM inventory_movements WHERE id=$1",
            [u.movement_id],
          )
        ).rows[0];
        const allocations = await client.query<{
          lot_id: string;
          location_id: string;
          qty: string;
        }>(
          "SELECT lot_id::text,location_id,qty::text FROM inventory_movement_allocations WHERE movement_id=$1",
          [u.movement_id],
        );
        evidence(
          movement &&
            movement.kind === "out" &&
            !movement.is_return &&
            movement.item_id === lot.item_id &&
            quantityAtoms(movement.qty) === qty &&
            allocations.rows.length === 1 &&
            allocations.rows[0].lot_id === lot.id &&
            allocations.rows[0].location_id === u.location_id &&
            quantityAtoms(allocations.rows[0].qty) === qty,
          "consumption_movement_mismatch",
        );
        evidence(
          (
            await client.query(
              "SELECT id FROM custody_usage_events WHERE movement_id=$1 LIMIT 2",
              [u.movement_id],
            )
          ).rows.length === 1,
          "duplicate_consumption_movement",
        );
        evidence(
          u.document.lotId === lot.id &&
            u.document.itemId === lot.item_id &&
            u.document.locationId === u.location_id &&
            quantityAtoms(u.document.baseQuantity) === qty &&
            u.document.quantityState === u.quantity_state,
          "consumption_document_mismatch",
        );
        let value = lotValues.get(lot.id);
        if (!value) {
          value = await valueLot(client, lot, principal, at, invoiceCache);
          lotValues.set(lot.id, value);
        }
        Object.assign(row, value, {
          movementId: String(u.movement_id),
          lotId: lot.id,
          quantityAtoms: safe(qty),
          clinicalAttribution: "verified",
          visitId: u.visit_id,
          caseId: u.case_id,
          procedureId: u.procedure_id,
        });
        const baseIssue = {
          movementId: String(u.movement_id),
          usageKey: u.usage_key,
          itemId: String(lot.item_id),
          baseUnit: conversion.baseUnit,
          atomsPerUnit: 1000,
          quantityAtoms: safe(qty),
          quantityState: u.quantity_state,
          allocations: [
            {
              id: u.id,
              patientId,
              visitId: u.visit_id,
              caseId: u.case_id,
              procedureId: u.procedure_id,
              quantityAtoms: safe(qty),
            },
          ],
        };
        row.roundedBaseMinor =
          value.base.state === "missing"
            ? null
            : proportionalCostMinor(
                value.base.amountMinor,
                safe(qty),
                value.base.pricedQuantityAtoms,
              );
        row.roundedNativeMinor =
          !value.native || value.native.state === "missing"
            ? null
            : proportionalCostMinor(
                value.native.amountMinor,
                safe(qty),
                value.native.pricedQuantityAtoms,
              );
        // Publish into summaries only after all row validation and display arithmetic succeeds.
        baseIssues.push({ ...baseIssue, cost: value.base });
        if (value.native)
          nativeIssues.push({ ...baseIssue, cost: value.native });
      } catch (error) {
        if (error instanceof InventoryDomainError) {
          const reason =
            error.code === "cost_evidence_missing" ? error.message : error.code;
          Object.assign(row, failed(u.id, at, reason), {
            clinicalAttribution: "missing",
            movementId: null,
            lotId: null,
            visitId: null,
            caseId: null,
            procedureId: null,
            quantityAtoms: null,
            roundedBaseMinor: null,
            roundedNativeMinor: null,
          });
        } else throw error;
      }
      rows.push(row);
    }
    // Keep base and native streams distinct even when native currency is YER.
    const summarize = (currency: Currency, selected: TreatmentIssue[]) =>
      summarizeTreatmentCost({
        currency,
        scope: { kind: "patient", patientId },
        issues: selected,
        returns: [],
        registrationComplete: false,
      });
    return {
      patientId,
      asOf: at,
      registration: {
        state: "unproven" as const,
        reason: "No authoritative complete material-registration evidence",
      },
      doctorAttribution: "missing" as const,
      rows,
      base: summarize("YER", baseIssues),
      native: (["YER", "SAR", "USD"] as const)
        .filter((currency) =>
          nativeIssues.some((i) => i.cost.currency === currency),
        )
        .map((currency) =>
          summarize(
            currency,
            nativeIssues.filter((i) => i.cost.currency === currency),
          ),
        ),
      rejectedUsageIds: rows
        .filter((r) => r.clinicalAttribution === "missing")
        .map((r) => r.usageId),
      readOnly: true as const,
    };
  };
}
