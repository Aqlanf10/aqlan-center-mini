import type { Client } from "pg";

export const OPERATOR_LIMITS = {
  connectionTimeoutMillis: 5_000,
  query_timeout: 65_000,
  statementMs: 60_000,
  lockMs: 30_000,
  idleTransactionMs: 10_000,
  transactionMs: 120_000,
  processMs: 180_000,
} as const;

export const OPERATOR_SESSION_OPTIONS = `-c search_path=pg_catalog,public -c statement_timeout=${OPERATOR_LIMITS.statementMs} -c lock_timeout=${OPERATOR_LIMITS.lockMs} -c idle_in_transaction_session_timeout=${OPERATOR_LIMITS.idleTransactionMs} -c transaction_timeout=${OPERATOR_LIMITS.transactionMs}`;

/** Operator functions require a dedicated connection, never an application pool.
 * SELECT-only session configuration also bounds direct library callers.
 */
export async function configureOperatorTimeouts(client: Client) {
  await client.query(`SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),
    set_config('idle_in_transaction_session_timeout',$3,false),set_config('transaction_timeout',$4,false)`,
  [String(OPERATOR_LIMITS.statementMs), String(OPERATOR_LIMITS.lockMs), String(OPERATOR_LIMITS.idleTransactionMs), String(OPERATOR_LIMITS.transactionMs)]);
}
