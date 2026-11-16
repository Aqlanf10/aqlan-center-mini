# Supplier invoice operational slice

The existing operations workspace now connects invoice review, immutable
revision, payable posting and full unpaid financial cancellation to authenticated
HTTP commands. This is one usable synthetic-tested slice of the larger inventory
completion plan. The overall workflow is not ready for activation.

## Product paths

- `/inventory/procurement/operations`: choose an order, review its effective
  supplier invoices and frozen native/base valuation, revise an unposted
  invoice, post its payable, or cancel an unpaid posted invoice with a reason.
- `/api/inventory/procurement?view=supplier-finance&orderId=…`: current invoice
  revision/digest, matching status, linked payable, settlement and available
  actions. Reads use one repeatable snapshot.
- The same POST endpoint dispatches `supplier.admit`, `supplier.execute` and
  `supplier.retire`. Admission commits before execution; a browser stores the
  immutable intent before the first request and the returned operation key
  before execution. No mutation is sent from a read or an inferred service name.
- Posted invoices link to the existing `/finance/parties/{supplierId}` payment
  workspace. This slice does not replace its cash writer. Cancellation requires
  zero net settlement; otherwise the authorized payment-reversal path is needed.

The canonical signed session is revalidated while its user lock remains held
through the transaction, after the shared reset fence. Supplier management
retains the existing legacy admin permission policy. Restricted permission
envelopes receive no fallback grant. Optional identity claims are issued by the
existing login/password paths only when explicitly provisioned identity exists;
this does not initialize schema or activate global capabilities.

## Recovery and restoration

Supplier intents are scoped by stable realm/subject and retain the original
execution epoch, actor, payload, nonce, operation key and digest. Generic errors,
403/409, timeout, reload and tab races do not clear them. New same-invoice intents
wait on the original operation lock before checking its terminal result. If the
old intent is still pending, the new nonce gets immutable audited rejection
evidence; loss of that reply recovers the same rejection. Only a complete matching
committed/retired/rejected acknowledgement clears its exact browser record.

The v1 inventory journal and the application's shared financial journal remain
unchanged. Ambiguous old v1 commands remain visible and held; an independent
supplier invoice can proceed without dropping those commands. Full legacy
command reconciliation remains an outstanding workflow, not a claim of this
slice.

Actual application archive restore and the SQL restore CLI preserve realm,
subjects and all business/command evidence, then rotate an execution epoch in
the data transaction. Original committed and retired outcomes replay exactly
under a fresh session. Old-epoch pending work can neither execute nor retire,
and it blocks a new intent for that invoice. Restore regenerates only the
cluster-local `created_xid`, preserving key/payload/actor values. Guarded rows
restore in dependency/revision order without disabling immutable guards.

Reset refuses recorded inventory history before backup/deletion. An allowed
empty-history reset rotates only the inventory execution epoch; failed backup
or mandatory audit rolls the rotation back. Ordinary non-inventory session
compatibility is retained. An out-of-band physical rollback cannot be inferred
from the restored database alone; this slice proves managed restore only.

## Executed local evidence

Node 22.23.3, PostgreSQL 18.6 and installed Chromium 151; synthetic loopback data
only. Production gate settings were not changed. Implementation and independent
review used Astra / Medium as requested.

| Evidence | Observed result |
|---|---|
| Supplier operational PostgreSQL + actual archive/SQL restore + maintenance | 3 files, 26 passed; includes epoch FK/nonce alias refusal, concurrent admission, locked pending lookup, rejection audit rollback, exact restored proof and reset failure cases |
| Canonical auth, journal and route units | 10 files, 110 passed, 14.98 s |
| Restore SQL boundary and purchase-reset route units | 2 files, 20 passed |
| Production build with Next TypeScript check | Passed |
| Same-build opt-in existing procurement + new supplier HTTP/browser | 2 files, 26 passed, 109.79 s |
| Same-build gate-off and existing purchase browser recovery | 2 files, 25 passed, 56.11 s; all 39 proposal tables absent and supplier endpoints refuse with the gate closed |
| Earlier composed HR/restore/reset regression | 5 files, 28 passed after supplying the required synthetic session secret; its first invocation skipped four HR tests and is not acceptance |
| Bounded independent source review | No additional actionable correctness defect |

The browser journey uses real signed login at 390px and 1280px, exercises revision
→ posting → actual supplier-ledger navigation → cancellation → refreshed balance,
and checks no horizontal overflow. Recovery cases include lost admission,
execution, retirement and rejection replies, reload, generic 403, two tabs,
retained legacy evidence, and an old-epoch pending invoice alongside independent
work. Final screenshots were visually reviewed with the center logo, established
blue/orange identity and navigation retained.

Browser diagnostics recorded zero page errors. Seven resource-console errors
were the four intentional lost-response aborts and three expected 403 cases;
network aborts also include ordinary navigation/prefetch cancellation. Focused
lint had no errors and one React effect warning in the new panel; the existing
restore module retains its two unused-import warnings. Plain Node restore modules
passed syntax checks. Whitespace checks passed. Earlier failing fixtures and
selectors were corrected and rerun; no permission or validation guard was reduced.

Evidence remains under `/workspace/inventory-resume-evidence/`, including
`supplier-operational-{build,units,http,gateoff}-acceptance.log` and
`supplier-browser/supplier-{posted,cancelled}-ar-{390,1280}.png`. These runtime
artifacts are not part of the private source-only continuation archive. Hosted CI
must be checked on the new commit; the previous head's green checks do not accept
this changed source.

## Remaining work

The [operational plan](OPERATIONAL-COMPLETION-20261026.md) and
[schema manifest](proposals/migration-manifest-20261027.json) are the active
dependency list. Migration numbers and the identity contract are pending parent
coordination. Synthetic tests explicitly install proposals; they are not a
registered-migration empty-target acceptance proof.

Remaining product gaps include reference-data setup from screens, canonical
transactional entry/recovery for older commands, order amendments and legacy
quarantine exit, source-linked partial supplier returns/credits, patient/visit
consumption reporting/correction and evidenced doctor attribution. An originally
unnumbered invoice cannot yet acquire its official number through the current
immutable-identity revision rule; a source-linked unique-number resolution is
required. No doctor liability, payroll deduction or refund is inferred.

The parent's future 0077 manual-payable identity proposal is not available at the
reported GitHub ref; composition against those exact guards is untested. Current
baseline success does not cover it. No main merge, deployment, live migration,
Railway change, Staging request or production activation is authorized here.
