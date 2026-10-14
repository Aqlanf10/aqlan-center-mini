import { ensureSchema, getPool, getSettingsInTransaction } from "./db";
import { createHash } from "node:crypto";
import type { ParsedInvoiceInput } from "./invoice-input";

export function invoicePricingAudit(snapshots: ParsedInvoiceInput["pricingSnapshots"]) {
  return snapshots.map(snapshot=>({...snapshot,quoteHash:createHash("sha256").update(JSON.stringify([snapshot.serviceId,snapshot.quote])).digest("hex")}));
}

/** Display defaults must never become an invoice's configured FX snapshot. */
export async function invoicePricingSettings() {
  await ensureSchema();
  const client = await getPool().connect();
  try { return await getSettingsInTransaction(client, { requireStoredExchangeRates: true }); }
  finally { client.release(); }
}
