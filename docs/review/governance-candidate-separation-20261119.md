# Governance candidate: separating unapproved orthodontic additions (2026-11-19)

- **Branch:** `feat/claude-governance-candidate-20261119`.
- **Source:** #506 `feat/work-recovery-followup-20261027` @ `8586f991`, plus `main` @ `c6c88612`.
- **Compared with:** #539 `33175cbe`, #541 `4e88b6a7`, and the Codex 0079 retirement branches. Used for comparison only; neither is merged wholesale.
- **Not a release:** #506 and every original orthodontic branch remain unchanged. No merge, deployment, data change or migration renumbering.

## 1. What #506 actually contains

- #506 does **not** contain the orthodontic agent's line:
  - no 0106–0125 migrations;
  - no `0af83b43` import;
  - no workup navigation;
  - no #538 redesign.
- Its orthodontic and cephalometric changes fall into four groups:
  1. **Governance conversions of existing screens** (`canonical-ortho-*`, `canonical-ceph-*`, the M2 capability map).
  2. **Concurrency and lint hardening** of existing ceph files (`CephTracer`, `WebCephRecordsGrid`, `cephCompare`): no new analysis, no report change.
  3. **The 0079 follow-up coverage feature**, together with a billing-classification change, both from the mixed commit `0b654f4c` (2026-10-27).
  4. **Daily session form changes** from the same commit.

## 2. Classification

| Item | Source | Decision |
|---|---|---|
| Canonical admission, capabilities and patient scope for existing ortho/ceph screens | #506 M2 slices | **Keep.** It protects screens that already exist in `main`. |
| Ceph canonical commands (calibration, landmarks, diagnosis, completion) for the existing tracer | #506 slices 53–54 | **Keep.** Governance of the existing engine; no new definitions. |
| Ceph/ortho concurrency fixes | #506 | **Keep.** |
| Responsible doctor, return-booking context, nearby booking on the ortho next-appointment card | #506 | **Keep.** Governance, booking and finance. |
| 0079 explicit follow-up coverage: authoring route, panels, canonical editor, fresh activation | `0b654f4c` + later slices | **Separate.** Retired using the Codex retirement commits (`-x` provenance). Detail in section 3. |
| `REVIEW_REQUIRED` as the classification for missing evidence | `0b654f4c` | **Mixed; partly separated.** New rows return to main's `OUTSIDE_CONTRACT`. Readers, the decision queue and decision commands still accept `REVIEW_REQUIRED` for historical rows. |
| Required "what was done" in the session | `0b654f4c` | **Separate.** Optional again, as on main. |
| Explicit wire removal checkbox; 1–52 week validation | `0b654f4c` | **Keep.** It sits within the owner's approved wire expansion, and the approved wire timeline depends on it. The week check only refuses invalid values. |
| Wire catalog and new fixed appliance types | #541 `ef54ef1e` (owner, #483 2026-11-13) | **Kept by porting** onto main's screen. The case-section reorder (`ortho-workup-navigation`) is excluded. |
| Auxiliary appliances (0132) | #541 `1ea56f21`, `b5e4dc38` | **Not separable now.** Section 5. |
| Ortho agent line, #538 redesign, new ceph analysis/report work | staging line, #541 | **Not present in #506;** nothing to remove. |
| 0090–0093 prescriptions/booking, 0126, 0128–0136 | staging line, #539, #541 | **Out of scope:** not part of #506. |

## 3. 0079 and adjustment billing

- **Where 0079 has been applied:** it is in neither `main` nor Staging (`4d85fb69`). No production or Staging database has it applied.
- **What the candidate keeps:**
  - the SQL file and its embedded source, byte-identical (SHA-256 `5603226d…`);
  - historical readers and exact receipts.
- **What the candidate does:**
  - a fresh database (runtime and CLI) skips 0079;
  - an existing database that has 0079 registered is validated against its exact registry and footprint;
  - no `DROP`, no data rewrite, no deletion of migration records;
  - a full-archive restore keeps validated 0079 history.
- **Known limit, taken over from the Codex work:** the raw-SQL restore CLI refuses backups that carry 0079 and points to the full-archive path.
- **Billing:**
  - An adjustment without proven funding again records `OUTSIDE_CONTRACT`, a pending decision as on main, instead of `REVIEW_REQUIRED`.
  - Installment/principal funding is unchanged (`INCLUDED`), and so is verified legacy coverage.
  - No owner approval to change adjustment billing was found. The coverage design records approval by "Root", not by the owner.

## 4. Migrations

- **Set:** the migration list is #506's set minus fresh activation of 0079: 0074, 0080, 0081, 0082 plus main's set.
- **Numbering:** no number is reused or renumbered; no applied migration is edited.
- **Schema contract:** `schema/current-schema-contract.pg18.json` was regenerated from a fresh PostgreSQL 18.6 build of this source. The difference against #506 is only 0079's tables, columns and triggers.

## 5. What could not be separated, and why

- **Auxiliary appliances (0132):**
  - Their writer and receipts run through `lib/ortho-adjustment-command.ts` and `lib/ortho-adjustment-requests.ts`, with migration 0109 from the orthodontic agent's line.
  - Moving them onto main's existing writer is a new backend design, the A/B choice that the coordinator has not decided. Copying 0109 would bring part of the excluded line in.
  - They stay on #541, unchanged.
- **Patient numbering (0080):** present in #506 and left exactly as it is. No numbering work was done in this task.

## 6. Test changes that follow from the separation (recorded, not hidden)

- **Coverage editor journey:** the nine browser cases that drove the retired 0079 authoring form were replaced.
  - **Replacements:** read-only witnesses for the owner and the case doctor, with and without a historical decision. They check that there is no authoring control, no write request, no change to money, coverage or audit rows, and no DDL.
  - **Added:** Codex `4ad839c8` exact-status journal witnesses.
  - **Unchanged:** the HTTP cases, including `coverage_authoring_retired`.
- **Adjustment classification and session narrative:**
  - suites that encoded `REVIEW_REQUIRED` for missing evidence, or a mandatory "what was done", now assert main's behavior;
  - several are restored to main verbatim.
- **Document download with Next 16.4.5:**
  - the patched Next strips `content-length` from route responses (its `FORBIDDEN_HEADERS` framing fix);
  - the header may now be absent but never wrong, and the exact downloaded bytes are still asserted.

## 7. Before/after comparison (synthetic PostgreSQL)

| Head | Ortho, billing and onboarding suites |
|---|---|
| #506 `8586f991` | 35 files / 563 tests passed |
| Candidate | 37 files / 567 tests passed (the same suites plus two retired-0079 suites) |

- **Covered by these suites:** case creation, opening a legacy case, recording an adjustment with the same steps, billing, and permissions.
- **Only intended difference:** an adjustment without proven funding is `OUTSIDE_CONTRACT` (main's behavior) instead of `REVIEW_REQUIRED`.
