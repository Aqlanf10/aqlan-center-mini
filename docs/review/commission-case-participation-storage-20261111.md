# Doctors sharing a case: storage, report and payroll (2026-11-11)

Branch `feat/claude-commission-case-participation-20261111`, stacked on `feat/claude-work-continuation-20261110`. Owner decision of 2026-11-11, finance point 3, option 2, decided per case (`commission-owner-decisions-20261111.md`, section 3). Synthetic data only. Not merged, not deployed.

## 1. What it adds

| Part | Content |
|---|---|
| Migration `0126_commission_case_participations` | One additive table, `commission_case_participations`, with its validation function, two unique indexes, one lookup index and an append-only trigger. No existing table, column or migration is changed. The numbered file is byte-for-byte the runtime constant (one checksum), as `0089`. |
| The decision | One row per decision: the case, the status (`approved`, `pending`, `void`), the participants and their shares in basis points, the source (`centre_decision`, `sessions_guided`, `equal`), the written reason, who decided (username and user id) and when. |
| Database guarantees | An approved split adds up to exactly 10,000 basis points with distinct doctors and no extra fields; a pending or void row carries no participants; a void row must supersede a decision; one head per case (unique root, unique `supersedes_id`); no row is ever updated or deleted. |
| Writer `decideCaseParticipation` | One transaction: case row `FOR UPDATE`, stale-head check (`expectedHeadId`), doctors `FOR SHARE`, insert, audit row. Two decisions on the same head: exactly one is recorded, the other gets `stale_head`. |
| Route `/api/finance/commission-participations` | `GET ?caseId=` (head and history) and `POST` (decide). Legacy administrator only, like the case rate override next to it; mapped to `finance.commissions.manage-rates` for the later canonical conversion. Arabic messages; nothing cached. |
| Audit | `commission.case_participation.set` and `.void`, in the writer's transaction, marked sensitive. |
| Commission report | `commissionReport` reads the decisions in force at the end of the report range. A line of a case with an approved split becomes one share per participant; each is paid at his own contract rate on his part of the line base after the invoice discount and the lab and material costs. A shared case without an approved split is held: paid to nobody, listed in `heldParticipations` of the detail collector. A void decision returns the line to its doctor. A report for an earlier period keeps the split that was in force then. |
| Payroll | No code change. Payroll pays the cumulative commission due, so a later decision changes each participant's cumulative figure and the next run settles the difference. An approved or closed run is never rewritten. A participant who was paid more than his new share carries a negative commission balance; it is not taken from his salary. |
| Clinic reset | The table is wiped with its cases (it is listed before `clinical_cases`). |

Session count may guide the centre (`sessions_guided`) but nothing is computed from it automatically. An equal split is recorded as `equal` and is still a decision of the centre.

## 2. Migration number

`0126` was checked before use:

- All 57 active branches (`*202611*`, `main`, the WORK branch): the highest number in use is `0125`.
- The orthodontic candidate #535 at `18b8659d` and #537 at `4d85fb69`, with `hardening/ortho-http-final-fixtures-20261111` at `afff742f`: all end at `0125_ortho_case_reopen.sql`.
- No number is left empty on purpose and no existing migration's text or checksum is touched.

If another line takes `0126` first, this migration is renumbered before integration (the file name, the runtime registration and the lists below; the SQL text does not change).

## 3. Integration with the orthodontic candidate (#535 / #537) — plan, not executed

This branch's base has migrations up to `0089`. The candidate adds `0090`–`0125`. Every strict list therefore conflicts textually; the resolution is always the same: **keep the candidate's list and append `0126`**.

