# Continuation validation

Environment: disposable Docker `postgres:18-alpine`, server **18.6**; no live database access. Frozen source: `c998b435306f8295a217e49f20080293c479c359`.

- Original reviewed PR454 test: **5/5 passed**, before changes.
- Existing `ortho-revision-registration.test.ts`: **16/16 passed**, independently before expansion.
- Focused unit/route/guard/operator-boundary tests: **22/22 passed**.
- Expanded PostgreSQL tests: **43/43 passed** (27 new/extended cases plus 16 existing registration cases). After the final sequence-lock hardening, the two affected preservation/locking tests were rerun: **2/2 passed**; 25 unrelated cases were filtered out in that focused rerun.
- Typecheck: **passed**.
- Full repository lint: **0 errors, 210 existing warnings**. The initial generator `no-unsafe-finally` issue was fixed without changing rules. Changed files also receive a final focused lint check.
- Full GitHub CI: dispatched separately after push; the Draft PR/run links are the source of truth for exact-head status. Local focused results do not imply full CI completion.
- Local build/image and HTTP-security suite: not run.
- Staging/Production acceptance: not run; no deployment or merge.

Commands:

```sh
npm test -- __tests__/login-diagnostics.test.ts __tests__/login-diagnostics-route.test.ts __tests__/ortho-revision-migration-guard.test.ts __tests__/ortho-reconciliation-cli.test.ts
npm run test:postgres -- __tests__/postgres/ortho-legacy-object-login.test.ts __tests__/postgres/ortho-revision-registration.test.ts
npm run typecheck
npm run lint
```

PostgreSQL commands use an explicit local `TEST_DATABASE_URL` accepted by the existing safe-target harness. Fixtures include the original post-initialization reproduction and a genuinely fresh pre-Ortho initialization boundary, empty and nonempty objects, partial/conflicting objects, catalog/ACL/owner/collation/dependency drift, invariant violations, concurrent reconciliation/runtime requests, rollback and lost-COMMIT-acknowledgement simulation, and real route login/initialization after reconciliation. No synthetic test is evidence that existing live objects are equivalent.
