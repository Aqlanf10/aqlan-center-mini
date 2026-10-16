# Dormant integration rollout — PR338

## Boundary

`INVENTORY_INTEGRATION_ENABLED` is a private server runtime setting. Only the exact
value `true` enables procurement and custody. Unset, false, malformed, or public
client settings leave them disabled. Do not configure it in `next.config` or use a
`NEXT_PUBLIC_` alias. Dynamic server pages pass only the evaluated boolean to the
legacy inventory overview. Direct procurement/custody pages show an unavailable
message and never mount their fetching/mutation components. GET and POST on the
exact procurement API return 503 / `inventory_integration_disabled` after normal session validation and before body
parsing or store calls. Authentication queries remain permitted; disabled store
access does not bypass authentication. Both store readiness paths fail before schema/pool access.
The shared transactional writer covers procurement and custody mutations.

Legacy inventory remains available, including its valuation/review page, movements,
expiry/stock alerts, historical-unit protections, and cost visibility improvements.
This gate does not register or apply either proposal SQL module. Schema existence
is not an enablement signal. Existing authentication/authorization still applies.

## Verification separation

- Default `npm run test:security-http`: built application, private gate unset (default closed),
  registered main schema only; proposal HTTP suite excluded. Disabled-route tests
  check hidden links, all direct pages, all new commands, no new fetches, unchanged
  schema and inventory/audit counts. Existing foundation and overview suites prove
  legacy inventory behavior against that same schema.
- `INVENTORY_SCHEMA_TEST=1 npm run test:security-http`: separate disposable HTTP
  database and server; only the proposal suite runs. The test harness enables the
  private flag for that server and the suite installs proposal SQL in its isolated
  fixture. CI runs both rounds sequentially against the same compiled artifact.
- PostgreSQL procurement/custody files explicitly stub the server flag for their
  isolated proposal fixtures and restore it afterward. Domain tests stay available.
- Unit rollout tests verify default rejection and zero database/transaction access.

## Required before any future integration activation (not performed)

1. Root approves the integrated PR head and its complete CI, independently reviews
   the gate and the existing procurement/custody invariants, and authorizes the
   next integration phase. This PR is not merged or deployed by this task.
2. Coordinate migration ownership with the schema owner: allocate migration IDs,
   review all 29 proposed tables, dependencies, constraints, indexes and audit
   coverage; register migrations and update schema/ownership contracts in a
   separately approved change. Do not execute proposal SQL ad hoc on a live DB.
3. Rehearse forward migration and recovery on a disposable copy with synthetic or
   approved sanitized data; prove legacy quantity/cost preservation, concurrency,
   retry idempotency, authorization and failure rollback on PostgreSQL 18. Capture
   backups/restore evidence and an approved recovery procedure before live work.
4. Reconcile historical stock and establish reviewed unit versions, locations,
   doctor ownership, lots, opening balances and cost provenance. No automatic
   assumption that old quantities imply reconciled lots or known zero costs.
5. Obtain explicit financial approval for receipt-to-stock, supplier payable,
   tax/FX/currency, valuation and patient-treatment-cost integration boundaries.
   Confirm accounting postings and reversal ownership; no financial integration
   or live permission changes are authorized by this gate work.
6. Define and review approval policies, self-approval rules, custody acceptance,
   expiry/quarantine, waste, package closure evidence and annual settlement roles.
   Seed only reviewed reference data through approved tooling, not test fixtures.
7. Staging remains stopped under the financial agreement. Obtain explicit approval
   before restarting or changing it, then perform an approved staging rehearsal
   with the flag still closed first. Confirm all registered migrations, schema
   readiness and operational monitoring before any enabled acceptance run.
8. Approve a separate activation window, responsible operators, alerts and rollback
   criteria. Set the private flag only after schema/integration sign-off; smoke-test
   old and new paths and permissions. Turning it off blocks new access/writes but
   does not undo prior postings or migrate data backward; rollback needs its own
   reviewed reconciliation procedure.

No production/staging settings, live permissions, financial records, SQL deployment,
or migration registration are changed by this phase.