| File | This branch | At integration |
|---|---|---|
| `__tests__/security-http/hr-temporal-history-ui.test.ts` | `'0126'` appended to the exact list | Keep the candidate's list and the fix from #532 exactly as they are; append only `'0126'` after `'0125'`. Nothing else in the file changes. |
| `__tests__/migrations.test.ts`, `schema-preflight-cli.test.ts`, `periodontal-schema.test.ts`, `periodontal-candidate-chain.test.ts`, `patient-appointment-history-schema.test.ts` | lists and counts end at `0126` (72 files) | Candidate's lists plus `0126`; counts = candidate's count + 1. |
| `__tests__/postgres/_periodontal-fixture.ts` | an exact suffix clause: `0126` directly after `0089` | The clause's predecessor becomes `0125` (`0125_ortho_case_reopen.sql`), placed before the candidate's `0125` clause. Unknown suffixes still fail closed. |
| `__tests__/postgres/hr-runtime-registration.test.ts`, `hr-composed-backup.test.ts`, `schema-ownership.test.ts`, `patient-appointment-history-index.test.ts`, `periodontal-restore.test.ts`, `legacy-doctor-fk-compatibility.test.ts`, `debt-installments-storage.test.ts` | `0126` appended | Candidate's lists plus `0126`. |
| `scripts/verify-schema-ownership.ts` | version and file-name lists end at `0126` | Candidate's lists plus `0126`. |
| `__tests__/ortho-followup-coverage-schema.test.ts`, `patient-numbering-schema.test.ts` | `0126` appended | Absent on the candidate: follow whatever replaces them there. |
| `lib/db.ts` | one import, one registration line after `0089`, the participation read in `commissionReport` | Registration line moves after the candidate's last registration (`0125`). The `commissionReport` change is in the finance section; the candidate changes the orthodontic and cephalometric sections. |
| `lib/clinic-reset.ts`, `lib/audit.ts`, `lib/http-permissions.ts` | one entry each | Additive on both sides: keep both. |
| `schema/current-schema-contract.pg18.json` | regenerated (one new table; 147 tables) | Regenerate after the merge (`npm run schema:contract`); never merge by hand. |
| `schema/preflight-disclosure.pg18.json` | regenerated with `generatePreflightDisclosure` (73 added fingerprints, none removed) | Regenerate after the merge with the same generator; never merge by hand. |
| `__tests__/postgres/schema-ownership.test.ts` table count | 145 → 146 | Candidate's count + 1. |
| `docs/security/staff-cutover/*.json` | regenerated | Regenerate after the merge. |

Order: integrate only from a head the orthodontic owner names as frozen; resolve as above; regenerate the generated files; run the schema, commission, payroll and concurrency suites and the full gate; then review. This branch does not write to any orthodontic branch.

## 4. Tests

- Unit: `commission-participation-schema` (byte identity, registration, additive only, checks, reset order), `commission-case-participation` (engine: split, held, invalid sums, costs, rounding), the strict migration lists.
- PostgreSQL: `commission-case-participation-db`:
  - storage: who/when/source/reason and the audit row; supersession; every refusal writes nothing; the database refuses an incomplete split, a duplicate doctor, extra fields, participants on a pending row, and any update or delete; two concurrent decisions on one head record exactly one;
  - report: 60/40 with rates 40% and 30% gives 24,000 and 12,000 on 100,000; a case that is not shared is untouched; pending holds, approval releases, void returns the line; an earlier period keeps its split; part collections earn in proportion;
  - payroll: a split decided after an approved, paid run leaves that run unchanged; the next run pays the participant who gains, the other carries −16,000, and recalculation pays nothing twice.

## 5. Results (before the full gate)

| Check | Result |
|---|---|
| PostgreSQL `commission-case-participation-db` | 9/9 |
| Mutation: the report ignores the stored decision | 5 of 9 fail (the four report tests and the payroll test); restored byte for byte |
| PostgreSQL schema, migration, reset, backup/restore, commission, payroll, lab and concurrency suites | 100 files, 1,282/1,282 after two expected registrations found by the first run (1,279/1,282: the table count in `schema-ownership` and the reviewed fingerprint list in `schema-fingerprint`, both regenerated or updated with the repository's own tools) |
| Unit: schema, strict lists, commission, audits | pass (see the plan file for the full-suite count) |
| tsc, lint | clean |
