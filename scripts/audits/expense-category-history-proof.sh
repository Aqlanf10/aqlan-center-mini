#!/usr/bin/env bash
# Reproducible local-only audit. Requires installed Node 22, dependencies and
# PostgreSQL 18 binaries. Creates a NEW cluster; never erases an existing DB.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$REPO_ROOT"
: "${PG18_BIN_DIR:?Point PG18_BIN_DIR to an already-installed PostgreSQL 18 bin directory}"
NODE_BIN=${NODE_BIN:-node}
PORT=${CATEGORY_HISTORY_TEST_PORT:-56547}
OUTPUT_ROOT=${CATEGORY_HISTORY_TEST_OUTPUT_ROOT:-"$(dirname "$REPO_ROOT")"}
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo "Invalid local port" >&2; exit 1; }

# Refuse original Production/Railway classifications before setting any test
# variables. No environment files, credentials or Production URLs are loaded.
"$NODE_BIN" --input-type=module -e '
  import { validateLocalVerificationEnvironment } from "./lib/verification-target-policy.mjs";
  validateLocalVerificationEnvironment(process.env, "CATEGORY_HISTORY_TEST_UNSAFE_ENV");
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Node 22 required");
'
"$PG18_BIN_DIR/pg_ctl" --version | grep -Eq 'PostgreSQL\) 18\.' || { echo "PostgreSQL 18 required" >&2; exit 1; }

RUN_ROOT=$(mktemp -d "$OUTPUT_ROOT/category-history-containment-pg18.XXXXXX")
STARTED=0
cleanup() {
  if (( STARTED )); then
    "$PG18_BIN_DIR/pg_ctl" -D "$RUN_ROOT/data" -m fast -w stop > "$RUN_ROOT/stop.log" 2>&1 || {
      echo "WARNING: inspect $RUN_ROOT/stop.log; cluster stop failed" >&2
      return 1
    }
  fi
}
trap cleanup EXIT
printf 'Synthetic audit artifacts retained at %s\n' "$RUN_ROOT"
"$PG18_BIN_DIR/initdb" -D "$RUN_ROOT/data" -U ci --auth=trust --encoding=UTF8 --locale=C > "$RUN_ROOT/init.log"
"$PG18_BIN_DIR/pg_ctl" -D "$RUN_ROOT/data" -l "$RUN_ROOT/server.log" \
  -o "-h 127.0.0.1 -p $PORT -c unix_socket_directories=''" -w start
STARTED=1

export TEST_DATABASE_URL="postgresql://ci@127.0.0.1:$PORT/aqlan_p1_test?sslmode=disable"
export DATABASE_URL="$TEST_DATABASE_URL" NODE_ENV=test DATABASE_ENVIRONMENT=test
unset CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE
unset USE_LOCAL_DB

# Validate the exact test URL with the real canonical guard before creating
# its new, known-empty database on this newly created private cluster.
"$NODE_BIN" --import tsx --input-type=module -e '
  import { Client } from "pg";
  import { validatePostgresTestTarget } from "./__tests__/postgres/_safe-target.ts";
  const target = validatePostgresTestTarget(process.env);
  const client = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await client.connect();
  try {
    const { rows: [row] } = await client.query("SELECT current_setting('\''server_version_num'\'') AS version");
    if (Math.floor(Number(row.version) / 10000) !== 18) throw new Error("PostgreSQL 18 required");
    await client.query("CREATE DATABASE aqlan_p1_test");
  } finally { await client.end(); }
'
"$NODE_BIN" node_modules/vitest/vitest.mjs run --config vitest.config.postgres.mts \
  __tests__/postgres/expense-category-history-containment.test.ts \
  2>&1 | tee "$RUN_ROOT/postgres.log"
printf 'Desired containment regressions passed. This does not establish historical remediation or coverage of party/lab settings.\n'
