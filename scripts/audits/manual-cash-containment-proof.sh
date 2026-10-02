#!/usr/bin/env bash
# Standalone, synthetic-only positive containment contract. A failing result
# is never swallowed and its private synthetic data/logs are retained.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$REPO_ROOT"
: "${PG18_BIN_DIR:?Point PG18_BIN_DIR to an already-installed PostgreSQL 18 bin directory}"
NODE_BIN=${NODE_BIN:-node}
PORT=${MANUAL_CASH_TEST_PORT:-56639}
OUTPUT_ROOT=${MANUAL_CASH_TEST_OUTPUT_ROOT:-"$(dirname "$REPO_ROOT")"}
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo "Invalid private port" >&2; exit 1; }

# Check the ORIGINAL environment and all supplied aliases before replacing a
# test connection value. Do not hide Railway/Production classifications.
"$NODE_BIN" --input-type=module -e '
  import { validateOperationalVerificationEnvironment } from "./lib/verification-target-policy.mjs";
  validateOperationalVerificationEnvironment(process.env);
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Node 22 required");
'
"$PG18_BIN_DIR/pg_ctl" --version | grep -Eq 'PostgreSQL\) 18\.' || { echo "PostgreSQL 18 required" >&2; exit 1; }

RUN_ROOT=$(mktemp -d "$OUTPUT_ROOT/manual-cash-containment-pg18.XXXXXX")
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
  -o "-h 127.0.0.1 -p $PORT -c unix_socket_directories=''" -w start

export TEST_DATABASE_URL="postgresql://ci@127.0.0.1:$PORT/aqlan_p1_test?sslmode=disable"
export DATABASE_URL="$TEST_DATABASE_URL" NODE_ENV=test DATABASE_ENVIRONMENT=test
unset USE_LOCAL_DB MANUAL_CASH_CI_DISPOSABLE_FIXTURE
"$NODE_BIN" --import tsx --input-type=module -e '
  import { Client } from "pg";
  import { validatePostgresTestTarget } from "./__tests__/postgres/_safe-target.ts";
  const target = validatePostgresTestTarget(process.env);
  const connection = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await connection.connect();
  try {
    const { rows: [row] } = await connection.query("SELECT current_setting('\''server_version_num'\'') AS version");
    if (Math.floor(Number(row.version) / 10000) !== 18) throw new Error("PostgreSQL 18 required");
    await connection.query("CREATE DATABASE aqlan_p1_test");
  } finally { await connection.end(); }
'
"$NODE_BIN" node_modules/vitest/vitest.mjs run --config vitest.config.postgres.mts \
  __tests__/postgres/manual-cash-containment.test.ts 2>&1 | tee "$RUN_ROOT/postgres.log"
printf 'Prospective containment contract passed against this local runtime. No Production verification was performed.\n'
