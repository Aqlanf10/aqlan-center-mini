# Local validation of the composed candidate

Validation uses Node 22.23.3 and disposable PostgreSQL 18.6 databases. Runtime
source was frozen before the production build and broad test runs. Following
independent review, the native upgrade test gained an additional assertion for
the saved prescription body; that test is rerun separately. Later edits are
evidence and review documentation only.

| Check | Result |
| --- | --- |
| Production Next build, including TypeScript | Passed |
| Final TypeScript + new/changed integration-test lint | Passed; test lint has zero errors/warnings |
| Full unit suite | 801 files / 13,935 tests passed |
| Full native PostgreSQL suite | 317 files / 3,715 tests passed |
| Composed populated-upgrade + official SQL/archive restore | 3/3 passed again with both pre-upgrade prescription and receipt snapshots |
| Five real HTTP/browser journey files | 21/21 passed again on the clean build in 72.13 seconds; successful server/database teardown |
| Current schema contract | Passed: 136 tables, 1,727 columns, 2,008 constraints, 425 indexes, 107 triggers |
| Schema ownership | Zero unexpected differences; 16 previously disclosed open findings (12 columns, four functions) |
| Full ESLint | Zero errors; 333 warnings |
| Dependency audit with fresh official evidence | Passed after enabling Node's supported environment-proxy option; full and production raw reports each contain zero findings |
| Raw body-parser scan | Passed |
| Read-only preflight artifact | Built with 72 immutable migration assets |
| Built runtime braces absence | Passed on clean build: 9,131 files and 359 traces |
| Built runtime lint-tooling boundary | Passed on clean build: 715 traces, 86 manifests, clean production graph |
| Immutable baseline manifest | Passed; original 55-table baseline retained |
| Full local print suite | 31 passed, 14 failed; not a green print gate |

The print failures are explicit: 13 cannot launch the lockfile's missing
Playwright Chromium headless-shell build 1243; one reports `PDF service label
must occur in exactly one field block` in the lab dispatch fixture. The same
lab failure was reproduced on a separate detached checkout of untouched Rx
`b804d515`. All prescription cases in the compact-print file passed. Local
Chromium is 151.0.7922.173 and Poppler is 25.03.0; this is not acceptance on the
lockfile's Chrome 153. Tests and geometry thresholds were not relaxed.

The first audit attempt returned clean raw reports but could not fetch its
mandatory live official evidence. `NODE_USE_ENV_PROXY=1` resolved that transport
configuration without changing the audit verifier. The first runtime tooling
check found two extraneous optional packages in the copied local installation
(`@img/sharp-wasm32` and `@emnapi/runtime`). They were moved to a local quarantine.
The old build retained NFT references to them, so a fresh build and preflight
artifact were produced. Both runtime verifiers then passed on build
`E1VUGnfBQNaQ-Wi0jOr7p`; native Sharp still loads as 0.35.5. No package manifest
or lockfile change is part of this integration.

## Reproduction

Use a fresh local PG18 service and the repository's guarded test database name
`aqlan_p1_test`. Set `DATABASE_URL` and `TEST_DATABASE_URL` to that synthetic
loopback database, a synthetic `SESSION_SECRET`, and
`CLINIC_TIME_ZONE=Asia/Aden`. Native suite flags are
`MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1` and
`CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1`; native schema/restore checks use
`SKIP_SEED=true`. **Unset `SKIP_SEED` for the browser harness**: it creates its
own disposable database and needs the normal synthetic/default clinic settings.
An initial clean-build browser rerun incorrectly inherited `SKIP_SEED=true` and
passed 19/21, failing two saved-print assertions because the clinic phone/footer
had not been seeded. No application source or print assertion was changed to
address that harness configuration. Restoring normal harness seeding produced
the final 21/21 pass on the same clean build. Do not provide production/Stage URLs
or Railway runtime identities.

Run the repository's `test`, `test:postgres`, `schema:contract:verify`,
`schema:ownership:verify`, `lint`, `ci:audit`, `ci:scan:body`, `build`,
`build:preflight`, and runtime verification commands. The browser suite command
and exact executed files are preserved in `evidence/browser.log`. Browser
fixtures use a separate local PG18 cluster; never overlap native fixtures and
the HTTP harness on the same mutable test database.

## Evidence and release limits

`inventory.json` pins both input heads, approved Rx file hashes and regenerated
schema artifact hashes. `evidence/manifest.json` hashes the nine synthetic
screenshots/PDF; the remaining logs document schema, restore, browser and print
results. Roster screenshots show both missing and ambiguous mappings at mobile
and desktop widths. They contain synthetic identities only.

At the end of local preparation there was no exact-head hosted CI result.
The subsequent owner instruction authorizes draft publication and supported
GitHub CI; the draft PR/checks are the source of truth for the final head.
The earlier #522 CI success applies only to its appointments source commit.
The full HTTP suite was not rerun on this composed branch; the listed 21 cases
are focused real application acceptance. No real doctor roster, approved leave,
patient data or deployed application was read or validated. Stage coordination,
supported-browser print acceptance and hosted CI remain required before any
release decision. The preparation did not merge or deploy anything; subsequent
draft publication does not authorize either action.
