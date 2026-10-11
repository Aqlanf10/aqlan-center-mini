# Reception checkout lifecycle correction

Source baseline: main 1878cf92ae5ac8ed5596b67a9d0c58f7b67812cd (released PR318).

## Defect

The old Today green panel was an unbounded signed-visit register. Its query only constrained signed_at and date; payment/defer did not affect membership. Actual reported screenshot shows five rows consuming approximately the upper third of the day board.

## Intended behavior

Today defaults to waiting/chairs. The separate التحصيل والخروج tab has a live pending count. Both tabs stay mounted. The latest reception read continues while the day tab or an older signing period is displayed. Only latest-window new signatures sound; history navigation does not replay notifications. Lists have a bounded keyboard-scrollable viewport. Read failures remove active links and do not display a false fresh zero.

The signed visit and canonical finance/audit records remain the sources of truth. Opening a link does not finish the task. An existing explicit defer moves the exact signed visit to history without touching debt. Positive, fully collected visit invoices can be classified as collected from canonical net invoice payments only, with no pending review; partial collection, missing/zero invoices, unrelated payment and old balances never infer completion. A refund may reopen a derived collected task. Explicit handled/deferred decisions remain historical decisions rather than a claim the account is paid.

The existing checkout includes an optional تمت المعالجة action for other reviewed cases. It requires a written reason and a signed-visit/patient match, persists a transactional idempotent audit decision, and does not mutate invoices, payments, balances or clinical signature. Lost response requires a fresh read; retries use the first persisted decision. New visits for the same patient are independent.

No migration, Production write, branch or publication occurs in this candidate. Local dependency installation, builds, tests and SQL were not run. Full exact-head CI and independently reviewed composition into existing PR321 are required before merge/release. Read-only deployed verification must confirm the dedicated tab and pending/history behavior without changing real patient data.

Signature precision: audit identity records the database's microsecond signature timestamp to avoid reusing a decision across a changed signature. The request precondition uses the existing walkout ISO millisecond timestamp, so it does not claim stale-command protection against a hypothetical same-millisecond re-sign. The released signature writer rejects already-signed visits; no reachable re-sign writer was found. Any future re-sign feature must expose a full version token before reusing this command.
