// Reads every patient's canonical per-currency balances with ONE runtime's own readers.
// Run with the deployed runtime before the upgrade and the candidate after it: equal output proves
// existing financial records still mean the same. Usage: tsx balances.mjs <runtime root>
import { guardHelperProcess } from "./guard.mjs";

// Refuses a non-loopback DATABASE_URL and strips rerouting variables BEFORE any runtime module is imported.
guardHelperProcess();
const root = process.argv[2];
if (!root) throw new Error("runtime root required");
const db = await import(`${root}/lib/db.ts`);
const { rows } = await db.getPool().query("SELECT id FROM patients ORDER BY id");
const out = {};
for (const { id } of rows) {
  const ledger = await db.patientLedger(id);
  out[id] = db.ledgerBalancesByCurrency(id, ledger, await db.patientPlanCurrencies(id));
}
await db.resetPoolForTesting?.();
console.log(JSON.stringify({ balances: out }));
process.exit(0);
