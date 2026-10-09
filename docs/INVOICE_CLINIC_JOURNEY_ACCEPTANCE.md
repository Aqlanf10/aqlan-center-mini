# Invoice-origin clinic continuity acceptance

Status: source prepared; not run. No local test, PostgreSQL, application server, installation or build was started. These files are independent acceptance witnesses, not evidence that the feature passes. Publication is held for reconciliation with the incoming implementation and exact PR heads.

## Scope

Three synthetic-patient journeys using the existing isolated PostgreSQL/built-app HTTP/Chromium fixtures:

1. Orthodontics: invoice arch selection, canonical plan/case, actual orthodontic intake, explicit clinical consent, walk-in arrival from the planned visit, waiting/call/return/call/chair, planned clinical procedure, signature, original-invoice collection, canonical checkout, next planned appointment.
2. Endodontics on tooth 36: actual shared odontogram click, lost invoice response and same-key recovery, canonical endodontic episode, consent, arrival/queue/chair, clinical staging and endodontic work, stale-version refusal, signature, immutable signed record plus idempotent addendum, lost collection response and recovery, checkout and next appointment.
3. Endodontics to crown on tooth 46 for the same patient: competing invoice tabs, two financial documents tied to one compatible unconsented master, same-tooth dependency, three actual RCT visits and signatures, real episode completion, then an actual crown preparation visit, collection of both original invoices, checkout and next crown appointment.

This is a mixed browser/HTTP acceptance suite. It does not claim that every transition was clicked in the browser. The invoice chart, planned-item staging and collection are clicked; queue, specialty records, signature and scheduling call the production HTTP handlers using the harness's authenticated roles. Arrival is the supported walk-in-from-planned-visit path. The final appointment uses the canonical planned-visit scheduling path.

No AI/Dot feature or historical legacy financial intake is included. Crown preparation is not falsely marked as a completed crown: the next crown session is booked, and the remaining sessions stay open. The orthodontic test covers the exact invoiced treatment item, not an assumed unlimited adjustment package.

## Files and measurable witnesses

### `__tests__/security-http/invoice-clinic-continuity-journey.test.ts`

Three bounded tests, using `./_server` and its existing global setup.

- Real `odontogram-tooth-36` / `odontogram-tooth-46` clicks and confirmed invoice payloads; cancelled chart edits retain the original selection.
- Invoice response identities are checked against `invoice_items.plan_item_id`, `plan_items.case_id`, origin invoice, tooth and the saved clinical case's patient/specialty/site.
- Invoice creation must not invent clinical consent.
- Duplicate invoice, arrival, signature, collection and appointment attempts cannot create duplicate durable records.
- The visit is actually created. `GET /api/visits/:id/clinical` and persisted `visit_procedures` must agree on patient, plan item, service, tooth, surfaces, treating doctor and zero-price exact prepaid work.
- Each signature completes exactly one persisted treatment session and creates no visit-procedure invoice line or second obligation.
- Checkout is read from the canonical server projection, with zero remaining YER debt after collection. Reading it cannot create invoices.
- Endo records have a real visit, measured synthetic canal data, version checks, signatures and addenda. RCT completion is performed through its real endpoint; no SQL marks work complete.
- Crown dependency is written through the existing endodontic crown endpoint and checked in `plan_item_dependencies`; RCT must be done before crown work.
- The next appointment is checked in both `appointments` and the owning planned visit, then reread through walkout.

### `__tests__/postgres/invoice-journey-financial-containment.test.ts`

Eighteen containment/boundary cases, using the existing PG suite setup:

- Invoice financial acceptance cannot substitute for clinical consent. Truthful draft work survives; unresolved consent blocks signature without financial or clinical advancement.
- Missing financial provider cannot be silently assigned to the first clinician. The actual clinician's saved procedure survives; original financial provenance stays unchanged.
- An unlinked prepaid single-session treatment cannot silently create a second bill. This deliberately tests the single-session hole, not only the existing multi-session guard.
- Cancelling an invoice after the procedure was staged preserves origin/current invoice history, marks financial review, and blocks signature. Retrying invoice creation cannot manufacture a fresh treatment identity.
- Reducing quantity or unit price after staging retains invoice-line lineage, requires financial review and cannot cover the old full treatment or silently rebill it.
- An ordinary ortho invoice must not make `ORTHO_CASE_FUNDED_SQL` classify unrelated adjustments as an unlimited package.
- Overlapping Ortho both-arch and upper-arch work cannot create duplicate obligations, either in successive invoices or two lines of the same request.
- The positive boundaries prevent overbroad repairs: ordinary unlinked work must not acquire invented financial review from a NULL join, and disjoint upper/lower arch work remains legitimate in successive invoices or a single request.
- A labelled historical fixture clears the original/current invoice IDs after cancellation while preserving `invoice_items` lineage. Signature, fresh invoice creation and installment scheduling must not rebill the obligation.
- Two labelled corrupt fixtures retain a plausible amount and `plan_item_id`, but break `source_type` or `source_id`. Neither is proof of prepaid coverage. Walkout must expose financial review rather than present the work as included.
- Existing discount policy is preserved: a known-provider therapeutic invoice with a 10% header discount remains covered at its original net amount; removing an unrelated line preserves unchanged treatment coverage and the existing capped-header-discount rule. A quantity change still requires review even when a 100% discount leaves both nets at zero. HTTP price/discount authorization remains owned by the existing manual-invoice discount suite.

