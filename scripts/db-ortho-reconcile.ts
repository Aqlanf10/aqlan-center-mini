import { Client } from "pg";
import { validateLocalVerificationTarget } from "../lib/verification-target-policy.mjs";
import { ReconciliationRefused } from "../lib/ortho-reconciliation";

import { OPERATOR_LIMITS, OPERATOR_SESSION_OPTIONS } from "../lib/ortho-reconciliation-limits";
import { OperatorCleanupFailure, runOrthoOperatorSession } from "../lib/ortho-reconciliation-session";

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply-synthetic" && !arg.startsWith("--expected-oid=") && !arg.startsWith("--capability="))) throw new ReconciliationRefused("target");
  if (new Set(args.map(arg => arg.split("=")[0])).size !== args.length) throw new ReconciliationRefused("target");
  const raw = process.env.ORTHO_RECONCILE_URL;
  let database: string;
  try { database = new URL(raw ?? "").pathname.slice(1); } catch { throw new ReconciliationRefused("target"); }
  if (!/^aqlan_ortho_legacy_[a-f0-9]{32}_[a-z0-9]+$/.test(database)) throw new ReconciliationRefused("target");
  const url = validateLocalVerificationTarget(raw, process.env, { varName: "ORTHO_RECONCILE_URL", databaseName: database, errorPrefix: "ORTHO_RECONCILIATION_TARGET" });
  if (!["127.0.0.1", "[::1]"].includes(url.hostname)) throw new ReconciliationRefused("target");
  const apply = args.includes("--apply-synthetic");
  const expected = { database,
    oid: args.find(arg => arg.startsWith("--expected-oid="))?.slice(15) ?? "",
    capability: args.find(arg => arg.startsWith("--capability="))?.slice(13) ?? "" };
  if (apply && (!/^\d+$/.test(expected.oid) || !/^[a-f0-9]{64}$/.test(expected.capability))) throw new ReconciliationRefused("target");
  if (!apply && args.length) throw new ReconciliationRefused("target");
  const client = new Client({ connectionString: url.toString(), ssl: false,
    connectionTimeoutMillis: OPERATOR_LIMITS.connectionTimeoutMillis, query_timeout: OPERATOR_LIMITS.query_timeout,
    options: `${OPERATOR_SESSION_OPTIONS}${apply ? "" : " -c default_transaction_read_only=on"}` });
  return runOrthoOperatorSession(client, { apply, expected });
}
// Process-level deadline also bounds a stalled socket or cleanup operation.
// Termination closes the connection, but never proves a COMMIT did not occur.
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ event: "ortho_reconciliation_refused", category: "deadline", outcome: "unknown" }));
  process.exit(124);
}, OPERATOR_LIMITS.processMs);
main().then(result => {
  console.log(JSON.stringify(result));
}, error => {
  console.error(JSON.stringify({ event: "ortho_reconciliation_refused",
    category: error instanceof OperatorCleanupFailure ? "cleanup" : error instanceof ReconciliationRefused ? error.category : "unclassified",
    ...(error instanceof OperatorCleanupFailure ? { outcome: error.outcome } : {}) }));
  process.exitCode = 1;
  if (error instanceof OperatorCleanupFailure) process.exit(1);
}).finally(() => clearTimeout(deadline));
