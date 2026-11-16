# WORK batch 48–52 — coverage, manual proposal contact and orthodontic decisions

Base published `327b12fba84049e2b0f5e4e65fbd48445da42386`, accepted by the parent’s bounded review of 43–47 and exact-head CI [41294113283](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/41294113283), all five jobs successful. This batch’s product is frozen at `014c6ae0456794335b15c5a471ee049584ba7d97`; the final HTTP contract assertion is separately committed at `a3812c1127e41ab60a57754c0e3912f8dbff9316`. Later evidence changes do not constitute a new product build. This is not release or whole-system acceptance.

| Slice | User workflow / retained boundary | Actual slice-focused evidence |
|---|---|---|
| 48 | Existing follow-up agreement coverage, independent agreement authority and patient scope; bounded snapshot retains the old applicability/fingerprint rules. Invoice references need invoice-view independently. | 34 PG / 4 files; 35 HTTP and Chromium / 4 files; 32 unit and map guards / 3 files. |
| 49 | Scoped saved treatment proposals with independent financial totals authority; oldest 300 with hasMore. No outbound send or implicit communication consent. | 24 PG / 3 files; 23 HTTP and Chromium / 4 files; 29 unit and map guards / 4 files. |
| 50 | Explicit record of a contact already completed manually. Existing writer/audit meaning preserved on one admitted connection; no message send, consent change, amounts or installment changes. | 41 PG / 4 files; 31 HTTP and Chromium / 5 files; 36 unit / 3 files plus 10 map guards. Frozen 985 full gate: 14,487 units / 858 files and 5,225 PG / 402 files. |
| 51 | Saved pending orthodontic decision queue, independent care read plus scope; bounded 300 / 1 MiB. NULL visit ownership fails closed. No visit details, money, note text or raw MVCC identifiers. | Corrected source: 38 PG / 3 files and 36 HTTP / 4 files; full PG 5,241 / 404 files, zero skipped. Pre-fix 5,239 PG success is explicitly historical only. |
| 52 | Existing no-charge decision for the native responsible clinician or protected owner, and existing invoice link with independent invoice-create authority. Both obey current patient scope. No invoice creation, money movement, coverage recalculation or assignment. | 47 PG / 4 files; 46 HTTP and Chromium / 5 files (10 new command journeys); 41 unit / 2 files plus 10 map guards. Final combined gates below. |

Counts overlap across slice regression groups and are **not summed**. The final 46-journey run covers decision read/write, follow-ups, detail and coverage on build `WX0_Tl-PFBBeQ1-urhmI-`; proposal journeys were run at their own documented slice builds. Whole-repository HTTP CI remains a separate exact-head gate.

## Causal fixes and failed attempts retained

- Slice 48 exposed eager expansion of an SQL template during mocked imports. `f864e07c` restores lazy expansion; original report/session/signer assertions remain. An invocation without the synthetic session secret is recorded separately. Later full units passed, without weakening the guard.
- A synthetic NULL `visits.patient_id` witness on `86c0bf36` resolved a pending queue row with an unrelated clinician summary when it should have refused. `fa84550a` changes the comparison to `IS DISTINCT FROM`. The identical witness fails before and passes after; own and owner cases, clinical history retention and HTTP stale-data clearing are retained. No production incident or real-data repair is claimed.
- The new NULL HTTP assertion initially expected 500; the existing central refusal contract returns 503. `ddc6a21` asserts its exact code/message. The product error handler is unchanged.
- Slice 52’s first concurrency fixture violated the existing one-open-case index. It now moves the case to a separate synthetic patient without an open case. No constraint or business rule was removed.
- Once the canonical decision POST was implemented, a previous test could no longer correctly assert that all canonical POSTs were held at 401. `a3812c11` instead sends a well-formed mutation from an actual read-only principal and requires exact 403, while preserving the exact state/audit snapshot comparison. Final run: 46/46.
- Corrected-51 full unit run: 14,503 passed and one unchanged import-guard timeout. The same guard passed 5/5 in isolation with no edits. Initial combined-52 full run: 14,527 passed and one 5000 ms guard timeout (actual 6509 ms) during concurrent full PG/provenance work. Neither failed run is called a full pass. The subsequent **unchanged complete run passed 14,528/14,528 in 860 files** in 427.67 seconds after full PG/provenance completed.

## Final local acceptance gates

- Build, final typecheck, body/environment/money/preflight guards: passed. Lint: zero errors and 345 existing warnings.
- Braces runtime provenance: 10,313 shipped/provenance files, 372 traces, build `WX0_Tl-PFBBeQ1-urhmI-`.
- Lint tooling runtime: passed, 741 traces / 86 manifests, available maps only. Full combined PostgreSQL passes **5,264/5,264 in 405 files**, zero skipped. Final unchanged full units pass **14,528/14,528 in 860 files**.
- Exact published-head CI and independent review of 48–52: pending. Previous 327b CI does not cover this source.

Pinned evidence verification passed **691 historical source hashes** and **15 final frozen source inputs**. Only the documented HTTP principal/assertion changed after the production build; migrations, schemas, workflow configuration, dependencies, Dockerfile, the clinical engine, commission and backup/restore source are unchanged from 327b.

## Explicit limits and next work

The list-level command recovery is tested with an actual committed response loss. It never automatically resends; the current state and a fresh explicit intent are needed. A changed row, disappearance or matching date is not a durable receipt. If sessionStorage is unavailable, reload recovery is not guaranteed.

The orthodontic queue/UI separately requires ortho-view. Invoice-create alone can authorize the command with valid context, but this slice does not provide a finance-only navigation/context acquisition surface. The full tracing workspace and approval flow are not claimed as complete. Next local work is slice 53, the existing cephalometric draft-edit contract; it is excluded from this batch’s source and tests.

The map records **73 canonical-done / 271 existing ordinary methods**, from a fixed 344-method conversion cohort. Those are route/method states, not a percentage of the whole program. Wider inventory remains **NOT_READY** (420 methods / 97 pages). M3b’s 69 acceptance scenarios, M4 schema/adoption/restore work, and M5 comprehensive staging acceptance remain separate.

Actual WORK Docker proof is still blocked by the enforced Alpine CONNECT HTTP 403. No bypass, alternate mirror or forbidden retry was attempted. No WORK image is claimed from the permitted cached PostgreSQL containers. Schema convergence’s 16 open findings and the ledger of unreviewed parts of the 35 prior main-integration conflict files remain open. Clinic-device Arabic speech quality remains unverified.

No WORK-to-main merge, deployment, live activation, account/data/secret change or migration allocation. Reserved Rx migrations and branches remain untouched. Draft #506 remains for review only.

Source-level reports and raw manifests: [coverage 48](work-ortho-coverage-slice48-20261101.md), [manual contact 50](work-proposal-contact-slice50-20261101.md), [decision 52](work-ortho-decision-command-slice52-20261101.md), [NULL-visit causal evidence](evidence/work-ortho-null-visit-20261101/manifest.json), [final source evidence](evidence/work-ortho-decision-command-20261101/manifest.json).
