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

## Separate empty-0051 path

Development verification: 12 restricted-path PostgreSQL cases passed in one run, including the actual format-1 reconciliation event through supported full backup, staged restore and reset. Reset preserved the event and exact registry rows; restore preserved exact event fields/timestamp but created its own full migration registry (source registry inserts are filtered). A restored event remains source-bound evidence. No future retention or live policy is proved.

38 focused units passed under Node 22.23.4. Typecheck and changed-file lint passed. Final expanded focused PostgreSQL verification additionally includes non-superuser ordinary-lock operation and absent-0067-object refusal; exact-head outcomes will be reported in Draft PR455. Earlier development runs used the environment's Node24 executable; final focused verification uses the repository's Node22 contract. No CI gate was weakened.

The parent-supplied metadata supplement also passed offline: see [METADATA-QUERY-VALIDATION.md](METADATA-QUERY-VALIDATION.md). No cause for the generic live refusal was established, and no live retry was made.
