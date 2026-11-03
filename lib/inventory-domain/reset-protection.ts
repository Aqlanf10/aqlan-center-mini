import type { DbClient } from "../db";

/** Optional until coordinated migration registration; never erase historical proof. */
export const INVENTORY_PROTECTED_HISTORY_TABLES = [
  "purchase_requests", "purchase_request_revisions", "purchase_request_lines",
  "purchase_approval_events", "purchase_orders", "purchase_order_lines",
  "purchase_order_source_allocations", "goods_receipts", "goods_receipt_lines",
  "stock_lots", "inventory_movement_allocations", "quarantine_dispositions",
  "supplier_invoices", "supplier_invoice_receipt_allocations", "supplier_invoice_payable_links",
  "inventory_operations", "inventory_transfers", "inventory_transfer_lines",
  "inventory_transfer_acknowledgements", "inventory_transfer_ack_lines",
  "custody_waste_approvals", "custody_usage_events", "custody_stocktakes",
  "custody_package_closures", "custody_annual_settlements", "custody_settlement_objections",
  "supplier_invoice_finance_roots", "supplier_invoice_revisions",
  "supplier_invoice_postings", "supplier_invoice_cancellations",
  "inventory_command_bindings", "inventory_command_retirements", "inventory_supplier_intents",
  "inventory_supplier_intent_rejections",
  "supplier_invoice_number_claims",
] as const;

export class ProtectedInventoryHistoryError extends Error {
  constructor() {
    super("لا يمكن إعادة الضبط بعد تسجيل طلبات المخزون أو حركاته أو نتائجه المالية. لم يُمسح شيء؛ يجب الاحتفاظ بالمستندات ومفاتيح الطلبات وتاريخها.");
    this.name = "ProtectedInventoryHistoryError";
  }
}

/** Caller first holds PURCHASE_RESET_FENCE exclusively. Returns only locked empty tables. */
export async function protectInventoryHistoryForReset(client: DbClient): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM unnest($1::text[]) name WHERE to_regclass('public.' || name) IS NOT NULL ORDER BY name",
    [INVENTORY_PROTECTED_HISTORY_TABLES],
  );
  const tables = rows.map(row => row.name);
  if (!tables.length) return [];
  // These identifiers come from the fixed source list, never a request.
  await client.query(`LOCK TABLE ${tables.map(table => `"${table}"`).join(", ")} IN EXCLUSIVE MODE`);
  for (const table of tables) {
    if ((await client.query(`SELECT 1 FROM "${table}" LIMIT 1`)).rows.length)
      throw new ProtectedInventoryHistoryError();
  }
  // Empty referencing tables must join TRUNCATE, without CASCADE or history loss.
  return tables;
}
