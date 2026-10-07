# Invoice-first clinical linkage: prospective safety contract

Status: **source-reviewed TARGET contract for PR 273**. This is a documentation-only
successor to `c669a82e8dbd18d7510b5ca07caa23410cd7bdec`, based on `main`
`4fa7c406455b666e163ff1f9f10861d004eb04a4`.

The rules below describe the reviewed target behavior. They do not assert current
Production behavior, completed implementation, migration activation, or release acceptance.
Implementation remains separately gated through PR 274 and PR 278, with exact-head CI
and end-to-end evidence required. Legacy PR 285 remains separate.
This document supersedes the earlier B–D proposal's consent, cancellation, correction,
provider, scope, and blanket orthodontic-funding rules. It is not a deployment claim.
The complete reviewed core, UI, and regression tests must pass CI before activation.

## Canonical identities

- The patient owns a treatment plan; a plan item identifies a particular service and
  clinical scope. Visits record actual care against that item. Invoices record money.
- Original therapeutic invoice lines use `source_type='plan_item'`, `source_id=item.id`,
  and `plan_item_id=item.id`. The existing unique source index prevents a second source.
- Corrections retain `invoice_items.plan_item_id`. The original source stays on the
  original invoice; corrected lines have no new source identity.
- `origin` and `origin_invoice_id` retain provenance. `billed_invoice_id` retains the
  financial reference after cancellation or a shape-changing correction; it is not
  an assertion of valid coverage by itself.
- `invoices.plan_id` keeps its existing installment/payment meaning. Invoice-first
  linkage never changes that field into a clinical association.
- No new schema or status constraint migration is required by this correction:
  `plan_items.billing_status` is existing unconstrained TEXT. The existing invoice
  linkage migration and its runtime mirror are not renumbered or rewritten here.

## Create, reuse, amend, or refuse

`createLinkedInvoice` classifies lines only from catalog category. No service or an
unrecognized/financial category remains financial-only. No clinical finding is inferred.

The transaction locks the patient, plans and sorted items before existing financial
locks. It checks idempotency before writing. Equal keys and equal requests replay the
original invoice; conflicting requests do not create another obligation.

Existing work is inspected before creating identity. Reuse requires exact patient,
service, currency, quantity, unit price, normalized surfaces, requested sessions, and
compatible case/site. Started, cancelled, billed, or review-required work is not silently
recreated. A different total or shape is a refusal, not partial coverage.

Fresh work can amend the unique active, unconsented, item-priced, per-procedure master
in the same currency without installments. The shared `insertPlanV2InTx` engine creates
its items/sessions/planned visits and updates its total. If there is no active master,
one plan can be created for the invoice. An incompatible, consented, or ambiguous master
requires an explicit clinical/financial decision rather than a duplicate plan.

A genuinely new episode can be distinguished by an explicitly different case after
completed prior work and a terminal prior case, only when prior financial coverage is
not in review. Ambiguous repeat work, including case-less repeats with no independent
episode identity, is refused rather than guessed.

## Financial coverage and review

`PLAN_ITEM_PREBILLED_SQL` requires all of the following:

- A live invoice for the same patient and currency
- Exactly one current invoice line for that item
- Exact service, quantity, unit price, total, and known doctor attribution
- The canonical original plan-item source, including matching patient/currency/work
- A consistent current source, or a null source on a retained correction line

`PLAN_ITEM_INVOICE_LINEAGE_SQL` recognizes both item invoice IDs and retained invoice
line/source identity. It therefore detects older cleared-ID cancellation records without
rewriting them. Missing/invalid coverage with any lineage, an unknown billing status, or
an explicit `needs_financial_review` status fails closed. Ordinary financial-only lines
with no plan item are not labeled as review merely because a LEFT JOIN returns NULL.

Cancellation changes the item to `needs_financial_review` while retaining provenance.
Correction always retains line lineage. Only unchanged quantity AND unchanged unit price
can move accepted coverage to the replacement. Removed or shape-changing lines require
review. Neither action authorizes billing the same work again.

A separate new plan item is not an escape hatch: linked signing compares its work against
other protected invoice identities of the same service and overlapping scope. Unlinked
single-session prepaid work is also refused. Installments cannot be added over a plan's
existing invoice-lineage obligations.

