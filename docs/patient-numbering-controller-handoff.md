# HOLD: unmounted patient-numbering save controller

Base: private candidate `8a3438dfc2e283ccc200409506b0a61c74d46768`.

## Delivered local slice

- `lib/patient-numbering-controller.ts`: dependency-injected `executePatientNumberingSave(raw, dependencies)` wrapping the existing `executeNumberingCommand` without editing that command, its policy, PostgreSQL adapter or any UI/app route.
- `__tests__/patient-numbering-controller.test.ts`: synthetic canonical-owner tests, serial transaction model, exact transaction-identity checks.
- No live owner binding, persistent authentication configuration, credential, cryptographic token provider, route, schema, numeric migration, allocation, push or deployment.

Input is exactly `{prefix,next,expectedRevision,requestId,reason,previewToken}`. Display-only `preview` is not accepted; the UI adapter strips it. Prefix/next/reason normalize exactly as the existing command. Request identity and expected revision are not silently replaced. The UI provider, not the UI, must issue requestId and opaque previewToken after previewing canonical prefix/next/reason. The controller never issues either.

Required injected dependencies are backend, currentSessionBinding(tx), and verifyPreview(token,tx). Missing dependencies default to `owner-numbering-not-activated`. No backend/authority fallback exists. Optional `now` is solely a testable clock.

## Proven local behavior

- Existing canonical resolver/WeakMap produces a structurally legitimate synthetic owner, not forged JSON or a fabricated role grant. Ordinary admin, copied flags and inactive/missing identity do not authorize.
- One existing-command transaction handles verification, actor-scoped receipt lookup, current revision planning and apply. Verifier/session callbacks receive the exact same NumberingTransaction instance.
- Authenticated preview claims bind version, operation purpose, exact actor ID, current authority fingerprint, exact authenticated session binding, all five normalized command fields, and expiry. Changing any command field or foreign actor/session fails before receipt access. Fingerprint changes after preview also fail.
- Fresh authority/session rechecks occur before receipt access, after receipt lookup, before snapshot, before/after apply and before the transaction callback completes. The backend must roll back any post-apply refusal.
- Exact committed receipt replay takes priority over current allocator revision and can recover after preview expiry, but only under current valid actor/session authority and exact intent. An expired token with no committed receipt cannot reach snapshot/apply. Changed intent still produces the existing idempotency conflict. Authenticated expired claims are not permission to create a new operation.
- Unknown commit acknowledgment preserves the original command identity; explicit retry returns one existing receipt/audit. No automatic retry or new request ID is created.

## Test evidence and limits

Failure-first: the new test suite initially failed to import the absent controller. This is evidence of a missing seam, NOT a reproduced production defect.

Final local command:

`node node_modules/vitest/vitest.mjs run __tests__/patient-numbering-controller.test.ts __tests__/patient-numbering-command.test.ts __tests__/patient-numbering-policy.test.ts --no-cache`

Result: **82 tests passed across 3 files**, none skipped. Focused strict TypeScript and ESLint also passed for the two new TS files. Independent read-only review found no blocking defect within the documented injected-provider contracts.

Node was 24.22.3 and Vitest 4.1.12. Repository requires Node 22; full build/CI and Node 22 validation remain pending. No PostgreSQL, real signed session, token authenticity, browser or app HTTP proof is claimed. The model verifies orchestration/rollback contracts, not database isolation, sequence rollback, durable receipt integrity or real session revocation.

## Required activation decisions and proof

1. **Trusted owner bootstrap remains absent.** Real immutable user ID and binding-version origin must be separately authorized, not first-admin, editable settings or client flags.
2. **Same-client fresh session evidence is unresolved.** Current PG backend supplies owner(client) internally but NumberingTransaction does not expose the PoolClient or current authenticated-session binding. The new seam demonstrates transaction identity at the abstract interface only. A reviewed backend/provider integration must resolve and lock the current account, credential validity, binding version and authenticated request session on that exact client. Never close over stale role/session or use a second pooled connection to satisfy this contract.
3. **Token issuer/verifier is not implemented.** Decide authenticated token format or durable opaque record, audience/deployment binding, issuer trust, expiration, integrity, request-ID issuance, key rotation/revocation and restoration behavior. A fingerprint is revocation material, not a signature or credential. Token possession never supplies login authority. A valid token must bind the canonical prefix/next/revision/requestId/reason, actor ID, authority fingerprint and exact current session. Do not manufacture persistent config/keys to make this seam pass.
4. **Recovery policy:** verifier may return authenticated expired claims only for receipt recovery. If its token format refuses all expired tokens, recovery will safely refuse but requires a separately reviewed recovery path; never silently mint a new command. A foreign session holding the OLD token is refused. Existing receipt schema keys actor/request plus intent, not original session. If original-session receipt provenance must survive a newly issued replacement token, enforce issuance rules and/or explicit receipt provenance before activation.
5. **Transactions:** prove actual backend authority lock order, all allocation-path serialization, stale revision, audit/receipt atomicity, rollback after refusal, duplicate calls and commit-ack loss with real disposable PostgreSQL. The last deadline/authority check is before COMMIT; it is not proof that COMMIT completed before the wall-clock expiry instant.
6. **HTTP boundary absent:** any future route needs independently verified session extraction, bounded JSON body, same-origin/CSRF checks, authorization, error mapping and private no-store responses. Do not import the server seam into a client component or mount it merely because unit tests are green.
7. **UI recovery:** uncertain/malformed transport results remain frozen with the same complete ticket. Only a matching authenticated result or definite refusal may resolve that state. No new preview/new identity after uncertain save. Existing preview panel and unrelated patient flow are unchanged here.

## Result reasons

Controller: owner-numbering-not-activated, invalid-input, owner-required, session-required, invalid-preview, preview-authority-changed, preview-command-mismatch, preview-expired, numbering-clock-unavailable.

Existing command/policy: stale-preview, idempotency-conflict, history-unverified, would-reuse-or-rewind, invalid-snapshot, numbering-transaction-failed (plus existing validation/default denial).

`numbering-transaction-failed` is NOT definitive no-commit: the backend may have committed before losing its acknowledgment. Keep the original ticket for deliberate recovery.
