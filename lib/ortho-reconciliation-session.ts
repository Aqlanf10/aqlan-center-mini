import type { Client } from "pg";
import { applySyntheticOrthoReconciliation, reportOrthoReconciliation } from "./ortho-reconciliation";

export class OperatorCleanupFailure extends Error {
  constructor(public readonly outcome: "committed" | "read_only" | "unknown") { super("ORTHO_OPERATOR_CLEANUP_FAILED"); }
}

/** Do not expose a result until transaction completion AND connection cleanup
 * succeed. In particular a confirmed COMMIT is never described as rolled back.
 */
export async function runOrthoOperatorSession(client: Client, options: {
  apply: boolean;
  expected: Parameters<typeof applySyntheticOrthoReconciliation>[1];
}) {
  let result: Awaited<ReturnType<typeof applySyntheticOrthoReconciliation>> | Awaited<ReturnType<typeof reportOrthoReconciliation>> | undefined;
  let failure: unknown;
  let failed = false;
  let connectionError = false;
  client.on("error", () => { connectionError = true; });
  try {
    await client.connect();
    if (options.apply) result = await applySyntheticOrthoReconciliation(client, options.expected);
    else {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const report = await reportOrthoReconciliation(client);
      await client.query("ROLLBACK");
      result = report;
    }
  } catch (error) { failed = true; failure = error; }
  try {
    await client.end();
    if (connectionError) throw new Error("CONNECTION_CLEANUP_FAILED");
  } catch {
    throw new OperatorCleanupFailure(options.apply ? (result ? "committed" : "unknown") : "read_only");
  }
  if (failed) throw failure;
  return result!;
}
