# Prospective manual-cash containment: implementation and evidence

Status: implemented and locally verified; full CI/browser/release gates remain pending. Implementation base: `91a212859714d0a54a0fcdf2b3342a0361910298`, tree `4a0cbba3ee0fbd5c45609b2f1b4df0d4fba03c39`, equivalent to the merged PR198 release. No publication or Production action in this worktree.

The bounded policy rejects any new manual cash-account entry while a shift is open, keeps valid noncash journals, and preserves legacy no-open cash bookkeeping and all historical records. It is temporary containment, not historical reconciliation or a new physical-movement feature.

## Runtime contract and limitations

- `lib/manual-cash-entry.ts` recognizes the existing `CASH_ACCOUNT` codes `1101/1102/1103` without trusting entry date, side, currency or net amount as a bypass
- `createManualEntry` snapshots its lines and validates/classifies/inserts that same snapshot. Its existing transaction sets READ COMMITTED for cash entries, applies a 5-second **per-lock-wait** timeout, takes SHARE on `cashier_shifts`, then checks for any open shift using a separate plain SELECT
- That table lock conflicts with `openShift`'s existing INSERT/ROW EXCLUSIVE, including an inserted but uncommitted opening, and is held until the manual journal commits. A plain status SELECT deliberately avoids closeShift's row-lock/table-lock inversion
- Open shift: `ManualCashEntryConflictError`, code `manual_cash_requires_linked_movement`. Lock timeout (SQLSTATE 55P03): separate code `manual_cash_shift_busy`. Both roll back and map to Arabic HTTP 409; neither records a success audit
- The timeout limits each lock wait, not total transaction duration. Noncash journals do not take this new fence or change isolation/timeout settings
- The form explains the temporary restriction and already preserves the draft on 409. No automatic retry, date substitution, account substitution or shift-closing workaround is introduced
- Legitimate historical cash corrections and initial cash book openings are also refused during an open shift. No-open bookkeeping remains compatible but is not proof that an opening count and GL reconcile. Existing receipt/refund/expense flows remain the valid operational paths when they represent the actual transaction
- No historical rows, amounts, saved counts/expected/differences, category posting policies or account mappings are rewritten. No parallel cash ledger or migration is added
- Manual-entry idempotency and transactional success auditing do not have an existing source-key contract to reuse. They remain explicit follow-up work with the durable source-linked movement design; this slice adds no replay engine and does not claim protection from duplicate successful submissions after an uncertain network response

## Test artifact

`__tests__/postgres/manual-cash-containment.test.ts` calls actual `createManualEntry`, `openShift`, `closeShift`, `getShift`, and `journalEntries`. It has no domain/database mocks. All data is synthetic. The canonical target guard runs before runtime import. Standalone setup refuses a nonempty public schema; only exact `MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1` opts into the existing disposable CI reset lifecycle, after validating the original environment and canonical loopback test target. The normal proof runner clears any inherited opt-in. This mirrors the established category-history fixture safety contract and has independent unsafe-target/opt-in tests.

The fixture installs test-only AFTER INSERT/UPDATE triggers in that synthetic database to pause actual opening/closing writes before commit. No runtime source or product migration contains those triggers. Standalone cleanup normally closes only its own synthetic shift; it never drops/truncates the standalone schema. The broader existing PG suite uses its documented disposable-schema resets.

The typed domain refusals are asserted by their exact code, not “throws anything”: a connection failure must not count as successful containment.

The initial 16-test fixture was red on the old writer; the repaired fixture now has 20 passing positive invariants. The isolated expected-bug audit commit `aa36cd1c766a44d841dedc8552fc1aab1f4c5dc4` was not incorporated into this fix.

## Covered cases

- All three cash accounts, debit and credit; dates in the distant past/future; mismatched account currency; net-zero cash lines
- Refusal inserts no manual header, line or manual audit
- Bank-only journals keep working while open; no-open cash journals keep working without a guessed shift
- Previously written manual journal and closed-shift expected/count/difference snapshots survive unchanged
- Actual opening wins against a cash writer while the new shift is not yet visible
- Cash writer wins and commits completely before the next opening
- Concurrent close and manual posting produce only a typed refusal while open or a complete save after close; no partial entry or generic deadlock error is accepted
- The 5-second cash lock timeout creates no cash header/lines/audit while an independently permitted bank journal still succeeds
- Forced close tuple-lock wait permits prompt cash refusal without a row-lock cycle; a written-but-uncommitted close snapshot makes cash posting wait, then permits no-open bookkeeping
- A direct caller changing its draft during an await cannot change which classified lines are ultimately inserted

## Deterministic opening barriers

Opening-wins test:

1. A controller transaction holds a known test-only transaction advisory lock
2. Call the real `openShift`; the fresh-fixture AFTER INSERT trigger requests that lock after the row is inserted. Use `pg_stat_activity` to observe the actual domain INSERT waiting inside the trigger
3. Call the real `createManualEntry`; observe whether it has finished or another runtime connection is lock-waiting
4. It must not have committed without a shift guard
5. Release the controller; opening must complete first, and cash posting must return the typed refusal with no inserts

