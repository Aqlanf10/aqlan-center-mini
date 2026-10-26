# Invoice archive and additional-service documents

Verified base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f` (`origin/main`, also the requested published reference).
Independent branch: `codex/invoice-archive-add-service`.

## Contract inventory and decisions

- Cancellation changes the financial meaning of an invoice and its plan links. Archive therefore uses a separate reversible documentary event, never `Invoice.status` or a deletion.
- There is no existing policy authorizing archive of unpaid or partly paid invoices. Such requests need a policy decision and perform no write. Actual settlement evidence, including correction lineage, is used; a manually assigned `paid` label is insufficient.
- `InvoiceCorrection` and the revision API identify existing `itemId`s. They do not add independent treatment. The existing invoice-first contract explicitly directs additional work to a new invoice.
- Additional services therefore create one dated, linked invoice containing only the new service through the canonical clinical-linkage writer. The original invoice, receipt allocations, signatures, lab history and old commission history are retained. There is no cash movement or automatic refund.
- The existing positive agreement-upgrade mechanism is unchanged. Existing plan consent, source ownership, already-billed work, pricing, dental site and clinical readiness constraints remain authoritative. Unsupported source shapes are refused rather than bypassed by duplicating a plan.
- Only new admin-authorized operations are exposed. Current session authority is checked inside the transaction; ordinary finance readers retain their existing read boundaries.

The detailed archive and service designs and failing-test evidence are recorded beside this file before implementation. Synthetic PostgreSQL 18 databases on loopback are used for financial concurrency tests. No deployed database, patient or invoice is accessed.

## Integration boundaries

The patient ledger receives small entry points and separate components. Archive metadata is displayed separately and is not used to remove documents from accounting readers, patient balances or statements. Supplementary documents use their own number/date and print route. The agreement-settlement button, patient-statement redesign and multiple-filling workflows are outside this change.

Schema additions remain unnumbered proposals under `migrations/proposals/`. They are not registered by `ensureSchema`, adopted by the migration runner or applied to a deployed environment. Missing/incompatible schema must fail closed. Versions 0073–0080 are untouched. Number allocation, schema ownership/manifest integration and deployment are follow-up review gates, not actions of this task.

## Acceptance evidence to retain

| Area | Evidence required |
| --- | --- |
| Archive | Actual paid/zero versus unpaid/partial/manual-paid, reason/authority, archive/restore, no-op/replay, stale version, concurrent attempts, locked period |
| Financial invariants | Unchanged original documents/receipts/signatures/lab/commission rows; unchanged balances and statement visibility across archive |
| Service addition | Before/after partial payment, only new amount billed, canonical plan/site/provider validation, original clinical work retained |
| Command recovery | Exact request persisted before dispatch, response loss, same-key replay, changed-key/body conflict, actor change, concurrent writes |
| Presentation | Preview exposes service/provider/site/price/discount/currency/plan/case/planned state; final identity and dated print |
| Release | Appropriate targeted and regression tests, Draft PR, CI checked against the final pushed head; no merge or Railway deployment |

## Policy decisions deliberately unresolved

1. Whether unpaid, partly paid or financially ambiguous invoices may be archived. Until approved, archive is refused with a policy-decision result and no financial change.
2. Whether documentary archive/restore is allowed in a locked invoice period. This implementation conservatively refuses new transitions there; exact committed requests remain recoverable.
3. Any additional service that violates the existing consented/approved plan or completed-work source contract still needs its established financial/clinical review. This task does not authorize retrospective rebilling or a negative agreement amendment.

Final test counts, commit identity, PR URL and CI outcomes are supplied in the delivery report; planned checks above are not claims of passing results.
