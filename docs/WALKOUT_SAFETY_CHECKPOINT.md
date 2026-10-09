# Walkout safety checkpoint

Base: main 9e8f496f0ee55dce3396e60e023487a9bc975dfd.
Branch: hardening/walkout-verified-balances.
Draft PR: https://github.com/Aqlanf10/aqlan-center-mini/pull/316.
Red test commit: a562f3935ea0d885a1625cdf5ad55a5b8793fcaf.
CI run 37981393395 confirmed exactly the 3 new print regressions failed; 8322 tests passed.
Implementation commit: 12f60f4e26ceb616ccab074a50502147b3ec8967; typecheck passed.
Follow-up: invalidate child checkout suggestions with the parent financial read, including partial collection.

## Verified cause and bounded repair

- Print replaced empty procedure lines with an invented examination and omitted orthoAdjustment. Shared presentation now uses the existing walkout clinical evidence and billing classifications, including pending outside-contract decisions.
- TodayVisitTab coerced missing/invalid currency amounts to zero, retained old state on HTTP failure and froze a pre-sign read. The repair uses explicit loading/error/verified state, complete currency maps, safe integer amounts, patient/visit ownership, abort plus request identity and post-sign/payment canonical walkout refresh.
- Current debt is read directly from the existing engine. No agreement remaining is added to ledger debt.
- Previous balance means the existing engine's ledger excluding this visit's invoice and all payments on its arrival day. It is NOT a pre-sign timestamp snapshot. Same definition on fresh signing, reopening and print.
- No owner production patient is identified or edited. Expected owner file number remains unconfirmed. Synthetic 180000 fixtures are not a production correction.

## Reception notification gap (not implemented in this urgent slice)

Inspected app/page.tsx, lib/flow.ts, lib/today-board.ts, app/api/visits/route.ts,
app/api/visits/[id]/clinical/route.ts and signClinicalVisit in lib/db.ts.

The existing today board polls /api/visits every 20 seconds and has a done filter.
Its Visit projection has no signedAt, checkout acknowledgement or collection-completion event.
signClinicalVisit locks the unsigned visit FOR UPDATE, commits signed_at/status=done,
and rejects retries as already_signed. The route writes visit.sign audit AFTER that commit.
That audit is not a transactional notification outbox: a crash between commit and audit
cannot be repaired by simply retrying sign. A doctor success toast is not receptionist delivery.

The next bounded slice must extend the existing board/read projection (not a second queue):
derive eligible signed visits from committed signed_at, preserve patient/role authorization,
show canonical per-currency walkout debt/fees and unknown states, and define durable
acknowledgement/completion plus idempotent notification identity per visit. Persistent delivery/
acknowledgement may require a migration, so it is deliberately not added to this urgent repair.
Acceptance must cover rollback/no event, commit/event, retries/two tabs without duplication,
reception visibility under the existing filter, assistant denial and no financial disclosure.
No WhatsApp/SMS. This gap is explicit and does not claim the owner's alert requirement is complete.

## Validation and handoff

New unit coverage: adjustment-only included/legacy/pending print; strict workflow/walkout data;
read failures; pre-sign and pre-collection stale responses; post-sign opening debt; owner unmount.
Postgres synthetic regression: unpaid 180000 remains after adjustment-only sign and repeated reads,
without a new invoice. Built-browser test is discovered by the existing isolated
__tests__/security-http/**/*.test.ts CI suite; guards remain intact and browser writes are blocked.

Operational execution is CI only. No local install, build, app, tests or SQL; no Railway testing.
Local execution transport disconnected during setup, so subsequent source changes and commits
are saved via GitHub. Do not depend on the laptop working tree. CI results must be checked on
the final remote SHA. No merge/deploy/force-push; no CI/deployment edits; #312/#313 untouched.
This is one safety slice of the larger patient-file redesign, not its replacement.
