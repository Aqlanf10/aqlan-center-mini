# «تسوية الاتفاق» — reviewed implementation contract

Scope: existing classic installment plan, active or clinically completed, never cancelled; no existing approved or reconciled principal. No live operations. A01 payable replay work paused, not closed.

## Ownership and boundaries
- Finance engine agent: new `lib/agreement-reconciliation.ts`, `lib/agreement-reconciliation-db.ts`, reviewed schema 0078, new dedicated route `app/api/plans/[id]/reconcile/route.ts`, focused synthetic tests. Minimal named hooks in db.ts plan-reader and classic-installment writer only after canonical coordination.
- Root / assigned UI agent: new isolated reconciliation UI + durable command journal, shared PatientPlans/PatientLedger entry points only after canonical finance child coordination. Exact label **تسوية الاتفاق**.
- Canonical owner child: current capability/session guard contract. Do not reuse stale role-only checks. No permission probe reruns.

## Proposed API (freeze after source/authority review)
GET `/api/plans/:id/reconcile`: read-only current authorized snapshot, no financial mutation.
POST same: `{operationKey, expectedSourceHash, reason}`; principal, currency, patient, source IDs and provider cannot be overridden by client. Requires reviewed current source proof. Request intent hash binds these exact fields + plan + current actor identity.

Response envelope:
```
{ status: 'preview' | 'reconciled' | 'review_required',
  planId, patientId, currency, sourceHash,
  amounts: { agreedMinor, billedPrincipalMinor, unbilledPrincipalMinor,
    paidMinor, remainingMinor, dueNowMinor },
  sourceInvoices: [{ invoiceId, invoiceNumber, principalMinor, settledMinor, remainingMinor }],
  blockers: [{ code, message }],
  reconciliation: null | { id, operationKey, deltaInvoiceId: number|null },
  canConfirm: boolean }
```
All money values safe integers in native minor units. Unknown paid/remaining/due-now must be null, not zero. Only verified source membership yields figures. No unrelated patient invoice is folded in by date/amount/title. No private snapshot contents in client proof hash. Read-only preview returns actionable explicit blockers, not an invitation to manual SQL.

Success POST `{status:'reconciled', replayed:boolean, reconciliation:{id,operationKey,deltaInvoiceId}, view:<current projection>}`. Durable command result must remain retrievable if optional post-commit projection fails; do not turn success into permission to create a new command. Same key/same intent replays original document identity; different intent conflicts. Recheck current authority before replay.

Errors: 401/403 current authorization; 409 `agreement_source_changed` (fresh preview required), `agreement_already_reconciled` (return authorized original identity), `operation_key_conflict`, `agreement_review_required`; 503 `agreement_reconciliation_unavailable` for schema/read unavailable. Network/500 remains **uncertain**, retain exact command and replay it, never auto-new-key. Rejected commands must be distinguishable from uncertain commands.

## Accounting invariants
A = verified contract principal, B = existing valid linked invoice principal, U = A−B. Paid P is separately verified net settlement. U is not A−P. Create only U when positive; U=0 still records explicit adoption, without zero-value invoice. Negative U or unsafe totals refuse. Preserve all original invoices, receipts, cash/FX and prior commission records. Delta invoice cannot fabricate provider attribution; unresolved provider/commission policy blocks confirmation.

Existing sources must be exact classic installment lineage, same patient/currency, no ambiguous mixed ownership/opening overlap. Independent invoice-backed services stay independent. Cancellation/correction/refund and cross-currency settlement require explicit verified lineage, otherwise review. Notes alone cannot allocate receipts or prove FX.

## Persistence/locking plan
Explicit immutable reconciliation header + source membership (migration 0078), actor-scoped durable identity + intent hash, source snapshot, native totals, reason, audit in same transaction. One reconciliation per plan. Source guard must freeze membership/principal identity and prevent additional classic principal issuance while preserving legitimate refunds/receipts. Insert reconciliation only after delta invoice; guard all subsequent plan sources. No rewriting existing approved-agreement single-source constraint to lie about full principal.

Current authority lock first, then established finance account/invoice/plan domain lock order. Read preview with repeatable read; confirmation must reread under locks and compare expected source hash. Concurrent independent receipts/edits must either serialize and be included or yield stale refusal. Entire error path rolls back invoice/reconciliation/audit. Integration must prove lock ordering against classic collection writers, not rely on a new advisory lock nobody else honors.

## Required proofs before acceptance
Red→green pure arithmetic (A−B not A−P), three currencies, completed plan visibility, unrelated invoice separation; real PG audit failure rollback, exact replay, two concurrent keys for one plan, collection/confirmation race, stale preview, cancelled/corrected sources, refunds, ambiguous opening/FX refusal; client persistent uncertain recovery across reload/tabs; source labels and independent agreed/paid/remaining/due-now display; canonical guard integration; official statement/print/export parity. Existing restricted probe boundary stays blocked, not passed.

## v1 exact-attempt recovery and standalone base
Baseline dc1be92e, established deployed admin admission + transaction actor/session revalidation; canonical agreements.view/manage adapter later. Types frozen in lib/agreement-reconciliation.ts. GET includes patientId. Every receipt includes planId, patientId, operationKey and ORIGINAL accepted expectedSourceHash.
PUT same endpoint with exact immutable POST body is status-only, serialized on same attempt fence as POST; committed(receipt), rejected(permanent matching stale-refusal tombstone), or unresolved. Missing record is unresolved, never rejection. Status does not create financial data. POST stale refusal commits a no-save tombstone before returning conflict; later delayed POST checks tombstone before mutation. No 403/409 alone clears client command. Only strictly matching receipt or matching durable terminal refusal permits closure.

## Standalone compatibility
Migration 0078 was reserved and collision-checked by root, independently reviewed, then registered locally with exact matching migration/runtime SQL. Lower reserved migrations 0073–0077 are intentionally not dependencies of this standalone main-based feature. Local registration is not evidence of deployment; combined CI, browser and Staging acceptance remain release gates.
This branch is based on verified main dc1be92e. It does not import0073clinical,
0074lab,0075guard rollout,0076owner, or0077payable migration. Its own immutable
records require independent guarded-empty reset/restore, source completeness,
shape, FK and replay protections. Backup/restore compatibility and current main
schema fingerprint must pass before registration/publication. Canonical authority
adapters are a separately reviewed integration, never a reason to drop main's
live-session revalidation.
