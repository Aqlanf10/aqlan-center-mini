# Verification evidence

All financial examples use synthetic records on disposable localhost PostgreSQL18.6.
No live database, reported patient's record, migration on production, merge or
release was performed. Base: `a03aea1eb911c3c886028bc902f6f4f97f3546cf`.

## Before and after

The preserved [baseline failure](evidence/baseline-unmet-contract.log) records the
old consent/installment flow returning0 instead of100000USD minor and16000SAR
minor. [Baseline review](evidence/baseline-decision.md) predates this implementation.
The new tests exercise **explicit financial approval**, not an automatic upgrade
of clinical consent. After approval1500USD and collection500USD, ledger debt is
1000USD;300SAR less140SAR is160SAR. An opening match1500USD/500USD historic paid
keeps the existing1000USD source and posts no new invoice or historic receipt.

## Checks

- `npm test`:566 files passed;10072 tests passed;1 repository skip.
- New principal PostgreSQL suite:20 passed. Covers currency separation, recorded
  FX/refusal, replay and simultaneous requests, proposals, existing invoice and
  opening matching, frozen terms/source, old-writer rejection, refund/recollection,
  current roles/credentials, multiple plans, covered work, commission, due-date
  boundaries, propagation of receipt read failure and real SQL backup/restore.
- Related PostgreSQL suite:67 passed across7 files (includes the earlier19-case
  version of the principal suite plus existing installment, debt, snapshot,
  report cutoff, restore and commission cases).
- Principal/schema/HR backup/FK compatibility suite:42 passed across4 files;
  standalone updated schema-ownership suite:6 passed.
- Real built-server HTTP/browser suite:13 passed across2 files. Financial approval
  by admin1280px and reception390px, collection/replay, printed full remainder and
  due now, one-invoice invariant, general cashier collection, role denials and the
  existing full HTTP permission matrix. No horizontal overflow or page errors.
- `npm run typecheck`:passed. `npm run lint`:0 errors,208 repository warnings;
  focused lint for the final collection/print/HTTP edits also passed.
- `npm run build`:passed without database connection environment variables.
  Existing dynamic-filesystem tracing warning remains.
- `npm run scan:money` and `git diff --check`:passed.
- Schema contract regenerated on PostgreSQL18.6. Ownership verification:0 new
  unexpected differences,16 pre-existing open convergence findings. The current
  migration/runtime schema is not claimed globally identical.

[Mobile](evidence/reception-390.png) · [Desktop](evidence/admin-1280.png)

The initial expanded runs found stale migration-count/matrix/mock expectations;
those registrations were updated and rerun successfully. The restore test also
found the plan-item/visit dependency cycle fixed in this branch. The earlier
refund-source mismatch was resolved in an approval-specific matcher without
loosening existing debt schedule revision checks.

## Review limits

Read [design and explicit limits](design.md) before approval. This Draft supports
new full-principal approval and explicit matching to one whole existing source.
It does not implement post-approval discount/cancellation credits or multi-source
legacy reconciliation; those operations fail closed and need a separately
specified, reviewed adjustment workflow. It does not establish the cause of any
reported real-patient discrepancy. Parent review and CI are required before merge.

## Subsequent review fixes

See [review follow-up and red/green logs](review-followup.md) for product heads, lock-order regression, recovery coverage and limits.
