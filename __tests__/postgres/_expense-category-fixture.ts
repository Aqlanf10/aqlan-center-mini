import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema } from "./_setup";

/** Default proof is read-only on a nonempty target. Only the disposable CI
 * service fixture opts into the suite's established reset lifecycle. Revalidate
 * the original (pre-stub) environment before either a reset or any connection. */
export async function prepareExpenseCategoryHistoryFixture(environment: NodeJS.ProcessEnv): Promise<void> {
  const target = validatePostgresTestTarget(environment);
  if (environment.CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE === "1") {
    await dropPublicSchema(target.testUrl.toString());
  }
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await client.connect();
  try {
    const { rows: [row] } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
    );
    if (row.n !== 0) {
      throw new Error("Focused containment proof requires a NEW empty synthetic database; do not erase a schema");
    }
  } finally { await client.end(); }
}
