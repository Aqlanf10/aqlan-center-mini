import { Client } from "pg";
import { validateLocalVerificationTarget } from "../lib/verification-target-policy.mjs";
import { applySyntheticOrthoReconciliation, reportOrthoReconciliation, ReconciliationRefused } from "../lib/ortho-reconciliation";

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
  const client = new Client({ connectionString: url.toString(), ssl: false,
    options: apply ? "-c search_path=pg_catalog,public" : "-c default_transaction_read_only=on -c search_path=pg_catalog,public" });
  client.on("error", () => { /* pending queries reject; never print raw connection errors */ });
  await client.connect();
  try {
    if (apply) {
      console.log(JSON.stringify(await applySyntheticOrthoReconciliation(client, expected)));
    } else {
      if (args.length) throw new ReconciliationRefused("target");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      console.log(JSON.stringify(await reportOrthoReconciliation(client)));
      await client.query("ROLLBACK");
    }
  } finally { await client.end(); }
}
main().catch(error => {
  console.error(JSON.stringify({ event: "ortho_reconciliation_refused", category: error instanceof ReconciliationRefused ? error.category : "unclassified" }));
  process.exitCode = 1;
});
