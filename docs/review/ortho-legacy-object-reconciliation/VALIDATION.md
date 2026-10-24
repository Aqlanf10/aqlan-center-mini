# Continuation validation

Environment: disposable Docker `postgres:18-alpine`, server **18.6**; no live database access. Frozen source: `c998b435306f8295a217e49f20080293c479c359`.

- Original reviewed PR454 test: **5/5 passed**, before changes.
- Existing `ortho-revision-registration.test.ts`: **16/16 passed**, independently before expansion.
- Full post-sequence-hardening focused run on `81d8a3d700247255c2dc9a001317467dc63440ce`: **43/43 passed in one run**, not an aggregate of old/new cases.
- After the independent-review fixes, expanded PostgreSQL suite: **46/46 passed in one run** (30 new/extended cases plus 16 existing registration cases).
- Focused unit/route/guard/operator cleanup and collision-scope tests: **30/30 passed**.
- Typecheck: **passed**.
- Full repository lint before the review follow-up: **0 errors, 210 existing warnings**. Follow-up changed-file lint passed without changing rules.
- Full GitHub CI: dispatched separately after push; the Draft PR/run links are the source of truth for exact-head status. Local focused results do not imply full CI completion.
- Local build/image and HTTP-security suite: not run.
- Staging/Production acceptance: not run; no deployment or merge.

Commands:

```sh
npm test -- __tests__/login-diagnostics.test.ts __tests__/login-diagnostics-route.test.ts __tests__/ortho-revision-migration-guard.test.ts __tests__/ortho-reconciliation-cli.test.ts __tests__/ortho-reconciliation-session.test.ts __tests__/ortho-reconciliation-collision-scope.test.ts
npm run test:postgres -- __tests__/postgres/ortho-legacy-object-login.test.ts __tests__/postgres/ortho-revision-registration.test.ts
npm run typecheck
npm run lint
```

PostgreSQL commands use an explicit local `TEST_DATABASE_URL` accepted by the existing safe-target harness. Fixtures include the original post-initialization reproduction and a genuinely fresh pre-Ortho initialization boundary, empty and nonempty objects, partial/conflicting objects, catalog/ACL/owner/collation/dependency drift, invariant violations, concurrent reconciliation/runtime requests, rollback and lost-COMMIT-acknowledgement simulation, and real route login/initialization after reconciliation. No synthetic test is evidence that existing live objects are equivalent.
