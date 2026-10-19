# Unlinked covered single-session work: independently reproduced finding

Baseline: `e34080e53ae4286c0df56175b1d20373107af58e`, branch `feat/approved-agreement-principal`, PR346. FIN008 is independently reproduced. Root reports completing source review of all26 external claims and authorizes publishing this narrow candidate for exact-SHA review and hosted CI; this is not final acceptance. No merge, deployment, production data, debt backfill, schema or migration changes.

## Reproduction before production edits

The synthetic PostgreSQL18.6 fixture created a1500SAR consented single-session plan and a matching1500SAR unlinked procedure. Approved-principal variant deliberately had no installment rows, isolating coverage supplied by approval. Signing returned success, added a second1500SAR invoice (1500→3000SAR total invoices with no payments), and marked the item `done` while its billing status remained `unbilled`. An old direct-installment variant likewise signed, added a1500SAR procedure invoice, and marked the covered item done. The expected refusal assertions failed in both cases. These are runtime observations, not conclusions inferred from the external report.

A real built-application HTTP regression on the same unchanged baseline then produced3 failed refusal cases (approved, direct installments, multiple matching approved plans) and4 passing control cases (explicit linked work, unrelated additional service, same-service additional work with a new explicit plan-item identity, reception forbidden). HTTP returned200 where409 was required. The existing `.next` build preceded all production edits; the candidate was rebuilt before the green HTTP run.

## Narrow candidate and preserved policy

The existing `PLAN_FUNDED_BY_AGREEMENT_SQL` predicate already classifies linked work as covered when either installments or an approved principal exist. Project that same predicate into the unlinked conflict loader, retaining funded identities after completion, and check it before the legacy single-session service/tooth match. A matching unlinked procedure now fails closed before clinical progression or invoice creation. No implicit financial allocation or service-based attachment was added. The clinical route message names funded work as well as multiple sessions.

Existing protective policies are preserved: linked covered work remains zero additional debt; an unrelated service can bill; same-service additional work uses an explicit new plan-item identity; repeated signing cannot create another invoice; reception cannot sign. An unfunded single-session proposal retains its old behavior. Multiple possible funded matches refuse rather than choose one. A new unlinked visit after completion also refuses. The patient lock and financial-history/lineage checks are unchanged; existing approved principal and signing paths both take the patient row lock before financial decisions.

## Verification and evidence

- PostgreSQL regression:2 red before /2 green after. Related approved-agreement, installment-funded and multi-session suites:40 passed.
- Historical treatment, identity drift and invoice-clinical linkage PostgreSQL suites:51 passed.
- Unit conflict/historical safety suites:78 passed.
- HTTP regression:3 red/4 controls green before. After adding the completed-plan case, all8 candidate cases pass; combined with existing approved-agreement recovery, installment retry and assistant authorization suites:27 passed across4 files.
- Fresh build passed with database environment variables removed; `npm run typecheck` also passed. Lint passed with0 errors/208 existing repository warnings. Money aggregation guard and `git diff --check` passed.
- All database runs used the disposable localhost PostgreSQL18.6 container on55445. Browser controls used the available system Chromium; this targeted run does not certify the full hosted release suite.
- Raw logs and candidate diff: `/workspace/reviews/pr346-unlinked/`. `postgres-red.log` and `http-red.log` preserve the pre-edit observations. No rejected browser download was retried.

Commands use the repository's synthetic session secret and `TEST_DATABASE_URL` pointing only at the disposable localhost test service. The PostgreSQL regression file creates its own isolated database; HTTP creates/drops `aqlan_sec_http`. No real credentials or patient records were used.

## Publication scope and remaining holds

The committed evidence in `fin008-evidence/` preserves the full raw red/green logs as lossless `.log.gz` files and a SHA-256 manifest for both compressed and original bytes. The source candidate was compared byte-for-byte with the tested patch before publication. Only the conflict predicate projection, pure conflict check, route explanation, regression tests and review evidence belong to this change. Unrelated untracked decision tests/documents and generated artifacts are excluded. Evidence contains synthetic test identities only; token/private-key/credential-URL scans found no matches.

This change resolves only the reproduced FIN008 path. Other finance defects under root's separate triage remain outside this patch and are not asserted fixed or accepted here. Existing unsupported post-approval amendments and historical-source reconciliation limitations remain as documented in the PR. Root retains the merge hold pending independent exact-SHA review, hosted CI and disposition of the remaining findings. Draft status is retained; no merge or deployment is authorized.

Reproduction and verification commands (using the disposable local test environment described above):

```sh
npm run test:postgres -- __tests__/postgres/approved-agreement-principal.test.ts -t 'refuses unlinked single-session'
npm run test:postgres -- __tests__/postgres/approved-agreement-principal.test.ts __tests__/postgres/installment-plan-included.test.ts __tests__/postgres/multi-session-billing.test.ts
npm run test:postgres -- __tests__/postgres/legacy-treatment.test.ts __tests__/postgres/legacy-treatment-identity-drift.test.ts __tests__/postgres/invoice-clinical-linkage.test.ts
npm test -- __tests__/multi-session-conflicts.test.ts __tests__/legacy-treatment.test.ts __tests__/legacy-treatment-ui-safety.test.ts
npm run test:security-http -- __tests__/security-http/agreement-unlinked-signing-http.test.ts __tests__/security-http/approved-agreement-principal-ui.test.ts __tests__/security-http/plan-installment-idempotency-ui.test.ts __tests__/security-http/clinical-assistant-http.test.ts
npm run build
npm run typecheck
npm run lint
npm run scan:money
git diff --check
```
