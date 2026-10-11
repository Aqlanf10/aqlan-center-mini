# Assessment / unified-finance seam — local review packet

Parent checkpoint: `ec718e836132093732575bd4fcf77d8573e9cfd0` on
`local/ortho-finance-union-20261011`. The frozen PR325 branch and main are untouched.
Final code checkpoint: `6d3a4d363bba043dd1c1ffa1d9b29633e4f9bc8b`, tree `8881d506ffc8d4abd52d3c300c31fd0e61a5abe9`.

## Narrow shared changes for root/dot

- `lib/invoice-linkage-db.ts`: five lifecycle filters now include assessment, in
  both preview and the existing writer. Unknown arches remain nullable. Existing
  site, patient, plan, duplicate-work, currency, cancellation and lock checks stay.
- `lib/legacy-treatment-db.ts`: three matching filters and one unknown-site
  refusal. An existing assessment cannot disappear and trigger a second shell.
  The existing opening-balance engine is still the sole writer of historical debt.
- `components/OrthoPackageLink.tsx`: replaces the obsolete Plans anchor with the
  parent's unified financial-entry callback; no independent navigation or writer.
- `components/PatientOrtho.tsx`: forwards that callback, fixes the intake lifetime
  lint error, and acknowledges exactly one requested section-to-case transition.
  Native testing exposed that starting from all cases discarded the chosen study
  section when the canonical case was selected. Other case switches, stale reads,
  owner retirement, permission loss and superseding navigation invalidate the ticket.
- `app/patients/[id]/page.tsx`: separates reuse of the exact successful context
  read from the pre-existing same-case guard exception. A newly selected case
  still runs every departure guard. Only an accepted target may reuse the response;
  role changes and Back/Forward do not inherit a navigation exception.
- No SQL, permission registry, clinical signature writer, invoice reader, migration
  numbering or HR implementation changed in this packet.

## Reconciled independent reviews

Both complete texts were read and materialized without changing their bytes:

- `ortho-union-science/FINANCIAL_SEAM_STATIC_REVIEW.md`: Library
  `libfile_c02be2d4bca08191a5669cb30538af3e`, 20,129 bytes,
  SHA256 `870b4ab15d7d00fbbe5e64015bf87b5f9438f574a49fd0f819c3dd383c1159a8`.
- `ortho-union-science/BILINGUAL_STATIC_AUDIT.md`: Library
  `libfile_a9a9561999d48191bf3f4b2ae15b28f5`, 19,463 bytes,
  SHA256 `cddc3a9a38513ad025632945e70b93a7c6fae28f1269f43148e37c9afdbf63ab`.

The bilingual audit distinguishes exact PR324 findings from archive-only seams.
Its 31 source fingerprints remain immutable. Interface/output locale must remain
separate from authored clinical text and source hashes. This packet does not
claim bilingual UI or export acceptance.

## Financial review scenario mapping

| Scenario | Current evidence and remaining limits |
| --- | --- |
| 1. Invoice → assessment → activation | Mounted native intake replaces old POST /api/ortho; same invoice, plan and bridge, nullable start; clinical steps do not add financial rows. |
| 2. Assessment before finance | Real PostgreSQL preview/write refusal for unknown scope with explicit/automatic choice; reuse after explicit activation; cancelled explicit choice refused; simultaneous intake/invoice serialize to one bridge. |
| 3. Historical 300000/120000 | Existing 390/1280 actual historical journey retains 180000 opening; added invoice-first/legacy-first assessment seam tests, exact replay and no historical receipt. |
| 4. Existing identity | Exact existing invoice selection regression retained; seam tests use separately authorized synthetic services and the same bridge. Not blanket acceptance of every cross-currency or multi-case scenario. |
| 5. Second visit | Actual Today staging followed by adjustment/sign-card review, concurrent signatures and lost acknowledgement; exactly one second session and adjustment. Invoice-linked item does not establish an installment package: adjustment remains OUTSIDE_CONTRACT with no decision, no invented coverage or charge. |
| 6. Patient / currency | Existing PR325 authority and currency guards retained; no new exhaustive native matrix claimed. |
| 7. Navigation / role | Existing actor/patient tests retained; native empty package entry adds rejected dirty-study navigation followed by accepted parent navigation. Full Back/Forward/regrant matrix remains open. |
| 8. Writer / rollback | Existing transaction revocation and audit-failure rollback plus financial regressions retained. itemsFor/getInvoice optional-client bodies stay byte-identical. No new clinical financial writer. |

Tests are synthetic only. Earlier failed runs are retained as negative evidence;
passing results must name their actual final run and code checkpoint. The full
349 requirements and 52 end-to-end acceptance scenarios remain incomplete.

## Verified local runs

- `pg-financial-seam-before.txt`: two independent PostgreSQL seam failures before the filter changes.
- `pg-financial-seam-regression.txt`: 5 files / 75 passed; includes 10 connected tests.
- `pg-financial-seam-final.txt`: connected suite expanded to 12 / 12 passed (concurrency and cancellation).
- `native-financial-receipt-verified.txt`: 3 files / 16 passed, real built app, HTTP writers and synthetic PG18.
- `financial-receipt-unit-final.txt`: 4 files / 139 passed, including current guard and role-change behavior.
- `package-entry-unit.txt`: 2 files / 57 passed; `financial-navigation-unit-final.txt`: 4 files / 155 passed before the final context-read receipt refinement.
- `build-financial-receipt-final.txt`: successful final application build and TypeScript.
- `lint-financial-receipt-final.txt`: zero errors, ten existing warnings.

132 previously protected production files remain byte-identical to PR325. The invoice-linkage file is an explicit reviewed exception now, not falsely counted unchanged. Shared diffs and base/current hashes include the patient page and package card. HR source and the optional-client invoice readers are unchanged. No full-suite rerun or remote CI success is claimed for this successor.