This catches the original no-guard writer and tests an opening row that exists but is not visible to another transaction yet. A bare row-lock lookup cannot protect that invisible row. The old writer should fail the “must not commit” assertion. After adding a guard, both post-release outcome and absence of inserts must still pass; merely waiting on a lock is not sufficient proof. Pausing before INSERT would be insufficient because the manual writer could legitimately serialize first; the AFTER INSERT trigger removes that ambiguity.

Manual-wins test:

1. Controller holds SHARE on `journal_manual`, blocking the real manual header INSERT after any preceding shift guard has completed
2. Call the real manual writer and observe that header INSERT lock wait
3. Call real `openShift`; it must wait while the admitted cash journal is still uncommitted, with no partial new manual data visible
4. Release controller; manual journal commits fully, then opening succeeds

These are outcome/synchronization assertions. They do not assert that the runtime uses a particular lock mode, lock SQL text, or advisory key. The controller barriers and synthetic trigger solely establish deterministic interleavings.

Locks are checked through PostgreSQL state with a bounded 8-second deadline, not assumed from a fixed sleep. All observed domain promises catch their errors immediately to avoid unhandled rejections. Controller locks are released and pending domain work is awaited in finally blocks even if an assertion fails.

The original concurrent-close smoke check is supplemented by both forced close orderings and an explicit bounded lock-timeout rollback test. The long close SELECT is recognized in pg_stat_activity by its unique prefix because the default query text limit truncates its trailing FOR UPDATE clause.

## Compatibility adaptations and remaining gates

1. Carry-forward PG fixture now writes its genuine initial book openings before opening its live shift; original dated-report assertions and values are retained
2. Multi-currency PG and HTTP accepted-journal fixtures use SAR bank 1112 while open, preserving native-currency balance/audit/CSV assertions; historical cash read coverage remains intact
3. `verify-executive.mjs` preserves generic manual/KPI coverage with a bank-only journal, verifies drawer spending stays unchanged, and explicitly asserts the manual-cash refusal
4. API tests cover both typed 409 codes/no success audit, generic 500 privacy, unchanged period-lock rejection and admin-only writes
5. Two built-browser tests vary date, accounts, currency, sides and decimal amounts; assert every draft field plus exactly one complete submitted payload survives the 409; screenshots are written into the existing CI artifacts directory. These tests have not been executed locally because no heavy build is allowed; they remain mandatory CI coverage
6. Root final review is required before publication; full CI and built-browser execution remain merge/deployment gates, followed by read-only release verification. No historical monetary adjustment is implied

## Historical red proof (before implementation)

- Node 22, PostgreSQL 18.4; **13 expected failures and 3 compatibility passes out of 16 tests**, 4.95 seconds on the final trigger-barrier fixture
- Failures include all open-shift cash refusal cases, the historical-preservation case's prerequisite refusal, and both deterministic opening interleavings. The old runtime accepted those prohibited writes instead of rejecting them
- Compatibility passes: bank-only journal while open, cash bookkeeping with no open shift, and the bounded concurrent-close outcome smoke check
- Focused ESLint, TypeScript and shell syntax checks passed; no runtime/core source file changed
- Final log: workspace parent `manual-cash-containment-before-fix-final.log`; private synthetic cluster/data retained under `manual-cash-containment-pg18.7XvAGH`
- `pg_ctl status` confirmed that the final cluster is stopped; the PG slot was released

This historical red run establishes the defect; it is not the fixed-runtime result.

## Executed fixed-runtime verification

- **20/20** focused positive PG tests passed on fresh PostgreSQL 18.4, including 5-second timeout and all forced interleavings; log `manual-cash-containment-after-fix-final.log`
- **94/94** tests across five related PG files passed with the actual disposable CI opt-in: manual cash, carry-forward, multi-currency ledger, shift close and category history; log `manual-cash-containment-related-pg.log`
- `verify-executive.mjs` passed all checks on a database created inside the same private PG cluster, including the new bank/no-drawer-change and cash-refusal checks
- **102/102** focused unit/route/accounting/report/fixture-safety tests passed across six files; log `manual-cash-containment-focused-unit.log`
- Sequential changed-file ESLint passed with only 8 pre-existing db.ts warnings; focused Next-ambient TypeScript passed; money aggregation guard, shell and verification-script syntax and diff checks passed
- An earlier full local typecheck and simultaneous lint attempt were killed with exit 137. They are not passes and were not repeated; full typecheck/build remain CI gates
- Independent review found no remaining runtime or fixture blockers. Two UI-test review findings (render wait and omitted nondefault field assertions) were corrected; browser execution remains pending CI
- All private clusters used by this slice are confirmed stopped; synthetic data/logs retained. No Production connection, mutation, remote push, PR or deployment was performed

Reproduce using `scripts/audits/manual-cash-containment-proof.sh` from this worktree:

```sh
NODE_BIN=/tmp/aqlan-npm-cache/_npx/52027bd8fc0022aa/node_modules/node/bin/node \
PG18_BIN_DIR=/tmp/aqlan-pg18-package/package/native/bin \
bash scripts/audits/manual-cash-containment-proof.sh
```

The runner first validates the original environment/connection aliases, creates a fresh private cluster and guarded test database, runs only this file, stops the cluster even on failure, and preserves all synthetic data/logs. Failure retains a nonzero exit status. Coordinate the shared PG slot before another launch. The original cash-ledger audit runner expects an old category-setting defect; do not reuse that expectation as a fixed-release acceptance test.