## Clinical consent, truthful drafts, and providers

Only `recordPlanConsent` records clinical plan consent. An invoice does not write
`consent_at`, `consent_by`, or `consent_note`. Its provenance records financial acceptance.

Clinical drafts retain actual observations and the actual entered performer even when
consent or financial review is unresolved. Draft estimates create no receivable. The
atomic sign path rechecks consent, exact coverage, dependencies and financial identity;
it refuses unsupported monetary/sign-off activation while preserving the saved draft.
The same warning is exposed in session pricing, outstanding work, plans, invoice details,
and walkout results. Review takes precedence over a zero-price or included label.

An explicitly selected real invoice doctor is retained. A known existing plan-item
assignment can be reused after the same doctor-identity validation. No doctor is inferred
from the first signer. Null financial attribution is allowed to remain explicitly
`needs_financial_review`; it is never silently assigned to a later clinician.
Actual performer defaults retain the existing visit/signer semantics. Conflicting
prepaid performer/financial attribution requires review; drafts still retain the care facts.

Existing `attributeInstallment` proportionally groups item value by doctor/service and
uses its established primary-doctor fallback. It is not a rule for splitting one prepaid
multi-session item between future clinicians. That allocation and the null-provider
resolution workflow remain explicit policy gaps; this patch invents neither.

## Clinical scope and case lifecycle

The shared `validateLineSite` and Dental Chart wire format remain `toothCode`, `surfaces`,
`episodeTeeth`, and `scope`. Tooth-bound care requires a valid FDI tooth. Orthodontics
requires upper/lower/both; periodontal care requires an explicit region or a tooth.
Crown/veneer/bridge episodes retain their exact tooth set. Whitening has its catalog-defined
whole-mouth scope, without a fabricated tooth.

Explicit, inherited and automatic case choices all require same patient, specialty,
site and active lifecycle. Blank or unparseable legacy site is unknown, not compatibility.
Reuse needs exact scope; duplicate prevention also checks overlap: both arches overlaps
upper/lower, and full mouth overlaps a region/tooth. Disjoint upper/lower is not a duplicate.
These checks cover existing work and sibling lines within one request.

A bridged orthodontic case uses its actual orthodontic lifecycle. Closing it shares
patient-first serialization with financial linkage. Intake bridges only one compatible
shell; ambiguous or mismatched scope is refused. No invoice creates wires, diagnosis,
endodontic findings, laboratory orders, or an `ortho_cases` clinical record.

An ordinary billed orthodontic item is NOT an unlimited adjustment package. Its exact
linked sessions can be covered. The existing installment agreement rule for a case's
adjustments remains; unrelated adjustments are not implicitly funded by one billed item.

## Input, UI, and release checks

Preview and save share `parseInvoiceInput`, including existing valid quantity normalization,
price/currency requirements, doctors, tooth/case/session bounds, site fields, discount and
idempotency validation. Both use the existing price-authority engine. Read-only preview
never replaces an invalid price with a catalog price or zero, or drops malformed fields.
Only fields actually included in the preview request can be previewed.

UI integration must send the same current form inputs, preserve explicit doctor selection,
show review/consent warnings without preventing truthful draft documentation, and prevent
stale affirmative previews. Walkout/print consumers must prioritize financial review over
`NO_CHARGE` fallback presentation. No claim of paid, free, consented, or covered care is
inferred from origin alone.

Required CI evidence includes exact reuse/append, real consent, known-provider execution,
null/different-provider draft preservation, cancellation/shape correction with retained
lineage, old cleared-ID history, wrong/duplicate sources, alternate-item bypass, scope
overlap and disjoint controls, lifecycle races, and unchanged financial-only behavior.
Existing tests that asserted synthetic consent, cancellation rebilling, or blanket Ortho
funding must be corrected without dropping their regression coverage.

No partial B+C activation is safe. Keep the stack held until the full source/UI/test
composition is reviewed, CI is green for that exact head, migration-candidate test fixtures
are collision-free, and the nonportable tracked `node_modules` symlink is removed from
Git. This correction does not activate legacy intake or periodontal schema, change real
Production data, rewrite history, alter credentials, or delete backups.
