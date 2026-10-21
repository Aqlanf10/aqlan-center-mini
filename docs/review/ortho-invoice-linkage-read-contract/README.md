# Orthodontic financial-source read contract

Status: local read-only UI candidate based on frozen tree
`b95f3c6c19c98a1b0b6ec2683a2d309c65cbe7de`. Not published or deployed.
No billing eligibility change and no real patient's linkage is inferred here.

## Verified baseline source trace (before this repair)

1. `lib/invoice-linkage-db.ts:450-498` creates or reuses a treatment plan/item.
   New invoice-origin plans use `per_procedure` with `installments: []`; the item
   records `origin_invoice_id` / `billed_invoice_id` and provider identity.
2. `:503-584` selects or creates the same-patient, matching-site clinical case,
   then records `plan_items.case_id`. Existing unbridged Ortho can be bridged.
3. `:587-599` records invoice item source identity and `plan_item_id`.
4. `lib/db.ts:22204-22233` bridges a unique matching invoice/historical clinical
   shell when Ortho intake is created. It does not assign `ortho_cases.plan_id`.
5. `components/PatientOrtho.tsx:1405-1411` does not submit a plan ID on new case
   creation. The financial reference can therefore exist through the item/case
   graph while the old package-plan field stays null.
6. `components/OrthoPackageLink.tsx:141-183` reads only the old plan field and
   installment identities, then says no financial agreement is linked.
7. `PatientOrtho.tsx:571-573` mounts the canonical reference card only when
   navigation contains an explicit `orthoCaseId`, not on generic Ortho/Ceph entry.

These are distinct notions: a recorded financial reference, current validity of
that reference, and financial coverage of a particular adjustment. Neither a
paid invoice nor a case bridge alone proves all future adjustments are covered.

## Executed baseline witness

The separately preserved baseline witness used the real canonical
projector and package component effects against entirely synthetic identities.
It does not import DB runtime, execute a writer, or run schema setup. Seven tests
passed on the pre-repair baseline:

- exact invoice/item/clinical-case/Ortho reference exists, coverage unspecified;
- current false-absence display with zero, partial and full invoice payment;
- another case's item does not become this case's reference;
- legacy installment-package behavior is preserved;
- unavailable reads remain unknown instead of declaring absence.

This was defect characterization, not release acceptance. The candidate
`__tests__/ortho-invoice-linkage-read-witness.test.tsx` now asserts that the old-plan
widget cannot deny a canonical invoice reference. Actual parent-composition tests
assert the new exact-case source card for generic invoice/historical entry.
The DB-free witness does not claim the invoice writer ran end to end.

## Implemented read-only contract

Keep four independently represented facts:

1. Read authority/state: loading, ready, denied, unavailable. Do not show absence
   after denial, malformed payload, timeout or retired response.
2. Exact source references for the displayed case: patient, Ortho case, clinical
   case, plan and item IDs, then invoice line/document or historical agreement
   identities. Traverse recorded edges only. Multiple genuine item references
   are a list, not automatically an error or permission to select one for billing.
3. Reference validity: current verified source, preserved historical/cancelled
   source, or review required. Display the current canonical review reasons;
   do not equate invoice existence with financial eligibility or suppress them.
4. Adjustment coverage: independently read the existing canonical adjustment
   classification and any unresolved billing decision. A linked invoice reference
   must not force INCLUDED. Existing signed snapshots remain frozen.

For money-authorized roles, use the existing TreatmentFinancialContext read for
each verified displayed Ortho case, even without a deep-link context. Filter by
the exact case and preserve any explicitly selected item/case identities using
AND semantics. Do not guess the latest invoice, current plan or most recent case.

The old `plan_id` UI remains a separate, narrowly named installment-package link.
Its empty state must not deny other financial references. When a reference exists
but adjustment coverage is not established, show both facts clearly, for example:
"مرجع الفاتورة مرتبط بهذه الحالة؛ شمول هذه الشدّة يحتاج قرارًا موثقًا."
Keep the visible review/decision warning. Do not hide it or imply a new charge.

The money-free case projection returns allowlisted identities/status only.
The existing signing classifier is reused unchanged in the same read-only
snapshot. Source identities follow the existing plans endpoint ownership rule,
not broader clinical `canViewAllPatients`: active doctor, enabled plan visibility,
doctor party and actual patient ownership. Other clinical readers receive
`restricted`, no source IDs or scheduling evidence, and the existing clinical
classification only. The full money endpoint/role gate is unchanged.

Review-existing-source navigation has a separate guarded Account-only callback;
it does not open the new-treatment chooser. Existing creation entry stays unchanged.
A missing legacy `plan_id` no longer offers new linking as a prerequisite.
No legacy `plan_id` backfill, automatic bind, new invoice, new installment schedule,
automatic charge-once flag, or change to funding predicates is part of this repair.

## Finite post-freeze acceptance recipe

Use a dedicated isolated PostgreSQL database only after the database owner
releases it. Never run schema-dropping existing suites against shared/live data.

1. Through the real `createLinkedInvoice`, create one synthetic ortho invoice with
   explicit provider and both-arch scope. Assert one invoice, one exact item/case,
   source IDs match, and no `plan_installments` were manufactured.
2. Open the matching Ortho intake with `planId: null` through `createOrthoCase`.
   Assert the same clinical case is bridged, no second clinical identity is
   created, and the legacy package-plan field remains null.
3. Read the real canonical reference endpoint. Assert the exact invoice/item/
   clinical-case/Ortho chain appears without financial-review failure. Open the
   generic Ortho and Ceph navigation views and prove the reference is visible,
   with no false overall-financial-absence claim and no unlimited coverage claim.
