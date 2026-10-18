import type {DbPool} from "./db";
import {INVOICE_CORRECTION_SQL} from "./invoice-correction-schema";
import {INVOICE_CURRENCY_RECLASSIFICATION_SQL} from "./invoice-currency-schema";
import {applyRuntimeMigrationFiles,MIGRATION_ADVISORY_LOCK_KEY} from "./migrations";
import {checksumOf} from "./migration-files";

export const INVOICE_CURRENCY_MIGRATION={version:"0063",name:"invoice_currency_reclassification",
  filename:"0063_invoice_currency_reclassification.sql",sql:INVOICE_CURRENCY_RECLASSIFICATION_SQL,
  checksum:checksumOf(INVOICE_CURRENCY_RECLASSIFICATION_SQL)};
/** Do not reinstall the old same-currency guard over the registered successor.
 * No historical migration/data backfill is invoked by this additive extension. */
export async function ensureInvoiceCurrencySchema(pool:DbPool){
  const client=await pool.connect();let destroy=false;
  try{
    await client.query("SELECT pg_advisory_lock($1)",[MIGRATION_ADVISORY_LOCK_KEY]);
    const {rows:[state]}=await client.query<{present:boolean}>("SELECT to_regclass('invoice_settlement_reclassifications') IS NOT NULL AS present");
    if(!state.present)await client.query(INVOICE_CORRECTION_SQL);
    const shared={query:client.query.bind(client),release(){}};
    await applyRuntimeMigrationFiles({query:shared.query,connect:async()=>shared},[INVOICE_CURRENCY_MIGRATION]);
  }finally{try{await client.query("SELECT pg_advisory_unlock($1)",[MIGRATION_ADVISORY_LOCK_KEY]);}catch{destroy=true;}client.release(destroy);}
}
