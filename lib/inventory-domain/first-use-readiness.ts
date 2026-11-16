import "server-only";
import type { DbClient } from "../db";
import { INVENTORY_PROTECTED_HISTORY_TABLES } from "./reset-protection";
import { InventoryDomainError } from "./quantities";

const REFERENCES = ["inventory_items", "inventory_item_unit_versions", "inventory_locations", "inventory_approval_policies"] as const;
const HISTORY = ["inventory_movements", "inventory_purchase_receipts", ...INVENTORY_PROTECTED_HISTORY_TABLES] as const;
const FINANCE = ["parties", "payables", "expenses", "expense_payable_allocations"] as const;
// The transport proposal is on hold; its presence must still be inspected, but
// its absence does not pretend that an unaccepted migration is required.
const OPTIONAL_TRANSPORT = new Set<string>(["inventory_supplier_intents", "inventory_supplier_intent_rejections"]);
const TABLES = [...REFERENCES, ...HISTORY, ...FINANCE];

export interface InventoryReadinessCount {
  table: string;
  /** Decimal count, never a balance or a sum of these overlapping evidence rows. */
  count: string | null;
}
export interface InventoryFirstUseReadiness {
  observedAt: string;
  snapshotOnly: true;
  state: "schema_incomplete" | "history_review_required" | "first_use_candidate";
  /** Presence of the fixed count tables only; not migration/trigger/restore acceptance. */
  schemaCoverage: "complete" | "missing_tables";
  missingTables: string[];
  references: InventoryReadinessCount[];
  inventoryHistory: InventoryReadinessCount[];
  /** Shared supplier finance can predate inventory; it is never adopted/erased. */
  protectedSupplierFinance: {
    liabilities: string | null;
    payments: string | null;
    allocations: string | null;
  };
}

/** Count-only observation, NOT permission to activate or write. The caller must
 * authorize this read through central authority and own a REPEATABLE READ
 * transaction. It may permit row locks for central authority revalidation. No connection, schema provisioning, role inference, history
 * adoption or mutation occurs here. A later write must revalidate independently.
 */
export async function readFirstUseReadinessInTransaction(client: DbClient): Promise<InventoryFirstUseReadiness> {
  try { await client.query("SAVEPOINT inventory_readiness_transaction_check"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "25P01")
      throw new InventoryDomainError("transaction_required", "Readiness requires a caller-owned snapshot transaction");
    throw error;
  }
  await client.query("RELEASE SAVEPOINT inventory_readiness_transaction_check");
  return readFirstUseReadinessFacts(client);
}
/** The same count-only facts for an owner that already proved its own REPEATABLE READ
 * READ ONLY snapshot (the canonical owning reader); no savepoint probe, no locks. */
export async function readFirstUseReadinessFacts(client: Pick<DbClient, "query">): Promise<InventoryFirstUseReadiness> {
  const { rows: [snapshot] } = await client.query<{ isolation: string; observed_at: string }>(
    `SELECT current_setting('transaction_isolation') AS isolation,
      to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at`);
  if (!snapshot || !["repeatable read", "serializable"].includes(snapshot.isolation))
    throw new InventoryDomainError("readiness_snapshot_required", "Readiness requires a repeatable snapshot");

  const { rows: present } = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind IN ('r','p')`, [TABLES]);
  const available = new Set(present.map(row => row.name));
  const observedTables = [...REFERENCES, ...HISTORY].filter(table => available.has(table));
  // Identifiers come only from fixed source constants, and are always qualified.
  const counts = observedTables.length ? (await client.query<{ name: string; n: string }>(
    observedTables.map(table => `SELECT '${table}' AS name, count(*)::text AS n FROM public."${table}"`).join(" UNION ALL "))).rows : [];
  const byTable = new Map(counts.map(row => [row.name, row.n]));
  const list = (tables: readonly string[]): InventoryReadinessCount[] => tables.map(table => ({ table, count: byTable.get(table) ?? null }));
  const missingTables = TABLES.filter(table => !OPTIONAL_TRANSPORT.has(table) && !available.has(table));
  const inventoryHistory = list(HISTORY);
  const hasHistory = inventoryHistory.some(row => row.count !== null && row.count !== "0");
  let liabilities: string | null = null, payments: string | null = null, allocations: string | null = null;
  if (FINANCE.every(table => available.has(table))) {
    // Count documents, including reversals/voids and on-account payments. EXISTS
    // avoids counting one expense twice when it has multiple allocations.
    const { rows: [finance] } = await client.query<{ liabilities: string; payments: string; allocations: string }>(
      `WITH supplier_liabilities AS (
         SELECT p.id FROM public.payables p JOIN public.parties s ON s.id=p.party_id
         WHERE s.kind='supplier' OR p.category='supplier'
       ) SELECT
       (SELECT count(*)::text FROM supplier_liabilities) AS liabilities,
       (SELECT count(*)::text FROM public.expenses e WHERE e.category='supplier'
         OR EXISTS(SELECT 1 FROM public.parties s WHERE s.id=e.party_id AND s.kind='supplier')
         OR EXISTS(SELECT 1 FROM supplier_liabilities p WHERE p.id=e.payable_id)
         OR EXISTS(SELECT 1 FROM public.expense_payable_allocations a JOIN supplier_liabilities p ON p.id=a.payable_id WHERE a.expense_id=e.id)) AS payments,
       (SELECT count(*)::text FROM public.expense_payable_allocations a JOIN supplier_liabilities p ON p.id=a.payable_id) AS allocations`);
    ({ liabilities, payments, allocations } = finance);
  }
  return {
    observedAt: snapshot.observed_at, snapshotOnly: true,
    state: hasHistory ? "history_review_required" : missingTables.length ? "schema_incomplete" : "first_use_candidate",
    schemaCoverage: missingTables.length ? "missing_tables" : "complete",
    missingTables, references: list(REFERENCES), inventoryHistory,
    protectedSupplierFinance: { liabilities, payments, allocations },
  };
}
