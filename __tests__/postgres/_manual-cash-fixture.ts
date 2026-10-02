import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema } from "./_setup";

/** Fresh-only by default; explicit disposable CI opt-in follows the existing
 * suite lifecycle after validating the ORIGINAL target/classifications. */
export async function prepareManualCashFixture(environment: NodeJS.ProcessEnv): Promise<void> {
  const target = validatePostgresTestTarget(environment);
  if (environment.MANUAL_CASH_CI_DISPOSABLE_FIXTURE === "1") {
    await dropPublicSchema(target.testUrl.toString());
  }
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await client.connect();
  try {
    const { rows: [row] } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
    );
    if (row.n !== 0) throw new Error("Manual cash proof requires a NEW empty synthetic database; do not erase a schema");
  } finally { await client.end(); }
}
