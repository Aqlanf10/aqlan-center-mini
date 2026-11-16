# Reviewed security fixes (#527) in WORK, and the same scope mechanism on the canonical writers (2026-11-05)

The owner asked, through the review on #483 (6643572594), that the independently reviewed fixes from Draft #527 be reviewed here and brought into WORK. Branch `fix/reviewed-security-integration-20261105`, head `e4473cb3`, built on `171ae786`.

## Review decision

All three fixes are accepted. They come in unchanged and as separate commits, through a merge commit.

| Commit | Fix | Review |
|---|---|---|
| `40317be1` | Lab tracking events projected by grants and patient scope | Sound. Classifies by the writers' actual actions (`work_intent_materialized` from slice 87 is classified clinical). Financial events need `finance.cost-prices.view`. Settlement notes also need `finance.expenses.view` and patient scope `all`, because batch totals can cover other patients. Unknown kinds stay hidden. The stored history is unchanged. |
| `2fb7c07c` | Visit and vitals scope held across concurrent writes | Sound. Admission is decided after the writer's first domain lock. A positive ownership witness is held `FOR SHARE NOWAIT` to commit. A lock-order contention is a bounded 409, never a backward wait. The vitals writer keeps patient-first order. |
| `95d6b527` | One session envelope grammar for the proxy and the routes; the report guard | Sound. One splitter and one strict decoder serve both runtimes. A signed canonical cookie is selected even when its admission will refuse, so it never falls back to a Bearer identity. `viewReports` is enforced inside the handler too. |
| `e4473cb3` | The reviewer's digest | Not copied. The digest is regenerated for this composed tree. |

**Merge:** `lib/db.ts` merged without conflict against the extracted visit writers (slices 84–87). Only `inventory.json` conflicted, and it was regenerated.

## The same mechanism on the canonical writers

These writers had the same race: the scope was checked on an unlocked row before the writer's own locks.

### Visit documentation (slices 85–87)

Covers save, addendum, sign and the lab draft, all through `commandCanonicalVisitDocument`. `admitLockedVisit` now:
1. takes the legacy visit writers' own order: the visit's patient first (`lockVisitPatientFirst`, now exported), then the visit `FOR UPDATE`;
2. decides the scope on the locked row:
   - a doctor's link through this visit holds, because the visit is locked;
   - any other link needs a positive ownership witness (`doctorOwnsPatient`, `FOR SHARE NOWAIT`);
3. refuses with 409 if the visit's patient changed while waiting, since its lock would come after the visit's, the reverse order.

The lab rejection settlement uses the same witness.

### Debt arrangement and collection (slice 91)

`lockedDebtAdmission` runs through a new `afterLocks` hook in the legacy bodies, after all of the writer's own locks:
- **arrangement:** after the patient and account locks;
- **collection:** after the patient fence, shift, visits, invoices, plans and arrangement.

The witness is taken after those locks, so it never forces a SHARE-then-UPDATE upgrade on the visits the writer locks. The early unlocked check only answers missing or outside quickly.

## Tests

| Gate | Result |
|---|---|
| PG `canonical-writer-scope-races` before the fix | 4/4 **failed**: writes landed on a visit or patient that had left the scope during the wait |
| PG `canonical-writer-scope-races` after the fix | 4/4 passed |
| Focused PG on the composed tree | 14 files, 117/117 (canonical visit suites, payment writes, ledger, invoices, ortho decision, the reviewer's `visit-scope-lock-races` and `lab-canonical-event-privacy`, debt collection) |
| Focused unit on the composed tree | 7 files, 167/167 (the reviewer's session-transport parity, report access, lab event privacy, role routes, the extracted-body protocol test, session selection) |
| Typecheck, lint on the changed files, audits | clean, 10/10 |

The pre-fix and post-fix race tests are each lock-wait interleavings proved through `pg_stat_activity`, not timing:
- a visit reassigned while waiting;
- a visit's patient relinked while waiting;
- a collection waiting on the shift while the patient leaves the scope;
- an arrangement waiting on the patient lock while the patient leaves the scope.
