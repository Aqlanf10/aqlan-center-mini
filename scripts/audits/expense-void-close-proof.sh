#!/usr/bin/env bash
# Focused source-linked reversal/close proof on a NEW private synthetic cluster.
# Failures remain failures; retain evidence and stop the cluster on every exit.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$REPO_ROOT"
: "${PG18_BIN_DIR:?Point PG18_BIN_DIR to an already-installed PostgreSQL 18 bin directory}"
NODE_BIN=${NODE_BIN:-node}
PORT=${EXPENSE_VOID_TEST_PORT:-56647}
OUTPUT_ROOT=${EXPENSE_VOID_TEST_OUTPUT_ROOT:-"$(dirname "$REPO_ROOT")"}
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo "Invalid private port" >&2; exit 1; }

# Preserve and validate the original aliases/classifications before supplying
# our generated loopback target. No Railway/Production marker is hidden.
"$NODE_BIN" --input-type=module -e '
  import { validateOperationalVerificationEnvironment } from "./lib/verification-target-policy.mjs";
  validateOperationalVerificationEnvironment(process.env);
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Node 22 required");
'
"$PG18_BIN_DIR/pg_ctl" --version | grep -Eq 'PostgreSQL\) 18\.' || { echo "PostgreSQL 18 required" >&2; exit 1; }

RUN_ROOT=$(mktemp -d "$OUTPUT_ROOT/expense-void-close-pg18.XXXXXX")
cleanup() {
  if "$PG18_BIN_DIR/pg_ctl" -D "$RUN_ROOT/data" status >/dev/null 2>&1; then
    "$PG18_BIN_DIR/pg_ctl" -D "$RUN_ROOT/data" -m fast -w stop > "$RUN_ROOT/stop.log" 2>&1 || {
      echo "WARNING: inspect $RUN_ROOT/stop.log; private cluster stop failed" >&2
      return 1
    }
  fi
}
trap cleanup EXIT
printf 'Synthetic test data and logs retained at %s\n' "$RUN_ROOT"
"$PG18_BIN_DIR/initdb" -D "$RUN_ROOT/data" -U ci --auth=trust --encoding=UTF8 --locale=C > "$RUN_ROOT/init.log"
"$PG18_BIN_DIR/pg_ctl" -D "$RUN_ROOT/data" -l "$RUN_ROOT/server.log" \
  -o "-h 127.0.0.1 -p $PORT -c unix_socket_directories='' -c max_connections=12 -c shared_buffers=16MB" -w start

export TEST_DATABASE_URL="postgresql://ci@127.0.0.1:$PORT/aqlan_p1_test?sslmode=disable"
export DATABASE_URL="$TEST_DATABASE_URL" NODE_ENV=test DATABASE_ENVIRONMENT=test
export EXPENSE_VOID_RUN_ROOT="$RUN_ROOT" EXPENSE_VOID_EXPECTED_PORT="$PORT"
unset USE_LOCAL_DB MANUAL_CASH_CI_DISPOSABLE_FIXTURE
"$NODE_BIN" --import tsx --input-type=module -e '
  import { Client } from "pg";
  import { validatePostgresTestTarget } from "./__tests__/postgres/_safe-target.ts";
  const target = validatePostgresTestTarget(process.env);
  const connection = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await connection.connect();
  try {
    const { rows: [row] } = await connection.query("SELECT current_setting('\''server_version_num'\'') AS version, current_setting('\''data_directory'\'') AS data_directory, current_setting('\''port'\'') AS port, current_setting('\''listen_addresses'\'') AS listen_addresses, current_setting('\''unix_socket_directories'\'') AS sockets");
    if (Math.floor(Number(row.version) / 10000) !== 18) throw new Error("PostgreSQL 18 required");
    if (row.data_directory !== `${process.env.EXPENSE_VOID_RUN_ROOT}/data`
      || row.port !== process.env.EXPENSE_VOID_EXPECTED_PORT
      || row.listen_addresses !== "127.0.0.1" || row.sockets !== "") throw new Error("Private server identity mismatch");
    console.log("Verified private PostgreSQL server", row);
    await connection.query("CREATE DATABASE aqlan_p1_test");
  } finally { await connection.end(); }
'
TEST_FILES=(__tests__/postgres/expense-void-close-race.test.ts)
if [[ "${EXPENSE_VOID_RELATED_CONTROLS:-0}" = "1" ]]; then
  # This database was just created in our identity-verified private cluster.
  # Related suites use the established explicitly disposable CI lifecycle.
  export MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1 CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1
  TEST_FILES+=(
    __tests__/postgres/shift-close.test.ts
    __tests__/postgres/supplier-payable-overpayment.test.ts
    __tests__/postgres/multi-currency-ledger.test.ts
    __tests__/postgres/expense-category-history-containment.test.ts
    __tests__/postgres/manual-cash-containment.test.ts
  )
fi
"$NODE_BIN" node_modules/vitest/vitest.mjs run --config vitest.config.postgres.mts --maxWorkers=1 --no-file-parallelism \
  "${TEST_FILES[@]}" 2>&1 | tee "$RUN_ROOT/postgres.log"
printf 'Expense reversal/close contract passed on this local runtime. No Production operation was performed.\n'