4. Repeat display states with unpaid, partial and fully paid invoice. Linkage
   identity remains the same; payment state must not determine adjustment scope.
5. Exercise invoice-first and Ortho-first creation ordering, legitimate mixed-
   specialty plan with an explicit ortho item, another same-patient case, foreign
   patient item, mismatched arches and multiple ambiguous bridge candidates.
6. Cancel/correct the source through existing authorized synthetic test writers.
   Preserve historical IDs and review reasons. Refresh must update display; it
   must not rebind, create debt, replay a command or discard clinical drafts.
7. Verify denial, missing plan-read capability, redacted doctor view, late A/B/A
   responses, malformed IDs, logout, timeout, and retained signed classification.

At every step compare invoice/payment/installment counts and monetary totals
before/after read-only UI actions. Money assertions remain per currency. Any
currency-corrected clinical-source activation requires its own exact-proof gate;
the separate exact-pair foundation must not silently activate it here.

## Separate issue, not fixed by this contract

`ORTHO_CASE_FUNDED_SQL` is still installment-only. `PLAN_ITEM_PREBILLED_SQL` can
cover explicitly linked clinical work, but standalone adjustment classification
does not consume that item identity. A future scoped adjustment-to-item contract
would be a billing-policy/workflow change, not this read-only display repair.
Existing tests intentionally reject treating an ordinary ortho invoice as an
unlimited package. Preserve those tests and do not broaden the predicate by OR
with invoice existence, payment status or approved-principal existence.

Likewise, strategy `bridge_missing` means the clinical-case bridge is missing;
it is not a financial failure. Check its actual source separately before acting.


## Historical document facts, not fabricated per-line settlement

Modern historical documents keep paid-before-system and registered remaining on
the latest document revision, not on individual agreement lines. Their line
fields remain nullable. The financial card shows the actual document facts once,
with exact patient/line membership, without allocating shared opening receipts
or repeating document totals as case debt. Legacy single-agreement facts remain
available. Missing/malformed revision proof must be review/error, never zero.

The optional repayment indicator is collection metadata only. Invoice schedules
belong to that invoice. Historical opening schedules remain shared patient/currency
schedules, explicitly not a case allocation, and require a current approved
historical source with opening provenance. No schedule creates principal or
establishes adjustment scope.

## Existing old-case bridge: future explicit preview, not this repair

A strategy `bridge_missing` result is a separate clinical identity issue. The
current case-create endpoint inserts a new clinical case; it must not be used as
an automatic repair when an existing case might already own the invoice item.

A safe future read-only matching preview would list recorded same-patient
orthodontic clinical cases, their exact item/source IDs, status and documented
arches/site, distinguishing already-linked, unlinked compatible, conflicting,
unknown and multiple candidates. Names, prices and recent timestamps are not
identity proof. Do not select the latest candidate automatically or infer a
bridge from the patient balance.

Any separately approved future attach-existing action must display the exact
existing clinical-case and Ortho-case pair and all affected references, explain
that no new case, invoice, principal, payment or coverage is created, and require
an explicit selection. Its transaction would lock and revalidate the same
patient/cases/items and expected source versions, reject changed or competing
bridges and unknown scope, and audit only the verified association. This candidate
adds no preview writer, no backfill, and no old-data reconciliation.

## Validation boundaries

DB-free source, permission, lifecycle and composition tests exercise the real
components and pure projectors, including denial/unknown states, late responses,
shared versus exact references, conflicting line IDs and the unowned globally
visible doctor. The new PG acceptance suites are separate and may run only in a
fresh owned localhost PG18 database with verified name/OID/owner/datadir.
The financial writer/classification-policy bodies are unchanged; lib/db.ts has
only one approved change: exporting the existing adjustment classifier.

## Executed local acceptance (2026-10-20 UTC)

- Node 22.23.3 focused unit/component/permission tests: 222 passed in 14 files
  with the repaired Vite 8.2.4 dependency tree.
- PostgreSQL 18.6 acceptance on a fresh owned localhost cluster: 25 passed in
  five files (`invoice-first-ui`, `ortho-package`, `legacy-onboarding`, and the
  two new financial-reference suites). This includes real invoice-first and
  Ortho-first bridge writers, a mixed-specialty plan, historical multi-line
  document correction and shared repayment metadata, nullable line amounts,
  current revision proof, foreign-patient isolation, and unchanged financial
  row snapshots after reads. This PostgreSQL run preceded the final rollback
  cleanup correction below; its SQL and successful read behavior are unchanged.
- The synthetic database name, OID, owner, server port and data directory were
  proved before use. Cleanup rechecked the owned database identity, dropped
  that database, and stopped only the owned cluster. No ambient database URL
  or shared/live database was used.
- Full Node 22 TypeScript check passed with incremental compilation disabled on
  the initial sealed candidate, before the final rollback cleanup correction.
  Two existing security-HTTP fixtures were updated only to include the new
  required empty `historicalDocuments` array.
- ESLint on all changed TypeScript files: zero errors; 12 existing warnings on
  unchanged lines (four Ortho hook dependencies and eight database unused
  symbols). Whitespace/diff validation passed.
- Independent source review found no remaining P0/P1/P2 blocker after the
  plan-ownership, invoice-item identity and shared-schedule corrections.
- Root's final review identified failed-rollback disposal: the checklist reader
  now discards its client if rollback fails, preserving the original read error
  and releasing normally after a successful commit or rollback. A focused
  failure-injection test proves this; the two affected files pass ESLint with
  zero warnings. A final composed typecheck remains a release gate.

These are local, source-hashed checks, not hosted CI, production build/browser
acceptance, or proof that any real patient's old clinical bridge exists. The
separate existing-case reconciliation described above remains unimplemented.
