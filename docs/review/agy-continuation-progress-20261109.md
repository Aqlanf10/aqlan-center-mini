# Stand-in progress log — Antigravity continuing Claude's WORK (from 2026-11-09)

The owner asked the Antigravity agent to continue Claude Code's WORK on **aqlan-center-mini** while the Anthropic account's usage limit is reached. This log is updated with each batch.

## Binding limits

- No merge to `main`.
- No Staging or Production deploy, and no Production database.
- No change to Railway, secrets or permissions, and no deletion of backups or earlier work.
- Synthetic data only.
- Nothing from the separate `aqlan-center` repository is used here.
- Dot owns orthodontics and cephalometrics; none of Dot's branches is edited.

## Starting point (verified 2026-11-09 00:43 +03)

| Item | Value |
|---|---|
| Reference branch | `feat/work-recovery-followup-20261027` (Draft PR #506) |
| Head verified | `8586f991d95b6456e2b58574a33add3418b93702` (unchanged from the owner's note); PR CI on it: all six jobs green |
| Work branch | `feat/agy-work-continuation-20261109`, created from `8586f991`; upstream unset so nothing can be pushed to Claude's branch |
| `origin/main` | `c6c88612`; #506 is `CONFLICTING` with main (known, not touched) |

### What #506 already contains (from HANDOFF, the Group 4 contract and the map)

- M1–M3 canonical identity runtime; M2 slices up to **94e**. Lab group complete (66–71). Group 3 clinical complete (to 87). Group 4 money slices 88–94e complete.
- Map at `8586f991`: 189 `canonical-done`, 155 `existing`, 23 `owner-only`, 12 `excluded`, 4 `entry`, 3 `self` (386 rows). The PR body's "75/344" is stale (it describes the 53–55 batch).
- The wider inventory stays **NOT_READY**.

### What remained (Group 4 plan section 4, plus the map)

| Slice | Content | State |
|---|---|---|
| 95 | Historical onboarding and documents (G4-2) | open; not started on this repository |
| **96** | **Price-free service catalogue; services and prices; service materials (G4-3)** | **done in this batch (below)** |
| 97 | Expenses, payables, parties, openings, FX, reconciliation, lab accounting | open |
| 98 | Accounting, reports, executive, commissions (G4-5) | open |
| — | Appointments: `PATCH /api/appointments/[id]` (rest of the branches), `GET /api/appointments/availability` | open |
| — | Prescriptions: `POST /api/prescriptions`, `.../void`, `GET /api/patients/[id]/prescriptions` | open; the Rx branches and reserved migrations 0090–0093 are separate, coordination needed |
| — | Governance: `users` (3), `audit` (1), `settings/*` (14) | open |
| — | HR (41), tasks (8), messages (6), inventory legacy (7) | open |
| — | Slice 56 (assessment revision beyond the 8 MiB budget) | Claude's local-only work, not in the branch, and ortho domain (Dot). Not touched. |

## Local environment

| Item | Value |
|---|---|
| OS and Node | Windows; Node 22.15.0 (portable); `npm ci` from the lockfile |
| Checkout | renormalized to LF (`core.autocrlf=false`), so `sourceDigest` matches CI |
| PostgreSQL | **18.6** portable cluster of my own; `127.0.0.1:55496`, loopback only, synthetic data only |

Not available locally:
- Docker;
- the hosted CI runner;
- a Playwright browser install, not yet attempted.

## Batch 1 — slice 96 (G4-3)

Report: [work-services-catalogue-slice96-20261109.md](work-services-catalogue-slice96-20261109.md). Contract: section 15 of the Group 4 design.

| Gate | Result |
|---|---|
| PG `services-canonical` | 11/11 |
| Failure-first: legacy provisional over-count | failed on `8586f991` (`filled: 2` for one row written); passes with the fix |
| Failure-first: batch "before" race | failed with the legacy pre-lock read (9100 recorded instead of 9300); passes |
| Failure-first: material/deactivation race | failed with the unlocked check; passes |
| PG neighbours (18 files: inventory, commission, day1 currency, display, visit/plan UX, lab pricing, documents, invoice create, plan items/writes, receipts, settings, visit documentation) | 195/196. The one failure (`inventory-audit` "expiring soon … longer than 30 days") **fails identically on the untouched base `8586f991`**. It is a real date defect, fixed in batch 1b below. |
| `tsc --noEmit` | pass |
| ESLint on the changed files | 0 errors; the 8 warnings are the existing ones in `lib/db.ts` |
| Inventory | regenerated: NOT_READY, 420 methods; no drift |
| Audit tests (`scripts/audits`) | 9/10. The failing one, "CLI drift success…", spawns the inventory CLI with a fixed 8 s timeout. Here the CLI takes ~13 s (`Measure-Command`), and run directly it exits 0 with no drift. **Environmental (slow Windows filesystem); not raised or skipped.** CI on Linux is the authority. |
| HTTP journey, browser | **not done** for slice 96. No claim of acceptance. |
| Full unit and full PG suites | not run in this batch |

### Dot overlap (for the owner to coordinate)

- My slice touches no orthodontic or cephalometric file.
- `lib/db.ts` is also changed by Dot's `review/ortho-ceph-current-source-20261107` (#530, 1672 changed lines) and `fix/ceph-canvas-loupe-20261105` (#529, 87 lines). None of their hunks touch the functions changed here: `createService`/`updateService`/`priceServiceBatch`/`fillProvisionalServicePrices`/`getSettingsWith` and the new `…With`/`…On` writers. A textual conflict is unlikely, but the file is shared.
- Both Dot branches are based on `main`. #506 itself already carries Claude's orthodontic and cephalometric canonical slices (29–64, including ceph 53–55 and 59–60). That pre-existing #506 ↔ #530 overlap is not created by this work. It needs the owner and Dot to decide the integration order before any merge.

## Batch 1b — inventory DATE columns keep their civil day (defect found by the neighbour run)

node-postgres returns a PostgreSQL `DATE` as a local-midnight JavaScript `Date`. Two readers mishandled it.

| Reader | Defect | Visible in CI (UTC)? |
|---|---|---|
| `toMovement` (`lib/db.ts`): every inventory movement and batch expiry (legacy screens, alerts, item detail) | `new Date(d).toISOString().slice(0,10)`: one day **early** when the server process runs east of UTC (Asia/Aden) | no, hidden by the UTC runner |
| `listPatientMaterialsWith` (M2 slice 82, canonical patient materials) | `String(d).slice(0,10)` gives `"Thu Dec 31"`, not a date | **yes, in every zone** |

- **Fix:** both use the existing `postgresDateOnly` helper (`lib/postgres-date-only.ts`), as the cephalometric and backup readers already do.
- **New test:** `__tests__/postgres/inventory-date-only.test.ts` (8 cases) runs the writer/reader and the slice-82 read under Asia/Aden, Pacific/Kiritimati, America/Los_Angeles and UTC, restoring `TZ` after each case.
- **Failure-first:**
  - Before the fix: the movement read returned `2026-11-10` for `2026-11-11` in Asia/Aden, and the slice-82 read returned `Thu Dec 31` in all four zones. The log is kept locally.
  - After the fix: 8/8, plus `inventory-audit` 4/4 in the Aden zone.

### Local environment notes (batch 1b)

The agent host restarted twice. A local PostgreSQL started from a tool task was killed with the task. It is now started detached with `pg_ctl` (loopback only, my own data directory). No test result from an interrupted run is counted.
