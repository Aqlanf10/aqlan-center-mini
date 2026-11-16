# Local repair of the saved invoice-actions checkpoint

Restored source base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`.
Restored checkpoint: `df369d0d25f55f45b20e01135a77e73ceeda2929`.
Verified restored tree: `4d44d80ee95780a76fc2bc2e48bc5523079a96f9`.

## Completed source repairs

- Refund/period-close after preview now commits an immutable, actor/invoice/body/key
  bound archive refusal under the same command and invoice locks. Concurrent and
  delayed retries return terminal proof, even after repayment, reopening or a later
  successful archive using a new key. No archive event, audit transition or financial
  mutation is manufactured by refusal. Generic conflicts remain uncertain.
- The client retires only an exact durable refusal. Missing/mutable rejection schema
  fails readiness closed. The database excludes reuse of a refused key for events.
- Historical archive replay does not depend on a user's current name, role or active
  flag. Current-session runtime authorization is unchanged and tested for all three
  changes. Supplement replay no longer rejects historical evidence solely because
  its original invoice was subsequently cancelled.
- SQL backup orders archive streams by invoice/version and explicitly restores
  invoice items before supplementary evidence. An actual production-writer backup
  round-trip uses nonempty proposal tables, changed actor/status, and reversed heap
  order, without disabling immutable guards.

## Final local evidence

- Focused PostgreSQL 18.6: **58 passed** (archive 32, addition 25, backup replay 1).
- Focused unit/headless UI: **103 passed** across eight files (archive, maintenance
  view/UI, command recovery/transport, linkage, correction, print veracity).
- Whole-worktree TypeScript and focused ESLint passed. No lint errors/warnings from
  source; the environment printed an experimental HTTP proxy warning.
- `git diff --check` passed.
- First PG run had one outdated current-username guard assertion fail; it was replaced
  with missing-actor FK proof, explicit revoked-runtime-actor tests and real historical
  restore evidence. The subsequent final focused run is green.

Logs are retained outside the source tree in `../invoice-actions-local-input/`.
The original checkpoint's logs remain historical, not final-head proof.

## Still not activated or release accepted

Both proposal filenames remain unnumbered and unregistered. Root owns the composed
batch activation (reserved 0081/0082), runtime/schema/checksum ownership registration,
reset protection for all four evidence tables, empty-only safe reset guard handling,
and final composed-schema/backup testing. Missing schema intentionally refuses writes.

No full build, browser/built-server HTTP journey, full suite, remote CI, PR, merge or
Railway verification was performed. No production data, backup or credentials changed.
Unpaid/partial/ambiguous archive and locked-period transitions remain conservatively
refused. Archive does not delete history or forgive debt; service addition remains a
separate dated linked invoice, explicitly identified in the existing UI.