For cancellation/correction, snapshots include invoices, signature fields, saved procedures, treatment sessions, chart and cases. Refusal must leave all those snapshots unchanged. These assertions intentionally reject the prior cancellation-rebilling and blanket-ortho-funding behaviour.

### `__tests__/security-http/invoice-signature-readiness-journey.test.ts`

Seven bounded built-browser tests complement the HTTP signature races in the three journeys:

- A real persisted missing-consent item permits actual draft staging/save; its real confirmation button is disabled. Recording actual consent and reloading the canonical DTO enables the real button, which is clicked to create an observed signature without invoice #2.
- A real persisted unknown financial provider permits the actual clinician's draft but leaves final confirmation disabled. Financial provenance is not rewritten; an unauthorized reception signature is rejected by the actual server.
- Four negative read tests begin with a complete, genuinely ready canonical DTO, then corrupt only GET evidence: truncated session pricing, missing authoritative flag, wrong procedure correlation, or duplicate evidence. None fabricates financial approval or a successful sign response.
- A valid editor stays mounted while a real ordinary save succeeds and only its authoritative GET reload is denied. The error/retry UI must appear and previous review/confirmation controls must retire; the draft and finances remain intact.
- Runtime screenshots and JSON evidence use the existing `.settings-ui-artifacts/invoice-signature-*` destination. No screenshots or passing runtime evidence exist in this source-preparation packet.

## Blocking contract reconciliation

The financial owner clarified that an unknown invoice-line provider requires explicit financial review; the actual visit performer must never be silently substituted into the original financial record. The invoice UI at reviewed head `7e8e6ce7db6c6bb0379798395cf65118ed8a13b7` does not send a provider. The root subsequently authorized an explicit per-line provider choice using the existing authorized doctor catalogue and `doctorId` wire field. The UI owner has prepared `invoice-provider-0`; the three positive journeys now choose the known doctor through that real control and verify financial provenance before and after signature. This integration still requires reconciliation with the incoming final head. The suite does not rewrite SQL, intercept requests to invent a provider, weaken the safety invariant, or skip that failure. The unresolved multi-doctor prepaid allocation policy is not presumed to pass.

Similarly, truthful clinical drafting remains available when financial review or clinical consent is unresolved; the finalization boundary owns the refusal. The browser staging helper currently executes consented, financially resolved happy paths and expects the server's authoritative DTO fields. The separate PG cases own the unresolved negative boundary.

Expected final DTO fields from the prepared owners: `outstanding.surfaces`, `clinicalConsentRecorded`, `financialReviewRequired` and authoritative prepaid pricing. Expected UI selectors: `invoice-provider-0` is the explicit doctor select; `planned-item-<id>` wraps the real execute button; invoice previews carry `data-preview-state="ready"` only for current successful evidence. These are cross-file integration dependencies that must be reconciled against the final exact head.

## Source provenance and current head movement

- Source/API review began from PR #278 head `7e8e6ce7db6c6bb0379798395cf65118ed8a13b7`, then based on #274 `8549d49b0b1fa7a9e1cead14994dc89870926e0b`.
- At 2026-10-07 02:33 UTC, read-only GitHub verification showed #273 at `c669a82e8dbd18d7510b5ca07caa23410cd7bdec`, based on main `4fa7c406455b666e163ff1f9f10861d004eb04a4`; #274 had moved to `947d02ca06a2452a33cb199881721be35ae71fe2`.
- Fresh source at #278 `efc85a37657cffdaa55a861c9c04ba03f251431f` was retrieved at 02:41–02:42 UTC. Invoice response/doctorId wire fields, clinical HTTP handlers, Endo services, collection controls and the HTTP harness retain the relevant API shapes. The fresh head still lacks the prepared safety DTO and new provider/staging selectors, so the acceptance suite targets the reconciled final overlay rather than claiming this predecessor already passes.
- The five existing-suite maintenance originals were subsequently compared at `dfed65dc3de627a141794599fda0b8ea4d8ba8c2`; every original blob is unchanged. The related maintenance packet records their assertion mapping and exact hashes. The safety contract has progressed through frozen-v3, including shared parsing and linked-alternate-identity containment; none of these source freezes is execution proof.
- These moving heads are not runtime proof. Re-read the final handoff and source contracts before publication. Do not report predecessor CI or source preparation as final-head acceptance.

## Execution, once authorized on the reconciled exact head

Use the repository's approved isolated PostgreSQL 18 target and normal build/harness workflow. Do not point either suite at Railway Production or an unverified database.

1. Run normal typecheck/lint against the final reconciled source. These stages have not run for this packet.
2. Run the focused PG suite: `npm run test:postgres -- __tests__/postgres/invoice-journey-financial-containment.test.ts`.
3. Build through the repository's normal approved build path, then run: `npm run test:security-http -- __tests__/security-http/invoice-clinic-continuity-journey.test.ts __tests__/security-http/invoice-signature-readiness-journey.test.ts`.
4. Resolve genuine failures without weakening the expected domain behaviour. Re-run focused tests and final aggregate CI on the exact final commit.
5. Record exact commit, server/PostgreSQL versions, invoked command, test names/counts, exit status and logs. Only a successful observed run is passing evidence.

Timeouts are bounded per journey (240 seconds for Ortho/Endo, 360 seconds for Endo→Crown) and per browser operation (20 seconds). Fixture patients and services are uniquely named. Browser contexts and database connections close in teardown. Tests do not modify shared permissions, production settings, credentials or historical data.
