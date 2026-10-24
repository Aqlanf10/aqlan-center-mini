import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { runEmpty51Session, validateEmpty51Approval, type Empty51Approval, type Empty51Reference } from "../lib/ortho-empty51-reconciliation";
import { ReconciliationRefused } from "../lib/ortho-reconciliation";
import { OperatorCleanupFailure } from "../lib/ortho-reconciliation-session";
import { OPERATOR_LIMITS, OPERATOR_SESSION_OPTIONS } from "../lib/ortho-reconciliation-limits";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--apply-empty-0051") || process.env.ORTHO_EMPTY51_ENVIRONMENT !== "staging") throw new ReconciliationRefused("target");
  const approval: Empty51Approval = JSON.parse(await readFile(process.env.ORTHO_EMPTY51_APPROVAL_FILE ?? "", "utf8"));
  const reference: Empty51Reference = JSON.parse(await readFile(process.env.ORTHO_EMPTY51_REFERENCE_FILE ?? "", "utf8"));
  validateEmpty51Approval(approval, reference);
  // Dedicated URL only; no app environment loader, DATABASE_URL fallback or URL
  // query options that could override TLS/host/timeouts. No credential output.
  const url = new URL(process.env.ORTHO_EMPTY51_URL ?? "");
  const endpoint = approval.endpoint;
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash
      || url.hostname !== endpoint.host || Number(url.port || 5432) !== endpoint.port
      || decodeURIComponent(url.pathname.slice(1)) !== endpoint.database || decodeURIComponent(url.username) !== endpoint.user) throw new ReconciliationRefused("target");
  const ca = process.env.ORTHO_EMPTY51_CA_FILE ? await readFile(process.env.ORTHO_EMPTY51_CA_FILE, "utf8") : undefined;
  const apply = args.includes("--apply-empty-0051");
  const client = new Client({ host: endpoint.host, port: endpoint.port, database: endpoint.database, user: endpoint.user,
    password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: OPERATOR_LIMITS.connectionTimeoutMillis, query_timeout: OPERATOR_LIMITS.query_timeout,
    options: OPERATOR_SESSION_OPTIONS + (apply ? "" : " -c default_transaction_read_only=on") });
  return runEmpty51Session(client, approval, reference, apply);
}
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ event: "ortho_empty51_refused", category: "deadline", outcome: "unknown" }));
  process.exit(124);
}, OPERATOR_LIMITS.processMs);
main().then(result => console.log(JSON.stringify(result)), error => {
  console.error(JSON.stringify({ event: "ortho_empty51_refused",
    category: error instanceof OperatorCleanupFailure ? "cleanup" : error instanceof ReconciliationRefused ? error.category : "unclassified",
    ...(error instanceof OperatorCleanupFailure ? { outcome: error.outcome } : {}) }));
  process.exitCode = 1;
  if (error instanceof OperatorCleanupFailure) process.exit(1);
}).finally(() => clearTimeout(deadline));
