# Explicit approval of the full agreement principal

Base: `a03aea1eb911c3c886028bc902f6f4f97f3546cf`, after PR343/344/345.
Migration: `0064_approved_agreement_principal.sql`;0062 is reserved for HR.

This implements the newly authorized financial-approval event. Treatment consent
and a proposed plan are not financial approval. No historical rows are backfilled,
no patient's live balance has been examined, and no deployment is included.

## Posting and collection

Approval confirms the exact current plan total, currency, clinical consent and
source under transaction locks. It records immutable terms, source evidence,
reason, actor and request hash. A new agreement issues one invoice for the full
principal, with frozen provider/service attribution using the existing allocation
rule. Thus1500USD approved and500USD collected leaves1000USD in the ledger, not0.
300SAR less140SAR leaves160SAR. Approval does not record cash.

A new receipt settles the explicit invoice or opening source. The plan endpoint,
general payment endpoint, plan display and print use that same source. The old
installment invoice writer and generic plan-only credit writer refuse an approved
plan. Successful old request retries retain their original behavior. Ordinary
unapproved legacy plans retain their old contract until explicitly reviewed and
approved; consent is not silently upgraded into a financial event.

The account and reports derive debt from invoices/opening balances minus signed
receipts only. They never add the agreement total again. Approved-plan reference
payments include the linked source's receipts; an opening match also includes the
explicit pre-opening paid amount, without posting that historic cash again.

The UI and print distinguish full remaining from due through the clinic's current
date. Due now is scheduled amounts through that day less all source settlements
and historic paid, bounded by the remaining principal. With no schedule, the full
remaining is due. Dates/terms are frozen at approval. Each currency is independent.
Foreign-to-foreign collection is refused; foreign tender against YER uses the
stored rate and existing recorded base-amount contract. A refund restores debt
and recollection creates only a new receipt. Schedule-revision refund policy was
not relaxed: approved principal has its own source matcher after canonical
settlement validation.

## Historical sources and changes

An administrator can explicitly match one full existing invoice with the same
patient/currency/net principal, or one whole opening balance equal to total minus
explicit pre-opening paid. There is no guessed allocation by name or patient
balance. A source can back only one approved plan. Multiple independent plans
remain separate. Partial installment invoices, multiple-source reconciliation,
ambiguous historical coverage and unrelated opening balances require financial
review; they do not automatically produce a supplemental invoice.

Approved principal, source price/currency, schedule, and item financial terms are
protected by database triggers. Clinical progress/completion and append-only
receipts/refunds remain possible. New items cannot be appended to an approved
plan; additional work requires a separately reviewed plan and approval. This
version does **not** implement discounts, cancellation of unperformed work, or
financial amendment credits after approval. Such changes are refused, not silently
applied or represented as completed workflows. Their approval/accounting policy
and a linked adjustment document remain a follow-up requirement before such
changes can be supported. Existing cash corrections remain in the canonical
receipt/refund mechanism.

## Authorization, retries and recovery

New approvals require a live admin/reception session revalidated in the
transaction. Collection retains admin/reception/cashier authority; cashiers can
collect through the general payment endpoint but cannot approve principal.
Matching prior sources additionally requires admin. Changed role,
credentials, missing keys and changed request payloads are refused. The database
uniqueness constraints and canonical locks serialize duplicate approval and
collection. Distinct concurrent collections cannot over-collect a source.

The approval UI preserves an uncertain request's body/key until retry or refreshed
proof; unique plan approval prevents another invoice even after page reload. The
existing durable money attempt mechanism handles collection. Read failures are
not mapped to zero. No external notification is sent.

## Storage and restore

Runtime and CLI use identical0064 bytes/checksum; the current schema contract and
migration-chain tests include it. The reset classification includes the new table.
Backup orders items, installments, invoice items and openings before approval so
validation triggers remain enabled on restore. Completed plans are valid restore
sources. The restore regression exposed a pre-existing plan-item/visit cycle;
backup now emits the optional item.visit_id link after both records exist, as it
already does for patient photos and family guarantors.

Existing commission policy is retained: full invoice principal accrues the
provider share, cash collection earns only the proportional covered share. The
synthetic300000YER/30% example accrues90000 and earns30000 after100000 collection;
clinical work does not add another invoice or accrual.

## Baseline and authorship

The checkout already contained uncommitted approval drafts and the decision
review when this task resumed. Git cannot identify their author. They were
inspected and completed rather than discarded or treated as verified work.
The earlier decision review and its expected-failure fixtures document the old
unapproved flow; they are not proof of success for this new approval event.
