# Shift opening reviews (migration 0129)

Status: specification written before tests and code (2026-11-14). **Revised 2026-11-15 by the owner's
blind-count decision (#483 6886911163): §8 supersedes every rule below about the 409 refusal, the opener's
note and who sees amounts.**
Sources: owner decision on #483, comment 6831365228, item 1. Number and scope: allocation 6833690789
(`0129_shift_opening_reviews.sql`: the opening difference per currency, with its reason, its settlement,
the reviewer and a reference to the previous close, without changing that close). Finance queue row F1-1
in `docs/review/work-finance-continuation-plan-20261110.md`.

This specification covers only migration 0129. Lab payable waivers (0130) and invoice doctor
corrections (0131) have their own specifications.

## 1. Problem today

| Row | Problem | Where |
|---|---|---|
| F1-1 | A shift's opening float is free input. It is never compared with the cash counted when the previous shift closed. Cash that leaves or appears between two shifts is in no voucher, no journal entry and no review. | `openShiftWith` in `lib/db.ts`; `commandCanonicalShiftOpen` in `lib/canonical-shifts.ts`; legacy `POST /api/shifts` |

## 2. Approved rules (owner item 1)

The owner's words: the opening difference never passes silently and is never converted automatically into
a deposit or a withdrawal. It is reviewed, and its reason and its settlement are recorded with an audit
trail, without changing the previous shift's close and without inventing a cash movement.

### 2.1 Detection at opening (same transaction as the opening)

- The reference is the **previous close**: the closed shift with the latest `closed_at` (ties broken by
  the higher id). Its `counted_*` amounts are what was physically left in the drawer.
- For each currency (YER, SAR, USD), the difference is `opening − previous counted`. A positive
  difference is more cash at opening than was counted at close; a negative one is less.
- **The opening form does not show the previous count.** It starts empty and is never prefilled from the
  previous close, and the refusal below never returns that count. This is not a full blind count: the shift
  history on the same screen (and `GET /api/shifts`) still lists past closes, with their counted amounts, to
  anyone who may view shifts (§6). When at least one
  currency differs, the server refuses the first attempt with 409 `opening_difference_note_required`. The
  refusal names each differing currency with its signed difference, the same way the close refuses
  a count that does not match the expected cash. Nothing is written. The opener recounts. If the count is right,
  the opener resends with `openingDifferenceNote` (3–300 characters, trimmed), saying what they know.
- With the note, the shift opens. In the **same transaction**, one row per differing currency is written
  to `shift_opening_reviews` (§3) with:
  - the opening amount,
  - the previous shift's id and counted amount,
  - the difference,
  - the opener's note.
  
  The opening's audit row lists the same differences. No voucher, payment, expense, deposit, withdrawal
  or journal entry is written. The drawer's expected cash still starts from the opening amount as entered.
- The previous shift is not touched. Closed shifts are already append-only (0014 trigger
  `cashier_shifts_closed_guard`), and the opening reads them without locking them for update.
- **A previous count that is unknown** (a legacy close with a NULL `counted_*` for that currency)
  cannot be compared. If the opening amount for that currency is not zero, a row is written with a NULL
  previous count and a NULL difference, and it needs a review like any other. The opener's note is
  required for it too.
- **No previous close at all** (the clinic's first shift): there is nothing to compare. The shift opens
  as today and no row is written.
- The comparison runs under the shift lifecycle lock (`aqlan.canonical.cashier-shift-lifecycle.v1`).
  Both the canonical and the legacy open take that lock, so a close and an open that race each other
  are serialized.

### 2.2 Review (a separate action, after opening)

- A pending row is reviewed once, by a person, with:
  - `reason` (3–300 characters, trimmed): why the cash differed;
  - `settlement` (3–300 characters, trimmed): how it was settled outside the drawer's records (for
    example, "the owner took the amount to the bank, deposit slip 123", or "counting error at close,
    confirmed with the cashier"). It is text, not an accounting classification. No account, voucher or
    journal entry is chosen or created. If the owner later wants a settlement to post an entry, that is
    a separate decision, and it will be asked first, as item 2 requires.
- The review is **append-only**: the reason, the settlement, the reviewer and the review time are set
  once and never changed or cleared. A row is never deleted. A mistaken review is answered by a note
  in the next review or a later decision, never by an edit.
- **Who may review:** the protected owner (`staff_authority_control.owner_user_id`), or a canonical
  staff member holding the new capability `finance.shifts.review-opening`.
  - The capability is granted to nobody by default and is not implied by `finance.shifts.operate`,
    by `finance.reconciliation.manage` (which means approving lab reconciliations) or by any role label.
  - A reviewer who is not the owner cannot review a difference on a shift they opened, or one whose
    previous close they made (separation of duties). The owner may.
- **The review is canonical only.** A legacy session is refused with 403 and an Arabic message. A legacy
  admin is not an owner identity. Until the cutover, differences stay pending and visible. They are never
  hidden and never auto-approved.
- The review writes its audit row in the same transaction. A refusal writes nothing.
- A concurrent second review of the same row is refused with 409 `opening_review_already_done`. The row
  is locked `FOR UPDATE`, and the review is a conditional update of a row that has no review yet.

### 2.3 What a pending difference does not block

A pending review does not stop opening, collecting, paying, closing or the next opening. The owner asked
for review, not for a block. Blocking the drawer would worsen the clinic's daily crowding. What it does:

- the shift screen and the reconciliation page show every pending difference, with its currency, signed
  amount, previous shift, opener and note, until it is reviewed;
- the shift read API returns `openingReviews` for the open shift and a count of all pending rows for
  anyone who can view shifts.

If the owner wants a pending review to block the next close, that is one setting and one check, which
can be added after a decision.

## 3. Storage (migration 0129)

`shift_opening_reviews`:

| Column | Type | Rule |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `shift_id` | INTEGER NOT NULL → `cashier_shifts(id)` ON DELETE RESTRICT | the shift that opened with the difference |
| `currency` | TEXT NOT NULL | `YER`, `SAR` or `USD`; unique with `shift_id` |
| `previous_shift_id` | INTEGER NOT NULL (no foreign key, see below) | the previous close; `<> shift_id`; an insert trigger proves it exists and is closed |
| `previous_counted_minor` | BIGINT NULL | NULL only when that close has no count for the currency |
| `opening_minor` | BIGINT NOT NULL | ≥ 0 |
| `difference_minor` | BIGINT NULL | `opening_minor − previous_counted_minor`. Non-zero when the count is known, NULL when it is not. When the count is unknown, the opening amount is non-zero. |
| `opening_note` | TEXT NULL | the opener's note, trimmed, 3–300. Both opening routes require it; NULL only from an internal opening path (test fixtures, `db.openShift` without `requireOpeningDifferenceNote`), so the difference is still recorded |
| `detected_by` | TEXT NOT NULL | the opener's username |
| `detected_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `review_reason`, `review_settlement` | TEXT NULL | trimmed, 3–300 each |
| `reviewed_by_user_id` | INTEGER NULL → `users(id)` ON DELETE RESTRICT | |
| `reviewed_by` | TEXT NULL | username |
| `reviewed_at` | TIMESTAMPTZ NULL | |

- CHECK: the four review columns plus `reviewed_by_user_id` are either all NULL or all set.
- Trigger `shift_opening_reviews_append_only`:
  - refuses a DELETE;
  - refuses any change to a detected column;
  - refuses any change to a review column once it is set.
  The only UPDATE allowed is filling the review columns of a pending row, once.
- Partial index on `(detected_at)` `WHERE reviewed_at IS NULL` for the pending list.
- Trigger `shift_opening_reviews_previous_closed` (BEFORE INSERT): the previous shift exists and is closed, read without a row lock. A foreign key would take a key-share lock on the previous (closed) row, so an opening would queue behind any writer still holding that row (a payment writer keeps the row lock its open-shift read took even after the close filtered the row out). The regression test holds that lock and proves the opening does not wait. Closed shifts are never deleted by the application; `shift_id` keeps its foreign key.
- Nothing is backfilled. Shifts opened before 0129 have no rows. The first opening after the upgrade
  compares with the last close made before it.

Runtime registration: constant in `lib/shift-opening-reviews-schema.ts`, byte-identical to the SQL file,
registered after 0128 and before 0132 in `applyRuntimeMigrationFiles`.

## 4. API

- `POST /api/shifts` (open), both paths: the optional `openingDifferenceNote`. A mismatch without a note
  returns 409 `opening_difference_note_required` with `differences: [{currency, differenceMinor |
  null}]`, and with `previousCountKnown` per currency. The previous counted amounts are not returned, so
  that the form never learns it (see §6 for what the history still shows). The 201 body adds `openingReviews` (the rows written).
- `GET /api/shifts`: the open shift carries `openingReviews`. The response carries `pendingOpeningReviews`,
  a number.
- `POST /api/shifts/opening-reviews` (new, canonical only), body `{id, reason, settlement}`. The action
  is `finance.shifts.review-opening`. It returns 200 with the reviewed row. Refusals:
  - 400 `invalid_opening_review`;
  - 403 for capability or separation of duties;
  - 404 `opening_review_not_found`;
  - 409 `opening_review_already_done`.

  Each refusal carries an Arabic `message` and writes nothing.
- `GET /api/shifts/opening-reviews?status=pending|all` (canonical `finance.shifts.view`): the list,
  newest first, at most 200 rows.

## 5. Tests (failure first)

PostgreSQL, synthetic data only:

1. A matching opening writes no row. A mismatch without a note is refused, and nothing is written (no
   shift, no row, no audit).
2. A mismatch with a note opens the shift. One row is written per differing currency, with the right
   signed difference, and the audit row is written in the same transaction. Nothing is written to
   payments, expenses or journal entries, and the drawer's expected cash starts from the opening as entered.
3. The previous shift's row is byte-identical before and after the opening and the review.
4. An unknown previous count with a non-zero opening needs a note and a review. The first shift ever
   writes no row.
5. Review grant matrix:
   - the owner: allowed;
   - a holder of the new capability: allowed;
   - a holder of `finance.shifts.operate`, `finance.reconciliation.manage` or every other finance
     capability but not this one: 403;
   - the opener or the previous closer without owner status: 403;
   - a revoked grant: 403;
   - a legacy admin: 403.

   Every refusal writes nothing.
6. Two concurrent reviews of one row: one succeeds and the other gets 409. No partial write.
7. The append-only trigger refuses DELETE, a detected-column change and a second review, written as raw SQL.
8. A race between close and open under the lifecycle lock: the opening compares with the committed close.
9. Upgrade from a database at 0128 with legacy closed shifts: the table is created and nothing is
   backfilled. The next opening compares with the last close.

Unit tests: the refusal message, the difference arithmetic, and the route dispatch (a canonical session
never falls back to legacy). Browser journey: the empty opening form, the mismatch notice, the note, the
pending notice, and the review by the owner.

## 7. Implementation decisions (2026-11-14)

- Where the note is required: in the two human entry points (the canonical command and the legacy
  `POST /api/shifts`), not in the shared writer. The shared writer always records the difference rows,
  so no opening is silent at the storage level; 127 PostgreSQL suites open shifts through it as fixtures.
- The comparison runs after the insert, under the lifecycle lock, on both paths; the legacy
  `db.openShift` now runs in its own transaction with that lock (it used a single pool statement before).
- Separation of duties also excludes the person recorded as `detected_by` (the opener), compared
  case-insensitively.
- Text projection: amounts and states to every shift viewer; the opener's note, the reason and the
  settlement only with the shift-note projection (payments.view AND expenses.view AND patientScope=all) or
  to a holder of the review capability (the protected owner has all).
- Legacy matrix rows for `/api/shifts/opening-reviews`: GET admin/reception/doctor, POST admin. The handler
  refuses every legacy session (401 if expired, 403 with the Arabic reason otherwise); the gated legacy
  roles (cashier, accountant) are not registered because their gate rejects the path anyway.
- The legacy audit row of the opening is still written after the opening's commit (unchanged legacy
  behaviour); the review rows themselves are in the opening's transaction.
- UI: the shift tab and the reconciliation page show the note field only after the server's 409; the
  previous count is never shown. A panel lists the open shift's differences and the clinic's pending
  count, with review forms only when the server reports `canReviewOpening`.

## 6. Limitations (stated, not hidden)

- Before the cutover, no one can review, because the review is canonical only. Differences stay
  pending and visible.
- The review is text. It does not post any entry. Moving cash between the drawer and a bank or the owner
  is still outside the system, as it is today.
- A shift opened before 0129 is never compared retroactively.
- **Not a full blind count** (corrected 2026-11-14, found by the browser journey): the opening form and the
  refusal hide the previous count, but the shift history and the shifts feed still show the last close's
  counted amount to every shift viewer, the opener included. Hiding it from openers until the next opening
  would change an existing screen and report, so it is an owner question, not done here.

## 8. Blind count (owner decision #483 6886911163, 2026-11-15) — supersedes §2.1, §2.3, §4 and §7 where they differ

The owner's words, in short: the employee counts the cash and records the real count before seeing the
previous close's balance. The difference is recorded and sent to an authorized reviewer, with no automatic
deposit or withdrawal. The owner and the authorized reviewer see the balance and the difference according to
their grants. The protection is on the server, not only on the screen.

### 8.1 Who is authorized

- Canonical: the protected owner, or a holder of `finance.shifts.review-opening` (unchanged, granted to
  nobody by default, never implied by a role label, `finance.shifts.operate` or `finance.reconciliation.manage`).
- Legacy (before the cutover): the legacy admin only. The legacy admin is the account the owner uses on the
  legacy runtime; it still cannot review or correct (those stay canonical only, §2.2, §8.4).
- Everyone else who may view shifts is **unauthorized** for the amounts below, whatever their other grants.

### 8.2 The count is fixed first

- `POST /api/shifts` (both paths) opens the shift with the amounts entered. There is **no difference refusal and
  no note step**: the server never answers a count with "it differs" before that count is committed, so a
  rejected or repeated attempt cannot be used to probe the previous balance. `opening_difference_note_required`
  is removed. The opener's note (`opening_note`, `openingDifferenceNote`) is removed: the opener cannot
  explain a difference they are not shown; the explanation belongs to the review.
- In the opening's own transaction (unchanged): one `shift_opening_reviews` row per differing currency, the
  opening's audit row, no voucher, payment, expense, deposit, withdrawal or journal entry; the previous close
  is not touched.
- The 201 answer and every later read tell an unauthorized viewer only **that** a currency differs and that it
  waits for review (`{ id, shiftId, currency, state }`), never the previous count, the signed difference or
  the previous shift's id. An authorized viewer gets the full row.
- Every other refusal of an opening (a shift already open, invalid amounts, a stale session, no grant) is
  decided before any comparison and says nothing about the previous close.

### 8.3 The previous close is sealed until the next count is fixed

- The **sealed close** is the latest closed shift (by `closed_at`, then id) while no shift is open.
- For an unauthorized viewer, every read withholds the sealed close's `counted`, `expected`, `difference`,
  `differenceReason` and `note` (returned as `null`, with `sealed: true`):
  - the canonical shift feed (`recent`);
  - legacy `GET /api/shifts` (`shifts`);
  - `GET /api/finance/reconciliation` (`shifts`);
  - the shift print page `/print/shift/[id]` (the amounts are replaced by a sealed notice).
- Once the next shift has opened (its count is fixed), that close is ordinary history again and shows as
  before (the existing shift history is kept).
- The close answer itself (`PATCH /api/shifts`) still returns the closer's own count to the closer.
- `GET /api/shifts/opening-reviews` and the open shift's `openingReviews` follow §8.2 for every row.
- The audit log is readable only by the legacy admin (`/api/audit`, unchanged), who is authorized; a canonical
  session cannot read it.

### 8.4 Correction of the opening count (authorized and audited)

- Instead of letting the opener change the count after seeing a result: `POST /api/shifts/opening-corrections`
  (canonical only), body `{ shiftId, opening: { YER?, SAR?, USD? }, reason }`, action
  `finance.shifts.review-opening` (or the protected owner).
- Only the **open** shift can be corrected. Under the shift lifecycle lock and the shift row lock (the same
  row lock payment and expense writers take), the server writes one append-only `shift_opening_corrections` row
  per currency whose amount changes (from, to, reason, who, when), updates that shift's opening amount, and
  writes the audit row `shift.opening_correct`, all in one transaction. No cash movement is written.
- Separation of duties as for the review: a non-owner may not correct a shift they opened or whose previous
  close they made. The opener can never correct their own count.
- Refused, with an Arabic message and nothing written: no change (400 `invalid_opening_correction`), shift not
  open (409 `opening_correction_shift_not_open`), own shift (403 `opening_correction_own_shift`), a correction
  that would make the drawer's expected cash negative in a currency (409 `opening_correction_negative_drawer`),
  no grant or a legacy session (403).
- The detected difference rows are history and never change; the review sees the corrections next to them.

### 8.5 Storage (amended 0129, not yet merged or deployed anywhere)

- `shift_opening_reviews.opening_note` and its CHECK are removed.
- New `shift_opening_corrections` (id, shift_id → cashier_shifts RESTRICT, currency, from_minor ≥ 0,
  to_minor ≥ 0, from ≠ to, reason trimmed 3–300, corrected_by_user_id → users RESTRICT, corrected_by
  non-blank, corrected_at), append-only (no UPDATE or DELETE).
- Both tables are wiped by the clinic reset before `cashier_shifts`.

### 8.6 Tests (failure first, synthetic data)

1. An opening that differs opens at once (201, no 409), writes the rows and the audit row, and writes no cash
   movement; the unauthorized opener's answer has no previous count, difference or previous shift id.
2. Repeated attempts: a second opening while one is open, invalid amounts and a stale session all refuse
   without any comparison data; no answer before commit varies with the previous count.
3. Sealed close: before the next opening, the unauthorized operator, reader and own-scope viewer get the
   latest close with `counted`, `expected`, `difference`, `differenceReason` and `note` null on the canonical
   feed, legacy `GET /api/shifts`, reconciliation and the print page; the owner, a reviewer and the legacy admin
   see them; after the next opening the close shows again.
4. Opening reviews read: unauthorized viewers get state only; authorized viewers get the amounts.
5. Correction: allowed for the owner and a reviewer who is neither the opener nor the previous closer; refused
   for the opener, the previous closer, an operator without the grant, a legacy session and a closed shift;
   append-only; the drawer's expected cash follows the corrected opening; a negative drawer is refused; a
   correction racing a close or a payment is serialized by the locks; the audit row is in the same transaction.
6. The browser journey: the opener sees an empty form, opens in one step, sees only "recorded for review",
   and never sees the previous close's count anywhere on the screen; the reviewer sees the amounts, corrects
   and reviews.

### 8.7 Implementation notes (2026-11-15)

- One rule, three places: `projectOpeningReview` / `projectOpeningCorrection` (what a viewer may know about a
  difference) and `sealShiftForViewer` with `sealedCloseIdWith` (the latest close while no shift is open), all in
  `lib/shift-opening-reviews.ts`; the canonical feed, the legacy routes and the print page call them.
- The canonical opening re-proves admission after the insert and asks for `finance.shifts.review-opening` on the
  same transaction to decide what its answer shows.
- A single shift's differences are listed in the order they were recorded (by id); the clinic's pending list stays
  newest first.
- Residual limit, stated: someone who may see every receipt and expense of the sealed shift could add up its
  expected cash by hand (not its count). Hiding movements of a closed shift would change the receipt views and is not
  part of this decision.

