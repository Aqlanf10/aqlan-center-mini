# HR payout, authority and period-selection evidence — PR #308

All financial writes, role/credential changes and browser accounts below belong to synthetic isolated PostgreSQL 18.6 fixtures. No external payment, message, production/staging database change or permanent account was used. Existing CI gates, assertions and deadlines remain mandatory.

## Failure before the repair

| Defect | Executed baseline | Result and evidence |
| --- | --- | --- |
| Accepting an HTTP success without a matching payout/reversal receipt | Built application frozen at `07f39992563255ecb329731837f0ee109d35a784`, application source equal to reviewed `cfa1dda16da25ebdd5530bfd881578455428d808` | Six expected failures at 390/1280: four actual payout commits followed by missing/foreign response bodies, and two actual reversal commits followed by missing bodies. [Log](browser-confirmation-before.txt). |
| Revoking an admitted manager while payout waits | Same old build | Both role and credential-version revocations still returned 201. Real row-lock barriers establish the ordering; expected 403 and no financial write. [Log](http-authority-before.txt). |
| Settings audit failure, non-manager settings writer, expiry while waiting for a payroll row lock | Separate `git archive` of exact `cfa1dda16da25ebdd5530bfd881578455428d808`, final added PostgreSQL test cases copied unchanged | Three genuine assertion failures: first policy remained committed, non-manager update resolved, and expired payout resolved rather than rolling back. [Log](postgres-before.txt). An earlier expiry-test setup error (`simple` outside its scope) was corrected and is not counted as application evidence. |
| Old period response overwrites new selected run | Intermediate build `Rq6Mct_vkpmF3eO_t8boc`; confirmation/authority fixes were present, but `loadRuns` still used the original implementation | Two failures, both widths, after deliberately releasing an old August response after the new period loaded: selected option remained new but the new employee row vanished. [Log](browser-period-race-before.txt). The preceding full browser run exposed the same disappearing-row failure; [initial log](browser-initial-race-failure.txt). These two failures are not attributed to a fully untouched cfa build. |

## Verification of the repair

[PostgreSQL results](postgres-after.txt): 47 passed across payroll integrity, financial integration and backup roundtrip. The newly added three cases pass with the same assertions. Existing cases verify canonical doctor commissions, separate salary/commission vouchers, derived party balances, cash totals, immutable contract snapshots, currency isolation, replay/concurrency/overpayment, reversal and audit rollback. Backup cases cover custom IDs/entitlements/settings and pre-HR restoration.

[Final browser run](browser-after.txt): 34 passed, including actual second-manager night-correction approval and preserved raw timestamps, reception/doctor restrictions, self-approval/spoof rejection, salary/percentage/hybrid settlement, uncertain payout verification/replay, reversal recovery after reload and deliberately delayed period responses at both 390 and 1280. [Additional independent PDF run](browser-multipage-after.txt): both cases passed; 40 uniquely named staff are created through real HR APIs per case, real payroll writers calculate/approve, and every expected name is checked in extracted PDF text. The generated 390/1280 PDFs have **3 and 5 pages** respectively. The final test file includes both PDF cases; they are not skipped in full CI. No assertion or timeout was weakened to turn a failure green.

[Frozen build](build-after.txt), [preflight](preflight-after.txt) and [runtime proof](runtime-after.txt) passed. Build `tfehEenIEbuxk_psT5x39` ships 6647 verified provenance files and 321 traces; preflight contains 48 immutable migration assets. Final typecheck passed; full initial lint and final changed-file lint have zero errors (existing warnings are disclosed in their logs).

The initial local full unit run inherited `DATABASE_ENVIRONMENT=development`, so two unchanged environment-parity cases failed and the unchanged source-import tracing case exceeded its 5-second deadline. That diagnostic run was interrupted, not reported as a complete successful suite. A clean CI-like selected run corrected environment parity and passed **86 cases**, but the same source-import tracing case still exceeded its unchanged 5-second deadline locally. [Clean selected log](unit-clean-selected.txt), [initial diagnostic](unit-initial-development-environment.txt). Exact-head **full CI** remains required; neither the local timeout nor a skipped test is counted as success. No deadline, tracing boundary or CI gate was changed.

The final application/migration hashes are in [application-source-frozen.json](application-source-frozen.json). [Integration inventory](integration-migration-inventory.json) compares reviewed HR, main `148fcbea`, moving PR #322 candidate `1594c91d`, and the user's last verified staging source `eadd750`. It finds no same-number or common-content migration conflicts in those sources. HR 0045/0046/0048/0049/0050 remain unchanged; dot must preserve ceph 0047 and ortho 0051. This is source comparison, not inspection of an externally applied migration ledger.

## Reproduce

```sh
source /workspace/.aqlan-env/development.sh
npm run test:postgres -- __tests__/postgres/hr-payroll-integrity.test.ts __tests__/postgres/hr-payroll-financial.test.ts __tests__/postgres/hr-backup-roundtrip.test.ts
npm run build
HR_EVIDENCE_DIR=/tmp/hr-confirmation-evidence-frozen npm run test:security-http -- __tests__/security-http/hr-payroll-journey.test.ts __tests__/security-http/hr-ui-journey.test.ts __tests__/security-http/http-permission-matrix.test.ts
env -u DATABASE_ENVIRONMENT -u USE_LOCAL_DB \
  DATABASE_URL='postgresql://ci:ci@127.0.0.1:5432/aqlan_center_ci?sslmode=disable' \
  TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable' npm test
npm run typecheck
npm run lint
npm run ci:scan:body
npm run scan:money
npm run build:preflight
node scripts/verify-braces-runtime.mjs
```

The setup script is local environment configuration, not a tracked secret or deployment instruction. Standalone PostgreSQL verification validates local PostgreSQL 18 and uses disposable test targets; do not substitute any external database URL.

## Scope and outstanding acceptance

Final literal head and completed exact-head full CI links belong in PR #308, never inferred from old cfa CI. Dot still owns `staging-web` / `staging`; no combined source or deployed SHA is claimed verified here. Dot must compose/review/test a compatible source with main/ceph/ortho, inspect the actual staging migration ledger and publish only that exact reviewed combined SHA. Staging screenshots and post-deployment cases remain unexecuted.

The 16 declared schema convergence findings and `applicationSchemaEqual=false` remain disclosed. Unsupported proration/nonmonthly/partial-period wage policies, unallocated paid leave, commission-policy conflicts and unreconciled legacy claims stay explicit approval blockers rather than guessed financial rules. Patient-finance relations remain a separate design-only packet pinned to ab3218c2; no patient migration or PR #322 modification was authorized or performed.
